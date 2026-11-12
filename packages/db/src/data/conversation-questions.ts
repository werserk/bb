import { and, desc, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import type { ConversationQuestionStatus } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { createConversationQuestionId } from "../ids.js";
import { conversationQuestions, threads } from "../schema.js";

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
  const reason =
    !thread || thread.deletedAt !== null
      ? "thread deleted"
      : thread.archivedAt !== null
        ? "thread archived"
        : !question
          ? "question missing"
          : question.revision !== row.questionRevision
            ? "question revision changed"
            : question.status !== "answered"
              ? `question ${question.status}`
              : question.queuedMessageId !== row.id ||
                  question.response === null
                ? "response ownership changed"
                : null;
  if (reason !== null)
    throw new QuestionResponseNotDeliverableError(row.id, reason);
}

export function openConversationQuestionExists(threadId: string | SQLWrapper) {
  return sql<number>`EXISTS (SELECT 1 FROM ${conversationQuestions} WHERE ${conversationQuestions.threadId} = ${threadId} AND ${conversationQuestions.status} = 'open')`;
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
