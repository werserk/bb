import {
  queuedMessagePayloadSchema,
  type QueuedMessagePayload,
} from "@bb/domain";

interface StoredQueuePayload {
  payloadKind: QueuedMessagePayload["kind"];
  retryOfTurnRequestId: string | null;
  retryAttempt: number | null;
  retryReason: string | null;
}

export function encodeQueuedMessagePayload(
  payload: QueuedMessagePayload,
): StoredQueuePayload {
  const parsed = queuedMessagePayloadSchema.parse(payload);
  return {
    payloadKind: parsed.kind,
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
