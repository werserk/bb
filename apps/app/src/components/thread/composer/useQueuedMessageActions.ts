import { useCallback, useMemo, useRef, useState } from "react";
import type { PromptInput, ThreadQueuedMessage } from "@bb/domain";
import type {
  SendQueuedMessageMode,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type {
  QueuedMessageGroupBoundaryRequest,
  QueuedMessageProcessingAction,
  QueuedMessageSendTimeRequest,
} from "@/components/promptbox/banner/LazyQueuedMessagesList";
import {
  useDeleteThreadQueuedMessage,
  useReorderThreadQueuedMessage,
  useSendThreadQueuedMessage,
  useSetThreadQueuedMessageGroupBoundary,
  useUpdateThreadQueuedMessage,
} from "@/hooks/mutations/thread-runtime-mutations";
import {
  reportMutationError,
  showMutationErrorToast,
} from "@/lib/mutation-errors";
import type { QueuedMessageReorderRequest } from "@/lib/queued-message-reorder";
import { BbHttpError } from "@/lib/sdk";
import type { InlineQueuedMessageEditState } from "./useInlineQueuedMessageEditing";

function isThreadMutationPending(
  mutation: { isPending: boolean; variables?: { id: string } },
  threadId: string,
) {
  return mutation.isPending && mutation.variables?.id === threadId;
}

type QueuedMessageSendGuard = "current-head" | "exists" | "none";

interface SendQueuedMessageByIdArgs {
  guard: QueuedMessageSendGuard;
  messageId: string;
  mode: SendQueuedMessageMode;
}

interface UseQueuedMessageActionsArgs {
  threadId: string;
  queuedMessages: readonly ThreadQueuedMessage[];
  sendProcessingPersistence: "clear-on-settle" | "until-left-queue";
  onSendSuccess?: () => void;
  onSaveSuccess?: () => void;
  inlineEditingQueuedMessage: InlineQueuedMessageEditState | null;
  dismissInlineQueuedMessageEditor: () => void;
  activeComposerDraftInput: PromptInput[];
}

interface UseQueuedMessageActionsResult {
  processingQueuedMessage: {
    action: QueuedMessageProcessingAction;
    id: string;
  } | null;
  queuedMessageActionPending: boolean;
  isUpdateQueuedMessagePending: boolean;
  sendQueuedMessageById: (args: SendQueuedMessageByIdArgs) => Promise<void>;
  handleSaveInlineQueuedMessage: () => Promise<void>;
  handleChangeQueuedMessageSendTime: (
    request: QueuedMessageSendTimeRequest,
  ) => Promise<void>;
  handleDeleteQueuedMessage: (queuedMessageId: string) => void;
  handleReorderQueuedMessage: (request: QueuedMessageReorderRequest) => void;
  handleSetQueuedMessageGroupBoundary: (
    request: QueuedMessageGroupBoundaryRequest,
  ) => void;
}

function changedExecutionFields(
  edit: InlineQueuedMessageEditState,
  queuedMessage: ThreadQueuedMessage | undefined,
): Pick<
  UpdateQueuedMessageRequest,
  "model" | "permissionMode" | "reasoningLevel" | "serviceTier"
> {
  return {
    ...(edit.model === queuedMessage?.model ? {} : { model: edit.model }),
    ...(edit.permissionMode === queuedMessage?.permissionMode
      ? {}
      : { permissionMode: edit.permissionMode }),
    ...(edit.reasoningLevel === queuedMessage?.reasoningLevel
      ? {}
      : { reasoningLevel: edit.reasoningLevel }),
    ...(edit.serviceTier === queuedMessage?.serviceTier
      ? {}
      : { serviceTier: edit.serviceTier }),
  };
}

export function useQueuedMessageActions({
  threadId,
  queuedMessages,
  sendProcessingPersistence,
  onSendSuccess,
  onSaveSuccess,
  inlineEditingQueuedMessage,
  dismissInlineQueuedMessageEditor,
  activeComposerDraftInput,
}: UseQueuedMessageActionsArgs): UseQueuedMessageActionsResult {
  const updateQueuedMessage = useUpdateThreadQueuedMessage();
  const sendQueuedMessage = useSendThreadQueuedMessage();
  const deleteQueuedMessage = useDeleteThreadQueuedMessage();
  const reorderQueuedMessage = useReorderThreadQueuedMessage();
  const setQueuedMessageGroupBoundary =
    useSetThreadQueuedMessageGroupBoundary();
  const [processingQueuedMessage, setProcessingQueuedMessage] = useState<{
    action: QueuedMessageProcessingAction;
    id: string;
  } | null>(null);
  const currentUi = useRef({
    threadId,
    editSessionId: inlineEditingQueuedMessage?.editSessionId,
  });
  currentUi.current = {
    threadId,
    editSessionId: inlineEditingQueuedMessage?.editSessionId,
  };
  const queuedMessagesRef = useRef<readonly ThreadQueuedMessage[]>([]);
  queuedMessagesRef.current = queuedMessages;

  const displayedProcessingQueuedMessage = useMemo(
    () =>
      sendProcessingPersistence === "until-left-queue"
        ? processingQueuedMessage &&
          queuedMessages.some(
            (message) => message.id === processingQueuedMessage.id,
          )
          ? processingQueuedMessage
          : null
        : processingQueuedMessage,
    [processingQueuedMessage, queuedMessages, sendProcessingPersistence],
  );

  const sendQueuedMessageById = useCallback(
    async ({ guard, messageId, mode }: SendQueuedMessageByIdArgs) => {
      if (currentUi.current.threadId !== threadId) return;
      if (
        guard !== "none" &&
        !queuedMessagesRef.current.some((message) => message.id === messageId)
      ) {
        return;
      }
      if (
        guard === "current-head" &&
        queuedMessagesRef.current[0]?.id !== messageId
      ) {
        return;
      }

      const operation = { id: messageId, action: "send" } as const;
      setProcessingQueuedMessage(operation);
      try {
        await sendQueuedMessage.mutateAsync({
          id: threadId,
          mode,
          queuedMessageId: messageId,
        });
        if (currentUi.current.threadId === threadId) onSendSuccess?.();
        if (
          mode === "steer" ||
          sendProcessingPersistence === "clear-on-settle"
        ) {
          setProcessingQueuedMessage((current) =>
            current === operation ? null : current,
          );
        }
      } catch (error) {
        setProcessingQueuedMessage((current) =>
          current === operation ? null : current,
        );
        throw reportMutationError({
          error,
          fallbackMessage: "Failed to send queued message",
          lifecycleOperation: "send_queued_message",
        });
      }
    },
    [onSendSuccess, sendProcessingPersistence, sendQueuedMessage, threadId],
  );

  const handleSaveInlineQueuedMessage = useCallback(async () => {
    if (
      !inlineEditingQueuedMessage ||
      activeComposerDraftInput.length === 0 ||
      currentUi.current.threadId !== threadId ||
      currentUi.current.editSessionId !==
        inlineEditingQueuedMessage.editSessionId ||
      isThreadMutationPending(updateQueuedMessage, threadId)
    ) {
      return;
    }
    if (
      inlineEditingQueuedMessage.ownerThreadId !== threadId ||
      !queuedMessagesRef.current.some(
        (message) => message.id === inlineEditingQueuedMessage.queuedMessageId,
      )
    ) {
      dismissInlineQueuedMessageEditor();
      return;
    }
    const { editSessionId, expectedUpdatedAt, ownerThreadId, queuedMessageId } =
      inlineEditingQueuedMessage;
    const queuedMessage = queuedMessagesRef.current.find(
      (message) => message.id === queuedMessageId,
    );
    const ownsEditor = () =>
      currentUi.current.threadId === ownerThreadId &&
      currentUi.current.editSessionId === editSessionId;
    const operation = { id: queuedMessageId, action: "edit" } as const;
    setProcessingQueuedMessage(operation);
    try {
      await updateQueuedMessage.mutateAsync({
        expectedUpdatedAt,
        id: ownerThreadId,
        input: activeComposerDraftInput,
        queuedMessageId,
        ...changedExecutionFields(inlineEditingQueuedMessage, queuedMessage),
      });
      if (ownsEditor()) {
        onSaveSuccess?.();
        dismissInlineQueuedMessageEditor();
      }
    } catch (error) {
      if (
        error instanceof BbHttpError &&
        error.status === 404 &&
        ownsEditor()
      ) {
        dismissInlineQueuedMessageEditor();
      }
      showMutationErrorToast({
        error,
        fallbackMessage: "Failed to update queued message",
        lifecycleOperation: "update_queued_message",
      });
    } finally {
      setProcessingQueuedMessage((current) =>
        current === operation ? null : current,
      );
    }
  }, [
    activeComposerDraftInput,
    dismissInlineQueuedMessageEditor,
    inlineEditingQueuedMessage,
    onSaveSuccess,
    threadId,
    updateQueuedMessage,
  ]);

  const handleChangeQueuedMessageSendTime = useCallback(
    async ({
      expectedUpdatedAt,
      queuedMessageId,
      sendAt,
    }: QueuedMessageSendTimeRequest) => {
      await updateQueuedMessage.mutateAsync({
        expectedUpdatedAt,
        id: threadId,
        queuedMessageId,
        sendAt,
      });
    },
    [threadId, updateQueuedMessage],
  );

  const handleDeleteQueuedMessage = useCallback(
    (queuedMessageId: string) => {
      const operation = { id: queuedMessageId, action: "delete" } as const;
      setProcessingQueuedMessage(operation);
      void deleteQueuedMessage
        .mutateAsync({
          id: threadId,
          queuedMessageId,
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to delete queued message",
            lifecycleOperation: "queue_message",
          });
        })
        .finally(() => {
          setProcessingQueuedMessage((current) =>
            current === operation ? null : current,
          );
        });
    },
    [deleteQueuedMessage, threadId],
  );

  const handleReorderQueuedMessage = useCallback(
    (request: QueuedMessageReorderRequest) => {
      void reorderQueuedMessage
        .mutateAsync({
          ...request,
          id: threadId,
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to reorder queued message",
            lifecycleOperation: "reorder_queued_message",
          });
        });
    },
    [reorderQueuedMessage, threadId],
  );

  const handleSetQueuedMessageGroupBoundary = useCallback(
    (request: QueuedMessageGroupBoundaryRequest) => {
      void setQueuedMessageGroupBoundary
        .mutateAsync({
          id: threadId,
          ...request,
        })
        .catch((error) => {
          showMutationErrorToast({
            error,
            fallbackMessage: "Failed to group queued messages",
            lifecycleOperation: "set_queued_message_group_boundary",
          });
        });
    },
    [setQueuedMessageGroupBoundary, threadId],
  );

  const queuedMessageActionPending =
    isThreadMutationPending(deleteQueuedMessage, threadId) ||
    isThreadMutationPending(reorderQueuedMessage, threadId) ||
    isThreadMutationPending(setQueuedMessageGroupBoundary, threadId) ||
    isThreadMutationPending(sendQueuedMessage, threadId) ||
    isThreadMutationPending(updateQueuedMessage, threadId);

  return {
    processingQueuedMessage: displayedProcessingQueuedMessage,
    queuedMessageActionPending,
    isUpdateQueuedMessagePending: isThreadMutationPending(
      updateQueuedMessage,
      threadId,
    ),
    sendQueuedMessageById,
    handleSaveInlineQueuedMessage,
    handleChangeQueuedMessageSendTime,
    handleDeleteQueuedMessage,
    handleReorderQueuedMessage,
    handleSetQueuedMessageGroupBoundary,
  };
}
