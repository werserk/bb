import {
  queuedMessagePayloadSchema,
  type QueuedMessagePayload,
} from "@bb/domain";

interface StoredQueuePayload {
  payloadKind: QueuedMessagePayload["kind"];
  retryOfTurnRequestId: string | null;
  retryAttempt: number | null;
  retryReason: string | null;
  questionId?: string | null;
  questionRevision?: number | null;
}

export function encodeQueuedMessagePayload(
  payload: QueuedMessagePayload,
): StoredQueuePayload {
  const parsed = queuedMessagePayloadSchema.parse(payload);
  return {
    payloadKind: parsed.kind,
    questionId: parsed.kind === "questionResponse" ? parsed.questionId : null,
    questionRevision:
      parsed.kind === "questionResponse" ? parsed.revision : null,
    retryOfTurnRequestId:
      parsed.kind === "retry"
        ? parsed.retryOfTurnRequestId
        : parsed.kind === "deferredSteer"
          ? parsed.sourceRequestId
          : null,
    retryAttempt: parsed.kind === "retry" ? parsed.attempt : null,
    retryReason: parsed.kind === "retry" ? parsed.reason : null,
  };
}

export function parseStoredQueuedMessagePayload(
  row: StoredQueuePayload,
): QueuedMessagePayload {
  if (
    row.payloadKind === "questionResponse" &&
    row.retryOfTurnRequestId === null &&
    row.retryAttempt === null &&
    row.retryReason === null
  ) {
    return queuedMessagePayloadSchema.parse({
      kind: "questionResponse",
      questionId: row.questionId,
      revision: row.questionRevision,
    });
  }
  if (row.questionId != null || row.questionRevision != null)
    throw new Error("Malformed stored question-response payload");
  if (
    row.payloadKind === "inline" &&
    row.retryOfTurnRequestId === null &&
    row.retryAttempt === null &&
    row.retryReason === null
  )
    return { kind: "inline" };
  if (
    row.payloadKind === "deferredSteer" &&
    row.retryAttempt === null &&
    row.retryReason === null
  ) {
    return queuedMessagePayloadSchema.parse({
      kind: "deferredSteer",
      sourceRequestId: row.retryOfTurnRequestId,
    });
  }
  if (row.payloadKind === "retry") {
    return queuedMessagePayloadSchema.parse({
      kind: "retry",
      retryOfTurnRequestId: row.retryOfTurnRequestId,
      attempt: row.retryAttempt,
      reason: row.retryReason,
    });
  }
  throw new Error("Malformed stored queued-message payload");
}
