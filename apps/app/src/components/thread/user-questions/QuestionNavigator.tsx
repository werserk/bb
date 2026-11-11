import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@bb/shared-ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@bb/shared-ui/popover";
import { sdk } from "@/lib/sdk";
import { BbHttpError } from "@bb/sdk/browser";
import { useSecondTick } from "@/hooks/useSecondTick";
import { isDocumentVisible } from "@/lib/document-visibility";
import { readOpenQuestionWindow } from "./open-question-window";
import { useBottomAnchoredScroll } from "@/components/ui/bottom-anchored-scroll-body";
import { conversationQuestionsQueryKey } from "@/hooks/queries/conversation-question-query-key";
import { useQuestionNavigation } from "./question-navigation";

import { questionTitle, questionTime } from "./question-response-presentation";

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
  const windowSize = useRef({ threadId, pages: 1 });
  if (windowSize.current.threadId !== threadId)
    windowSize.current = { threadId, pages: 1 };
  const query = useQuery({
    queryKey: [...conversationQuestionsQueryKey(threadId), "open"],
    queryFn: async ({ signal }) => {
      try {
        return {
          ...(await readOpenQuestionWindow({
            open: sdk.threads.questions.open,
            threadId,
            pages: windowSize.current.pages,
            signal,
          })),
          legacy: false,
        };
      } catch (error) {
        if (!(error instanceof BbHttpError) || error.status !== 404)
          throw error;
        const questions = await sdk.threads.questions.list({
          threadId,
          signal,
        });
        return {
          questions,
          total: null,
          nextCursor: null,
          incomplete: false,
          legacy: true,
        };
      }
    },
    retry: false,
    gcTime: 0,
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: "always",
    refetchOnReconnect: "always",
  });
  const now = useSecondTick();
  const expired = !!query.data && now - query.dataUpdatedAt >= 30_000;
  const stale =
    !!query.data &&
    !expired &&
    (query.isError ||
      now - query.dataUpdatedAt > 5_000 ||
      !isDocumentVisible());
  const questions = (expired ? [] : (query.data?.questions ?? []))
    .filter(
      (question) =>
        question.threadId === threadId && question.status === "open",
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const legacy = query.data?.legacy ?? false;
  const total = expired ? 0 : (query.data?.total ?? questions.length);
  const incomplete = !expired && (query.data?.incomplete ?? false);
  const go = (id: string) => {
    moving.current = true;
    setOpen(false);
    void navigation?.navigate(id, "question");
  };
  const buttonClass =
    "inline-flex min-h-9 min-w-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline focus-visible:outline-ring disabled:opacity-50";
  const showReturn =
    anchor &&
    (navigation?.request || navigation?.fallbackQuestionId) &&
    (!anchor.isAtBottom || navigation?.fallbackQuestionId);
  const composerFeedback = navigation?.feedback?.origin !== "inline";
  const visible =
    query.isPending ||
    query.isError ||
    expired ||
    total > 0 ||
    legacy ||
    (composerFeedback && (navigation?.error || navigation?.pending)) ||
    showReturn;
  if (!visible)
    return (
      <span role="status" className="sr-only">
        {query.isPending ? "Questions · Loading…" : "0 open questions"}
      </span>
    );
  return (
    <div
      className="mb-2 space-y-1"
      role="group"
      aria-label="Question navigation"
    >
      <span className="sr-only" aria-live="polite">
        {query.isPending
          ? "Loading questions"
          : legacy
            ? "Limited question coverage"
            : expired || (query.isError && !query.data)
              ? "Questions unavailable"
              : `${total} open questions`}
      </span>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-1">
        {query.isPending ? (
          <span role="status" className="px-2 text-xs text-muted-foreground">
            Questions · Loading…
          </span>
        ) : total === 1 && questions.length === 1 && !incomplete ? (
          <button
            type="button"
            className={buttonClass}
            aria-label={`${legacy ? "Recent question" : "Question"} · 1 ${questionTitle(questions[0]!.publication)}`}
            disabled={navigation?.pending}
            onClick={() => go(questions[0]!.id)}
          >
            <Icon
              name="MessageQuestion"
              className="size-4 shrink-0 text-attention"
            />
            <span className="shrink-0">
              {legacy ? "Recent question · 1" : "Question · 1"}
            </span>
            <span className="max-w-64 truncate">
              {questionTitle(questions[0]!.publication)}
            </span>
            <Icon name="ChevronRight" className="size-3 shrink-0" />
          </button>
        ) : total > 1 || incomplete ? (
          <Popover
            open={open}
            onOpenChange={(value) => {
              moving.current = false;
              setOpen(value);
            }}
          >
            <PopoverTrigger asChild>
              <button type="button" className={buttonClass}>
                <Icon
                  name="MessageQuestion"
                  className="size-4 text-attention"
                />
                {legacy ? "Recent questions" : "Questions"} · {total}
                {incomplete ? "+" : ""}
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
                  aria-label={questionTitle(question.publication)}
                  onClick={() => go(question.id)}
                  className="block min-h-11 w-full rounded-md px-3 py-2 text-left text-sm hover:bg-state-hover focus-visible:outline focus-visible:outline-ring"
                >
                  <span className="flex min-w-0 items-center justify-between gap-3">
                    <span className="truncate">
                      {questionTitle(question.publication)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {questionTime(question.createdAt)}
                    </span>
                  </span>
                </button>
              ))}
              {query.data?.nextCursor && !incomplete ? (
                <div className="space-y-1 px-3 py-2 text-xs text-muted-foreground">
                  Showing {questions.length} of {total}
                  <button
                    type="button"
                    className="block min-h-11 underline"
                    disabled={query.isFetching}
                    onClick={() => {
                      windowSize.current.pages++;
                      void query.refetch();
                    }}
                  >
                    {query.isFetching ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </PopoverContent>
          </Popover>
        ) : null}
        {showReturn ? (
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
      {legacy ? (
        <p className="px-2 text-xs text-muted-foreground">
          Limited coverage · this core exposes recent history only. Older
          questions may remain in history.
        </p>
      ) : null}
      {incomplete ? (
        <div role="alert" className="px-2 text-xs text-muted-foreground">
          The list keeps changing. Showing what is loaded.{" "}
          <button
            type="button"
            className="underline"
            onClick={() => void query.refetch()}
          >
            Retry
          </button>
        </div>
      ) : null}
      {stale ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Showing last known questions · updated{" "}
          {Math.max(0, Math.floor((now - query.dataUpdatedAt) / 1000))}s ago
        </p>
      ) : null}
      {query.isError || expired ? (
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
      {composerFeedback && navigation?.pending ? (
        <p role="status" className="px-2 text-xs text-muted-foreground">
          Opening message…
        </p>
      ) : null}
      {composerFeedback && navigation?.error ? (
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
