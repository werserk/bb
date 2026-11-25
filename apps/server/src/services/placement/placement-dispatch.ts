import {
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
import type { AppDeps } from "../../types.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";
import {
  assertThreadCreateRelationships,
  resolveCreateThreadVisibility,
} from "../threads/thread-create.js";
import { deriveTitleFallback } from "../threads/title-generation.js";

export type PlacementDispatchResult = "queued" | "refused" | "stale";

class QueueReceiptRefused extends Error {}

/**
 * Binds a reserved independent operation to a new native thread and records
 * its prepared input as that thread's ordinary queued message in one
 * transaction, so no thread exists without its receipt. Execution then
 * belongs to the native queue.
 */
export function dispatchReservedPlacement(
  deps: Pick<AppDeps, "db" | "hub">,
  operationId: string,
): PlacementDispatchResult {
  const record = readPlacementOperationRecord(deps.db, operationId);
  const receipt = readPlacementActionReceipt(deps.db, operationId);
  if (
    !record ||
    !receipt ||
    record.kind !== "independent" ||
    record.phase !== "reserved" ||
    record.fence === null ||
    record.preparedRequest === null ||
    record.preparedExecution === null ||
    receipt.submissionUuid === null
  )
    return "refused";
  const request = createThreadRequestSchema.parse(
    JSON.parse(record.preparedRequest),
  );
  if (request.environment.type !== "reuse") return "refused";
  const environmentId = request.environment.environmentId;
  const execution = resolvedThreadExecutionOptionsSchema.parse(
    JSON.parse(record.preparedExecution),
  );
  const relationships = assertThreadCreateRelationships(deps, request);
  const content = flattenPromptInputGroups(
    placementPreparedGroups(record.preparedRequest, record.kind),
  );
  const sectionId =
    request.sectionId && getThreadSectionById(deps.db, request.sectionId)
      ? request.sectionId
      : null;
  const fence = record.fence;
  const submissionUuid = receipt.submissionUuid;
  const authority = receipt.authority;
  try {
    return deps.db.transaction(
      (tx) => {
        const created: {
          thread?: ReturnType<typeof insertThreadInTransaction>;
        } = {};
        const attached = attachPlacementThread(tx, {
          operationId,
          fence,
          runtimeRootKey: `placement:${operationId}`,
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
            created.thread = thread;
          },
          onCommitted: () => {
            if (!created.thread) return;
            notifyThreadCreated(deps.hub, created.thread);
            emitPluginThreadCreated(created.thread);
          },
        });
        if (attached.kind !== "attached" || !created.thread)
          return attached.kind === "stale" ? "stale" : "refused";
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
              waitingOn: null,
              sendAt: null,
              payload: { kind: "inline" },
              systemNotice: null,
            });
          },
          onCommitted: () => deps.hub.notifyThread(target, ["queue-changed"]),
        });
        if (queued.kind !== "recorded") throw new QueueReceiptRefused();
        return "queued" as const;
      },
      { behavior: "immediate" },
    );
  } catch (error) {
    if (error instanceof QueueReceiptRefused) return "refused";
    throw error;
  }
}
