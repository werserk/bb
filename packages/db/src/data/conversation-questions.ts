import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  clientTurnRequestIdSchema,
  turnRequestEventDataSchema,
  type ClientTurnRequestId,
  type ConversationQuestionStatus,
} from "@bb/domain";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import { createConversationQuestionId } from "../ids.js";
import {
  conversationQuestions,
  threads,
  projects,
  events,
  questionResolutionEvents,
} from "../schema.js";
import { getQuestionResolutionDelivery } from "./question-resolution-events.js";
import { getStoredTurnRequestEventByRequestId } from "./events.js";

export type ConversationQuestionRow = typeof conversationQuestions.$inferSelect;

export function createConversationQuestion(
  db: DbQueryConnection,
  input: {
    id?: string;
    threadId: string;
    sourceTurnId: string | null;
    sourceCallId: string | null;
    publication: string;
    materialManifest: string;
  },
): ConversationQuestionRow | null {
  const now = Date.now();
  return (
    db
      .insert(conversationQuestions)
      .values({
        ...input,
        id: input.id ?? createConversationQuestionId(),
        revision: 1,
        status: "open",
        response: null,
        queuedMessageId: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning()
      .get() ?? null
  );
}

export function getConversationQuestion(
  db: DbQueryConnection,
  args: { threadId: string; questionId: string },
): ConversationQuestionRow | null {
  return (
    db
      .select()
      .from(conversationQuestions)
      .where(
        and(
          eq(conversationQuestions.threadId, args.threadId),
          eq(conversationQuestions.id, args.questionId),
        ),
      )
      .get() ?? null
  );
}

export function getConversationQuestionBySource(
  db: DbQueryConnection,
  args: { threadId: string; sourceTurnId: string; sourceCallId: string },
): ConversationQuestionRow | null {
  return (
    db
      .select()
      .from(conversationQuestions)
      .where(
        and(
          eq(conversationQuestions.threadId, args.threadId),
          eq(conversationQuestions.sourceTurnId, args.sourceTurnId),
          eq(conversationQuestions.sourceCallId, args.sourceCallId),
        ),
      )
      .get() ?? null
  );
}

export function listConversationQuestions(
  db: DbQueryConnection,
  args: {
    threadId: string;
    statuses?: readonly ConversationQuestionStatus[];
    limit?: number;
  },
): ConversationQuestionRow[] {
  return db
    .select()
    .from(conversationQuestions)
    .where(
      and(
        eq(conversationQuestions.threadId, args.threadId),
        args.statuses === undefined
          ? undefined
          : inArray(conversationQuestions.status, [...args.statuses]),
      ),
    )
    .orderBy(
      desc(conversationQuestions.createdAt),
      desc(conversationQuestions.id),
    )
    .limit(Math.max(1, Math.min(args.limit ?? 200, 200)))
    .all();
}

type SetConversationQuestionTerminalArgs = {
  threadId: string;
  questionId: string;
  revision: number;
} & (
  | { status: "answered"; response: string; queuedMessageId: string }
  | { status: "dismissed" | "withdrawn"; response: null; queuedMessageId: null }
);

export function setConversationQuestionTerminal(
  db: DbQueryConnection,
  args: SetConversationQuestionTerminalArgs,
): ConversationQuestionRow | null {
  return (
    db
      .update(conversationQuestions)
      .set({
        status: args.status,
        response: args.response,
        queuedMessageId: args.queuedMessageId,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(conversationQuestions.threadId, args.threadId),
          eq(conversationQuestions.id, args.questionId),
          eq(conversationQuestions.revision, args.revision),
          eq(conversationQuestions.status, "open"),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export function withdrawConversationQuestion(
  db: DbQueryConnection,
  args: { threadId: string; questionId: string; revision: number },
): ConversationQuestionRow | null {
  return (
    db
      .update(conversationQuestions)
      .set({ status: "withdrawn", updatedAt: Date.now() })
      .where(
        and(
          eq(conversationQuestions.threadId, args.threadId),
          eq(conversationQuestions.id, args.questionId),
          eq(conversationQuestions.revision, args.revision),
          inArray(conversationQuestions.status, ["open", "answered"]),
        ),
      )
      .returning()
      .get() ?? null
  );
}

export class QuestionResponseNotDeliverableError extends Error {
  constructor(
    readonly queuedMessageId: string,
    reason: string,
  ) {
    super(`Question response held: ${reason}`);
    this.name = "QuestionResponseNotDeliverableError";
  }
}

export function requireQuestionResponseDeliverable(
  db: DbQueryConnection,
  row: {
    id: string;
    threadId: string;
    questionId: string | null;
    questionRevision: number | null;
  },
): void {
  const thread = db
    .select({ archivedAt: threads.archivedAt, deletedAt: threads.deletedAt })
    .from(threads)
    .where(eq(threads.id, row.threadId))
    .get();
  const question =
    row.questionId === null
      ? null
      : getConversationQuestion(db, {
          threadId: row.threadId,
          questionId: row.questionId,
        });
  const resolution = getQuestionResolutionDelivery(db, row.id);
  const cancellation =
    resolution?.submittedAt === null &&
    resolution.attribution.action === "withdraw" &&
    resolution.attribution.targetKind === "qst" &&
    resolution.attribution.targetId === row.questionId &&
    resolution.attribution.threadId === row.threadId &&
    resolution.attribution.revision === row.questionRevision;
  const reason =
    !thread || thread.deletedAt !== null
      ? "thread deleted"
      : thread.archivedAt !== null
        ? "thread archived"
        : !question
          ? "question missing"
          : question.revision !== row.questionRevision
            ? "question revision changed"
            : question.status === "withdrawn" && cancellation
              ? null
              : question.status !== "answered"
                ? `question ${question.status}`
                : question.queuedMessageId !== row.id ||
                    question.response === null
                  ? "response ownership changed"
                  : null;
  if (reason !== null)
    throw new QuestionResponseNotDeliverableError(row.id, reason);
}

const questionOwner = alias(threads, "question_owner");
const questionProject = alias(projects, "question_project");

function openConversationQuestionPredicate(threadId: string | SQLWrapper) {
  return and(
    eq(conversationQuestions.threadId, threadId),
    eq(conversationQuestions.status, "open"),
    sql`EXISTS (SELECT 1 FROM ${threads} ${questionOwner}
      INNER JOIN ${projects} ${questionProject} ON ${questionProject.id} = ${questionOwner.projectId}
      WHERE ${questionOwner.id} = ${conversationQuestions.threadId}
        AND ${questionOwner.visibility} = 'visible'
        AND ${questionOwner.archivedAt} IS NULL
        AND ${questionOwner.deletedAt} IS NULL
        AND ${questionProject.deletedAt} IS NULL)`,
  );
}

export function getOpenConversationQuestionSummary(
  db: DbQueryConnection,
  threadId: string,
): { total: number; firstQuestionId: string | null } {
  const predicate = openConversationQuestionPredicate(threadId);
  const total =
    db
      .select({ total: count() })
      .from(conversationQuestions)
      .where(predicate)
      .get()?.total ?? 0;
  const firstQuestionId =
    total === 0
      ? null
      : (db
          .select({ id: conversationQuestions.id })
          .from(conversationQuestions)
          .where(predicate)
          .orderBy(
            asc(conversationQuestions.createdAt),
            asc(conversationQuestions.id),
          )
          .limit(1)
          .get()?.id ?? null);
  return { total, firstQuestionId };
}

export function listOpenConversationQuestionPage(
  db: DbQueryConnection,
  args: {
    threadId: string;
    limit: number;
    after?: { createdAt: number; id: string };
  },
): ConversationQuestionRow[] {
  return db
    .select()
    .from(conversationQuestions)
    .where(
      and(
        openConversationQuestionPredicate(args.threadId),
        args.after === undefined
          ? undefined
          : or(
              lt(conversationQuestions.createdAt, args.after.createdAt),
              and(
                eq(conversationQuestions.createdAt, args.after.createdAt),
                lt(conversationQuestions.id, args.after.id),
              ),
            ),
      ),
    )
    .orderBy(
      desc(conversationQuestions.createdAt),
      desc(conversationQuestions.id),
    )
    .limit(args.limit)
    .all();
}

export function listOpenConversationQuestionIdentities(
  db: DbQueryConnection,
  threadId: string,
) {
  return db
    .select({
      id: conversationQuestions.id,
      revision: conversationQuestions.revision,
    })
    .from(conversationQuestions)
    .where(openConversationQuestionPredicate(threadId))
    .orderBy(
      desc(conversationQuestions.createdAt),
      desc(conversationQuestions.id),
    )
    .all();
}

export function classifyLocalQuestionAnswer(
  db: DbQueryConnection,
  group: readonly {
    id: string;
    threadId: string;
    senderThreadId: string | null;
    payloadKind: string;
    questionId: string | null;
    questionRevision: number | null;
  }[],
  phase: "queued" | "submitted" = "queued",
) {
  const row = group.length === 1 ? group[0] : undefined;
  if (
    !row ||
    row.payloadKind !== "questionResponse" ||
    row.senderThreadId !== null ||
    row.questionId === null ||
    row.questionRevision === null
  )
    return undefined;
  const question = getConversationQuestion(db, {
    threadId: row.threadId,
    questionId: row.questionId,
  });
  const receipt = getQuestionResolutionDelivery(db, row.id);
  const attribution = receipt?.attribution;
  if (
    !question ||
    !receipt ||
    !attribution ||
    attribution.action !== "answer" ||
    attribution.actor.kind !== "local-unverified" ||
    attribution.targetKind !== "qst" ||
    attribution.targetId !== row.questionId ||
    attribution.threadId !== row.threadId ||
    attribution.revision !== row.questionRevision ||
    attribution.deliveryId !== row.id ||
    question.revision !== row.questionRevision ||
    question.queuedMessageId !== row.id
  )
    return undefined;
  if ((question.dispatchedAt === null) !== (receipt.submittedAt === null))
    throw new Error("Question response receipts disagree");
  if (
    phase === "queued"
      ? question.status !== "answered" || receipt.submittedAt !== null
      : !["answered", "withdrawn"].includes(question.status) ||
        receipt.submittedAt === null
  )
    return undefined;
  return {
    questionId: row.questionId,
    revision: row.questionRevision,
    queuedMessageId: row.id,
  };
}

function requireSubmittedLocalAnswer(
  db: DbQueryConnection,
  args: {
    threadId: string;
    questionId: string;
    revision: number;
    queuedMessageId: string;
  },
) {
  const identity = classifyLocalQuestionAnswer(
    db,
    [
      {
        id: args.queuedMessageId,
        threadId: args.threadId,
        senderThreadId: null,
        payloadKind: "questionResponse",
        questionId: args.questionId,
        questionRevision: args.revision,
      },
    ],
    "submitted",
  );
  if (!identity)
    throw new Error("Question response custody changed during recovery");
  return getQuestionResolutionDelivery(db, args.queuedMessageId)!;
}

export function restoreConversationQuestionDelivery(
  db: DbTransaction,
  args: {
    threadId: string;
    questionId: string;
    revision: number;
    previousQueuedMessageId: string;
    queuedMessageId: string;
  },
): boolean {
  const receipt = requireSubmittedLocalAnswer(db, {
    ...args,
    queuedMessageId: args.previousQueuedMessageId,
  });
  const changed =
    db
      .update(conversationQuestions)
      .set({
        queuedMessageId: args.queuedMessageId,
        dispatchedAt: null,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(conversationQuestions.threadId, args.threadId),
          eq(conversationQuestions.id, args.questionId),
          eq(conversationQuestions.revision, args.revision),
          eq(conversationQuestions.status, "answered"),
          eq(
            conversationQuestions.queuedMessageId,
            args.previousQueuedMessageId,
          ),
          isNotNull(conversationQuestions.dispatchedAt),
        ),
      )
      .returning({ id: conversationQuestions.id })
      .get() !== undefined;
  if (!changed) return false;
  const audit = db
    .update(questionResolutionEvents)
    .set({
      deliveryId: args.queuedMessageId,
      submittedAt: null,
      attribution: JSON.stringify({
        ...receipt.attribution,
        deliveryId: args.queuedMessageId,
      }),
    })
    .where(
      and(
        eq(questionResolutionEvents.id, receipt.attribution.id),
        eq(questionResolutionEvents.deliveryId, args.previousQueuedMessageId),
        eq(questionResolutionEvents.submittedAt, receipt.submittedAt!),
      ),
    )
    .returning({ id: questionResolutionEvents.id })
    .get();
  if (!audit)
    throw new Error("Question answer audit custody changed during recovery");
  return true;
}

export function clearWithdrawnQuestionResponseReceipt(
  db: DbTransaction,
  args: {
    threadId: string;
    questionId: string;
    revision: number;
    queuedMessageId: string;
  },
): boolean {
  const receipt = requireSubmittedLocalAnswer(db, args);
  const changed =
    db
      .update(conversationQuestions)
      .set({ dispatchedAt: null, updatedAt: Date.now() })
      .where(
        and(
          eq(conversationQuestions.threadId, args.threadId),
          eq(conversationQuestions.id, args.questionId),
          eq(conversationQuestions.revision, args.revision),
          eq(conversationQuestions.status, "withdrawn"),
          eq(conversationQuestions.queuedMessageId, args.queuedMessageId),
          isNotNull(conversationQuestions.dispatchedAt),
        ),
      )
      .returning({ id: conversationQuestions.id })
      .get() !== undefined;
  if (!changed) return false;
  const audit = db
    .update(questionResolutionEvents)
    .set({ submittedAt: null })
    .where(
      and(
        eq(questionResolutionEvents.id, receipt.attribution.id),
        eq(questionResolutionEvents.deliveryId, args.queuedMessageId),
        eq(questionResolutionEvents.submittedAt, receipt.submittedAt!),
      ),
    )
    .returning({ id: questionResolutionEvents.id })
    .get();
  if (!audit)
    throw new Error("Question answer audit custody changed during retirement");
  return true;
}

export function getQueuedQuestionResponseDeferral(
  db: DbQueryConnection,
  args: { threadId: string; queuedMessageId: string },
): ClientTurnRequestId | null {
  const row = db
    .select({
      requestId: sql<unknown>`json_extract(${events.data}, '$.requestId')`,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, args.threadId),
        eq(events.type, "client/turn/rejected"),
        sql`json_extract(${events.data}, '$.deferredToQueuedMessageId') = ${args.queuedMessageId}`,
      ),
    )
    .orderBy(desc(events.sequence))
    .limit(1)
    .get();
  if (row === undefined) return null;
  const requestId = clientTurnRequestIdSchema.parse(row.requestId);
  const request = getStoredTurnRequestEventByRequestId(db, {
    threadId: args.threadId,
    requestId,
  });
  if (request === null)
    throw new Error("Question response deferral source is missing");
  return (
    turnRequestEventDataSchema.parse(JSON.parse(request.data))
      .deferredFromRequestId ?? requestId
  );
}

export function openConversationQuestionExists(threadId: string | SQLWrapper) {
  return sql<number>`EXISTS (SELECT 1 FROM ${conversationQuestions} WHERE ${openConversationQuestionPredicate(threadId)})`;
}
export function hasOpenConversationQuestion(
  db: DbQueryConnection,
  threadId: string,
): boolean {
  return (
    (db
      .select({ found: openConversationQuestionExists(threadId) })
      .from(threads)
      .where(eq(threads.id, threadId))
      .get()?.found ?? 0) > 0
  );
}
