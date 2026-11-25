import { createThreadId } from "../ids.js";
import { readPlacementThreadBinding } from "./placement-bindings.js";
import { randomUUID } from "node:crypto";
import { and, eq, or, sql } from "drizzle-orm";
import {
  canonicalJsonBytes,
  canonicalPlacementPayload,
  sha256Digest,
  placementPayloadSchema,
  placementOperationSchema,
  type PlacementOperation,
  type PlacementPayload,
  placementPermissionProvenanceSchema,
  type PlacementPermissionProvenance,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  placementOperations as operations,
  placementCounters as counters,
  placementRetryConsents as consents,
  placementOwners as owners,
  placementWorkers as workers,
} from "../schema.js";

export function placementOperationProjection(
  row: typeof operations.$inferSelect,
): PlacementOperation {
  return placementOperationSchema.parse({
    id: row.id,
    schemaVersion: row.schemaVersion,
    revision: row.revision,
    acceptedSeq: row.acceptedSeq,
    kind: row.kind,
    phase: row.phase,
    reason: row.reason,
    requestedSelection: row.requestedSelection,
    binding: row.binding,
    threadId: row.threadId,
    payloadDigest: row.payloadDigest,
    queueReceipt:
      row.queuedMessageId === null
        ? null
        : {
            queuedMessageId: row.queuedMessageId,
            requestId: row.clientTurnRequestId,
          },
    failedOperationId: row.failedOperationId,
    retrySchedule:
      row.retryScheduleState === null
        ? null
        : {
            state: row.retryScheduleState,
            sendAt: row.sendAt,
            schedulerRevision: row.schedulerRevision,
          },
    cancelRequested: row.cancelRequested,
  });
}
export function readPlacementOperation(
  db: DbQueryConnection,
  id: string,
): PlacementOperation | null {
  const row = db.select().from(operations).where(eq(operations.id, id)).get();
  return row ? placementOperationProjection(row) : null;
}
export function readPlacementOperationRecord(
  db: DbQueryConnection,
  id: string,
) {
  return (
    db.select().from(operations).where(eq(operations.id, id)).get() ?? null
  );
}
export type PlacementAcceptanceResult =
  | { kind: "accepted"; operation: PlacementOperation }
  | { kind: "conflict" }
  | {
      kind: "refused";
      reason:
        | "retry_consent_required"
        | "binding_changed"
        | "owner_unavailable";
    };
export function acceptPlacementOperation(
  db: DbConnection,
  args: {
    principalScope: string;
    submissionKey: string;
    ownerPluginId: string;
    providerId: string;
    request: PlacementPayload;
  },
): PlacementAcceptanceResult {
  const request = placementPayloadSchema.parse(args.request);
  const bytes = canonicalPlacementPayload(request);
  const digest = sha256Digest(bytes);
  return db.transaction(
    (tx) => {
      const old = tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.principalScope, args.principalScope),
            eq(operations.submissionKey, args.submissionKey),
          ),
        )
        .get();
      if (old)
        return old.payloadDigest === digest
          ? { kind: "accepted", operation: placementOperationProjection(old) }
          : { kind: "conflict" };
      const owner = tx
        .select()
        .from(owners)
        .where(eq(owners.providerId, args.providerId))
        .get();
      if (!owner || owner.ownerPluginId !== args.ownerPluginId)
        return { kind: "refused", reason: "owner_unavailable" };
      const intent = request.intent;
      const sourceRequest =
        intent.kind === "fork" &&
        typeof intent.request === "object" &&
        intent.request !== null &&
        !Array.isArray(intent.request)
          ? intent.request
          : null;
      const sourceThreadId =
        intent.kind === "continuation"
          ? intent.threadId
          : typeof sourceRequest?.sourceThreadId === "string"
            ? sourceRequest.sourceThreadId
            : null;
      const sourceBinding = sourceThreadId
        ? readPlacementThreadBinding(tx, sourceThreadId)
        : null;
      if (
        (intent.kind === "continuation" || intent.kind === "fork") &&
        (!sourceBinding ||
          sourceBinding.ownerPluginId !== args.ownerPluginId ||
          sourceBinding.providerId !== args.providerId)
      )
        return { kind: "refused", reason: "binding_changed" };
      const failed =
        intent.kind === "retry"
          ? readPlacementOperationRecord(tx, intent.failedOperationId)
          : null;
      const consent =
        intent.kind === "retry"
          ? tx
              .select()
              .from(consents)
              .where(eq(consents.id, intent.consentId))
              .get()
          : null;
      if (
        intent.kind === "retry" &&
        (!failed ||
          failed.phase !== "failed" ||
          !failed.binding ||
          failed.ownerPluginId !== args.ownerPluginId ||
          failed.providerId !== args.providerId ||
          !consent ||
          consent.failedOperationId !== failed.id ||
          consent.principalScope !== args.principalScope ||
          consent.revokedAt !== null ||
          consent.consumedByOperationId !== null ||
          consent.failedPayloadDigest !== failed.payloadDigest ||
          consent.bindingDigest !==
            sha256Digest(canonicalJsonBytes(failed.binding)))
      )
        return { kind: "refused", reason: "retry_consent_required" };
      tx.insert(counters).values({ id: 1 }).onConflictDoNothing().run();
      const counter = tx
        .update(counters)
        .set({ acceptedSeq: sql`${counters.acceptedSeq} + 1` })
        .where(eq(counters.id, 1))
        .returning()
        .get();
      const id = `plc_${randomUUID()}`;
      const now = Date.now();
      const row = tx
        .insert(operations)
        .values({
          id,
          principalScope: args.principalScope,
          submissionKey: args.submissionKey,
          ownerPluginId: args.ownerPluginId,
          providerId: args.providerId,
          acceptedSeq: counter.acceptedSeq,
          kind: intent.kind,
          requestedSelection:
            intent.kind === "independent" ? intent.selection : null,
          canonicalRequest: bytes,
          payloadDigest: digest,
          phase:
            intent.kind === "retry" || !owner.available
              ? "pending"
              : "accepted",
          reason:
            intent.kind === "retry"
              ? "retry_scheduler_required"
              : !owner.available
                ? "owner_unavailable"
                : null,
          reservedThreadId:
            intent.kind === "independent" || intent.kind === "fork"
              ? createThreadId()
              : null,
          threadId:
            intent.kind === "continuation"
              ? intent.threadId
              : (failed?.threadId ?? null),
          binding: failed?.binding ?? sourceBinding,
          workerId: failed?.workerId ?? sourceBinding?.workerId ?? null,
          preparedRequest: failed?.preparedRequest ?? null,
          preparedExecution: failed?.preparedExecution ?? null,
          attachmentReceipts: failed?.attachmentReceipts ?? null,
          resolvedWorkspaceId: failed?.resolvedWorkspaceId ?? null,
          resolvedWorkspaceRevision: failed?.resolvedWorkspaceRevision ?? null,
          resolvedWorkspaceDigest: failed?.resolvedWorkspaceDigest ?? null,
          failedOperationId: failed?.id ?? null,
          sourceOperationId: failed?.id ?? null,
          consentId: consent?.id ?? null,
          retryScheduleState:
            intent.kind === "retry" ? "awaiting_scheduler" : null,
          schedulerRevision: intent.kind === "retry" ? 0 : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
      if (consent)
        tx.update(consents)
          .set({ consumedByOperationId: id })
          .where(eq(consents.id, consent.id))
          .run();
      return { kind: "accepted", operation: placementOperationProjection(row) };
    },
    { behavior: "immediate" },
  );
}
export function cancelPlacementOperation(
  db: DbConnection,
  id: string,
): PlacementOperation | null {
  return db.transaction(
    (tx) => {
      const op = readPlacementOperationRecord(tx, id);
      if (
        !op ||
        op.cancelRequested ||
        ["completed", "cancelled", "refused"].includes(op.phase)
      )
        return op ? placementOperationProjection(op) : null;
      const held = tx
        .select({ id: workers.ownerOperationId })
        .from(workers)
        .where(eq(workers.ownerOperationId, id))
        .get();
      const row = tx
        .update(operations)
        .set({
          cancelRequested: true,
          phase: held || op.queuedMessageId ? "cancel_requested" : "cancelled",
          revision: op.revision + 1,
          updatedAt: Date.now(),
        })
        .where(eq(operations.id, id))
        .returning()
        .get();
      return placementOperationProjection(row);
    },
    { behavior: "immediate" },
  );
}
export function grantPlacementRetryConsent(
  db: DbConnection,
  args: {
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
            or(
              eq(consents.submissionKey, args.submissionKey),
              sql`json_extract(${consents.permissionProvenance}, '$.actionId') = ${provenance.actionId}`,
            ),
          ),
        )
        .all();
      if (old.length)
        return old.length === 1 &&
          old[0]!.permissionProvenance.actionId === provenance.actionId &&
          old[0]!.failedOperationId === args.failedOperationId
          ? { kind: "granted" as const, consent: old[0]! }
          : { kind: "conflict" as const };
      const failed = readPlacementOperationRecord(tx, args.failedOperationId);
      if (!failed?.binding || failed.phase !== "failed")
        return { kind: "refused" as const };
      const consent = tx
        .insert(consents)
        .values({
          id: `consent_${randomUUID()}`,
          principalScope: args.principalScope,
          submissionKey: args.submissionKey,
          failedOperationId: failed.id,
          bindingDigest: sha256Digest(canonicalJsonBytes(failed.binding)),
          failedPayloadDigest: failed.payloadDigest,
          permissionProvenance: provenance,
        })
        .returning()
        .get();
      return { kind: "granted" as const, consent };
    },
    { behavior: "immediate" },
  );
}
export function revokePlacementRetryConsent(db: DbConnection, id: string) {
  return db.transaction(
    (tx) =>
      tx
        .update(consents)
        .set({ revokedAt: sql`coalesce(${consents.revokedAt},${Date.now()})` })
        .where(eq(consents.id, id))
        .returning()
        .get() ?? null,
    { behavior: "immediate" },
  );
}
