import { useNativeQuestionFocus } from "./native-question-focus";
import {
  focusPlanElement,
  createThreadPlanFocusRequest,
  type ThreadPlanFocusRequest,
} from "./thread-plan-focus";
import { useThreadPlanLayout } from "./thread-plan-layout";
import { useThreadPlanFocus } from "./useThreadPlanFocus";
import { flushSync } from "react-dom";
import {
  ThreadTodoCard,
  ThreadPlanQuestion,
} from "@/components/promptbox/banner/ThreadTodoCard";
import { sdk } from "@/lib/sdk";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useEffect, useRef, useState } from "react";
import type { PendingInteraction } from "@bb/domain";
import type { ThreadPlanStepsProps } from "@get-bb/plugin-sdk";
import { useThreadPlans } from "@/hooks/queries/thread-plans";
import {
  useThread,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { useOptionalPaneContext } from "./PaneContext";
import { cn } from "@bb/shared-ui/lib/utils";

function NativeWaitingRow({
  interaction,
  narrow,
  focusRequest,
  ...props
}: ThreadPlanStepsProps & {
  interaction: PendingInteraction;
  narrow: boolean;
  focusRequest?: ThreadPlanFocusRequest;
}) {
  const [expanded, setExpanded] = useState(!narrow);
  const previousNarrow = useRef(narrow);
  const trigger = useRef<HTMLButtonElement>(null);
  const focused = useOptionalPaneContext()?.isFocused ?? true;
  useEffect(() => {
    if (narrow && !previousNarrow.current) setExpanded(false);
    previousNarrow.current = narrow;
  }, [narrow]);
  useEffect(() => {
    if (
      focusRequest?.interactionId !== interaction.id ||
      !focusRequest.consumeReveal()
    )
      return;
    setExpanded(true);
  }, [focusRequest, interaction.id]);
  return (
    <section
      className="rounded-xl border border-warning bg-background text-xs"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          flushSync(() => setExpanded(false));
          focusPlanElement(trigger.current);
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        aria-expanded={expanded}
        className="h-8 w-full px-3 text-left text-warning"
        onClick={() => setExpanded((value) => !value)}
      >
        Needs you
      </button>
      {expanded && (
        <div className="max-h-[var(--thread-plan-max-height,60dvh)] overflow-y-auto overscroll-contain">
          <ThreadPlanQuestion
            interaction={interaction}
            threadId={props.threadId}
            placement={props.placement}
            focused={focused}
            focusRequest={focusRequest}
          />
        </div>
      )}
    </section>
  );
}
export function ThreadPlanSteps({
  compact = false,
  ...props
}: ThreadPlanStepsProps & { compact?: boolean }) {
  const result = useThreadPlans({ threadIds: [props.threadId] });
  const pending = useThreadPendingInteractions(props.threadId);
  const interactions = pending.data ?? [];
  const thread = useThread(props.threadId).data;
  const environment = useEnvironment(thread?.environmentId).data;
  const view = result.plans[props.threadId];
  const onOpenThread =
    props.onOpenThread ??
    (() => void sdk.threads.open({ threadId: props.threadId, file: null }));
  const root = useRef<HTMLDivElement>(null);
  const focused = useOptionalPaneContext()?.isFocused ?? true;
  const narrow = useThreadPlanLayout(root, props.placement);
  const focusRequest = useThreadPlanFocus({
    props,
    root,
    view,
    interactions: pending.data,
    interactionsLoading: pending.isFetching === true,
    focused,
    ready: result.status === "ready" && narrow !== null,
  });
  const nativeQuestionFocus = useNativeQuestionFocus();
  const revealQuestion = nativeQuestionFocus?.reveal;
  const jumpToQuestion = (interactionId: string) => {
    revealQuestion?.(createThreadPlanFocusRequest(interactionId));
  };
  useEffect(() => {
    if (compact && focusRequest?.interactionId) revealQuestion?.(focusRequest);
  }, [compact, focusRequest, revealQuestion]);
  const executing =
    thread?.runtime?.displayStatus === "active" &&
    !thread.serviceTurn &&
    !view?.attentionInteractionIds.length;
  const hidden =
    thread?.archivedAt != null ||
    (environment &&
      (environment.hostLifecycle !== "active" ||
        environment.status === "destroyed"));
  return (
    <div
      hidden={Boolean(hidden)}
      ref={root}
      className={cn(
        "pointer-events-auto min-w-0 space-y-1",
        !compact &&
          props.placement === "overlay" &&
          "w-[340px] max-w-full max-h-[var(--thread-plan-max-height,60dvh)] overflow-y-auto overscroll-contain",
      )}
      data-thread-plan=""
    >
      {result.status === "error" && (
        <div role="alert" className="text-xs">
          Plan unavailable{" "}
          <button type="button" onClick={() => void result.refresh()}>
            Retry
          </button>
          {props.onOpenThread && (
            <button type="button" onClick={props.onOpenThread}>
              Open
            </button>
          )}
        </div>
      )}
      {!hidden && narrow !== null && view?.current && (
        <ThreadTodoCard
          key={view.current.planId ?? "current"}
          {...props}
          focusRequest={
            compact && focusRequest?.interactionId ? undefined : focusRequest
          }
          compact={compact}
          snapshot={view.current}
          earlier={false}
          narrow={narrow}
          executing={executing}
          interactions={interactions}
        />
      )}
      {!hidden &&
        narrow !== null &&
        view?.previousPlans.map((snapshot) => (
          <ThreadTodoCard
            key={snapshot.planId ?? snapshot.sourceSeq}
            {...props}
            compact={compact}
            focusRequest={
              !compact && focusRequest?.interactionId ? focusRequest : undefined
            }
            snapshot={snapshot}
            earlier
            narrow={narrow}
            executing={false}
            interactions={interactions}
          />
        ))}
      {!compact &&
        narrow !== null &&
        !hidden &&
        view?.unboundInteractionIds.map((id) => {
          const interaction = interactions.find((i) => i.id === id);
          return interaction?.payload.kind === "user_question" ? (
            <NativeWaitingRow
              key={id}
              {...props}
              interaction={interaction}
              narrow={narrow}
              focusRequest={focusRequest}
            />
          ) : (
            <button
              key={id}
              type="button"
              className="text-xs text-warning"
              onClick={onOpenThread}
            >
              Needs you · Open
            </button>
          );
        })}
      {compact &&
        !hidden &&
        interactions
          .filter((item) => item.payload.kind === "user_question")
          .map((interaction) => (
            <button
              key={interaction.id}
              type="button"
              className="flex items-center gap-2 rounded-md px-3 py-1 text-xs text-warning hover:bg-accent focus-visible:outline focus-visible:outline-ring"
              onClick={() => jumpToQuestion(interaction.id)}
            >
              <span aria-hidden>↑</span> Question above
            </button>
          ))}
      {view?.historyTruncated && (
        <span className="sr-only">Earlier plan history truncated</span>
      )}
    </div>
  );
}
