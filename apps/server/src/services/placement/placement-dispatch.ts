import {
  InvalidLifecycleOwnerError,
  attachPlacementThread,
  createQueuedThreadMessageInTransaction,
  getThreadSectionById,
  insertThreadInTransaction,
  notifyThreadCreated,
  placementPreparedGroups,
  readPlacementActionReceipt,
  readPlacementOperationRecord,
  recordPlacementQueueReceipt,
} from "@bb/db";
import {
  clientSubmissionQueueId,
  flattenPromptInputGroups,
  resolvedThreadExecutionOptionsSchema,
} from "@bb/domain";
import { createThreadRequestSchema } from "@bb/server-contract";
import { ZodError } from "zod";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import {
  assertThreadCreateRelationships,
  resolveCreateThreadVisibility,
} from "../threads/thread-create.js";
import { seedThreadSessionOptionSelectionsInTransaction } from "../threads/thread-session-options.js";
import { deriveTitleFallback } from "../threads/title-generation.js";

export type PlacementDispatchResult =
  | { kind: "queued" }
  | { kind: "skipped" }
  | { kind: "retry"; reason: "runtime_root_unqualified" | "receipt_refused" }
  | { kind: "terminal"; reason: PlacementDispatchRefusal; error: string };

export type PlacementDispatchRefusal =
  | "binding_changed"
  | "workspace_unavailable"
  | "unsupported_preparation";

const PERMANENT_STATUSES = new Set([400, 403, 404, 410, 422]);

class QueueReceiptRefused extends Error {}

type DispatchDeps = Pick<AppDeps, "db" | "hub" | "placementRuntimeRootKey">;

/**
 * Binds a reserved independent operation to a new native pending thread and
 * records its prepared input as that thread's ordinary queued message in one
 * transaction, so no thread exists without its receipt. A retry keeps the
 * fenced reservation for the next wake; a terminal result keeps it too until
 * storage reconciles the unused reservation.
 */
export function dispatchReservedPlacement(
  deps: DispatchDeps,
  operationId: string,
): PlacementDispatchResult {
  const record = readPlacementOperationRecord(deps.db, operationId);
  const receipt = readPlacementActionReceipt(deps.db, operationId);
  if (
    !record ||
    !receipt ||
    record.kind !== "independent" ||
    record.phase !== "reserved" ||
    record.cancelRequested ||
    record.fence === null ||
    record.binding === null ||
    record.preparedRequest === null ||
    record.preparedExecution === null ||
    receipt.submissionUuid === null
  )
    return { kind: "skipped" };
  const binding = record.binding;
  const runtimeRootKey =
    deps.placementRuntimeRootKey?.({
      ownerPluginId: binding.ownerPluginId,
      providerId: binding.providerId,
      accountId: binding.accountId,
      agentHostId: binding.agentHostId,
      workerId: binding.workerId,
      generation: binding.generation,
    }) ?? null;
  if (runtimeRootKey === null)
    return { kind: "retry", reason: "runtime_root_unqualified" };
  try {
    return attachAndQueue(deps, operationId, runtimeRootKey);
  } catch (error) {
    if (error instanceof QueueReceiptRefused)
      return { kind: "retry", reason: "receipt_refused" };
    const reason = refusalOf(error);
    if (reason === null) throw error;
    return { kind: "terminal", reason, error: String(error) };
  }
}

function refusalOf(error: unknown): PlacementDispatchRefusal | null {
  if (error instanceof ApiError)
    return PERMANENT_STATUSES.has(error.status) ? "binding_changed" : null;
  if (error instanceof InvalidLifecycleOwnerError) return "binding_changed";
  if (error instanceof ZodError) return "unsupported_preparation";
  if (
    error instanceof Error &&
    error.message.startsWith("Placement thread insertion must retain")
  )
    return "workspace_unavailable";
  return null;
}

function attachAndQueue(
  deps: DispatchDeps,
  operationId: string,
  runtimeRootKey: string,
): PlacementDispatchResult {
  const record = readPlacementOperationRecord(deps.db, operationId)!;
  const receipt = readPlacementActionReceipt(deps.db, operationId)!;
  const request = createThreadRequestSchema.parse(
    JSON.parse(record.preparedRequest!),
  );
  if (request.environment.type !== "reuse")
    return {
      kind: "terminal",
      reason: "unsupported_preparation",
      error: "environment is not reuse",
    };
  const environmentId = request.environment.environmentId;
  const execution = resolvedThreadExecutionOptionsSchema.parse(
    JSON.parse(record.preparedExecution!),
  );
  const relationships = assertThreadCreateRelationships(deps, request);
  const content = flattenPromptInputGroups(
    placementPreparedGroups(record.preparedRequest, record.kind),
  );
  const sectionId =
    request.sectionId && getThreadSectionById(deps.db, request.sectionId)
      ? request.sectionId
      : null;
  const fence = record.fence!;
  const submissionUuid = receipt.submissionUuid!;
  const authority = receipt.authority;
  const sendAt = request.sendAt ?? null;
  return deps.db.transaction(
    (tx) => {
      const created: {
        thread?: ReturnType<typeof insertThreadInTransaction>;
      } = {};
      const attached = attachPlacementThread(tx, {
        operationId,
        fence,
        runtimeRootKey,
        sourceProviderThreadId: null,
        sourceCheckpoint: null,
        insertThread: (t, id) => {
          const thread = insertThreadInTransaction(t, id, {
            projectId: request.projectId,
            environmentId,
            providerId: record.providerId,
            title: request.title ?? null,
            titleFallback: deriveTitleFallback(content),
            sectionId,
            pinned: request.pinned ?? false,
            parentThreadId: relationships.hierarchyParentThreadId ?? null,
            sourceThreadId: relationships.sourceThread?.id ?? null,
            lifecycleOwnerThreadId: request.lifecycleOwnerThreadId,
            originKind: relationships.originKind,
            originPluginId: authority.plugin,
            pluginMetadata: relationships.pluginMetadata,
            visibility: resolveCreateThreadVisibility({
              parentThread: relationships.parentThread,
              requestedVisibility: request.visibility,
            }),
            parentNotifications: request.parentNotifications ?? "auto",
            status: "pending",
            startupContext: JSON.stringify({
              kind: "pending",
              environmentIntent: { type: "reuse", environmentId },
              fork: null,
              startedOnBehalfOf: request.startedOnBehalfOf ?? null,
              titleProvided: Boolean(request.title),
              execution,
            }),
          });
          seedThreadSessionOptionSelectionsInTransaction(t, {
            threadId: thread.id,
            environmentId,
            selections: request.sessionOptions ?? {},
          });
          created.thread = thread;
        },
        onCommitted: () => {
          if (!created.thread) return;
          notifyThreadCreated(deps.hub, created.thread);
          emitPluginThreadCreated(created.thread);
        },
      });
      if (attached.kind !== "attached" || !created.thread)
        return { kind: "skipped" as const };
      const target = created.thread.id;
      const queued = recordPlacementQueueReceipt(tx, {
        operationId,
        fence,
        queuedMessageId: clientSubmissionQueueId(submissionUuid),
        insertQueue: (t, identity) => {
          createQueuedThreadMessageInTransaction(t, {
            placement: identity,
            clientSubmissionId: submissionUuid,
            threadId: target,
            content,
            senderThreadId: authority.sender,
            origin: authority.origin,
            originPluginId: authority.plugin,
            requestedBy: authority.requestedBy,
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            permissionMode: execution.permissionMode,
            serviceTier: execution.serviceTier,
            waitingOn: sendAt === null ? null : { kind: "time" },
            sendAt,
            payload: { kind: "inline" },
            systemNotice: null,
          });
        },
        onCommitted: () => deps.hub.notifyThread(target, ["queue-changed"]),
      });
      if (queued.kind !== "recorded") throw new QueueReceiptRefused();
      return { kind: "queued" as const };
    },
    { behavior: "immediate" },
  );
}
