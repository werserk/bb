export function conversationQuestionsQueryKey(threadId?: string) {
  return threadId
    ? (["conversationQuestions", threadId] as const)
    : (["conversationQuestions"] as const);
}
