import { useQuery } from "@tanstack/react-query";
import { sdk } from "@/lib/sdk";
import { conversationQuestionsQueryKey } from "./conversation-question-query-key";

export function useComposerSuggestionQuestions(
  threadId: string,
  connected: boolean,
) {
  const query = useQuery({
    queryKey: [...conversationQuestionsQueryKey(threadId), "suggestion-guard"],
    queryFn: ({ signal }) =>
      sdk.threads.questions.open({ threadId, limit: 1, signal }),
    enabled: connected,
    retry: false,
    gcTime: 0,
  });
  return query.isFetching || query.isError || !connected
    ? undefined
    : query.data;
}
