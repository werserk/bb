import type { ConversationQuestion } from "@bb/domain";
import type { QueryClientArg } from "../cache-effect-types";
import { conversationQuestionsQueryKey } from "../queries/conversation-question-query-key";

interface ThreadQuestionArg extends QueryClientArg {
  threadId: string;
}

interface QuestionArg extends ThreadQuestionArg {
  questionId: string;
}

interface HydrateConversationQuestionArgs extends QuestionArg {
  question: ConversationQuestion;
}

export function invalidateConversationQuestions({
  queryClient,
  threadId,
}: ThreadQuestionArg): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: conversationQuestionsQueryKey(threadId),
  });
}

export function hydrateConversationQuestion({
  queryClient,
  threadId,
  questionId,
  question,
}: HydrateConversationQuestionArgs): void {
  queryClient.setQueryData(
    [...conversationQuestionsQueryKey(threadId), questionId],
    question,
  );
}
