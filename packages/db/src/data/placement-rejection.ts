import { and, eq, gt } from "drizzle-orm";
import {
  turnRequestEventDataSchema,
  clientTurnRequestIdSchema,
  turnRequestRejectedEventDataSchema,
} from "@bb/domain";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import {
  events,
  placementEffects as effects,
  placementAttempts as attempts,
  placementRejectionReasons,
} from "../schema.js";
import {
  getLatestThreadSequence,
  getLatestTurnRequestEventRow,
  hasStoredTerminalClientTurnRequestEvent,
} from "./events.js";
import { PlacementDispatchConflictError } from "./placement-dispatch-errors.js";

type Anchor = Pick<
  typeof effects.$inferSelect,
  | "thread"
  | "request"
  | "requestSequence"
  | "eventId"
  | "liveEventId"
  | "rejectionEventId"
  | "liveRejectionEventId"
>;
export function readLinkedPlacementRejection(
  db: DbQueryConnection,
  source: Anchor,
) {
  if (
    !source.liveEventId ||
    !source.liveRejectionEventId ||
    source.rejectionEventId !== source.liveRejectionEventId
  )
    return null;
  const event = db
    .select({ sequence: events.sequence, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.id, source.liveRejectionEventId),
        eq(events.threadId, source.thread),
        gt(events.sequence, source.requestSequence),
        eq(events.scopeKind, "thread"),
        eq(events.type, "client/turn/rejected"),
      ),
    )
    .get();
  if (!event) return null;
  const parsed = turnRequestRejectedEventDataSchema.parse(
    JSON.parse(event.data),
  );
  return parsed.requestId === source.request
    ? { sequence: event.sequence, data: parsed }
    : null;
}
export function readPlacementRedeliveryEvidence(
  db: DbQueryConnection,
  source: Anchor & Pick<typeof effects.$inferSelect, "state">,
) {
  if (source.state !== "refused") return null;
  const native = readLinkedPlacementRejection(db, source);
  if (!native) return null;
  const requested = db
    .select({ data: events.data })
    .from(events)
    .where(eq(events.id, source.eventId))
    .get();
  if (!requested) return null;
  const body = turnRequestEventDataSchema.parse(JSON.parse(requested.data));
  const rejection = native.data;
  if (
    rejection.deferredToQueuedMessageId &&
    (body.source !== "tell" ||
      body.initiator !== "user" ||
      body.senderThreadId !== null ||
      body.serviceTurn ||
      !body.dispatchProvenance ||
      Object.values(body.dispatchProvenance).some((v) => v !== null) ||
      !(body.target.kind === "auto" || body.target.kind === "steer") ||
      !(
        rejection.reason === "turn_not_steerable" ||
        (rejection.reason === "competing_turn" &&
          (body.deferredFromRequestId || body.questionResponse)) ||
        (rejection.reason === "stale_turn" && body.questionResponse)
      ))
  )
    return null;
  return { ...native, body };
}
export function placementAttemptHasSource(
  db: DbQueryConnection,
  member: typeof attempts.$inferSelect,
) {
  if (member.attempt === 0) return true;
  const parent = db
    .select({ effect: effects })
    .from(attempts)
    .innerJoin(effects, eq(effects.request, attempts.request))
    .where(
      and(
        eq(attempts.op, member.op),
        eq(attempts.step, member.step),
        eq(attempts.attempt, member.attempt - 1),
      ),
    )
    .get()?.effect;
  return (
    !!member.queueId &&
    !!parent &&
    readPlacementRedeliveryEvidence(db, parent)?.data
      .deferredToQueuedMessageId === member.queueId
  );
}
export function capturePlacementRejection(
  write: DbTransaction,
  receipt: Anchor,
  state: "refused" | "refused_unsent",
  append: (tx: DbTransaction) => number,
) {
  const threadId = receipt.thread;
  if (
    !receipt.liveEventId ||
    getLatestTurnRequestEventRow(write, threadId)?.id !== receipt.eventId ||
    hasStoredTerminalClientTurnRequestEvent(write, {
      threadId,
      requestId: clientTurnRequestIdSchema.parse(receipt.request),
    })
  )
    return null;
  const next = getLatestThreadSequence(write, { threadId }) + 1;
  const sequence = append(write);
  const native = write
    .select({ id: events.id, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.sequence, sequence),
        eq(events.scopeKind, "thread"),
        eq(events.type, "client/turn/rejected"),
      ),
    )
    .get();
  if (
    sequence !== next ||
    !native ||
    getLatestThreadSequence(write, { threadId }) !== sequence
  )
    throw new PlacementDispatchConflictError(
      "missing freshly appended rejection",
    );
  const rejection = turnRequestRejectedEventDataSchema.parse(
    JSON.parse(native.data),
  );
  if (
    rejection.requestId !== receipt.request ||
    (state === "refused_unsent" &&
      rejection.deferredToQueuedMessageId !== undefined)
  )
    throw new PlacementDispatchConflictError("rejection request mismatch");
  return {
    rejectionEventId: native.id,
    liveRejectionEventId: native.id,
    rejectionReason:
      state === "refused_unsent"
        ? (placementRejectionReasons.find(
            (value) => value === rejection.reason,
          ) ?? null)
        : null,
  };
}
