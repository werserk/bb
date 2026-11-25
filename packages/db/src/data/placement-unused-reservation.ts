import { and, eq } from "drizzle-orm";
import type { WorkerObservation } from "@bb/domain";
import type { DbConnection, DbTransaction } from "../connection.js";
import {
  placementEffects as effects,
  placementOperations as ops,
  placementWorkers as workers,
} from "../schema.js";
import { readPlacementOperationRecord } from "./placement-operations.js";
import {
  readPlacementOwner,
  readPlacementWorker,
} from "./placement-workers.js";
import { readPlacementQueueAttempts } from "./placement-action-receipts.js";
import { getQueuedThreadMessage } from "./queued-thread-messages.js";
import {
  physicalLockKey,
  foreignLockReport,
} from "./placement-source-facts.js";
import { readLinkedPlacementRejection } from "./placement-rejection.js";

export type UnusedPlacementReservationGuard = {
  workerId: string;
  operationId: string;
  expectedRevision: number;
  fence: number;
};

export function refuseReservedPlacement(
  db: DbConnection,
  args: {
    operationId: string;
    expectedRevision: number;
    fence: number;
    ownerRevision: number;
    reason:
      "workspace_unavailable" | "binding_changed" | "unsupported_preparation";
  },
) {
  return db.transaction(
    (tx) => {
      const op = readPlacementOperationRecord(tx, args.operationId);
      if (
        !op?.binding ||
        op.kind !== "independent" ||
        op.phase !== "reserved" ||
        op.cancelRequested ||
        op.revision !== args.expectedRevision ||
        op.fence !== args.fence ||
        op.threadId ||
        op.queuedMessageId ||
        op.clientTurnRequestId
      )
        return { kind: "stale" } as const;
      const owner = readPlacementOwner(tx, op.providerId);
      const worker = readPlacementWorker(
        tx,
        op.ownerPluginId,
        op.binding.workerId,
      );
      if (
        !owner?.available ||
        owner.mode !== "managed" ||
        owner.revision !== args.ownerRevision ||
        owner.ownerPluginId !== op.ownerPluginId ||
        worker?.slotState !== "reserved" ||
        worker.ownerOperationId !== op.id ||
        worker.fence !== args.fence
      )
        return { kind: "stale" } as const;
      tx.update(ops)
        .set({
          phase: "refused",
          reason: args.reason,
          revision: op.revision + 1,
          updatedAt: Date.now(),
        })
        .where(eq(ops.id, op.id))
        .run();
      return { kind: "refused" } as const;
    },
    { behavior: "immediate" },
  );
}

export function reconcileObservedUnusedReservation(
  tx: DbTransaction,
  old: typeof workers.$inferSelect,
  reported: WorkerObservation,
  guard: UnusedPlacementReservationGuard,
) {
  const c = reported.custody;
  if (
    !(old.slotState === "reserved" || old.slotState === "active") ||
    old.ownerOperationId !== guard.operationId ||
    old.fence !== guard.fence ||
    old.nativeCustody?.status !== "free" ||
    !old.nativeCustody.lock ||
    !old.fenceLock ||
    c.status !== "free" ||
    !c.lock ||
    c.workerId !== old.workerId ||
    c.agentHostId !== old.agentHostId ||
    c.generation !== old.generation ||
    c.revision <= old.nativeCustody.revision ||
    [c.lock, old.nativeCustody.lock, old.fenceLock].some(
      (lock) => physicalLockKey(c.agentHostId, lock) !== old.physicalLock,
    ) ||
    foreignLockReport(tx, old.ownerPluginId, old.providerId, c)
  )
    return;
  const op = readPlacementOperationRecord(tx, guard.operationId);
  if (
    !op?.binding ||
    op.kind !== "independent" ||
    op.revision !== guard.expectedRevision ||
    op.fence !== old.fence ||
    op.binding.workerId !== old.workerId ||
    op.threadId !== old.threadId ||
    op.binding.accountId !== reported.accountId ||
    op.binding.generation !== reported.generation ||
    op.binding.agentHostId !== reported.agentHostId ||
    op.binding.providerId !== reported.providerId ||
    op.binding.ownerPluginId !== old.ownerPluginId ||
    !op.reservedThreadId ||
    (op.threadId && op.threadId !== op.reservedThreadId)
  )
    return;
  const history = tx
    .select()
    .from(effects)
    .where(
      and(
        eq(effects.thread, op.reservedThreadId),
        eq(effects.fence, guard.fence),
      ),
    )
    .all();
  if (
    history.some(
      (effect) =>
        effect.state !== "refused_unsent" ||
        !readLinkedPlacementRejection(tx, effect),
    )
  )
    return;
  if (op.queuedMessageId && getQueuedThreadMessage(tx, op.queuedMessageId))
    return;
  if (old.slotState === "active") {
    if (
      !op.clientTurnRequestId ||
      !history.some(
        (e) =>
          e.request === op.clientTurnRequestId &&
          e.executionOwnerOperationId === op.id,
      ) ||
      !(op.phase === "admitted" || op.cancelRequested || op.phase === "refused")
    )
      return;
  } else {
    if (
      op.clientTurnRequestId ||
      history.length ||
      !(op.cancelRequested || (op.phase === "refused" && !op.threadId))
    )
      return;
    if (op.threadId) {
      if (!op.queuedMessageId) return;
      const links = readPlacementQueueAttempts(tx, op.queuedMessageId);
      if (
        links.length !== 1 ||
        links[0]!.op !== op.id ||
        links[0]!.request !== null
      )
        return;
    }
  }
  tx.update(workers)
    .set({
      slotState: "reclaiming",
      reclaimOperationId: op.id,
      reclaimSourceFence: old.fence,
      reclaimHolder: null,
    })
    .where(
      and(
        eq(workers.workerId, guard.workerId),
        eq(workers.ownerPluginId, op.ownerPluginId),
      ),
    )
    .run();
  tx.update(ops)
    .set({
      phase: op.cancelRequested ? "cancelled" : "refused",
      revision: op.revision + 1,
      updatedAt: Date.now(),
    })
    .where(eq(ops.id, op.id))
    .run();
  return true;
}
