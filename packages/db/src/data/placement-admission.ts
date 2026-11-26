import {
  readSharedPolicy,
  currentRoute,
  recordCustodyFact,
} from "./placement-source-facts.js";
import {
  readPlacementQueueAttempts,
  queueMemberDigest,
} from "./placement-action-receipts.js";
import { duePlacementRetry } from "./placement-retry.js";
import { hasTimeWait } from "./queued-thread-messages.js";
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import {
  assertWorkspaceRoute,
  canonicalJsonBytes,
  workerCustodySchema,
  workspaceBindingSchema,
  WorkspaceRefusal,
  type PlacementBinding,
  type PlacementReason,
  type WorkerCustody,
  type WorkspacePurpose,
} from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  placementOperations as operations,
  placementWorkers as workers,
  placementCounters as counters,
  placementWorkspaces as workspaces,
  placementRetryConsents as consents,
  placementEffects as effects,
  placementAttempts as attempts,
  threads,
  queuedThreadMessages as queue,
} from "../schema.js";
import {
  readPlacementOwner,
  readPlacementWorker,
} from "./placement-workers.js";
import {
  readPlacementOperationRecord,
  placementOperationProjection,
} from "./placement-operations.js";
import {
  placementWorkspaceMatches,
  readPlacementThreadBinding,
} from "./placement-bindings.js";

type Operation = typeof operations.$inferSelect;
type Worker = typeof workers.$inferSelect;
export type PlacementCandidate = {
  operationId: string;
  expectedRevision: number;
  ownerRevision: number;
  workerId: string;
  workerRevision: number;
  routeEvidenceRevision: number;
  purpose: WorkspacePurpose;
};
type Refusal = { kind: "wait"; reason: PlacementReason };
function wait(reason: PlacementReason): Refusal {
  return { kind: "wait", reason };
}
function matchesBinding(w: Worker, b: PlacementBinding): boolean {
  return (
    w.ownerPluginId === b.ownerPluginId &&
    w.providerId === b.providerId &&
    w.workerId === b.workerId &&
    w.accountId === b.accountId &&
    w.agentHostId === b.agentHostId &&
    w.generation === b.generation
  );
}
export function placementMemberIneligible(
  db: DbQueryConnection,
  op: Operation,
  w: Worker,
  purpose: WorkspacePurpose,
  routeRevision?: number,
): PlacementReason | null {
  const o = w.observation;
  if (op.providerId !== w.providerId) return "binding_changed";
  if (op.binding && !matchesBinding(w, op.binding)) return "binding_changed";
  if (
    op.requestedSelection?.mode === "worker" &&
    op.requestedSelection.workerId !== w.workerId
  )
    return "binding_changed";
  if (!w.available || !o.connected) return "worker_offline";
  if (o.admission !== "enabled")
    return o.admission === "draining" ? "worker_draining" : "worker_disabled";
  if (o.auth !== "authenticated") return "auth_required";
  const policy = readSharedPolicy(db, w.ownerPluginId, o);
  if (!policy || policy.exclusion.status !== "excluded")
    return "worker_disabled";
  const execution = op.preparedExecution
    ? JSON.parse(op.preparedExecution)
    : null;
  if (
    policy.quota.block?.generation === w.generation &&
    (policy.quota.block.model === null ||
      execution?.model === policy.quota.block.model)
  )
    return policy.quota.block.kind === "auth"
      ? "auth_required"
      : "quota_blocked";
  if (
    o.qualification.tier !== purpose.kind ||
    (purpose.kind === "local-fixture" &&
      o.qualification.fixtureRunId !== purpose.fixtureRunId)
  )
    return "capability_mismatch";
  if (
    !op.resolvedWorkspaceId ||
    op.resolvedWorkspaceRevision === null ||
    !op.resolvedWorkspaceDigest
  )
    return "workspace_unavailable";
  const stored = db
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.workspaceBindingId, op.resolvedWorkspaceId),
        eq(workspaces.revision, op.resolvedWorkspaceRevision),
      ),
    )
    .get();
  if (!stored || !placementWorkspaceMatches(db, stored))
    return "workspace_unavailable";
  const descriptor = workspaceBindingSchema.parse(
    JSON.parse(stored.canonicalDescriptor),
  );
  if (op.threadId) {
    const thread = db
      .select({
        env: threads.environmentId,
        provider: threads.providerId,
        project: threads.projectId,
      })
      .from(threads)
      .where(eq(threads.id, op.threadId))
      .get();
    if (
      !thread ||
      thread.env !== descriptor.environmentId ||
      thread.provider !== op.providerId ||
      thread.project !== JSON.parse(stored.locationSnapshot).projectId
    )
      return "binding_changed";
  }
  const publishedRoute = w.observation.routes.find(
    (r) =>
      r.workspace.workspaceBindingId === op.resolvedWorkspaceId &&
      r.workspace.revision === op.resolvedWorkspaceRevision &&
      r.workspace.workspaceDigest === op.resolvedWorkspaceDigest &&
      (routeRevision === undefined || r.revision === routeRevision),
  );
  const route =
    publishedRoute && currentRoute(db, w.ownerPluginId, o, publishedRoute);
  if (
    !route ||
    (routeRevision !== undefined && route.revision !== routeRevision)
  )
    return "unsupported_tool_route";
  if (
    route.agent.hostId !== w.agentHostId ||
    route.agent.generation !== w.generation ||
    route.agent.providerVersion !== w.providerVersion
  )
    return "binding_changed";
  try {
    assertWorkspaceRoute({
      binding: descriptor,
      pinned: route.workspace,
      evidence: route,
      purpose,
    });
  } catch (e) {
    if (e instanceof WorkspaceRefusal) return e.code;
    throw e;
  }
  return null;
}
export function olderCompatible(
  db: DbQueryConnection,
  op: Operation,
  w: Worker,
  purpose: WorkspacePurpose,
  otherThanThread?: string,
) {
  const older = db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.ownerPluginId, op.ownerPluginId),
        eq(operations.providerId, op.providerId),
        lt(operations.acceptedSeq, op.acceptedSeq),
        otherThanThread === undefined
          ? undefined
          : sql`${operations.threadId} IS NOT ${otherThanThread}`,
        eq(operations.cancelRequested, false),
        inArray(operations.phase, [
          "pending",
          "accepted",
          "reserved",
          "creating",
          "queued",
        ]),
        sql`${operations.resolvedWorkspaceId} IS NOT NULL`,
        sql`(${operations.retryScheduleState} IS NULL OR ${operations.retryScheduleState} = 'queued')`,
        sql`(${operations.sendAt} IS NULL OR ${operations.sendAt} <= ${Date.now()})`,
        sql`(${operations.workerId} IS NULL OR ${operations.workerId} = ${w.workerId})`,
        sql`(${operations.requestedSelection} IS NULL OR json_extract(${operations.requestedSelection}, '$.mode') = 'auto' OR json_extract(${operations.requestedSelection}, '$.workerId') = ${w.workerId})`,
      ),
    )
    .orderBy(asc(operations.acceptedSeq))
    .all();
  return older.find(
    (candidate) =>
      placementMemberIneligible(db, candidate, w, purpose) === null &&
      queuedCandidateDue(db, candidate) &&
      (candidate.consentId === null ||
        db
          .select({ id: consents.id })
          .from(consents)
          .where(
            and(
              eq(consents.id, candidate.consentId),
              sql`${consents.revokedAt} IS NULL`,
              eq(consents.consumedByOperationId, candidate.id),
            ),
          )
          .get() !== undefined),
  );
}
function validateCandidate(db: DbQueryConnection, args: PlacementCandidate) {
  const op = readPlacementOperationRecord(db, args.operationId);
  if (
    !op ||
    op.cancelRequested ||
    op.revision !== args.expectedRevision ||
    [
      "failed",
      "completed",
      "refused",
      "cancelled",
      "cancel_requested",
      "unknown",
    ].includes(op.phase)
  )
    return wait("reconciliation_required");
  const owner = readPlacementOwner(db, op.providerId);
  if (
    !owner?.available ||
    owner.mode !== "managed" ||
    owner.ownerPluginId !== op.ownerPluginId ||
    owner.revision !== args.ownerRevision
  )
    return wait("owner_unavailable");
  if (op.retryScheduleState === "awaiting_scheduler")
    return wait("retry_scheduler_required");
  if (op.consentId) {
    const consent = db
      .select()
      .from(consents)
      .where(eq(consents.id, op.consentId))
      .get();
    if (
      !consent ||
      consent.revokedAt !== null ||
      consent.consumedByOperationId !== op.id
    )
      return wait("retry_consent_required");
  }
  const w = readPlacementWorker(db, op.ownerPluginId, args.workerId);
  if (!w || w.observationRevision !== args.workerRevision)
    return wait("reconciliation_required");
  const reason = placementMemberIneligible(
    db,
    op,
    w,
    args.purpose,
    args.routeEvidenceRevision,
  );
  if (reason) return wait(reason);
  return { kind: "valid" as const, op, w };
}
function queuedCandidateDue(db: DbQueryConnection, op: Operation) {
  if (op.phase !== "queued") return true;
  const pending = db
    .select({ row: queue })
    .from(attempts)
    .innerJoin(queue, eq(queue.id, attempts.queueId))
    .where(and(eq(attempts.op, op.id), isNull(attempts.request)))
    .all();
  return pending.some(
    ({ row }) =>
      nativeQueueReady(row, true) &&
      (op.kind !== "retry" || duePlacementRetry(db, op, row) !== null),
  );
}
function nativeQueueReady(
  queued: typeof queue.$inferSelect,
  includeClaimed = false,
) {
  const now = Date.now();
  if (
    (queued.sendAt !== null && queued.sendAt > now) ||
    (queued.editHeldUntil !== null && queued.editHeldUntil > now)
  )
    return false;
  const dueWait = hasTimeWait(queued) && queued.sendAt !== null;
  if (queued.waitingOn !== null && !dueWait) return false;
  if (queued.state === "claimed")
    return (
      includeClaimed && queued.claimToken !== null && queued.claimedAt !== null
    );
  if (queued.claimToken !== null || queued.claimedAt !== null) return false;
  return (
    (queued.state === "queued" && queued.waitingOn === null) ||
    (queued.state === "scheduled" && dueWait)
  );
}

function unreservedQueueAttempt(db: DbQueryConnection, op: Operation) {
  if (
    (op.kind !== "continuation" && op.kind !== "retry") ||
    op.phase !== "queued" ||
    !op.binding ||
    !op.threadId ||
    op.fence !== null ||
    op.reservationId !== null ||
    op.clientTurnRequestId !== null ||
    !op.queuedMessageId
  )
    return null;
  const row = db
    .select()
    .from(queue)
    .where(eq(queue.id, op.queuedMessageId))
    .get();
  if (
    !row ||
    row.threadId !== op.threadId ||
    (op.kind === "retry"
      ? !duePlacementRetry(db, op, row)
      : row.payloadKind !== "inline") ||
    row.placementOperationId !== op.id ||
    !nativeQueueReady(row)
  )
    return null;
  const links = readPlacementQueueAttempts(db, row.id);
  const attempt = links[0];
  if (
    links.length !== 1 ||
    !attempt ||
    attempt.op !== op.id ||
    attempt.attempt !== 0 ||
    attempt.request !== null ||
    attempt.queueDigest !== queueMemberDigest(row)
  )
    return null;
  return row;
}
export function reservePlacementWorker(
  db: DbConnection,
  args: PlacementCandidate,
) {
  return db.transaction(
    (tx) => {
      const checked = validateCandidate(tx, args);
      if (checked.kind !== "valid") return checked;
      const { op, w } = checked;
      if (
        op.phase === "reserved" &&
        w.ownerOperationId === op.id &&
        op.fence === w.fence
      )
        return {
          kind: "reserved" as const,
          operation: placementOperationProjection(op),
          fence: w.fence,
        };
      const pendingAttempt = unreservedQueueAttempt(tx, op);
      if (!["pending", "accepted"].includes(op.phase) && !pendingAttempt)
        return wait("reconciliation_required");
      const continuingResident =
        (op.kind === "continuation" || op.kind === "retry") &&
        op.threadId !== null &&
        op.threadId === w.threadId &&
        w.slotState === "resident";
      if (w.slotState !== "free" && !continuingResident)
        return wait(
          w.slotState === "unknown" ? "custody_unknown" : "selected_busy",
        );
      if (continuingResident) {
        const donor =
          w.ownerOperationId &&
          readPlacementOperationRecord(tx, w.ownerOperationId);
        if (!donor || donor.phase !== "completed" || donor.cancelRequested)
          return wait("reconciliation_required");
      }
      const custody = w.nativeCustody;
      if (
        !custody ||
        (continuingResident
          ? custody.status !== "held" ||
            custody.holder?.fence !== w.fence ||
            custody.holder.threadId !== w.threadId ||
            canonicalJsonBytes(custody.lock) !== canonicalJsonBytes(w.fenceLock)
          : custody.status !== "free") ||
        !custody.lock ||
        custody.agentHostId !== w.agentHostId ||
        custody.generation !== w.generation
      )
        return wait("custody_unknown");
      if (olderCompatible(tx, op, w, args.purpose)) return wait("all_busy");
      if (
        !op.resolvedWorkspaceId ||
        op.resolvedWorkspaceRevision === null ||
        !op.resolvedWorkspaceDigest
      )
        return wait("workspace_unavailable");
      const binding: PlacementBinding = {
        ownerPluginId: w.ownerPluginId,
        providerId: w.providerId,
        accountId: w.accountId,
        workerId: w.workerId,
        agentHostId: w.agentHostId,
        generation: w.generation,
        workspace: {
          workspaceBindingId: op.resolvedWorkspaceId,
          revision: op.resolvedWorkspaceRevision,
          workspaceDigest: op.resolvedWorkspaceDigest,
        },
      };
      const pinned = op.threadId
        ? readPlacementThreadBinding(tx, op.threadId)
        : null;
      if (pinned && canonicalJsonBytes(pinned) !== canonicalJsonBytes(binding))
        return wait("binding_changed");
      if ((op.kind === "continuation" || op.kind === "retry") && !pinned)
        return wait("reconciliation_required");
      const fence = continuingResident ? w.fence : w.fence + 1;
      if (pendingAttempt?.payloadKind === "inline")
        tx.update(queue)
          .set({ placementFence: fence })
          .where(eq(queue.id, pendingAttempt.id))
          .run();
      const counter = tx
        .update(counters)
        .set({ allocationSeq: sql`${counters.allocationSeq}+1` })
        .where(eq(counters.id, 1))
        .returning()
        .get();
      tx.update(workers)
        .set({
          slotState: "reserved",
          ownerOperationId: op.id,
          threadId: op.threadId,
          fence,
          fenceLock: custody.lock,
          lastAssignedSeq: counter.allocationSeq,
        })
        .where(
          and(
            eq(workers.ownerPluginId, w.ownerPluginId),
            eq(workers.workerId, w.workerId),
          ),
        )
        .run();
      const row = tx
        .update(operations)
        .set({
          binding,
          workerId: w.workerId,
          phase: pendingAttempt ? "queued" : "reserved",
          reason: null,
          reservationId: randomUUID(),
          fence,
          revision: op.revision + 1,
          updatedAt: Date.now(),
        })
        .where(eq(operations.id, op.id))
        .returning()
        .get();
      return {
        kind: "reserved" as const,
        operation: placementOperationProjection(row),
        fence,
      };
    },
    { behavior: "immediate" },
  );
}
export function admitPlacementDispatch(
  tx: DbTransaction,
  args: PlacementCandidate & { fence: number; queuedMessageId: string },
) {
  const checked = validateCandidate(tx, args);
  if (checked.kind !== "valid") return checked;
  const { op, w } = checked;
  if (
    op.phase !== "queued" ||
    !op.binding ||
    !op.threadId ||
    op.queuedMessageId !== args.queuedMessageId ||
    op.fence !== args.fence ||
    w.fence !== args.fence ||
    w.ownerOperationId !== op.id ||
    !["reserved", "resident"].includes(w.slotState)
  )
    return wait("reconciliation_required");
  const queued = tx
    .select()
    .from(queue)
    .where(eq(queue.id, args.queuedMessageId))
    .get();
  if (
    !queued ||
    queued.placementOperationId !== op.id ||
    queued.placementFence !== args.fence ||
    queued.threadId !== op.threadId
  )
    return wait("reconciliation_required");
  const custody = w.nativeCustody;
  if (
    !custody ||
    custody.status === "unknown" ||
    custody.workerId !== w.workerId ||
    custody.agentHostId !== w.agentHostId ||
    custody.generation !== w.generation ||
    !custody.lock ||
    canonicalJsonBytes(custody.lock) !== canonicalJsonBytes(w.fenceLock) ||
    (custody.status === "held" &&
      (custody.holder?.fence !== w.fence ||
        custody.holder.threadId !== op.threadId))
  )
    return wait("custody_unknown");
  if (op.sendAt !== null && op.sendAt > Date.now())
    return wait("retry_scheduler_required");
  const pinned = readPlacementThreadBinding(tx, op.threadId);
  if (!pinned || canonicalJsonBytes(pinned) !== canonicalJsonBytes(op.binding))
    return wait("binding_changed");
  if (!nativeQueueReady(queued)) return wait("native_queue_wait");
  const row = tx
    .update(operations)
    .set({
      phase: "admitted",
      revision: op.revision + 1,
      updatedAt: Date.now(),
    })
    .where(eq(operations.id, op.id))
    .returning()
    .get();
  tx.update(workers)
    .set({ slotState: "active" })
    .where(
      and(
        eq(workers.ownerPluginId, w.ownerPluginId),
        eq(workers.workerId, w.workerId),
      ),
    )
    .run();
  return {
    kind: "admitted" as const,
    operation: placementOperationProjection(row),
  };
}
export function recordPlacementRuntimeState(
  db: DbConnection,
  args: {
    ownerPluginId: string;
    workerId: string;
    operationId: string;
    fence: number;
    activity: "idle" | "active" | "unknown";
    backgroundWork: boolean;
    pendingInteraction: boolean;
    custody: WorkerCustody;
  },
) {
  const custody = workerCustodySchema.parse(args.custody);
  return db.transaction(
    (tx) => {
      const w = readPlacementWorker(tx, args.ownerPluginId, args.workerId);
      const op = readPlacementOperationRecord(tx, args.operationId);
      if (
        !w ||
        !op ||
        w.ownerOperationId !== op.id ||
        w.fence !== args.fence ||
        !["active", "resident"].includes(w.slotState)
      )
        return wait("reconciliation_required");
      if (
        custody.workerId !== w.workerId ||
        custody.agentHostId !== w.agentHostId ||
        custody.generation !== w.generation ||
        custody.revision <= (w.nativeCustody?.revision ?? 0)
      )
        return wait("binding_changed");
      if (!recordCustodyFact(tx, w.ownerPluginId, w.providerId, custody))
        return wait("custody_unknown");
      const held =
        custody.status === "held" &&
        (w.nativeCustody?.status !== "held" ||
          canonicalJsonBytes(custody.holder) ===
            canonicalJsonBytes(w.nativeCustody.holder)) &&
        custody.holder?.fence === w.fence &&
        custody.holder.threadId === w.threadId &&
        custody.lock?.device === w.fenceLock?.device &&
        custody.lock?.inode === w.fenceLock?.inode;
      const unresolved = tx
        .select({ request: effects.request })
        .from(effects)
        .where(
          and(
            eq(effects.executionOwnerOperationId, op.id),
            eq(effects.fence, w.fence),
            inArray(effects.state, ["prepared", "possibly_sent"]),
          ),
        )
        .get();
      const state =
        !held || args.activity === "unknown"
          ? "unknown"
          : args.activity === "idle" &&
              !unresolved &&
              !args.backgroundWork &&
              !args.pendingInteraction
            ? "resident"
            : "active";
      tx.update(workers)
        .set({ slotState: state, nativeCustody: custody })
        .where(
          and(
            eq(workers.ownerPluginId, w.ownerPluginId),
            eq(workers.workerId, w.workerId),
          ),
        )
        .run();
      tx.update(operations)
        .set({
          phase:
            state === "resident"
              ? "completed"
              : state === "active"
                ? "active"
                : "unknown",
          revision: op.revision + 1,
          updatedAt: Date.now(),
        })
        .where(eq(operations.id, op.id))
        .run();
      return { kind: "observed" as const, state };
    },
    { behavior: "immediate" },
  );
}
export function beginPlacementReclaim(
  db: DbConnection,
  args: PlacementCandidate & {
    expectedSourceFence: number;
    expectedSourceOperationId: string;
  },
) {
  return db.transaction(
    (tx) => {
      const checked = validateCandidate(tx, args);
      if (checked.kind !== "valid") return checked;
      const { op, w } = checked;
      if (
        w.slotState !== "resident" ||
        ((op.kind === "continuation" || op.kind === "retry") &&
          op.threadId === w.threadId) ||
        w.fence !== args.expectedSourceFence ||
        w.ownerOperationId !== args.expectedSourceOperationId ||
        !w.ownerOperationId ||
        !w.threadId ||
        (!["accepted", "pending"].includes(op.phase) &&
          !unreservedQueueAttempt(tx, op))
      )
        return wait("selected_busy");
      const source = readPlacementOperationRecord(tx, w.ownerOperationId);
      if (
        !source ||
        source.phase !== "completed" ||
        w.nativeCustody?.status !== "held" ||
        w.nativeCustody.holder?.fence !== w.fence ||
        w.nativeCustody.holder.threadId !== w.threadId
      )
        return wait("custody_unknown");
      if (olderCompatible(tx, op, w, args.purpose)) return wait("all_busy");
      tx.update(workers)
        .set({
          slotState: "reclaiming",
          reclaimOperationId: op.id,
          reclaimSourceFence: w.fence,
        })
        .where(
          and(
            eq(workers.ownerPluginId, w.ownerPluginId),
            eq(workers.workerId, w.workerId),
          ),
        )
        .run();
      return {
        kind: "reclaiming" as const,
        fence: w.fence,
        sourceOperationId: w.ownerOperationId,
      };
    },
    { behavior: "immediate" },
  );
}
export function beginCancelledPlacementRelease(
  db: DbConnection,
  args: {
    ownerPluginId: string;
    workerId: string;
    operationId: string;
    expectedFence: number;
  },
) {
  return db.transaction(
    (tx) => {
      const w = readPlacementWorker(tx, args.ownerPluginId, args.workerId),
        op = readPlacementOperationRecord(tx, args.operationId);
      if (
        !w ||
        !op?.cancelRequested ||
        w.ownerOperationId !== op.id ||
        w.fence !== args.expectedFence ||
        !["reserved", "resident", "active"].includes(w.slotState)
      )
        return wait("reconciliation_required");
      tx.update(workers)
        .set({
          slotState: "reclaiming",
          reclaimOperationId: op.id,
          reclaimSourceFence: w.fence,
        })
        .where(
          and(
            eq(workers.ownerPluginId, w.ownerPluginId),
            eq(workers.workerId, w.workerId),
          ),
        )
        .run();
      return { kind: "reclaiming" as const, fence: w.fence };
    },
    { behavior: "immediate" },
  );
}
export function finishPlacementReclaim(
  db: DbConnection,
  args: {
    ownerPluginId: string;
    workerId: string;
    operationId: string;
    fence: number;
    closedSourceOperationId: string | null;
    processClosed: boolean;
    observation: WorkerCustody;
  },
) {
  const observation = workerCustodySchema.parse(args.observation);
  return db.transaction(
    (tx) => {
      const w = readPlacementWorker(tx, args.ownerPluginId, args.workerId);
      if (
        !w ||
        w.slotState !== "reclaiming" ||
        w.fence !== args.fence ||
        w.reclaimSourceFence !== args.fence ||
        w.reclaimOperationId !== args.operationId
      )
        return wait("reconciliation_required");
      if (
        !args.processClosed ||
        !args.closedSourceOperationId ||
        w.ownerOperationId !== args.closedSourceOperationId ||
        observation.status !== "free" ||
        observation.workerId !== w.workerId ||
        observation.agentHostId !== w.agentHostId ||
        observation.generation !== w.generation ||
        !observation.lock ||
        !w.nativeCustody ||
        !w.fenceLock ||
        observation.lock.device !== w.fenceLock.device ||
        observation.lock.inode !== w.fenceLock.inode ||
        observation.revision <= w.nativeCustody.revision
      )
        return wait("custody_unknown");
      if (!recordCustodyFact(tx, w.ownerPluginId, w.providerId, observation))
        return wait("custody_unknown");
      tx.update(workers)
        .set({
          slotState: "free",
          ownerOperationId: null,
          threadId: null,
          reclaimOperationId: null,
          reclaimSourceFence: null,
          nativeCustody: observation,
          fenceLock: null,
        })
        .where(
          and(
            eq(workers.ownerPluginId, w.ownerPluginId),
            eq(workers.workerId, w.workerId),
          ),
        )
        .run();
      const op = w.ownerOperationId
        ? readPlacementOperationRecord(tx, w.ownerOperationId)
        : null;
      if (op?.cancelRequested)
        tx.update(operations)
          .set({
            phase: "cancelled",
            revision: op.revision + 1,
            updatedAt: Date.now(),
          })
          .where(eq(operations.id, op.id))
          .run();
      return { kind: "released" as const };
    },
    { behavior: "immediate" },
  );
}
