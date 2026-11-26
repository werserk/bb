import { readPlacementRedeliveryEvidence } from "./placement-rejection.js";
import {
  classifyLocalQuestionAnswer,
  getConversationQuestion,
} from "./conversation-questions.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { canonicalJsonBytes } from "@bb/domain";
import type { DbTransaction } from "../connection.js";
import {
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
  return tx.transaction((write) => linkRedelivery(write, args));
}
function linkRedelivery(
  tx: DbTransaction,
  args: PlacementDispatchKey & { rejectionSequence: number },
) {
  const source = readPlacementDispatchReceipt(tx, args);
  if (source?.state !== "refused")
    throw new PlacementDispatchConflictError("no post-handoff refusal");
  const native = readPlacementRedeliveryEvidence(tx, source);
  if (!native || native.sequence !== args.rejectionSequence)
    throw new PlacementDispatchConflictError("authoritative rejection missing");
  const { body, data: rejection } = native;
  if (!rejection.deferredToQueuedMessageId) {
    const response = body.questionResponse;
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
  if (!source.members.length)
    throw new PlacementDispatchConflictError("no source membership");
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
