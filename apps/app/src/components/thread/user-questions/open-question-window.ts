import type {
  ConversationQuestion,
  ConversationQuestionsOpenPage,
} from "@bb/domain";
import { BbHttpError } from "@bb/sdk/browser";

type Open = (args: {
  threadId: string;
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
}) => Promise<ConversationQuestionsOpenPage>;

export async function readOpenQuestionWindow({
  open,
  threadId,
  pages,
  signal,
}: {
  open: Open;
  threadId: string;
  pages: number;
  signal: AbortSignal;
}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const questions = new Map<string, ConversationQuestion>();
    let nextCursor: string | null = null;
    let revision: string | null = null;
    let total = 0;
    try {
      for (let index = 0; index < pages; index++) {
        signal.throwIfAborted();
        const page = await open({
          threadId,
          signal,
          limit: 100,
          ...(nextCursor ? { cursor: nextCursor } : {}),
        });
        signal.throwIfAborted();
        if (revision !== null && revision !== page.readRevision)
          throw new BbHttpError({
            status: 409,
            code: "stale-question-cursor",
            message: "Question list changed",
            body: null,
          });
        revision = page.readRevision;
        total = page.total;
        for (const question of page.questions)
          questions.set(question.id, question);
        nextCursor = page.nextCursor;
        if (nextCursor === null) break;
      }
      return {
        questions: [...questions.values()],
        total,
        nextCursor,
        incomplete: false,
      };
    } catch (error) {
      if (
        !(error instanceof BbHttpError) ||
        error.status !== 409 ||
        error.code !== "stale-question-cursor"
      )
        throw error;
      if (attempt === 1) {
        if (revision === null) throw error;
        return {
          questions: [...questions.values()],
          total,
          nextCursor,
          incomplete: true,
        };
      }
    }
  }
  throw new Error("Unable to read open questions");
}
