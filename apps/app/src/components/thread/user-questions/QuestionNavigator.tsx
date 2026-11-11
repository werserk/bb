import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { sdk } from "@/lib/sdk";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";
import { conversationQuestionsQueryKey } from "@/hooks/queries/conversation-question-query-key";
import { useQuestionNavigation } from "./question-navigation";

export function QuestionNavigator({
  threadId,
  onReturnToComposer,
}: {
  threadId: string;
  onReturnToComposer?: () => void;
}) {
  const navigation = useQuestionNavigation();
  const anchor = useBottomAnchoredScroll();
  const [open, setOpen] = useState(false);
  const moving = useRef(false);
  const query = useQuery({
    queryKey: conversationQuestionsQueryKey(threadId),
    queryFn: ({ signal }) => sdk.threads.questions.list({ threadId, signal }),
    retry: false,
  });
  const questions = (query.data ?? [])
    .filter(
      (question) =>
        question.threadId === threadId && question.status === "open",
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const recentOnly = (query.data?.length ?? 0) >= 200;
  const title = (question: (typeof questions)[number]) =>
    question.publication.questions[0]?.prompt.replace(/\s+/gu, " ").trim() ||
    "Question";
  const go = (id: string) => {
    moving.current = true;
    setOpen(false);
    void navigation?.navigate(id, "question");
  };
  const buttonClass =
    "inline-flex min-h-9 min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline focus-visible:outline-ring disabled:opacity-50";
  const visible =
    query.isPending ||
    query.isError ||
    questions.length > 0 ||
    recentOnly ||
    navigation?.error ||
    navigation?.pending ||
    (anchor && !anchor.isAtBottom);
  if (!visible) return null;
  return (
    <div className="mb-2 space-y-1" aria-label="Question navigation">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
        {query.isPending ? (
          <span role="status" className="px-2 text-xs text-muted-foreground">
            Questions · Loading…
          </span>
        ) : questions.length === 1 ? (
          <button
            type="button"
            className={buttonClass}
            disabled={navigation?.pending}
            onClick={() => go(questions[0]!.id)}
          >
            <Icon name="MessageQuestion" className="size-4 shrink-0" />
            <span className="shrink-0">
              {recentOnly ? "Recent question · 1" : "Question · 1"}
            </span>
            <span className="max-w-64 truncate">{title(questions[0]!)}</span>
            <Icon name="ChevronRight" className="size-3 shrink-0" />
          </button>
        ) : questions.length > 1 ? (
          <Popover
            open={open}
            onOpenChange={(value) => {
              moving.current = false;
              setOpen(value);
            }}
          >
            <PopoverTrigger asChild>
              <button type="button" className={buttonClass}>
                <Icon name="MessageQuestion" className="size-4" />
                {recentOnly ? "Recent questions" : "Questions"} ·{" "}
                {questions.length}
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="start"
              mobileTitle="Open questions"
              className="max-h-80 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-1"
              onCloseAutoFocus={(event) => {
                if (moving.current) event.preventDefault();
                moving.current = false;
              }}
            >
              <div className="px-3 py-2 text-xs text-muted-foreground">
                Open questions · oldest first
              </div>
              {questions.map((question) => (
                <button
                  type="button"
                  key={question.id}
                  onClick={() => go(question.id)}
                  className="block min-h-11 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline focus-visible:outline-ring"
                >
                  {title(question)}
                </button>
              ))}
            </PopoverContent>
          </Popover>
        ) : null}
        {anchor && !anchor.isAtBottom ? (
          <button
            type="button"
            className={buttonClass}
            onClick={() => {
              navigation?.clear();
              anchor.scrollToBottom();
              onReturnToComposer?.();
            }}
          >
            <Icon name="ChevronDown" className="size-3" />
            Return to latest
          </button>
        ) : null}
      </div>
      {recentOnly ? (
        <p className="px-2 text-xs text-muted-foreground">
          Showing the latest {query.data?.length} cards. Older questions may
          remain in history.
        </p>
      ) : null}
      {query.isError ? (
        <div
          role="alert"
          className="flex items-center gap-2 px-2 text-xs text-destructive-text"
        >
          Questions unavailable
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {navigation?.pending ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Opening message…
        </p>
      ) : null}
      {navigation?.error ? (
        <div
          role="alert"
          className="flex items-center gap-2 px-2 text-xs text-destructive-text"
        >
          {navigation.error}
          <button
            type="button"
            className="underline"
            onClick={navigation.retry}
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
