import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
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

type ProcessingQueuedMessage =
  UseQueuedMessageActionsResult["processingQueuedMessage"];
type SetProcessingQueuedMessage = Dispatch<
  SetStateAction<ProcessingQueuedMessage>
>;

async function sendQueuedMessageWithProcessing({
  messageId,
  mode,
  threadId,
  sendProcessingPersistence,
  sendQueuedMessage,
  onSendSuccess,
  isCurrentThread,
  setProcessingQueuedMessage,
}: {
  messageId: string;
  mode: SendQueuedMessageMode;
  threadId: string;
  sendProcessingPersistence: UseQueuedMessageActionsArgs["sendProcessingPersistence"];
  sendQueuedMessage: Pick<
    ReturnType<typeof useSendThreadQueuedMessage>,
    "mutateAsync"
  >;
  onSendSuccess: (() => void) | undefined;
  isCurrentThread: () => boolean;
  setProcessingQueuedMessage: SetProcessingQueuedMessage;
}): Promise<void> {
  const operation = { id: messageId, action: "send" } as const;
  setProcessingQueuedMessage(operation);
  try {
    await sendQueuedMessage.mutateAsync({
      id: threadId,
      mode,
      queuedMessageId: messageId,
    });
    if (isCurrentThread()) onSendSuccess?.();
    if (mode === "steer" || sendProcessingPersistence === "clear-on-settle") {
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
}

async function saveInlineQueuedMessage({
  edit,
  queuedMessage,
  input,
  updateQueuedMessage,
  onSaveSuccess,
  dismissInlineQueuedMessageEditor,
  ownsEditor,
  setProcessingQueuedMessage,
}: {
  edit: InlineQueuedMessageEditState;
  queuedMessage: ThreadQueuedMessage | undefined;
  input: PromptInput[];
  updateQueuedMessage: Pick<
    ReturnType<typeof useUpdateThreadQueuedMessage>,
    "mutateAsync"
  >;
  onSaveSuccess: (() => void) | undefined;
  dismissInlineQueuedMessageEditor: () => void;
  ownsEditor: () => boolean;
  setProcessingQueuedMessage: SetProcessingQueuedMessage;
}): Promise<void> {
  const { expectedUpdatedAt, ownerThreadId, queuedMessageId } = edit;
  const operation = { id: queuedMessageId, action: "edit" } as const;
  setProcessingQueuedMessage(operation);
  try {
    await updateQueuedMessage.mutateAsync({
      expectedUpdatedAt,
      id: ownerThreadId,
      input,
      queuedMessageId,
      ...changedExecutionFields(edit, queuedMessage),
    });
    if (ownsEditor()) {
      onSaveSuccess?.();
      dismissInlineQueuedMessageEditor();
    }
  } catch (error) {
    if (error instanceof BbHttpError && error.status === 404 && ownsEditor()) {
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
  const [processingQueuedMessage, setProcessingQueuedMessage] =
    useState<ProcessingQueuedMessage>(null);
  const editSessionId = inlineEditingQueuedMessage?.editSessionId;
  const currentUi = useRef({ threadId, editSessionId });
  const queuedMessagesRef =
    useRef<readonly ThreadQueuedMessage[]>(queuedMessages);
  useLayoutEffect(() => {
    currentUi.current = { threadId, editSessionId };
    queuedMessagesRef.current = queuedMessages;
  });

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

      await sendQueuedMessageWithProcessing({
        messageId,
        mode,
        threadId,
        sendProcessingPersistence,
        sendQueuedMessage,
        onSendSuccess,
        isCurrentThread: () => currentUi.current.threadId === threadId,
        setProcessingQueuedMessage,
      });
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
    const queuedMessage = queuedMessagesRef.current.find(
      (message) => message.id === inlineEditingQueuedMessage.queuedMessageId,
    );
    const editingSessionId = inlineEditingQueuedMessage.editSessionId;
    await saveInlineQueuedMessage({
      edit: inlineEditingQueuedMessage,
      queuedMessage,
      input: activeComposerDraftInput,
      updateQueuedMessage,
      onSaveSuccess,
      dismissInlineQueuedMessageEditor,
      ownsEditor: () =>
        currentUi.current.threadId ===
          inlineEditingQueuedMessage.ownerThreadId &&
        currentUi.current.editSessionId === editingSessionId,
      setProcessingQueuedMessage,
    });
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
