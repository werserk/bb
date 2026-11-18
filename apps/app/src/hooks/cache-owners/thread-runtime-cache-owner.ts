import { prepareSendRequest } from "../mutations/mutation-request-types";
import { pendingSendGeneration } from "./pending-send-owner";
import {
  pendingSendOwner,
  refreshPendingSends,
  newPendingSend,
} from "./pending-send-owner";
import { cancelOptimisticQueries } from "./optimistic-query-cancellation";
import {
  beginThreadEntityPrediction,
  getThreadEntity,
  patchThreadEntity,
  type ThreadEntityPrediction,
} from "./thread-entity-store";
import type { QueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import type {
  Environment,
  PromptHistoryEntry,
  ThreadQueuedMessage,
  ThreadWithRuntime,
} from "@bb/domain";
import type {
  PromptHistoryResponse,
  SendMessageResponse,
  SendQueuedMessageResponse,
  SendQueuedMessageMode,
  ThreadQueuedMessageListResponse,
  ThreadResponse,
  ThreadTimelineResponse,
  TimelineConversationAttachments,
  TimelineUserConversationRow,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type { AppCreateThreadRequest } from "@bb/client-core";
import {
  OPTIMISTIC_TIMELINE_ROW_ID_PREFIX,
  shouldQueueFollowUpMessage,
} from "@bb/client-core";
import { collectPromptAttachments } from "@/lib/prompt-attachments";
import { prependPromptHistoryEntry } from "@/lib/prompt-history";
import {
  applyQueuedMessageReorder,
  collectLeadQueuedMessageGroupIds,
  preserveLeadQueuedMessageGroupAfterReorder,
  type QueuedMessageReorderRequest,
} from "@/lib/queued-message-reorder";
import type { SendThreadMessageMutationRequest } from "../mutations/mutation-request-types";
import { optimisticallyInsertThread } from "./query-cache";
import {
  environmentQueryKey,
  projectPromptHistoryQueryKey,
  projectSourceBranchesQueryKeyPrefix,
  threadPromptHistoryQueryKey,
  threadQueryKey,
  threadQueuedMessagesQueryKey,
  threadsQueryKey,
  threadTimelineQueryKey,
  threadTimelineQueryKeyPrefix,
} from "../queries/query-keys";
import {
  invalidateThreadAcceptedMessageQueriesWithoutRealtime,
  markThreadAcceptedMessageQueriesStale,
  invalidateProjectPromptHistoryQueries,
  invalidateThreadQueueQueries,
  invalidateThreadQueuedMessageSendQueries,
  invalidateThreadQueuedMessageStayedQueuedQueries,
  invalidateThreadListQueries,
  refetchThreadListsAfterComposerThreadCreate,
} from "./mutation-cache-effects";
import { readThreadBack } from "./thread-read-back";

interface ThreadIdCacheArgs {
  queryClient: QueryClient;
  threadId: string;
}

interface PrefetchThreadQueuedMessagesArgs extends ThreadIdCacheArgs {
  load: (signal: AbortSignal) => Promise<ThreadQueuedMessageListResponse>;
}

interface BeginCreateThreadTransactionArgs {
  queryClient: QueryClient;
}

interface CreateThreadSuccessArgs {
  queryClient: QueryClient;
  request: AppCreateThreadRequest;
  thread: ThreadResponse;
}

interface SendThreadMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
}

interface UpdateQueuedMessageRequestWithThreadId extends UpdateQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface UpdateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: UpdateQueuedMessageRequestWithThreadId;
}

interface RollbackUpdateQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: UpdateQueuedMessageRequestWithThreadId;
  transaction: UpdateQueuedMessageTransaction | undefined;
}

interface RemoveQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface SendQueuedMessageRequest extends RemoveQueuedMessageRequest {
  mode: SendQueuedMessageMode;
}

interface RemoveQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: RemoveQueuedMessageRequest;
}

interface SendQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
}

interface RollbackSendThreadMessageTransactionArgs {
  queryClient: QueryClient;
  request: SendThreadMessageMutationRequest;
  transaction: SendThreadMessageTransaction | undefined;
}

interface RollbackRemoveQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: RemoveQueuedMessageRequest;
  transaction: RemoveQueuedMessageTransaction | undefined;
}

interface ApplyQueuedMessageSendResultArgs {
  queryClient: QueryClient;
  request: SendQueuedMessageRequest;
  result: SendQueuedMessageResponse;
  transaction: RemoveQueuedMessageTransaction | undefined;
}

interface ApplySendThreadMessageSuccessArgs {
  queryClient: QueryClient;
  realtimeConnected: boolean;
  request: SendThreadMessageMutationRequest;
  result: SendMessageResponse;
  transaction: SendThreadMessageTransaction | undefined;
}

interface QueuedMessageResultArgs {
  queryClient: QueryClient;
  queuedMessage: ThreadQueuedMessage;
  threadId: string;
}

interface ReorderQueuedMessageRequest extends QueuedMessageReorderRequest {
  id: string;
}

interface SetQueuedMessageGroupBoundaryRequest {
  groupBoundaryQueuedMessageId: string;
  id: string;
}

interface ReorderQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: ReorderQueuedMessageRequest;
}

interface SetQueuedMessageGroupBoundaryTransactionArgs {
  queryClient: QueryClient;
  request: SetQueuedMessageGroupBoundaryRequest;
}

interface RollbackQueuedMessageTransactionArgs {
  queryClient: QueryClient;
  request: ReorderQueuedMessageRequest;
  transaction: ReorderQueuedMessageTransaction | undefined;
}

interface ApplyQueuedMessagesResultArgs {
  queryClient: QueryClient;
  queuedMessages: ThreadQueuedMessageListResponse;
  request: Pick<ReorderQueuedMessageRequest, "id">;
}

interface StopThreadTransactionArgs extends ThreadIdCacheArgs {
  requestedAt: number;
}

interface RollbackStopThreadTransactionArgs extends ThreadIdCacheArgs {
  transaction: StopThreadTransaction | undefined;
}

interface BuildAcceptedPromptHistoryEntryArgs {
  createdAt: number;
  input: PromptHistoryEntry["input"];
}

interface BuildOptimisticUserMessageRowParams {
  createdAt: number;
  input: SendThreadMessageMutationRequest["input"];
  mode: SendThreadMessageMutationRequest["mode"];
  threadId: string;
  threadStatus: ThreadWithRuntime["status"] | null;
}

type OptimisticTurnRequestKind = "message" | "steer";

interface OptimisticTurnRequestKindArgs {
  mode: SendThreadMessageMutationRequest["mode"];
  threadStatus: ThreadWithRuntime["status"] | null;
}

interface SendThreadMessageAcceptedTurnTransaction {
  kind: "accepted-turn";
  optimisticCreatedAt: number;
  optimisticRowId: string;
  generation: number;
  prediction: ThreadEntityPrediction | null;
}

interface SendThreadMessageQueuedTransaction {
  kind: "queued-message";
  optimisticCreatedAt: number;
  optimisticQueuedMessageId: string;
  previousThreadStatus: ThreadWithRuntime["status"] | null;
}

export type SendThreadMessageTransaction =
  | SendThreadMessageAcceptedTurnTransaction
  | SendThreadMessageQueuedTransaction;

export interface ReorderQueuedMessageTransaction {
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
}

export interface UpdateQueuedMessageTransaction {
  optimisticUpdatedAt: number | null;
  previousQueuedMessage: ThreadQueuedMessage | undefined;
}

export interface RemoveQueuedMessageTransaction {
  optimisticCreatedAt: number | null;
  optimisticQueueDataUpdateCount: number;
  optimisticRowId: string | null;
  sendGeneration?: number;
  prediction: ThreadEntityPrediction | null;
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
}

export interface StopThreadTransaction {
  prediction: ThreadEntityPrediction;
}

function buildAcceptedPromptHistoryEntry({
  createdAt,
  input,
}: BuildAcceptedPromptHistoryEntryArgs): PromptHistoryEntry {
  return {
    id: `optimistic-prompt-history:${nanoid()}`,
    createdAt,
    input,
  };
}

function applyQueuedMessageGroupBoundary({
  groupBoundaryQueuedMessageId,
  queuedMessages,
}: {
  groupBoundaryQueuedMessageId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
}): ThreadQueuedMessage[] {
  const boundaryIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === groupBoundaryQueuedMessageId,
  );
  if (boundaryIndex === -1) return [...queuedMessages];
  return queuedMessages.map((queuedMessage, index) => ({
    ...queuedMessage,
    groupWithNext: index < boundaryIndex,
  }));
}

function queuedMessageSendGroup(
  queuedMessages: readonly ThreadQueuedMessage[] | undefined,
  queuedMessageId: string,
): ThreadQueuedMessage[] {
  if (!queuedMessages) return [];
  const queuedMessageIndex = queuedMessages.findIndex(
    (queuedMessage) => queuedMessage.id === queuedMessageId,
  );
  if (queuedMessageIndex === -1) return [];
  if (queuedMessageIndex !== 0) return [queuedMessages[queuedMessageIndex]!];

  const group: ThreadQueuedMessage[] = [];
  for (const queuedMessage of queuedMessages) {
    group.push(queuedMessage);
    if (!queuedMessage.groupWithNext) break;
  }
  return group;
}

function removeQueuedMessagesAndRepairGroupEdges(
  queuedMessages: ThreadQueuedMessageListResponse | undefined,
  removeIds: ReadonlySet<string>,
): ThreadQueuedMessageListResponse | undefined {
  if (!queuedMessages) return queuedMessages;
  return queuedMessages.flatMap((queuedMessage, index) => {
    if (removeIds.has(queuedMessage.id)) return [];
    const nextQueuedMessage = queuedMessages[index + 1];
    if (
      nextQueuedMessage &&
      removeIds.has(nextQueuedMessage.id) &&
      queuedMessage.groupWithNext
    ) {
      return [{ ...queuedMessage, groupWithNext: false }];
    }
    return [queuedMessage];
  });
}

function restoreQueuedMessageSnapshotIfUnchanged({
  optimisticQueueDataUpdateCount,
  previousQueuedMessages,
  queryClient,
  threadId,
}: {
  optimisticQueueDataUpdateCount: number;
  previousQueuedMessages: ThreadQueuedMessageListResponse | undefined;
  queryClient: QueryClient;
  threadId: string;
}): boolean {
  const queryKey = threadQueuedMessagesQueryKey(threadId);
  if (
    queryClient.getQueryState(queryKey)?.dataUpdateCount !==
    optimisticQueueDataUpdateCount
  ) {
    return false;
  }
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    previousQueuedMessages ?? [],
  );
  return true;
}

function removeCachedQueuedMessage({
  queryClient,
  request,
}: RemoveQueuedMessageTransactionArgs): RemoveQueuedMessageTransaction {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      removeQueuedMessagesAndRepairGroupEdges(
        currentQueuedMessages,
        new Set([request.queuedMessageId]),
      ),
  );

  return {
    optimisticCreatedAt: null,
    optimisticQueueDataUpdateCount:
      queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0,
    optimisticRowId: null,
    prediction: null,
    previousQueuedMessages,
  };
}

function prependProjectPromptHistory(
  queryClient: QueryClient,
  projectId: string,
  entry: PromptHistoryEntry,
): void {
  queryClient.setQueryData<PromptHistoryResponse>(
    projectPromptHistoryQueryKey(projectId),
    (currentEntries) => prependPromptHistoryEntry(currentEntries, entry),
  );
}

function hasUnmanagedCheckoutIntent(request: AppCreateThreadRequest): boolean {
  return (
    request.environment.type === "host" &&
    request.environment.workspace.type === "unmanaged" &&
    request.environment.workspace.branch !== undefined
  );
}

function requestWillOptimisticallyQueue(
  request: SendThreadMessageMutationRequest,
  thread: ThreadWithRuntime | undefined,
): boolean {
  return (
    (request.sendAt !== undefined && request.sendAt > Date.now()) ||
    (request.mode === "queue-if-active" &&
      thread !== undefined &&
      shouldQueueFollowUpMessage(thread.runtime.displayStatus))
  );
}

function optimisticTurnRequestKind({
  mode,
  threadStatus,
}: OptimisticTurnRequestKindArgs): OptimisticTurnRequestKind {
  if (mode === "steer" || mode === "steer-if-active") {
    return "steer";
  }
  if (mode === "auto" && threadStatus === "active") {
    return "steer";
  }
  return "message";
}

function buildOptimisticUserMessageRow({
  createdAt,
  input,
  mode,
  threadId,
  threadStatus,
}: BuildOptimisticUserMessageRowParams): TimelineUserConversationRow {
  const id = `${OPTIMISTIC_TIMELINE_ROW_ID_PREFIX}${nanoid()}`;
  const text = input
    .filter(
      (entry): entry is Extract<typeof entry, { type: "text" }> =>
        entry.type === "text" && entry.visibility !== "agent-only",
    )
    .map((entry) => entry.text)
    .join("\n\n");
  const attachments = collectPromptAttachments(
    input.filter((entry) => entry.visibility !== "agent-only"),
  );
  const timelineAttachments: TimelineConversationAttachments | null =
    attachments
      ? {
          webImages: attachments.webImages,
          localImages: attachments.localImages,
          localFiles: attachments.localFiles,
          imageUrls: attachments.imageUrls ?? [],
          localImagePaths: attachments.localImagePaths ?? [],
          localFilePaths: attachments.localFilePaths ?? [],
          localFileDetails: attachments.localFileDetails ?? [],
        }
      : null;
  return {
    id,
    kind: "conversation",
    role: "user",
    threadId,
    turnId: null,
    messageSeq: 0,
    sourceSeqStart: 0,
    sourceSeqEnd: 0,
    startedAt: createdAt,
    createdAt,
    text,
    mentions: [],
    attachments: timelineAttachments,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: {
      isGrouped: false,
      kind: optimisticTurnRequestKind({ mode, threadStatus }),
      status: "pending",
    },
  };
}

function predictAcceptedTurnThreadState({
  createdAt,
  queryClient,
  threadId,
}: {
  createdAt: number;
  queryClient: QueryClient;
  threadId: string;
}): ThreadEntityPrediction {
  return beginThreadEntityPrediction(queryClient, {
    threadIds: [threadId],
    update: (entity) => ({
      ...entity,
      thread: {
        ...entity.thread,
        status: "active",
        updatedAt: Math.max(entity.thread.updatedAt ?? createdAt, createdAt),
        ...(entity.thread.runtime && {
          runtime: {
            ...entity.thread.runtime,
            displayStatus:
              entity.thread.runtime.displayStatus === "waiting-for-host"
                ? entity.thread.runtime.displayStatus
                : "active",
          },
        }),
      },
    }),
  });
}

function predictStopRequest({
  queryClient,
  requestedAt,
  threadId,
}: StopThreadTransactionArgs): ThreadEntityPrediction {
  return beginThreadEntityPrediction(queryClient, {
    threadIds: [threadId],
    update: (entity) => ({
      ...entity,
      thread: {
        ...entity.thread,
        status: "stopping",
        updatedAt: Math.max(
          entity.thread.updatedAt ?? requestedAt,
          requestedAt,
        ),
        ...(entity.thread.runtime && {
          runtime: { ...entity.thread.runtime, displayStatus: "stopping" },
        }),
      },
    }),
  });
}

export function applyThreadPlanCancellationResult({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  for (const [
    queryKey,
    timeline,
  ] of queryClient.getQueriesData<ThreadTimelineResponse>({
    queryKey: threadTimelineQueryKeyPrefix(threadId),
  })) {
    if (!timeline) {
      continue;
    }
    queryClient.setQueryData<ThreadTimelineResponse>(queryKey, {
      ...timeline,
      activePromptMode: null,
    });
  }

  const activity = getThreadEntity(queryClient, threadId)?.list?.activity;
  if (activity !== undefined)
    patchThreadEntity(queryClient, threadId, {
      activity: { ...activity, activePlanModeCount: 0 },
    });
}

export async function beginCreateThreadTransaction({
  queryClient,
}: BeginCreateThreadTransactionArgs): Promise<void> {
  await cancelOptimisticQueries(queryClient, { queryKey: threadsQueryKey() });
}

export function prefetchThreadQueuedMessages({
  load,
  queryClient,
  threadId,
}: PrefetchThreadQueuedMessagesArgs): Promise<void> {
  return queryClient.prefetchQuery<ThreadQueuedMessageListResponse>({
    queryKey: threadQueuedMessagesQueryKey(threadId),
    queryFn: ({ signal }) => load(signal),
  });
}

export function applyCreateThreadResult({
  queryClient,
  request,
  thread,
}: CreateThreadSuccessArgs): void {
  queryClient.setQueryData<ThreadResponse>(threadQueryKey(thread.id), thread);
  const environmentId =
    request.environment.type === "reuse"
      ? request.environment.environmentId
      : thread.environmentId;
  const cachedHostId =
    environmentId === null
      ? null
      : (queryClient.getQueryData<Environment>(
          environmentQueryKey(environmentId),
        )?.hostId ?? null);
  const selectedHostId =
    request.environment.type === "provider" &&
    request.environment.machine?.type === "existing"
      ? request.environment.machine.hostId
      : request.environment.type === "host"
        ? (request.environment.hostId ?? null)
        : null;
  optimisticallyInsertThread(
    queryClient,
    thread,
    cachedHostId ?? selectedHostId,
  );
  if (request.input.length > 0) {
    prependProjectPromptHistory(
      queryClient,
      request.projectId,
      buildAcceptedPromptHistoryEntry({
        createdAt: thread.createdAt,
        input: request.input,
      }),
    );
  }
  invalidateProjectPromptHistoryQueries({
    queryClient,
    projectId: request.projectId,
  });
  if (hasUnmanagedCheckoutIntent(request)) {
    queryClient.invalidateQueries({
      queryKey: projectSourceBranchesQueryKeyPrefix(request.projectId),
    });
  }
  refetchThreadListsAfterComposerThreadCreate({ queryClient });
}

export async function beginSendThreadMessageTransaction({
  queryClient,
  request,
}: SendThreadMessageTransactionArgs): Promise<SendThreadMessageTransaction> {
  const prepared = prepareSendRequest(request);
  request = prepared;
  const createdAt = Date.now();
  const previousThread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(request.id),
  );
  const row = buildOptimisticUserMessageRow({
    createdAt,
    input: request.input,
    mode: request.mode,
    threadId: request.id,
    threadStatus: previousThread?.status ?? null,
  });
  row.id = `pending-send-${request.clientSubmissionId}`;
  pendingSendOwner(queryClient).begin(
    newPendingSend({
      id: prepared.clientSubmissionId,
      threadId: request.id,
      row,
      submissionIds: [prepared.clientSubmissionId],
      queueIds: [],
      queueRows: [],
      afterSequence:
        queryClient.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey(request.id),
        )?.maxSeq ?? 0,
      legacyQueueBaselineIds: queryClient
        .getQueryData<ThreadQueuedMessageListResponse>(
          threadQueuedMessagesQueryKey(request.id),
        )
        ?.map((row) => row.id),
      request,
    }),
  );
  return {
    kind: "accepted-turn",
    optimisticCreatedAt: createdAt,
    optimisticRowId: row.id,
    generation: pendingSendGeneration(queryClient),
    prediction: requestWillOptimisticallyQueue(request, previousThread)
      ? null
      : predictAcceptedTurnThreadState({
          createdAt,
          queryClient,
          threadId: request.id,
        }),
  };
}
export function rollbackSendThreadMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackSendThreadMessageTransactionArgs): void {
  if (
    transaction?.kind === "accepted-turn" &&
    transaction.generation !== pendingSendGeneration(queryClient)
  ) {
    transaction.prediction?.fail();
    return;
  }
  request = prepareSendRequest(request);
  if (request.clientSubmissionId)
    pendingSendOwner(queryClient).fail(
      request.id,
      request.clientSubmissionId,
      false,
      "Delivery unconfirmed",
    );
  if (transaction?.kind === "accepted-turn") transaction.prediction?.fail();
}
export function applySendThreadMessageSuccess({
  queryClient,
  request,
  result,
  transaction,
  realtimeConnected,
}: ApplySendThreadMessageSuccessArgs): void {
  if (
    transaction?.kind === "accepted-turn" &&
    transaction.generation !== pendingSendGeneration(queryClient)
  ) {
    transaction.prediction?.fail();
    return;
  }
  request = prepareSendRequest(request);
  if (request.clientSubmissionId)
    pendingSendOwner(queryClient).receipt(
      request.id,
      request.clientSubmissionId,
      result,
      {
        maxSeq:
          queryClient.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey(request.id),
          )?.maxSeq ?? 0,
        queueIds: queryClient
          .getQueryData<ThreadQueuedMessageListResponse>(
            threadQueuedMessagesQueryKey(request.id),
          )
          ?.map((row) => row.id),
      },
    );
  if (transaction?.kind === "accepted-turn") {
    if (result.delivery === "queued") transaction.prediction?.fail();
    else transaction.prediction?.confirm([], readThreadBack(queryClient));
  }
  queryClient.setQueryData<PromptHistoryResponse>(
    threadPromptHistoryQueryKey(request.id),
    (current) =>
      prependPromptHistoryEntry(
        current,
        buildAcceptedPromptHistoryEntry({
          createdAt: transaction?.optimisticCreatedAt ?? Date.now(),
          input: request.input,
        }),
      ),
  );
  if (result.delivery === "queued")
    invalidateThreadQueueQueries({ queryClient, threadId: request.id });
  else
    (realtimeConnected
      ? markThreadAcceptedMessageQueriesStale
      : invalidateThreadAcceptedMessageQueriesWithoutRealtime)({
      queryClient,
      threadId: request.id,
    });
  void refreshPendingSends(queryClient, request.id).catch(() => {});
}

export async function beginUpdateQueuedMessageTransaction({
  queryClient,
  request,
}: UpdateQueuedMessageTransactionArgs): Promise<UpdateQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  await cancelOptimisticQueries(queryClient, { queryKey });
  const previousQueuedMessage = queryClient
    .getQueryData<ThreadQueuedMessageListResponse>(queryKey)
    ?.find((queuedMessage) => queuedMessage.id === request.queuedMessageId);
  const optimisticUpdatedAt = previousQueuedMessage
    ? Math.max(Date.now(), previousQueuedMessage.updatedAt + 1)
    : null;
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      currentQueuedMessages?.map((queuedMessage) =>
        queuedMessage.id === request.queuedMessageId
          ? {
              ...queuedMessage,
              content: request.input ?? queuedMessage.content,
              model: request.model ?? queuedMessage.model,
              permissionMode:
                request.permissionMode ?? queuedMessage.permissionMode,
              reasoningLevel:
                request.reasoningLevel ?? queuedMessage.reasoningLevel,
              serviceTier: request.serviceTier ?? queuedMessage.serviceTier,
              updatedAt: optimisticUpdatedAt ?? queuedMessage.updatedAt,
            }
          : queuedMessage,
      ),
  );
  return { optimisticUpdatedAt, previousQueuedMessage };
}

export function rollbackUpdateQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackUpdateQueuedMessageTransactionArgs): void {
  const previousQueuedMessage = transaction?.previousQueuedMessage;
  const optimisticUpdatedAt = transaction?.optimisticUpdatedAt;
  if (
    previousQueuedMessage !== undefined &&
    optimisticUpdatedAt !== null &&
    optimisticUpdatedAt !== undefined
  ) {
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      (currentQueuedMessages) =>
        currentQueuedMessages?.map((queuedMessage) =>
          queuedMessage.id === request.queuedMessageId &&
          queuedMessage.updatedAt === optimisticUpdatedAt
            ? {
                ...queuedMessage,
                content: previousQueuedMessage.content,
                model: previousQueuedMessage.model,
                permissionMode: previousQueuedMessage.permissionMode,
                reasoningLevel: previousQueuedMessage.reasoningLevel,
                serviceTier: previousQueuedMessage.serviceTier,
                updatedAt: previousQueuedMessage.updatedAt,
              }
            : queuedMessage,
        ),
    );
  }
  invalidateThreadQueueQueries({ queryClient, threadId: request.id });
}

export function applyQueuedMessageUpdateResult({
  queryClient,
  queuedMessage,
  threadId,
}: QueuedMessageResultArgs): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(threadId),
    (currentQueuedMessages) =>
      currentQueuedMessages?.map((currentQueuedMessage) =>
        currentQueuedMessage.id === queuedMessage.id
          ? queuedMessage
          : currentQueuedMessage,
      ) ?? [queuedMessage],
  );
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginRemoveQueuedMessageTransaction({
  queryClient,
  request,
}: RemoveQueuedMessageTransactionArgs): Promise<RemoveQueuedMessageTransaction> {
  await cancelOptimisticQueries(queryClient, {
    queryKey: threadQueuedMessagesQueryKey(request.id),
  });
  return removeCachedQueuedMessage({ queryClient, request });
}

export async function beginSendQueuedMessageTransaction({
  queryClient,
  request,
}: SendQueuedMessageTransactionArgs): Promise<RemoveQueuedMessageTransaction> {
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
    );
  const group = queuedMessageSendGroup(
    previousQueuedMessages,
    request.queuedMessageId,
  );
  if (group.length === 0) {
    return {
      optimisticCreatedAt: null,
      optimisticQueueDataUpdateCount: 0,
      optimisticRowId: null,
      prediction: null,
      previousQueuedMessages,
    };
  }
  const row = buildOptimisticUserMessageRow({
    createdAt: Date.now(),
    input: group.flatMap((item) => item.content),
    mode: request.mode,
    threadId: request.id,
    threadStatus:
      queryClient.getQueryData<ThreadResponse>(threadQueryKey(request.id))
        ?.status ?? null,
  });
  const id = `queue:${request.queuedMessageId}`;
  const pending = pendingSendOwner(queryClient).begin({
    ...newPendingSend({
      id,
      threadId: request.id,
      row,
      submissionIds: group.flatMap((item) => item.clientSubmissionIds ?? []),
      queueIds: group.map((item) => item.id),
      queueRows: group,
    }),
    afterSequence:
      queryClient.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey(request.id),
      )?.maxSeq ?? 0,
  });
  return {
    optimisticCreatedAt: Date.now(),
    optimisticQueueDataUpdateCount: 0,
    optimisticRowId: pending.id,
    sendGeneration: pendingSendGeneration(queryClient),
    prediction: predictAcceptedTurnThreadState({
      createdAt: Date.now(),
      queryClient,
      threadId: request.id,
    }),
    previousQueuedMessages,
  };
}
export function rollbackRemoveQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackRemoveQueuedMessageTransactionArgs): void {
  if (
    transaction?.sendGeneration !== undefined &&
    transaction.sendGeneration !== pendingSendGeneration(queryClient)
  ) {
    transaction.prediction?.fail();
    return;
  }
  if (transaction?.optimisticRowId?.startsWith("queue:")) {
    pendingSendOwner(queryClient).restoreQueue(
      request.id,
      transaction.optimisticRowId,
    );
    transaction.prediction?.fail();
    return;
  }
  transaction?.prediction?.fail();
  if (transaction)
    restoreQueuedMessageSnapshotIfUnchanged({
      queryClient,
      threadId: request.id,
      previousQueuedMessages: transaction.previousQueuedMessages,
      optimisticQueueDataUpdateCount:
        transaction.optimisticQueueDataUpdateCount,
    });
  invalidateThreadQueueQueries({ queryClient, threadId: request.id });
}
export function applyQueuedMessageSendResult({
  queryClient,
  request,
  result,
  transaction,
}: ApplyQueuedMessageSendResultArgs): void {
  if (
    transaction?.sendGeneration !== undefined &&
    transaction.sendGeneration !== pendingSendGeneration(queryClient)
  ) {
    transaction.prediction?.fail();
    return;
  }
  if (transaction?.optimisticRowId)
    pendingSendOwner(queryClient).receipt(
      request.id,
      transaction.optimisticRowId,
      result,
      {
        maxSeq:
          queryClient.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey(request.id),
          )?.maxSeq ?? 0,
        queueIds: queryClient
          .getQueryData<ThreadQueuedMessageListResponse>(
            threadQueuedMessagesQueryKey(request.id),
          )
          ?.map((row) => row.id),
      },
    );
  if (result.delivery === "queued") {
    transaction?.prediction?.fail();
    const authoritative = result.queuedMessage;
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      (rows) =>
        rows?.map((row) => (row.id === authoritative.id ? authoritative : row)),
    );
    invalidateThreadQueuedMessageStayedQueuedQueries({
      queryClient,
      threadId: request.id,
    });
  } else {
    transaction?.prediction?.confirm([], readThreadBack(queryClient));
    invalidateThreadQueuedMessageSendQueries({
      queryClient,
      threadId: request.id,
    });
  }
  void refreshPendingSends(queryClient, request.id).catch(() => {});
}

export async function beginReorderQueuedMessageTransaction({
  queryClient,
  request,
}: ReorderQueuedMessageTransactionArgs): Promise<ReorderQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) => {
      if (!currentQueuedMessages) return currentQueuedMessages;
      const originalLeadGroupIds = collectLeadQueuedMessageGroupIds(
        currentQueuedMessages,
      );
      const reordered = applyQueuedMessageReorder({
        queuedMessages: currentQueuedMessages,
        request,
      });
      return request.groupBoundaryQueuedMessageId !== undefined
        ? applyQueuedMessageGroupBoundary({
            queuedMessages: reordered,
            groupBoundaryQueuedMessageId: request.groupBoundaryQueuedMessageId,
          })
        : preserveLeadQueuedMessageGroupAfterReorder({
            queuedMessages: reordered,
            originalLeadGroupIds,
          });
    },
  );

  await cancelOptimisticQueries(queryClient, { queryKey });

  return { previousQueuedMessages };
}

export function rollbackReorderQueuedMessageTransaction({
  queryClient,
  request,
  transaction,
}: RollbackQueuedMessageTransactionArgs): void {
  if (transaction?.previousQueuedMessages !== undefined) {
    queryClient.setQueryData<ThreadQueuedMessageListResponse>(
      threadQueuedMessagesQueryKey(request.id),
      transaction.previousQueuedMessages,
    );
  }
  invalidateThreadQueueQueries({
    queryClient,
    threadId: request.id,
  });
}

export function applyQueuedMessagesResult({
  queryClient,
  queuedMessages,
  request,
}: ApplyQueuedMessagesResultArgs): void {
  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    threadQueuedMessagesQueryKey(request.id),
    queuedMessages,
  );
  invalidateThreadQueueQueries({
    queryClient,
    threadId: request.id,
  });
}

export async function beginSetQueuedMessageGroupBoundaryTransaction({
  queryClient,
  request,
}: SetQueuedMessageGroupBoundaryTransactionArgs): Promise<ReorderQueuedMessageTransaction> {
  const queryKey = threadQueuedMessagesQueryKey(request.id);
  const previousQueuedMessages =
    queryClient.getQueryData<ThreadQueuedMessageListResponse>(queryKey);

  queryClient.setQueryData<ThreadQueuedMessageListResponse>(
    queryKey,
    (currentQueuedMessages) =>
      currentQueuedMessages
        ? applyQueuedMessageGroupBoundary({
            queuedMessages: currentQueuedMessages,
            groupBoundaryQueuedMessageId: request.groupBoundaryQueuedMessageId,
          })
        : currentQueuedMessages,
  );

  await cancelOptimisticQueries(queryClient, { queryKey });

  return { previousQueuedMessages };
}

export function applyQueuedMessageDeleteResult({
  queryClient,
  threadId,
}: ThreadIdCacheArgs): void {
  invalidateThreadQueueQueries({ queryClient, threadId });
}

export async function beginStopThreadTransaction(
  args: StopThreadTransactionArgs,
): Promise<StopThreadTransaction> {
  return { prediction: predictStopRequest(args) };
}

export function rollbackStopThreadTransaction({
  transaction,
}: RollbackStopThreadTransactionArgs): void {
  transaction?.prediction.fail();
}

export function settleStopThreadTransaction({
  queryClient,
  transaction,
}: {
  queryClient: QueryClient;
  transaction?: StopThreadTransaction | undefined;
}): void {
  transaction?.prediction.confirm([], readThreadBack(queryClient));
  invalidateThreadListQueries({ queryClient });
}
