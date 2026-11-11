import { useQuestionNavigation } from "./question-navigation";
import type { QuestionNavigationKind } from "./question-navigation-events";

export function useQuestionLinkState(
  questionId: string,
  kind: QuestionNavigationKind,
) {
  const navigation = useQuestionNavigation();
  const active =
    navigation?.feedback?.origin === "inline" &&
    navigation.feedback.questionId === questionId &&
    navigation.feedback.kind === kind;
  return {
    pending: active && navigation.pending,
    error: active ? navigation.error : null,
  };
}

export function QuestionNavigationFeedback({
  questionId,
  kind,
}: {
  questionId: string;
  kind: QuestionNavigationKind;
}) {
  const navigation = useQuestionNavigation();
  const { pending, error } = useQuestionLinkState(questionId, kind);
  if (!pending && !error) return null;
  return (
    <div role="status" className="text-xs text-muted-foreground">
      {pending ? (
        "Opening message…"
      ) : (
        <>
          {error}{" "}
          <button
            type="button"
            className="min-h-9 underline pointer-coarse:min-h-11"
            onClick={navigation?.retry}
          >
            Retry
          </button>
        </>
      )}
    </div>
  );
}
