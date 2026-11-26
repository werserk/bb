import { and, eq } from "drizzle-orm";
import {
  canonicalWorkspaceBytes,
  workspaceBindingRef,
  canonicalJsonBytes,
  placementBindingSchema,
  type WorkspaceBinding,
  type PlacementBinding,
  type JsonValue,
  type ResolvedThreadExecutionOptions,
  resolvedThreadExecutionOptionsSchema,
} from "@bb/domain";
import {
  afterCommit,
  type DbConnection,
  type DbQueryConnection,
  type DbTransaction,
} from "../connection.js";
import {
  placementWorkspaces as workspaces,
  placementOperations as operations,
  placementBindings as bindings,
  placementWorkers as workers,
  environments,
  threads,
  queuedThreadMessages as queue,
} from "../schema.js";
import {
  readPlacementOperationRecord,
  placementOperationProjection,
} from "./placement-operations.js";
import { readPlacementWorker } from "./placement-workers.js";

export function preparePlacementOperation(
  db: DbConnection,
  args: {
    operationId: string;
    expectedRevision: number;
    workspace: WorkspaceBinding;
    preparedRequest: JsonValue;
    preparedExecution: ResolvedThreadExecutionOptions;
    attachmentReceipts: JsonValue;
  },
) {
  const descriptor = canonicalWorkspaceBytes(args.workspace),
    ref = workspaceBindingRef(args.workspace);
  const preparedRequest = canonicalJsonBytes(args.preparedRequest),
    preparedExecution = canonicalJsonBytes(
      resolvedThreadExecutionOptionsSchema.parse(args.preparedExecution),
    ),
    attachmentReceipts = canonicalJsonBytes(args.attachmentReceipts);
  return db.transaction(
    (tx) => {
      const op = readPlacementOperationRecord(tx, args.operationId);
      if (
        !op ||
        op.cancelRequested ||
        op.kind === "retry" ||
        !["accepted", "materializing", "pending"].includes(op.phase)
      )
        return { kind: "refused" as const };
      if (op.preparedRequest !== null)
        return op.preparedRequest === preparedRequest &&
          op.preparedExecution === preparedExecution &&
          op.attachmentReceipts === attachmentReceipts &&
          op.resolvedWorkspaceDigest === ref.workspaceDigest
          ? {
              kind: "prepared" as const,
              operation: placementOperationProjection(op),
            }
          : { kind: "conflict" as const };
      if (op.revision !== args.expectedRevision)
        return { kind: "stale" as const };
      const old = tx
        .select()
        .from(workspaces)
        .where(
          and(
            eq(workspaces.workspaceBindingId, ref.workspaceBindingId),
            eq(workspaces.revision, ref.revision),
          ),
        )
        .get();
      if (old && old.canonicalDescriptor !== descriptor)
        return { kind: "conflict" as const };
      if (!old)
        tx.insert(workspaces)
          .values({ ...ref, canonicalDescriptor: descriptor })
          .run();
      const row = tx
        .update(operations)
        .set({
          preparedRequest,
          preparedExecution,
          attachmentReceipts,
          resolvedWorkspaceId: ref.workspaceBindingId,
          resolvedWorkspaceRevision: ref.revision,
          resolvedWorkspaceDigest: ref.workspaceDigest,
          phase: "pending",
          revision: op.revision + 1,
          updatedAt: Date.now(),
        })
        .where(eq(operations.id, op.id))
        .returning()
        .get();
      return {
        kind: "prepared" as const,
        operation: placementOperationProjection(row),
      };
    },
    { behavior: "immediate" },
  );
}
export function readPlacementThreadBinding(
  db: DbQueryConnection,
  threadId: string,
): PlacementBinding | null {
  const row = db
    .select()
    .from(bindings)
    .where(eq(bindings.threadId, threadId))
    .get();
  return row
    ? placementBindingSchema.parse({
        ownerPluginId: row.ownerPluginId,
        providerId: row.providerId,
        accountId: row.accountId,
        workerId: row.workerId,
        agentHostId: row.agentHostId,
        generation: row.generation,
        workspace: {
          workspaceBindingId: row.workspaceId,
          revision: row.workspaceRevision,
          workspaceDigest: row.workspaceDigest,
        },
      })
    : null;
}
export function attachPlacementThread(
  tx: DbTransaction,
  args: {
    operationId: string;
    fence: number;
    runtimeRootKey: string;
    sourceProviderThreadId: string | null;
    sourceCheckpoint: string | null;
    insertThread: (tx: DbTransaction, threadId: string) => void;
    onCommitted: () => void;
  },
) {
  const op = readPlacementOperationRecord(tx, args.operationId);
  if (!op?.binding || op.cancelRequested || op.fence !== args.fence)
    return { kind: "refused" as const };
  if (op.threadId && readPlacementThreadBinding(tx, op.threadId))
    return {
      kind: "attached" as const,
      operation: placementOperationProjection(op),
    };
  if (op.phase !== "reserved" || !op.reservedThreadId)
    return { kind: "refused" as const };
  const w = readPlacementWorker(
    tx,
    op.binding.ownerPluginId,
    op.binding.workerId,
  );
  if (
    !w ||
    w.fence !== args.fence ||
    w.ownerOperationId !== op.id ||
    w.slotState !== "reserved"
  )
    return { kind: "stale" as const };
  const binding = op.binding;
  args.insertThread(tx, op.reservedThreadId);
  const thread = tx
    .select({ id: threads.id })
    .from(threads)
    .where(eq(threads.id, op.reservedThreadId))
    .get();
  if (!thread)
    throw new Error(
      "Placement thread insertion did not persist the reserved identity",
    );
  tx.insert(bindings)
    .values({
      threadId: thread.id,
      ownerPluginId: binding.ownerPluginId,
      providerId: binding.providerId,
      accountId: binding.accountId,
      workerId: binding.workerId,
      agentHostId: binding.agentHostId,
      generation: binding.generation,
      workspaceId: binding.workspace.workspaceBindingId,
      workspaceRevision: binding.workspace.revision,
      workspaceDigest: binding.workspace.workspaceDigest,
      boundFromOperationId: op.id,
      runtimeRootKey: args.runtimeRootKey,
      sourceProviderThreadId: args.sourceProviderThreadId,
      sourceCheckpoint: args.sourceCheckpoint,
      createdAt: Date.now(),
    })
    .run();
  tx.update(environments)
    .set({ ownerPlacementOperationId: null, ownerThreadId: thread.id })
    .where(eq(environments.ownerPlacementOperationId, op.id))
    .run();
  tx.update(workers)
    .set({ threadId: thread.id })
    .where(
      and(
        eq(workers.ownerPluginId, binding.ownerPluginId),
        eq(workers.workerId, binding.workerId),
      ),
    )
    .run();
  const row = tx
    .update(operations)
    .set({
      threadId: thread.id,
      phase: "creating",
      revision: op.revision + 1,
      updatedAt: Date.now(),
    })
    .where(eq(operations.id, op.id))
    .returning()
    .get();
  afterCommit(tx, args.onCommitted);
  return {
    kind: "attached" as const,
    operation: placementOperationProjection(row),
  };
}
export function recordPlacementQueueReceipt(
  tx: DbTransaction,
  args: {
    operationId: string;
    fence: number;
    queuedMessageId: string;
    requestId: string | null;
    insertQueue: (
      tx: DbTransaction,
      identity: { operationId: string; fence: number },
    ) => void;
    onCommitted: () => void;
  },
) {
  const op = readPlacementOperationRecord(tx, args.operationId);
  if (
    !op ||
    op.cancelRequested ||
    !op.binding ||
    !op.threadId ||
    op.fence !== args.fence ||
    op.retryScheduleState === "awaiting_scheduler"
  )
    return { kind: "refused" as const };
  if (op.queuedMessageId)
    return {
      kind: "recorded" as const,
      operation: placementOperationProjection(op),
    };
  const w = readPlacementWorker(
    tx,
    op.binding.ownerPluginId,
    op.binding.workerId,
  );
  if (
    !w ||
    w.ownerOperationId !== op.id ||
    w.fence !== args.fence ||
    !["reserved", "resident"].includes(w.slotState)
  )
    return { kind: "stale" as const };
  args.insertQueue(tx, { operationId: op.id, fence: args.fence });
  const row = tx
    .select()
    .from(queue)
    .where(eq(queue.id, args.queuedMessageId))
    .get();
  if (
    !row ||
    row.threadId !== op.threadId ||
    row.placementOperationId !== op.id ||
    row.placementFence !== args.fence
  )
    throw new Error(
      "Placement queue insertion must persist the exact operation/thread/fence",
    );
  const saved = tx
    .update(operations)
    .set({
      queuedMessageId: row.id,
      clientTurnRequestId: args.requestId,
      phase: "queued",
      revision: op.revision + 1,
      updatedAt: Date.now(),
    })
    .where(eq(operations.id, op.id))
    .returning()
    .get();
  afterCommit(tx, args.onCommitted);
  return {
    kind: "recorded" as const,
    operation: placementOperationProjection(saved),
  };
}
export function readPlacementPreparingEnvironment(
  db: DbQueryConnection,
  operationId: string,
) {
  return (
    db
      .select()
      .from(environments)
      .where(eq(environments.ownerPlacementOperationId, operationId))
      .get() ?? null
  );
}
export function claimPlacementPreparingEnvironment(
  tx: DbTransaction,
  args: { operationId: string; environmentId: string },
) {
  const op = readPlacementOperationRecord(tx, args.operationId);
  if (
    !op ||
    op.cancelRequested ||
    !["accepted", "materializing", "pending"].includes(op.phase) ||
    op.threadId
  )
    return { kind: "refused" as const };
  const environment = tx
    .select()
    .from(environments)
    .where(eq(environments.id, args.environmentId))
    .get();
  if (
    !environment ||
    environment.ownerThreadId ||
    (environment.ownerPlacementOperationId &&
      environment.ownerPlacementOperationId !== op.id)
  )
    return { kind: "conflict" as const };
  const old = readPlacementPreparingEnvironment(tx, op.id);
  if (old && old.id !== environment.id) return { kind: "conflict" as const };
  tx.update(environments)
    .set({ ownerPlacementOperationId: op.id })
    .where(eq(environments.id, environment.id))
    .run();
  return { kind: "claimed" as const };
}
