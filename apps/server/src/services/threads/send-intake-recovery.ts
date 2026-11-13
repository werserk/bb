import {
  findThreadSendIntakeClearCompletion,
  findThreadSendIntakeNativeRequest,
  getQueuedThreadMessage,
  hasThreadSendIntakeProviderAcceptance,
  readThreadSendIntakeEnvelope,
  type DbTransaction,
  type ThreadSendIntakeHandoff,
  type ThreadSendIntakeRow,
} from "@bb/db";
import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  systemOperationEventDataSchema,
  turnRequestEventDataSchema,
} from "@bb/domain";
import { sendMessageRequestSchema, type SendMessageResponse } from "@bb/server-contract";
import { persistedThreadProvisionContextSchema, readThreadStartupContextOfKind } from "./thread-startup-store.js";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

export function findSendIntakeHandoffProof(tx: DbTransaction, row: ThreadSendIntakeRow): {
  handoff: ThreadSendIntakeHandoff; receipt: string;
} | null {
  const stored = readThreadSendIntakeEnvelope(row);
  if (!stored || stored.effectStage === null) return null;
  const payload = sendMessageRequestSchema.parse(stored.payload);
  const ids = row.clientSubmissionId === null ? {} : { submissionIds: [row.clientSubmissionId] };
  const queued = row.clientSubmissionId === null ? null : getQueuedThreadMessage(tx, row.id);
  if (queued?.threadId === row.threadId) {
    const receipt: SendMessageResponse = { ok: true, delivery: "queued", queuedMessage: toThreadQueuedMessage(queued), ...ids };
    return { handoff: { kind: "queue", id: queued.id }, receipt: JSON.stringify(receipt) };
  }
  if (isStandaloneBuiltinClearCommand(payload.input)) {
    const event = findThreadSendIntakeClearCompletion(tx, row);
    if (!event) return null;
    const clear = systemOperationEventDataSchema.parse(JSON.parse(event.data));
    const receipt: SendMessageResponse = { ok: true, delivery: "sent", ...ids, ...(row.clientSubmissionId === null ? {} : { command: true }) };
    return { handoff: { kind: "clear", id: clear.operationId }, receipt: JSON.stringify(receipt) };
  }
  const standaloneCompact = isStandaloneBuiltinCompactCommand(payload.input);
  const event = findThreadSendIntakeNativeRequest(tx, row, standaloneCompact ? row.compactRequestId : null);
  if (!event) return null;
  const request = turnRequestEventDataSchema.parse(JSON.parse(event.data));
  const compactRequest = isStandaloneBuiltinCompactCommand(request.input);
  if (standaloneCompact !== compactRequest || (payload.compactFirst && request.requestId === row.compactRequestId)) return null;
  if (request.target.kind === "thread-start") {
    const startup = readThreadStartupContextOfKind(tx, row.threadId, "provisioning", persistedThreadProvisionContextSchema) ??
      readThreadStartupContextOfKind(tx, row.threadId, "dispatched", persistedThreadProvisionContextSchema);
    if (startup?.request.clientRequestId !== request.requestId &&
      !hasThreadSendIntakeProviderAcceptance(tx, row.threadId, request.requestId, event.sequence)) return null;
  }
  const receipt: SendMessageResponse = { ok: true, delivery: "sent", ...ids,
    ...(row.clientSubmissionId === null ? {} : { requested: { requestId: request.requestId, sequence: event.sequence } }) };
  return { handoff: request.target.kind === "thread-start" ? { kind: "startup", id: request.requestId } :
    { kind: "request", id: request.requestId, sequence: event.sequence }, receipt: JSON.stringify(receipt) };
}
