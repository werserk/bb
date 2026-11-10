import { useEffect, useRef } from "react";
import { focusPlanElement } from "./thread-plan-focus";
import { useNativeQuestionFocus } from "./native-question-focus";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { ThreadPlanQuestion } from "@/components/promptbox/banner/ThreadTodoCard";
import { useOptionalPaneContext } from "./PaneContext";

export function ThreadPendingQuestions({ threadId }: { threadId: string }) {
  const root = useRef<HTMLDivElement>(null);
  const focusRequest = useNativeQuestionFocus()?.request;
  useEffect(() => {
    if (!focusRequest?.interactionId || !focusRequest.consumeReveal()) return;
    const section = [
      ...(root.current?.querySelectorAll<HTMLElement>("[data-flow-question]") ??
        []),
    ].find(
      (element) => element.dataset.flowQuestion === focusRequest.interactionId,
    );
    focusPlanElement(section ?? null);
  }, [focusRequest]);
  const pending = useThreadPendingInteractions(threadId);
  const focused = useOptionalPaneContext()?.isFocused ?? true;
  return (
    <div ref={root} className="space-y-3" data-thread-questions="">
      {pending.data
        ?.filter((item) => item.payload.kind === "user_question")
        .map((interaction) => (
          <section
            key={interaction.id}
            className="rounded-xl border bg-card p-3"
            data-flow-question={interaction.id}
            tabIndex={-1}
          >
            <div className="mb-2 text-xs text-warning">Needs you</div>
            <ThreadPlanQuestion
              inFlow
              interaction={interaction}
              threadId={threadId}
              placement="overlay"
              focused={focused}
              focusRequest={
                focusRequest?.interactionId === interaction.id
                  ? focusRequest
                  : undefined
              }
            />
          </section>
        ))}
    </div>
  );
}
