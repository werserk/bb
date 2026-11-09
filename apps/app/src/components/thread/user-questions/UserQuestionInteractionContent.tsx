import { usePlanEditorOwner } from "../pending-interactions/plan-editor-ownership";
import { useMemo } from "react";
import type { PendingInteractionUserQuestionQuestion } from "@bb/domain";
import { QuestionForm } from "@bb/shared-ui/question-form";
import { useResolveThreadPendingInteraction } from "@/hooks/mutations/thread-interaction-mutations";
import { useStopThread } from "@/hooks/mutations/thread-runtime-mutations";
import { getMutationErrorMessage } from "@/lib/mutation-errors";

interface UserQuestionAnswerFormProps {
  interactionId: string;
  plan?: { priority: number; onSkip: () => void };
  isResolving: boolean;
  questions: readonly PendingInteractionUserQuestionQuestion[];
  threadId: string;
}

export function UserQuestionAnswerForm({
  interactionId,
  plan,
  isResolving,
  questions,
  threadId,
}: UserQuestionAnswerFormProps) {
  const normalizedQuestions = useMemo(
    () =>
      questions.map((question, index) => ({
        ...question,
        shortLabel: question.shortLabel ?? `Question ${index + 1}`,
        options: question.options ?? [],
      })),
    [questions],
  );
  const resolvePendingInteraction =
    useResolveThreadPendingInteraction(threadId);
  const stopThread = useStopThread();
  const ownsEditor = usePlanEditorOwner(
    `${threadId}:${interactionId}`,
    0,
    !plan,
  );
  const disabled = resolvePendingInteraction.isPending || isResolving;
  const error = resolvePendingInteraction.error
    ? getMutationErrorMessage({
        error: resolvePendingInteraction.error,
        fallbackMessage: "Failed to submit answer",
        lifecycleOperation: "resolve_interaction",
      })
    : null;
  if (!plan && !ownsEditor) return null;
  return (
    <div>
      <QuestionForm
        mode={plan ? "plan" : "native"}
        key={interactionId}
        draftKey={`${threadId}:${interactionId}`}
        questions={normalizedQuestions}
        disabled={disabled}
        cancelDisabled={disabled || stopThread.isPending}
        onSubmit={(answers) => {
          return resolvePendingInteraction
            .mutateAsync({
              threadId,
              interactionId,
              resolution: { kind: "user_answer", answers },
            })
            .then(() => {});
        }}
        onCancel={
          plan
            ? plan.onSkip
            : () => stopThread.mutateAsync(threadId).then(() => {})
        }
      />
      {error ? (
        <div className="mt-2 shrink-0 rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">
          {error}
        </div>
      ) : null}
    </div>
  );
}
