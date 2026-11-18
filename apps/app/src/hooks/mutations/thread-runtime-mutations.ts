import { prepareSendRequest } from "./mutation-request-types";
import { pendingSendGeneration } from "../cache-owners/pending-send-owner";
import { sendMessageResponseSchema } from "@bb/server-contract";
import {
  dispatchPendingSend,
  pendingSendOwner,
  refreshPendingSends,
} from "../cache-owners/pending-send-owner";
import { z } from "zod";
import { clientTurnRequestIdSchema } from "@bb/domain";
import { notifyComposerSubmitted } from "@/lib/composer-submissions";
import {
  mutationOptions,
  type QueryClient,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { ThreadQueuedMessage } from "@bb/domain";
import type {
  SendQueuedMessageMode,
  SendQueuedMessageResponse,
  ThreadQueuedMessageListResponse,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type { AppCreateThreadRequest } from "@bb/client-core";
import { BbHttpError, sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import type { QueuedMessageReorderRequest } from "@/lib/queued-message-reorder";
import type {
  EditMessageMutationRequest,
  SendThreadMessageMutationRequest,
} from "./mutation-request-types";
import {
  applyCreateThreadResult,
  applyQueuedMessageDeleteResult,
  applyQueuedMessagesResult,
  applyQueuedMessageSendResult,
  applyQueuedMessageUpdateResult,
  applySendThreadMessageSuccess,
  applyThreadPlanCancellationResult,
  beginCreateThreadTransaction,
  beginRemoveQueuedMessageTransaction,
  beginReorderQueuedMessageTransaction,
  beginSetQueuedMessageGroupBoundaryTransaction,
  beginSendQueuedMessageTransaction,
  beginSendThreadMessageTransaction,
  beginStopThreadTransaction,
  beginUpdateQueuedMessageTransaction,
  prefetchThreadQueuedMessages,
  rollbackRemoveQueuedMessageTransaction,
  rollbackReorderQueuedMessageTransaction,
  rollbackSendThreadMessageTransaction,
  rollbackStopThreadTransaction,
  rollbackUpdateQueuedMessageTransaction,
  settleStopThreadTransaction,
  type RemoveQueuedMessageTransaction,
  type ReorderQueuedMessageTransaction,
  type SendThreadMessageTransaction,
  type StopThreadTransaction,
  type UpdateQueuedMessageTransaction,
} from "../cache-owners/thread-runtime-cache-owner";
import {
  invalidateThreadBannerQueries,
  invalidateThreadHistoryRewriteQueries,
} from "../cache-owners/mutation-cache-effects";

interface UpdateThreadQueuedMessageMutationRequest extends UpdateQueuedMessageRequest {
  id: string;
  queuedMessageId: string;
}

interface SendThreadQueuedMessageMutationRequest {
  id: string;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
}

interface DeleteThreadQueuedMessageMutationRequest {
  id: string;
  queuedMessageId: string;
}

interface ReorderThreadQueuedMessageMutationRequest extends QueuedMessageReorderRequest {
  id: string;
}

interface SetThreadQueuedMessageGroupBoundaryMutationRequest {
  expectedGroupedPrefixQueuedMessageIds: string[];
  groupBoundaryQueuedMessageId: string;
  id: string;
}

function getHttpErrorBodyMessage(error: BbHttpError): string | null {
  const body = error.body;
  if (
    typeof body !== "object" ||
    body === null ||
    !("message" in body) ||
    typeof body.message !== "string"
  ) {
    return null;
  }
  return body.message;
}

function isQueuedMessageNotFoundError(error: unknown): boolean {
  return (
    error instanceof BbHttpError &&
    error.status === 404 &&
    error.code === "invalid_request" &&
    getHttpErrorBodyMessage(error) === "Queued message not found"
  );
}

async function deleteThreadQueuedMessageOrConfirmMissing({
  id,
  queuedMessageId,
}: DeleteThreadQueuedMessageMutationRequest): Promise<void> {
  try {
    await sdk.threads.queuedMessages.delete({ threadId: id, queuedMessageId });
  } catch (error) {
    if (isQueuedMessageNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

export function createThreadMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    meta: {
      errorMessage: "Failed to create thread.",
      lifecycleOperation: "create_thread",
    },
    mutationFn: (request: AppCreateThreadRequest) =>
      sdk.threads.spawn({
        ...request,
        origin: "app",
        originKind: request.originKind ?? null,
        startedOnBehalfOf: request.startedOnBehalfOf ?? null,
      }),
    onMutate: async () => beginCreateThreadTransaction({ queryClient }),
    onSuccess: (thread, variables) => {
      notifyComposerSubmitted({
        kind: "new-thread",
        projectId: variables.projectId,
      });
      if (thread.queuedMessageCount > 0) {
        void prefetchThreadQueuedMessages({
          queryClient,
          threadId: thread.id,
          load: (signal) =>
            sdk.threads.queuedMessages.list({
              threadId: thread.id,
              signal,
            }),
        });
      }
      applyCreateThreadResult({
        queryClient,
        request: variables,
        thread,
      });
    },
  });
}

export function useCreateThread() {
  const queryClient = useQueryClient();
  return useMutation(createThreadMutationOptions(queryClient));
}

/** A 4xx answer that proves the server did not admit the submission. */
function isDefiniteSendRejection(error: unknown): error is BbHttpError {
  return (
    error instanceof BbHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.code !== "submission_already_admitted"
  );
}

export function sendThreadMessageMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    retry: false,
    meta: {
      errorMessage: "Failed to send message.",
      lifecycleOperation: "send_message",
      showErrorToast: false,
    },
    mutationFn: async (variables: SendThreadMessageMutationRequest) => {
      const { id, ...request } = prepareSendRequest(variables);
      return dispatchPendingSend(
        queryClient,
        id,
        request.clientSubmissionId ?? crypto.randomUUID(),
        request,
        [],
        async () => {
          const receipt = sendMessageResponseSchema.parse(
            await sdk.threads.send({ threadId: id, ...request }),
          );
          if (
            receipt.submissionIds !== undefined &&
            request.clientSubmissionId &&
            !receipt.submissionIds.includes(request.clientSubmissionId)
          )
            throw new Error("Unrecognized submission receipt");
          return receipt;
        },
      );
    },
    onMutate: async (variables): Promise<SendThreadMessageTransaction> =>
      beginSendThreadMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      if (!context) {
        const { id, clientSubmissionId } = prepareSendRequest(variables);
        if (clientSubmissionId)
          pendingSendOwner(queryClient).markRejected(id, clientSubmissionId);
        return;
      }
      // After a scope reset the entry, if unacknowledged, was kept: settle
      // it as usual; only the old scope's caches are left alone.
      const stale =
        context.kind === "accepted-turn" &&
        context.generation !== pendingSendGeneration(queryClient);
      variables = prepareSendRequest(variables);
      if (variables.clientSubmissionId && _error instanceof BbHttpError) {
        if (_error.code === "submission_already_admitted") {
          const parsed = z
            .object({
              details: z.object({
                requested: z
                  .object({
                    requestId: clientTurnRequestIdSchema,
                    sequence: z.number().int(),
                  })
                  .optional(),
                queuedMessageId: z.string().optional(),
              }),
            })
            .safeParse(_error.body);
          if (parsed.success && parsed.data.details.requested) {
            pendingSendOwner(queryClient).receipt(
              variables.id,
              variables.clientSubmissionId,
              {
                ok: true,
                delivery: "sent",
                submissionIds: [variables.clientSubmissionId],
                requested: parsed.data.details.requested,
              },
            );
            void refreshPendingSends(queryClient, variables.id).catch(() => {});
            if (stale && context.kind === "accepted-turn")
              context.prediction?.fail();
            return;
          }
          if (parsed.success && parsed.data.details.queuedMessageId) {
            pendingSendOwner(queryClient).admittedQueue(
              variables.id,
              variables.clientSubmissionId,
              parsed.data.details.queuedMessageId,
            );
            void refreshPendingSends(queryClient, variables.id).catch(() => {});
            if (context?.kind === "accepted-turn") context.prediction?.fail();
            return;
          }
        }
        if (isDefiniteSendRejection(_error)) {
          // Recorded even when the entry is gone, so the composer restores
          // the draft.
          pendingSendOwner(queryClient).markRejected(
            variables.id,
            variables.clientSubmissionId,
          );
          pendingSendOwner(queryClient).fail(
            variables.id,
            variables.clientSubmissionId,
            true,
            getHttpErrorBodyMessage(_error) ?? "Not sent",
          );
        }
      }
      rollbackSendThreadMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (data, variables, context) => {
      notifyComposerSubmitted({ kind: "thread", threadId: variables.id });
      applySendThreadMessageSuccess({
        queryClient,
        realtimeConnected: wsManager.getConnectionState() === "connected",
        request: variables,
        result: data,
        transaction: context,
      });
    },
  });
}

export function useSendThreadMessage() {
  const queryClient = useQueryClient();
  return useMutation(sendThreadMessageMutationOptions(queryClient));
}

export function editThreadMessageMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    meta: {
      errorMessage: "Failed to edit the message.",
      lifecycleOperation: "edit_message",
      showErrorToast: false,
    },
    mutationFn: ({ id, ...request }: EditMessageMutationRequest) =>
      sdk.threads.editMessage({ threadId: id, ...request }),
    onSuccess: (_result, variables) => {
      if (wsManager.getConnectionState() === "connected") {
        return;
      }
      invalidateThreadHistoryRewriteQueries({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useEditThreadMessage() {
  const queryClient = useQueryClient();
  return useMutation(editThreadMessageMutationOptions(queryClient));
}

export function useUpdateThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to update queued message.",
      lifecycleOperation: "update_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      ...request
    }: UpdateThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessage> =>
      sdk.threads.queuedMessages.update({ ...request, threadId: id }),
    onMutate: async (variables): Promise<UpdateQueuedMessageTransaction> =>
      beginUpdateQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackUpdateQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessage, variables) => {
      applyQueuedMessageUpdateResult({
        queryClient,
        queuedMessage,
        threadId: variables.id,
      });
    },
  });
}

export function sendThreadQueuedMessageMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    meta: {
      errorMessage: "Failed to send queued message.",
      lifecycleOperation: "send_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      mode,
      queuedMessageId,
    }: SendThreadQueuedMessageMutationRequest): Promise<SendQueuedMessageResponse> =>
      dispatchPendingSend(
        queryClient,
        id,
        `queue:${queuedMessageId}`,
        { mode },
        pendingSendOwner(queryClient)
          .list(id)
          .find((entry) => entry.queueIds.includes(queuedMessageId))
          ?.queueIds ?? [queuedMessageId],
        async () =>
          sendMessageResponseSchema.parse(
            await sdk.threads.queuedMessages.send({
              threadId: id,
              queuedMessageId,
              mode,
            }),
          ),
      ),
    onMutate: async (variables): Promise<RemoveQueuedMessageTransaction> =>
      beginSendQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (data, variables, transaction) => {
      applyQueuedMessageSendResult({
        queryClient,
        request: variables,
        result: data,
        transaction,
      });
    },
  });
}

export function useSendThreadQueuedMessage() {
  const queryClient = useQueryClient();
  return useMutation(sendThreadQueuedMessageMutationOptions(queryClient));
}

export function useReorderThreadQueuedMessage() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to reorder queued message.",
      lifecycleOperation: "reorder_queued_message",
      showErrorToast: false,
    },
    mutationFn: ({
      id,
      nextQueuedMessageId,
      previousQueuedMessageId,
      groupBoundaryQueuedMessageId,
      queuedMessageId,
    }: ReorderThreadQueuedMessageMutationRequest): Promise<ThreadQueuedMessageListResponse> =>
      sdk.threads.queuedMessages.reorder({
        threadId: id,
        queuedMessageId,
        previousQueuedMessageId,
        nextQueuedMessageId,
        groupBoundaryQueuedMessageId,
      }),
    onMutate: async (variables): Promise<ReorderQueuedMessageTransaction> =>
      beginReorderQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackReorderQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (queuedMessages, variables) => {
      applyQueuedMessagesResult({
        queryClient,
        queuedMessages,
        request: variables,
      });
    },
  });
}

export function setThreadQueuedMessageGroupBoundaryMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    meta: {
      errorMessage: "Failed to group queued messages.",
      lifecycleOperation: "set_queued_message_group_boundary",
      showErrorToast: false,
    },
    mutationFn: ({
      expectedGroupedPrefixQueuedMessageIds,
      groupBoundaryQueuedMessageId,
      id,
    }: SetThreadQueuedMessageGroupBoundaryMutationRequest): Promise<ThreadQueuedMessageListResponse> =>
      sdk.threads.queuedMessages.setGroupBoundary({
        threadId: id,
        expectedGroupedPrefixQueuedMessageIds,
        groupBoundaryQueuedMessageId,
      }),
    onMutate: async (variables): Promise<ReorderQueuedMessageTransaction> =>
      beginSetQueuedMessageGroupBoundaryTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackReorderQueuedMessageTransaction({
        queryClient,
        request: {
          ...variables,
          queuedMessageId: variables.groupBoundaryQueuedMessageId,
          previousQueuedMessageId: null,
          nextQueuedMessageId: null,
        },
        transaction: context,
      });
    },
    onSuccess: (queuedMessages, variables) => {
      applyQueuedMessagesResult({
        queryClient,
        queuedMessages,
        request: variables,
      });
    },
  });
}

export function useSetThreadQueuedMessageGroupBoundary() {
  const queryClient = useQueryClient();
  return useMutation(
    setThreadQueuedMessageGroupBoundaryMutationOptions(queryClient),
  );
}

export function deleteThreadQueuedMessageMutationOptions(
  queryClient: QueryClient,
) {
  return mutationOptions({
    meta: {
      errorMessage: "Failed to delete queued message.",
      showErrorToast: false,
    },
    mutationFn: deleteThreadQueuedMessageOrConfirmMissing,
    onMutate: async (variables): Promise<RemoveQueuedMessageTransaction> =>
      beginRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
      }),
    onError: (_error, variables, context) => {
      rollbackRemoveQueuedMessageTransaction({
        queryClient,
        request: variables,
        transaction: context,
      });
    },
    onSuccess: (_data, variables) => {
      pendingSendOwner(queryClient).removed(
        variables.id,
        variables.queuedMessageId,
      );
      applyQueuedMessageDeleteResult({
        queryClient,
        threadId: variables.id,
      });
    },
  });
}

export function useDeleteThreadQueuedMessage() {
  const queryClient = useQueryClient();
  return useMutation(deleteThreadQueuedMessageMutationOptions(queryClient));
}

export function useStopThread() {
  const queryClient = useQueryClient();

  return useMutation({
    meta: {
      errorMessage: "Failed to stop thread.",
      lifecycleOperation: "stop_thread",
    },
    mutationFn: async (threadId: string) => {
      await sdk.threads.stop({ threadId });
    },
    onMutate: async (threadId): Promise<StopThreadTransaction> =>
      beginStopThreadTransaction({
        queryClient,
        requestedAt: Date.now(),
        threadId,
      }),
    onError: (_error, threadId, context) => {
      rollbackStopThreadTransaction({
        queryClient,
        threadId,
        transaction: context,
      });
    },
    onSettled: (_data, _error, _threadId, context) => {
      settleStopThreadTransaction({ queryClient, transaction: context });
    },
  });
}

export function cancelThreadPlanMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    meta: { showErrorToast: false },
    mutationFn: async (threadId: string) => {
      await sdk.threads.cancelPlan({ threadId });
    },
    onSuccess: (_data, threadId) => {
      applyThreadPlanCancellationResult({ queryClient, threadId });
      invalidateThreadBannerQueries({ queryClient, threadId });
    },
  });
}

export function useCancelThreadPlan() {
  const queryClient = useQueryClient();
  return useMutation(cancelThreadPlanMutationOptions(queryClient));
}
