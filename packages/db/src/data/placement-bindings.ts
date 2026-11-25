import { placementPreparedGroups } from "./placement-prepared-input.js";
import { PlacementDispatchConflictError } from "./placement-dispatch-errors.js";
import {
  queueMemberDigest,
  readPlacementActionReceipt,
} from "./placement-action-receipts.js";
import { placementAttempts } from "../schema.js";
import { clientSubmissionQueueId } from "@bb/domain";
import { and, eq } from "drizzle-orm";
import {
  flattenPromptInputGroups,
  promptInputSchema,
  canonicalWorkspaceBytes,
  workspaceBindingRef,
  workspaceBindingSchema,
  canonicalJsonBytes,
  placementBindingSchema,
  type WorkspaceBinding,
  placementPayloadSchema,
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
  projectSources,
  threads,
  queuedThreadMessages as queue,
} from "../schema.js";
import {
  readPlacementOperationRecord,
  placementOperationProjection,
} from "./placement-operations.js";
import { readPlacementWorker } from "./placement-workers.js";

function readWorkspaceLocation(
  db: DbQueryConnection,
  workspace: WorkspaceBinding,
) {
  const env = db
    .select({
      path: environments.path,
      hostId: environments.hostId,
      projectId: environments.projectId,
    })
    .from(environments)
    .where(eq(environments.id, workspace.environmentId))
    .get();
  if (
    !env?.path ||
    env.hostId !== workspace.hostId ||
    (workspace.projectId !== null && env.projectId !== workspace.projectId)
  )
    return null;
  const source =
    workspace.sourceId === null
      ? null
      : db
          .select({
            path: projectSources.path,
            hostId: projectSources.hostId,
            projectId: projectSources.projectId,
          })
          .from(projectSources)
          .where(eq(projectSources.id, workspace.sourceId))
          .get();
  if (
    workspace.sourceId !== null &&
    (!source?.path ||
      source.hostId !== env.hostId ||
      source.projectId !== env.projectId)
  )
    return null;
  return {
    environmentPath: env.path,
    sourcePath: source?.path ?? null,
    projectId: env.projectId,
  };
}

export function placementWorkspaceMatches(
  db: DbQueryConnection,
  snapshot: typeof workspaces.$inferSelect,
) {
  const workspace = workspaceBindingSchema.parse(
    JSON.parse(snapshot.canonicalDescriptor),
  );
  return (
    canonicalJsonBytes(readWorkspaceLocation(db, workspace)) ===
    snapshot.locationSnapshot
  );
}

function matchesForkSelection(
  bytes: string,
  workspace: WorkspaceBinding,
  path: string,
) {
  const { intent } = placementPayloadSchema.parse(JSON.parse(bytes));
  if (intent.kind !== "fork") return false;
  const request = intent.request;
  if (!request || typeof request !== "object" || Array.isArray(request))
    return false;
  const env = request.environment;
  if (env === undefined) return null;
  if (!env || typeof env !== "object" || Array.isArray(env)) return false;
  if (env.type === "reuse")
    return env.environmentId === workspace.environmentId;
  const ws = env.workspace;
  return (
    env.type === "host" &&
    env.hostId === workspace.hostId &&
    ws !== null &&
    typeof ws === "object" &&
    !Array.isArray(ws) &&
    ws.type === "unmanaged" &&
    ws.path === path
  );
}

export function preparePlacementOperation(
  db: DbConnection,
  args: {
    operationId: string;
    expectedRevision: number;
    workspace: WorkspaceBinding;
    rootResolution?: {
      hostId: string;
      environmentId: string;
      environmentPath: string;
      canonicalRoot: string;
    };
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
      const location = readWorkspaceLocation(tx, args.workspace);
      if (!location) return { kind: "conflict" as const };
      const resolution = args.rootResolution;
      if (
        location.environmentPath !== args.workspace.canonicalRoot &&
        (!resolution ||
          resolution.hostId !== args.workspace.hostId ||
          resolution.environmentId !== args.workspace.environmentId ||
          resolution.environmentPath !== location.environmentPath ||
          resolution.canonicalRoot !== args.workspace.canonicalRoot)
      )
        return { kind: "conflict" as const };
      const locationSnapshot = canonicalJsonBytes(location);
      const sourceWorkspace =
        op.binding?.workspace.workspaceDigest === ref.workspaceDigest;
      if (op.kind === "continuation" && !sourceWorkspace)
        return { kind: "conflict" as const };
      if (
        op.kind === "fork" &&
        !(
          matchesForkSelection(
            op.canonicalRequest,
            args.workspace,
            location.environmentPath,
          ) ?? sourceWorkspace
        )
      )
        return { kind: "conflict" as const };
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
      if (
        old &&
        (old.canonicalDescriptor !== descriptor ||
          old.locationSnapshot !== locationSnapshot)
      )
        return { kind: "conflict" as const };
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
      if (!old)
        tx.insert(workspaces)
          .values({ ...ref, canonicalDescriptor: descriptor, locationSnapshot })
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
    .select({
      id: threads.id,
      providerId: threads.providerId,
      projectId: threads.projectId,
      environmentId: environments.id,
      workspaceHostId: environments.hostId,
      environmentProjectId: environments.projectId,
      preparingOperation: environments.ownerPlacementOperationId,
    })
    .from(threads)
    .innerJoin(environments, eq(environments.id, threads.environmentId))
    .where(eq(threads.id, op.reservedThreadId))
    .get();
  const snapshot = tx
    .select()
    .from(workspaces)
    .where(
      and(
        eq(workspaces.workspaceBindingId, binding.workspace.workspaceBindingId),
        eq(workspaces.revision, binding.workspace.revision),
        eq(workspaces.workspaceDigest, binding.workspace.workspaceDigest),
      ),
    )
    .get();
  const workspace =
    snapshot &&
    workspaceBindingSchema.parse(JSON.parse(snapshot.canonicalDescriptor));
  const preparing = readPlacementPreparingEnvironment(tx, op.id);
  if (
    !thread ||
    !workspace ||
    !snapshot ||
    !placementWorkspaceMatches(tx, snapshot) ||
    thread.providerId !== binding.providerId ||
    thread.environmentId !== workspace.environmentId ||
    thread.workspaceHostId !== workspace.hostId ||
    thread.projectId !== thread.environmentProjectId ||
    (workspace.projectId !== null &&
      workspace.projectId !== thread.projectId) ||
    (preparing && preparing.id !== thread.environmentId) ||
    (thread.preparingOperation !== null && thread.preparingOperation !== op.id)
  )
    throw new Error(
      "Placement thread insertion must retain its provider and prepared Workspace",
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
    queuedMessageId?: string;
    insertQueue: (
      tx: DbTransaction,
      identity: { operationId: string; fence: number },
    ) => string | void;
    onCommitted: () => void;
  },
) {
  const op = readPlacementOperationRecord(tx, args.operationId);
  if (
    !op ||
    op.cancelRequested ||
    !op.binding ||
    !op.threadId ||
    (op.fence !== args.fence &&
      !(op.kind === "continuation" && op.fence === null)) ||
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
    (w.ownerOperationId !== op.id &&
      !(
        op.kind === "continuation" &&
        w.threadId === op.threadId &&
        w.ownerOperationId &&
        op.preparedExecution
      )) ||
    w.fence !== args.fence ||
    !["reserved", "resident", "active"].includes(w.slotState)
  )
    return { kind: "stale" as const };
  const receipt = readPlacementActionReceipt(tx, op.id);
  if (!receipt || (!receipt.protocol && !receipt.submissionUuid))
    throw new Error("Missing action identity");
  const expected = receipt.submissionUuid
    ? clientSubmissionQueueId(receipt.submissionUuid)
    : null;
  const actual =
    args.insertQueue(tx, { operationId: op.id, fence: args.fence }) ??
    args.queuedMessageId;
  if (
    !actual ||
    (expected !== null && actual !== expected) ||
    (args.queuedMessageId && actual !== args.queuedMessageId)
  )
    throw new Error("Wrong placement queue identity");
  const row = tx.select().from(queue).where(eq(queue.id, actual)).get();
  if (
    !row ||
    (receipt.protocol &&
      (row.payloadKind !== "questionResponse" ||
        row.questionId !== receipt.protocol.questionId ||
        row.questionRevision !== receipt.protocol.revision)) ||
    row.threadId !== op.threadId ||
    row.placementOperationId !== op.id ||
    row.placementFence !== args.fence
  )
    throw new Error(
      "Placement queue insertion must persist the exact operation/thread/fence",
    );
  if (!receipt.protocol) {
    if (op.kind === "retry" || row.payloadKind !== "inline")
      throw new PlacementDispatchConflictError(
        "invalid first ordinary transfer",
      );
    const prepared = placementPreparedGroups(op.preparedRequest, op.kind);
    const actualBlocks = promptInputSchema
      .array()
      .parse(JSON.parse(row.content));
    if (
      canonicalJsonBytes(flattenPromptInputGroups(prepared)) !==
      canonicalJsonBytes(actualBlocks)
    )
      throw new PlacementDispatchConflictError(
        "ordinary input differs from preparation",
      );
  }
  tx.insert(placementAttempts)
    .values({
      op: op.id,
      step: receipt.steps.at(-1)!.step,
      attempt: 0,
      queueId: row.id,
      queueDigest: queueMemberDigest(row),
      queueOrdinal: 0,
    })
    .run();
  const saved = tx
    .update(operations)
    .set({
      queuedMessageId: row.id,

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
