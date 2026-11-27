import {
  ComposerContextItem,
  useComposerContextSource,
} from "@/components/promptbox/context/composer-context";
import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@bb/shared-ui/icon";
import {
  ContextRow,
  ContextRowAction,
  ContextRowGlyph,
} from "@bb/shared-ui/context-row";
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
  const contextSource = useComposerContextSource();
  const navigation = useQuestionNavigation();
  const anchor = useBottomAnchoredScroll();
  const windowSize = useRef({ threadId, pages: 1 });
  const query = useQuery({
    queryKey: [...conversationQuestionsQueryKey(threadId), "open"],
    queryFn: async ({ signal }) => {
      try {
        return {
          ...(await readOpenQuestionWindow({
            open: sdk.threads.questions.open,
            threadId,
            pages:
              windowSize.current.threadId === threadId
                ? windowSize.current.pages
                : 1,
            signal,
          })),
          legacy: false,
        };
      } catch (error) {
        if (
          !(error instanceof BbHttpError) ||
          !(
            error.status === 404 ||
            (error.status === 400 && error.code === "invalid_request")
          )
        )
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
    contextSource?.dismiss();
    void navigation?.navigate(id, "question");
  };
  const buttonClass = contextSource
    ? "inline-flex min-h-8 min-w-0 items-center gap-2 rounded px-2 py-1 text-xs text-foreground hover:bg-state-hover focus-visible:outline focus-visible:outline-ring disabled:opacity-50"
    : "inline-flex min-h-9 min-w-0 items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs text-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline focus-visible:outline-ring disabled:opacity-50";
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
    <ComposerContextItem
      id="questions"
      kind={!expired && !query.isError && total > 0 ? "needs-you" : undefined}
      label={
        expired || query.isError
          ? "Questions unavailable"
          : total > 0
            ? "Needs you"
            : "Questions"
      }
      summary={total > 0 ? total : undefined}
      icon={expired || query.isError ? "AlertCircle" : "MessageQuestion"}
      group="attention"
      tone={
        expired || query.isError ? "error" : total > 0 ? "attention" : undefined
      }
    >
      <div className="space-y-1" role="group" aria-label="Question navigation">
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
          ) : questions.length > 0 ? (
            <div className="w-full min-w-0" role="list">
              {questions.map((question) => (
                <div role="listitem" key={question.id}>
                  <ContextRow
                    glyph={<ContextRowGlyph kind="question" />}
                    // oxlint-disable-next-line bb/no-native-title-with-aria-label
                    title={questionTitle(question.publication)}
                    age={questionTime(question.createdAt)}
                    aria-label={questionTitle(question.publication)}
                    disabled={navigation?.pending}
                    onClick={() => go(question.id)}
                    action={
                      <ContextRowAction variant="primary">
                        Answer
                      </ContextRowAction>
                    }
                  />
                </div>
              ))}
              {query.data?.nextCursor && !incomplete ? (
                <div
                  data-context-fit=""
                  className="space-y-1 px-1.5 py-1 text-xs text-muted-foreground"
                >
                  Showing {questions.length} of {total}
                  <button
                    type="button"
                    className="ml-2 underline"
                    disabled={query.isFetching}
                    onClick={() => {
                      windowSize.current = {
                        threadId,
                        pages:
                          (windowSize.current.threadId === threadId
                            ? windowSize.current.pages
                            : 1) + 1,
                      };
                      void query.refetch();
                    }}
                  >
                    {query.isFetching ? "Loading…" : "Load more"}
                  </button>
                </div>
              ) : null}
            </div>
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
    </ComposerContextItem>
  );
}
