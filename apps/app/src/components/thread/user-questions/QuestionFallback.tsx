import { useEffect, useRef } from "react";
import { ConversationQuestionCard } from "./ConversationQuestionCard";
import { useQuestionNavigation } from "./question-navigation";
import { questionCardId } from "./question-response-presentation";
import { flashSearchTarget } from "@/lib/search-flash";

export function QuestionFallback({ threadId }: { threadId: string }) {
  const navigation = useQuestionNavigation();
  const questionId = navigation?.fallbackQuestionId;
  const scope = navigation?.scope;
  const clear = navigation?.clear;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!questionId || !scope || !clear) return;
    const pane = scope();
    if (!pane) return;
    const id = questionCardId(threadId, questionId);
    const focus = (element: HTMLElement) => {
      element.scrollIntoView({ block: "center" });
      element.focus({ preventScroll: true });
      flashSearchTarget(element);
    };
    const check = () => {
      const original = [...pane.querySelectorAll<HTMLElement>("[id]")].find(
        (element) => element.id === id && !root.current?.contains(element),
      );
      if (original) {
        clear();
        focus(original);
      }
    };
    const target =
      root.current?.querySelector<HTMLElement>("section[tabindex]");
    if (target) focus(target);
    check();
    const observer = new MutationObserver(check);
    observer.observe(pane, { subtree: true, childList: true });
    return () => observer.disconnect();
  }, [questionId, threadId, scope, clear]);
  if (!questionId || navigation?.readOnly) return null;
  return (
    <div
      ref={root}
      className="space-y-2 border-t border-border pt-3"
      data-question-fallback=""
    >
      <p className="text-xs text-muted-foreground">
        Older question · not in loaded history
      </p>
      <p className="text-xs text-muted-foreground">
        Opened by ID · its message is outside the loaded history
      </p>
      <ConversationQuestionCard
        key={questionId}
        threadId={threadId}
        questionId={questionId}
        defaultExpanded
      />
    </div>
  );
}
