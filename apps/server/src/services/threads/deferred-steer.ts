import {
  createQueuedThreadMessageInTransaction,
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

export function recoverBusySteerInTransaction(args: {
  db: DbTransaction;
  thread: Thread;
  requestId: ClientTurnRequestId;
  message: string;
}): boolean {
  const row = getStoredTurnRequestEventByRequestId(args.db, {
    threadId: args.thread.id,
    requestId: args.requestId,
  });
  if (row === null) return false;
  const request = parseStoredTurnRequestEvent(row);
  if (!eligibleOwnerRequest(request)) return false;
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
    payload: { kind: "deferredSteer", sourceRequestId: args.requestId },
    systemNotice: null,
  });
  appendThreadEventInTransaction(args.db, {
    threadId: args.thread.id,
    environmentId: args.thread.environmentId,
    type: "client/turn/rejected",
    scope: threadScope(),
    data: {
      requestId: args.requestId,
      reason: "turn_not_steerable",
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
    inputGroups: request.inputGroups ?? [request.input],
    dispatchProvenance: request.dispatchProvenance,
    sourceRequestId: message.payload.sourceRequestId,
  };
}
