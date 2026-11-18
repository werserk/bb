import { classifyLocalQuestionAnswer } from "@bb/db";
import {
  createQueuedThreadMessageInTransaction,
  clearWithdrawnQuestionResponseReceipt,
  getConversationQuestion,
  restoreConversationQuestionDelivery,
  getStoredTurnRequestEventByRequestId,
  type DbQueryConnection,
  type DbTransaction,
} from "@bb/db";
import {
  flattenPromptInputGroups,
  permissionModeSchema,
  threadScope,
  type ClientTurnRequestId,
  type Thread,
  type TurnRequestEventData,
  type ThreadQueuedMessage,
} from "@bb/domain";
import {
  parseStoredTurnRequestEvent,
  appendThreadEventInTransaction,
} from "./thread-events.js";

function eligibleOwnerRequest(request: TurnRequestEventData): boolean {
  const provenance = request.dispatchProvenance;
  return (
    request.source === "tell" &&
    request.initiator === "user" &&
    request.senderThreadId === null &&
    request.serviceTurn === undefined &&
    request.input.length > 0 &&
    (request.target.kind === "auto" || request.target.kind === "steer") &&
    provenance !== undefined &&
    provenance.origin === null &&
    provenance.originPluginId === null &&
    provenance.requestedBy === null &&
    permissionModeSchema.safeParse(request.execution.permissionMode).success &&
    (request.inputGroups === undefined ||
      JSON.stringify(flattenPromptInputGroups(request.inputGroups)) ===
        JSON.stringify(request.input))
  );
}

export function readDeferredSteerRequest(
  db: DbQueryConnection,
  args: { threadId: string; sourceRequestId: ClientTurnRequestId },
): TurnRequestEventData {
  const row = getStoredTurnRequestEventByRequestId(db, {
    threadId: args.threadId,
    requestId: args.sourceRequestId,
  });
  if (row === null) throw new Error("Deferred steer source request is missing");
  const request = parseStoredTurnRequestEvent(row);
  if (!eligibleOwnerRequest(request))
    throw new Error("Deferred steer source has no eligible owner provenance");
  return request;
}

function immutableOwnerInput(request: TurnRequestEventData) {
  return {
    source: request.source,
    initiator: request.initiator,
    senderThreadId: request.senderThreadId,
    serviceTurn: request.serviceTurn,
    input: request.input,
    inputGroups: request.inputGroups ?? [request.input],
    provenance: request.dispatchProvenance,
    questionResponse:
      request.questionResponse === undefined
        ? undefined
        : {
            questionId: request.questionResponse.questionId,
            revision: request.questionResponse.revision,
          },
    model: request.execution.model,
    reasoningLevel: request.execution.reasoningLevel,
    permissionMode: request.execution.permissionMode,
    serviceTier: request.execution.serviceTier,
  };
}

export function recoverRefusedOwnerInputInTransaction(args: {
  db: DbTransaction;
  thread: Thread;
  requestId: ClientTurnRequestId;
  message: string;
  reason: "turn_not_steerable" | "competing_turn" | "stale_turn";
}): boolean {
  const row = getStoredTurnRequestEventByRequestId(args.db, {
    threadId: args.thread.id,
    requestId: args.requestId,
  });
  if (row === null) return false;
  let request = parseStoredTurnRequestEvent(row);
  let sourceRequestId = args.requestId;
  const questionResponse = request.questionResponse;
  if (args.reason === "stale_turn" && questionResponse === undefined)
    return false;
  if (
    args.reason === "competing_turn" &&
    request.deferredFromRequestId === undefined &&
    questionResponse === undefined
  )
    return false;
  if (
    args.reason === "competing_turn" &&
    request.deferredFromRequestId !== undefined
  ) {
    const source = getStoredTurnRequestEventByRequestId(args.db, {
      threadId: args.thread.id,
      requestId: request.deferredFromRequestId,
    });
    if (source === null) return false;
    const original = parseStoredTurnRequestEvent(source);
    if (
      JSON.stringify(immutableOwnerInput(request)) !==
      JSON.stringify(immutableOwnerInput(original))
    )
      return false;
    sourceRequestId = request.deferredFromRequestId;
    request = original;
  }
  if (!eligibleOwnerRequest(request)) return false;
  if (questionResponse !== undefined) {
    const verdict = classifyLocalQuestionAnswer(
      args.db,
      [
        {
          id: questionResponse.queuedMessageId,
          threadId: args.thread.id,
          senderThreadId: request.senderThreadId,
          payloadKind: "questionResponse",
          questionId: questionResponse.questionId,
          questionRevision: questionResponse.revision,
        },
      ],
      "submitted",
    );
    if (!verdict) return false;
    const question = getConversationQuestion(args.db, {
      threadId: args.thread.id,
      questionId: questionResponse.questionId,
    });
    if (
      question?.status === "withdrawn" &&
      clearWithdrawnQuestionResponseReceipt(args.db, {
        threadId: args.thread.id,
        ...questionResponse,
      })
    ) {
      appendThreadEventInTransaction(args.db, {
        threadId: args.thread.id,
        environmentId: args.thread.environmentId,
        type: "client/turn/rejected",
        scope: threadScope(),
        data: {
          requestId: args.requestId,
          reason: args.reason,
          message: args.message,
        },
      });
      return true;
    }
    if (
      question === null ||
      question.status !== "answered" ||
      question.revision !== questionResponse.revision ||
      question.queuedMessageId !== questionResponse.queuedMessageId ||
      question.dispatchedAt === null
    )
      return false;
  }
  const queued = createQueuedThreadMessageInTransaction(args.db, {
    threadId: args.thread.id,
    content: request.input,
    senderThreadId: null,
    origin: request.dispatchProvenance?.origin ?? null,
    originPluginId: request.dispatchProvenance?.originPluginId ?? null,
    requestedBy: request.dispatchProvenance?.requestedBy ?? null,
    model: request.execution.model,
    reasoningLevel: request.execution.reasoningLevel,
    permissionMode: permissionModeSchema.parse(
      request.execution.permissionMode,
    ),
    serviceTier: request.execution.serviceTier,
    waitingOn:
      args.thread.status === "stopping"
        ? { kind: "stopping" }
        : args.thread.status === "active"
          ? { kind: "thread-busy" }
          : null,
    sendAt: null,
    payload:
      questionResponse === undefined
        ? { kind: "deferredSteer", sourceRequestId }
        : {
            kind: "questionResponse",
            questionId: questionResponse.questionId,
            revision: questionResponse.revision,
          },
    systemNotice: null,
  });
  if (
    questionResponse !== undefined &&
    !restoreConversationQuestionDelivery(args.db, {
      threadId: args.thread.id,
      questionId: questionResponse.questionId,
      revision: questionResponse.revision,
      previousQueuedMessageId: questionResponse.queuedMessageId,
      queuedMessageId: queued.id,
    })
  )
    throw new Error("Question response custody changed during recovery");
  appendThreadEventInTransaction(args.db, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    type: "client/turn/rejected",
    scope: threadScope(),
    data: {
      requestId: args.requestId,
      reason: args.reason,
      message: args.message,
      deferredToQueuedMessageId: queued.id,
    },
  });
  return true;
}

export function resolveDeferredSteerQueuedMessage(
  db: DbQueryConnection,
  message: ThreadQueuedMessage,
) {
  if (message.payload.kind !== "deferredSteer") return null;
  const request = readDeferredSteerRequest(db, {
    threadId: message.threadId,
    sourceRequestId: message.payload.sourceRequestId,
  });
  return {
    message: {
      ...message,
      content: request.input,
      model: request.execution.model,
      reasoningLevel: request.execution.reasoningLevel,
      serviceTier: request.execution.serviceTier,
      permissionMode: permissionModeSchema.parse(
        request.execution.permissionMode,
      ),
    },
    clientSubmissions: request.clientSubmissions,
    inputGroups: request.inputGroups ?? [request.input],
    dispatchProvenance: request.dispatchProvenance,
    sourceRequestId: message.payload.sourceRequestId,
  };
}
