import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import {
  canonicalJsonBytes,
  sha256Digest,
  turnRequestEventDataSchema,
  placementPermissionProvenanceSchema,
  permissionModeSchema,
  placementAuthoritySchema,
  type PlacementAuthority,
  type PlacementPermissionProvenance,
  type TurnRequestEventData,
  type PromptInput,
} from "@bb/domain";
import type {
  DbConnection,
  DbTransaction,
  DbQueryConnection,
} from "../connection.js";
import {
  threads,
  events,
  queuedThreadMessages as queue,
  placementOperations as ops,
  placementActionIdentities as ids,
  placementRetryConsents as consents,
  placementRetryTargets as targets,
  placementGrantKeys as aliases,
  placementEffects as effects,
  placementAttempts as attempts,
} from "../schema.js";
import {
  queueMemberDigest,
  readPlacementActionReceipt,
} from "./placement-action-receipts.js";
import { createQueuedThreadMessageInTransaction } from "./queued-thread-messages.js";
import { PlacementDispatchConflictError } from "./placement-dispatch-errors.js";

function failure(
  db: DbQueryConnection,
  request: string,
  beforeSequence?: number,
) {
  const e = db.select().from(effects).where(eq(effects.request, request)).get();
  if (!e || !["refused", "failed_accepted", "refused_unsent"].includes(e.state))
    return null;
  const thread = db
    .select({ status: threads.status })
    .from(threads)
    .where(eq(threads.id, e.thread))
    .get();
  const latest = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, e.thread),
        eq(events.type, "client/turn/requested"),
        beforeSequence === undefined
          ? undefined
          : lt(events.sequence, beforeSequence),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (thread?.status !== "error" || latest?.id !== e.eventId) return null;
  const deferred = db.get(
    sql`SELECT 1 FROM events WHERE thread_id=${e.thread} AND type='client/turn/rejected' AND json_extract(data,'$.requestId')=${request} AND json_extract(data,'$.deferredToQueuedMessageId') IS NOT NULL`,
  );
  if (deferred) return null;
  const body = turnRequestEventDataSchema.parse(JSON.parse(latest.data));
  const members = db
    .select({
      op: attempts.op,
      step: attempts.step,
      attempt: attempts.attempt,
      authority: ids.authority,
      retryEscalation: sql<
        PlacementAuthority["escalation"]
      >`json_extract(${ops.retryDerivation}, '$.executionAuthority.escalation')`,
    })
    .from(attempts)
    .innerJoin(ids, eq(ids.op, attempts.op))
    .innerJoin(ops, eq(ops.id, attempts.op))
    .where(eq(attempts.request, request))
    .orderBy(asc(attempts.ordinal))
    .all();
  return {
    effect: e,
    body,
    members,
    digest: sha256Digest(
      canonicalJsonBytes([
        request,
        e.root,
        e.binding,
        e.execution,
        body,
        members.map(({ retryEscalation, ...member }) =>
          retryEscalation === null ? member : { ...member, retryEscalation },
        ),
      ]),
    ),
  };
}
export function currentPlacementRetryTarget(
  db: DbQueryConnection,
  consent: string,
  beforeSequence?: number,
) {
  const target = db
    .select()
    .from(targets)
    .where(eq(targets.consent, consent))
    .get();
  if (!target || !["held", "scheduled"].includes(target.state)) return null;
  const f = failure(db, target.failedRequest, beforeSequence);
  return f?.digest === target.groupDigest ? { target, ...f } : null;
}
// The native requested-event writer can call this after append. Only a newer
// committed request supersedes a target. No wall clock releases provider custody.
export function reconcileSupersededPlacementRetries(
  tx: DbTransaction,
  threadId: string,
) {
  const latest = tx
    .select({ seq: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (!latest) return;
  const older = tx
    .select({ id: targets.consent })
    .from(targets)
    .innerJoin(effects, eq(effects.request, targets.failedRequest))
    .innerJoin(events, eq(events.id, effects.eventId))
    .where(
      and(
        eq(effects.thread, threadId),
        lt(events.sequence, latest.seq),
        inArray(targets.state, ["held", "scheduled"]),
      ),
    )
    .all();
  for (const target of older) closePlacementRetry(tx, target.id, "superseded");
}
export function grantPlacementRetryConsent(
  db: DbConnection,
  args: {
    failedRequestId: string;
    failedOperationId: string;
    principalScope: string;
    submissionKey: string;
    permissionProvenance: PlacementPermissionProvenance;
  },
) {
  const provenance = placementPermissionProvenanceSchema.parse(
    args.permissionProvenance,
  );
  return db.transaction(
    (tx) => {
      const old = tx
        .select()
        .from(consents)
        .where(
          and(
            eq(consents.principalScope, args.principalScope),
            eq(consents.actionId, provenance.actionId),
          ),
        )
        .get();
      const alias = tx
        .select()
        .from(aliases)
        .where(
          and(
            eq(aliases.principal, args.principalScope),
            eq(aliases.transportKey, args.submissionKey),
          ),
        )
        .get();
      if (alias && alias.consent !== old?.id)
        return { kind: "conflict" } as const;
      const recordAlias = (id: string) =>
        tx
          .insert(aliases)
          .values({
            principal: args.principalScope,
            transportKey: args.submissionKey,
            consent: id,
          })
          .onConflictDoNothing()
          .run();
      if (old) {
        const target = tx
          .select()
          .from(targets)
          .where(eq(targets.consent, old.id))
          .get();
        if (
          target?.failedRequest !== args.failedRequestId ||
          old.failedOperationId !== args.failedOperationId
        )
          return { kind: "conflict" } as const;
        recordAlias(old.id);
        return { kind: "granted", consent: old } as const;
      }
      const f = failure(tx, args.failedRequestId);
      const op = tx
        .select()
        .from(ops)
        .where(eq(ops.id, args.failedOperationId))
        .get();
      if (
        !op?.binding ||
        !f ||
        !f.members.some((m) => m.op === op.id) ||
        op.cancelRequested ||
        op.clientTurnRequestId !== args.failedRequestId
      )
        return { kind: "refused" } as const;
      reconcileSupersededPlacementRetries(tx, f.effect.thread);
      const active = tx
        .select()
        .from(targets)
        .where(
          and(
            eq(targets.root, f.effect.root),
            inArray(targets.state, ["held", "scheduled", "spent"]),
          ),
        )
        .all();
      if (
        active.some(
          (t) =>
            t.failedRequest === args.failedRequestId || t.state !== "spent",
        )
      )
        return { kind: "refused" } as const;
      const consent = tx
        .insert(consents)
        .values({
          id: "consent_" + randomUUID(),
          actionId: provenance.actionId,
          principalScope: args.principalScope,
          submissionKey: args.submissionKey,
          failedOperationId: op.id,
          bindingDigest: sha256Digest(canonicalJsonBytes(op.binding)),
          failedPayloadDigest: op.payloadDigest,
          permissionProvenance: provenance,
        })
        .returning()
        .get();
      tx.insert(targets)
        .values({
          consent: consent.id,
          failedRequest: args.failedRequestId,
          root: f.effect.root,
          groupDigest: f.digest,
          state: "held",
        })
        .run();
      recordAlias(consent.id);
      return { kind: "granted", consent } as const;
    },
    { behavior: "immediate" },
  );
}
const retryScheduler = "provider-retry";
function envelope(
  f: NonNullable<ReturnType<typeof failure>>,
  grantActor: PlacementAuthority,
) {
  const original = placementAuthoritySchema.parse(
    JSON.parse(f.members[0]!.authority),
  );
  const priorEscalation = f.members[0]!.retryEscalation ?? original.escalation;
  const executionAuthority: PlacementAuthority = {
    principal: retryScheduler,
    actor: "system",
    initiator: "system",
    sender: null,
    origin: null,
    plugin: null,
    requestedBy: null,
    serviceTurn: f.body.serviceTurn ?? null,
    permission: permissionModeSchema.parse(f.body.execution.permissionMode),
    escalation:
      priorEscalation === "deny" || grantActor.escalation === "deny"
        ? "deny"
        : priorEscalation,
  };

  const accepted = f.effect.state === "failed_accepted";
  const groups: PromptInput[][] = accepted
    ? [
        [
          {
            type: "text",
            text: "Please continue.",
            mentions: [],
            visibility: "agent-only",
          },
        ],
      ]
    : (f.body.inputGroups ?? [f.body.input]).map((g) =>
        g.map((i) => ({ ...i, visibility: "agent-only" })),
      );
  const membership = (f.body.clientSubmissions ?? []).map((m) => ({
    ...m,
    inputGroupIndex: accepted ? 0 : m.inputGroupIndex,
  }));
  const input: PromptInput[] = accepted
    ? groups[0]!
    : f.body.input.map((block) => ({ ...block, visibility: "agent-only" }));
  return {
    input,
    executionAuthority,
    source: f.effect.request,
    root: f.effect.root,
    groups,
    membership,
    execution: f.body.execution,
  };
}
export function schedulePlacementRetry(
  db: DbConnection,
  args: { operationId: string; sendAt: number; scheduler: string },
) {
  if (args.scheduler !== retryScheduler || !Number.isSafeInteger(args.sendAt))
    return null;
  return db.transaction(
    (tx) => {
      const op = tx
        .select()
        .from(ops)
        .where(eq(ops.id, args.operationId))
        .get();
      if (!op?.consentId || !op.threadId || op.kind !== "retry") return null;
      const consent = tx
        .select()
        .from(consents)
        .where(eq(consents.id, op.consentId))
        .get();
      const target = tx
        .select()
        .from(targets)
        .where(eq(targets.consent, op.consentId))
        .get();
      if (
        !target ||
        !consent ||
        consent.consumedByOperationId !== op.id ||
        consent.failedOperationId !== op.failedOperationId ||
        consent.principalScope !== op.principalScope
      )
        return null;
      // A committed schedule is a durable receipt. Replaying it never wakes a
      // row, reopens a spent entitlement or needs the old failed turn to be current.
      if (target.state === "spent" || target.state === "scheduled") {
        return op.retryScheduleState === "queued" && op.sendAt === args.sendAt
          ? op.queuedMessageId
          : null;
      }
      if (
        target.state !== "held" ||
        op.cancelRequested ||
        consent.revokedAt !== null
      )
        return null;
      reconcileSupersededPlacementRetries(tx, op.threadId);
      const f = currentPlacementRetryTarget(tx, op.consentId);
      if (!f) return null;
      const action = readPlacementActionReceipt(tx, op.id)!;
      const env = envelope(f, action.authority);
      const row = createQueuedThreadMessageInTransaction(tx, {
        threadId: op.threadId,
        clientSubmissionId: action.submissionUuid!,
        placement: { operationId: op.id, fence: null },
        content: env.input,
        ...env.execution,
        permissionMode: permissionModeSchema.parse(
          env.execution.permissionMode,
        ),
        senderThreadId: env.executionAuthority.sender,
        origin: env.executionAuthority.origin,
        originPluginId: env.executionAuthority.plugin,
        requestedBy: env.executionAuthority.requestedBy,
        serviceTurn: env.executionAuthority.serviceTurn ?? undefined,
        waitingOn: { kind: "time" },
        sendAt: args.sendAt,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: f.effect.root,
          attempt: (f.body.retryAttempt ?? 1) + 1,
          reason: "manual",
        },
        systemNotice: null,
      });
      tx.insert(attempts)
        .values({
          op: op.id,
          step: 0,
          attempt: 0,
          queueId: row.id,
          queueOrdinal: 0,
          queueDigest: queueMemberDigest(row),
        })
        .run();
      tx.update(ops)
        .set({
          queuedMessageId: row.id,
          phase: "queued",
          reason: null,
          retryScheduleState: "queued",
          schedulerRevision: 1,
          sendAt: args.sendAt,
          retryDerivation: JSON.parse(canonicalJsonBytes(env)),
          revision: op.revision + 1,
        })
        .where(eq(ops.id, op.id))
        .run();
      tx.update(targets)
        .set({ state: "scheduled" })
        .where(eq(targets.consent, op.consentId))
        .run();
      return row.id;
    },
    { behavior: "immediate" },
  );
}
export function spendPlacementRetry(
  tx: DbTransaction,
  op: typeof ops.$inferSelect,
  row: typeof queue.$inferSelect,
  body: TurnRequestEventData,
  fence: number,
) {
  const current = tx
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, row.threadId),
        eq(events.type, "client/turn/requested"),
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  const f =
    op.consentId &&
    currentPlacementRetryTarget(tx, op.consentId, current?.sequence);
  const grant =
    op.consentId &&
    tx.select().from(consents).where(eq(consents.id, op.consentId)).get();
  if (
    !f ||
    f.target.state !== "scheduled" ||
    !grant ||
    grant.revokedAt !== null ||
    grant.consumedByOperationId !== op.id ||
    op.sendAt === null ||
    op.sendAt > Date.now() ||
    row.sendAt !== op.sendAt ||
    row.placementFence !== null ||
    row.id !== op.queuedMessageId ||
    row.retryOfTurnRequestId !== f.effect.root ||
    row.retryAttempt !== (f.body.retryAttempt ?? 1) + 1 ||
    body.retryAttempt !== row.retryAttempt ||
    body.initiator !== "system" ||
    body.senderThreadId !== null ||
    body.retryOfRequestId !== f.effect.root
  )
    throw new PlacementDispatchConflictError("retry target changed or not due");
  const env = envelope(f, readPlacementActionReceipt(tx, op.id)!.authority);
  if (
    canonicalJsonBytes(env) !== canonicalJsonBytes(op.retryDerivation) ||
    canonicalJsonBytes(env.input) !==
      canonicalJsonBytes(JSON.parse(row.content))
  )
    throw new PlacementDispatchConflictError("retry envelope changed");
  tx.update(queue)
    .set({ placementFence: fence })
    .where(eq(queue.id, row.id))
    .run();
  tx.update(targets)
    .set({ state: "spent" })
    .where(eq(targets.consent, f.target.consent))
    .run();
  return env;
}
export function closePlacementRetry(
  tx: DbTransaction,
  id: string,
  reason: "revoked" | "expired" | "superseded",
) {
  const target = tx.select().from(targets).where(eq(targets.consent, id)).get();
  if (!target || !["held", "scheduled"].includes(target.state)) return false;
  const c = tx
    .update(consents)
    .set({ revokedAt: Date.now() })
    .where(eq(consents.id, id))
    .returning()
    .get();
  tx.update(targets)
    .set({ state: reason })
    .where(eq(targets.consent, id))
    .run();
  if (c.consumedByOperationId) {
    tx.delete(queue)
      .where(eq(queue.placementOperationId, c.consumedByOperationId))
      .run();
    tx.update(ops)
      .set({
        phase: "cancelled",
        cancelRequested: true,
        revision: sql`${ops.revision}+1`,
      })
      .where(eq(ops.id, c.consumedByOperationId))
      .run();
  }
  return true;
}
export function revokePlacementRetryConsent(db: DbConnection, id: string) {
  return db.transaction((tx) => closePlacementRetry(tx, id, "revoked"), {
    behavior: "immediate",
  });
}
