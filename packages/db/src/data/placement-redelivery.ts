import {
  classifyLocalQuestionAnswer,
  getConversationQuestion,
} from "./conversation-questions.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  canonicalJsonBytes,
  turnRequestEventDataSchema,
  turnRequestRejectedEventDataSchema,
} from "@bb/domain";
import type { DbTransaction } from "../connection.js";
import {
  events,
  queuedThreadMessages as queue,
  placementOperations as operations,
  placementAttempts as attempts,
  placementRetryTargets as targets,
} from "../schema.js";
import {
  readPlacementDispatchReceipt,
  PlacementDispatchConflictError,
  type PlacementDispatchKey,
} from "./placement-dispatch-receipts.js";
import {
  queueMemberDigest,
  readPlacementQueueAttempts,
} from "./placement-action-receipts.js";

// Called in the native refusal/recovery transaction. The native writer owns
// eligibility/reason, creation, withdrawn-question tombstones and answer rebind.
export function recordPlacementSteerRedelivery(
  tx: DbTransaction,
  args: PlacementDispatchKey & { rejectionSequence: number },
) {
  const source = readPlacementDispatchReceipt(tx, args);
  if (
    !source?.liveEventId ||
    !["refused", "refused_unsent"].includes(source.state)
  )
    throw new PlacementDispatchConflictError("no definitive refusal");
  const rejected = tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.sequence, args.rejectionSequence),
        eq(events.type, "client/turn/rejected"),
      ),
    )
    .get();
  if (!rejected)
    throw new PlacementDispatchConflictError("native rejection missing");
  const rejection = turnRequestRejectedEventDataSchema.parse(
    JSON.parse(rejected.data),
  );
  if (
    rejection.requestId !== source.request ||
    rejected.sequence <= source.requestSequence
  )
    throw new PlacementDispatchConflictError("wrong native rejection");
  if (!rejection.deferredToQueuedMessageId) {
    const saved = tx
      .select()
      .from(events)
      .where(eq(events.id, source.eventId))
      .get()!;
    const response = turnRequestEventDataSchema.parse(
      JSON.parse(saved.data),
    ).questionResponse;
    if (response) {
      const q = getConversationQuestion(tx, {
        threadId: args.threadId,
        questionId: response.questionId,
      });
      if (
        q?.status !== "withdrawn" ||
        q.revision !== response.revision ||
        q.queuedMessageId !== response.queuedMessageId ||
        q.dispatchedAt !== null
      )
        throw new PlacementDispatchConflictError("withdrawal receipt changed");
    }
    return null;
  }
  const qid = rejection.deferredToQueuedMessageId;
  const prior = readPlacementQueueAttempts(tx, qid);
  const saved = tx
    .select()
    .from(events)
    .where(eq(events.id, source.eventId))
    .get()!;
  const body = turnRequestEventDataSchema.parse(JSON.parse(saved.data));
  if (
    !source.members.length ||
    body.source !== "tell" ||
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
    )
  )
    throw new PlacementDispatchConflictError("ineligible recovery");
  if (prior.length) {
    if (
      prior.length !== source.members.length ||
      prior.some(
        (m, i) =>
          m.op !== source.members[i]!.op ||
          m.step !== source.members[i]!.step ||
          m.attempt !== source.members[i]!.attempt + 1,
      )
    )
      throw new PlacementDispatchConflictError("replacement identity conflict");
    return qid;
  }
  if (
    tx
      .select()
      .from(targets)
      .where(
        and(
          eq(targets.failedRequest, args.requestId),
          inArray(targets.state, ["held", "scheduled", "spent"]),
        ),
      )
      .get()
  )
    throw new PlacementDispatchConflictError("retry already owns input");
  const row = tx.select().from(queue).where(eq(queue.id, qid)).get();
  const original = body.deferredFromRequestId ?? body.requestId;
  if (
    !row ||
    row.threadId !== source.thread ||
    row.placementOperationId !== null ||
    canonicalJsonBytes(JSON.parse(row.content)) !==
      canonicalJsonBytes(body.input) ||
    (body.questionResponse
      ? row.payloadKind !== "questionResponse" ||
        row.questionId !== body.questionResponse.questionId ||
        row.questionRevision !== body.questionResponse.revision
      : row.payloadKind !== "deferredSteer" ||
        row.retryOfTurnRequestId !== original)
  )
    throw new PlacementDispatchConflictError(
      "replacement row differs from refused input",
    );
  if (body.questionResponse && !classifyLocalQuestionAnswer(tx, [row]))
    throw new PlacementDispatchConflictError("question receipt not rebound");
  const updated = tx
    .update(queue)
    .set({
      placementOperationId: source.members[0]!.op,
      placementFence: source.fence,
    })
    .where(eq(queue.id, qid))
    .returning()
    .get();
  for (const m of source.members) {
    const latest = tx
      .select()
      .from(attempts)
      .where(and(eq(attempts.op, m.op), eq(attempts.step, m.step)))
      .orderBy(asc(attempts.attempt))
      .all()
      .at(-1);
    if (latest?.request !== args.requestId)
      throw new PlacementDispatchConflictError("replacement already assigned");
    tx.insert(attempts)
      .values({
        op: m.op,
        step: m.step,
        attempt: m.attempt + 1,
        queueId: qid,
        queueOrdinal: m.ordinal,
        queueDigest: queueMemberDigest(updated),
      })
      .run();
    tx.update(operations)
      .set({ phase: "queued", revision: sql`${operations.revision}+1` })
      .where(eq(operations.id, m.op))
      .run();
  }
  return qid;
}
