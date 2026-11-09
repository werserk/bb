import {
  createThreadPlanFocusRequest,
  focusThreadPlan,
  registerThreadPlanFocusTarget,
  isThreadPlanVisible,
  focusPlanElement,
  type ThreadPlanFocusRequest,
} from "./thread-plan-focus";
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
    if (props.focusInteractionId === interaction.id) setExpanded(true);
  }, [props.focusInteractionId, interaction.id]);
  useEffect(() => {
    if (focusRequest?.interactionId === interaction.id) setExpanded(true);
  }, [focusRequest, interaction.id]);
  return (
    <section
      className="rounded-xl border border-warning bg-background text-xs"
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
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
        <div className="max-h-[60dvh] overflow-y-auto overscroll-contain">
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
export function ThreadPlanSteps(props: ThreadPlanStepsProps) {
  const result = useThreadPlans({ threadIds: [props.threadId] });
  const interactions = useThreadPendingInteractions(props.threadId).data ?? [];
  const thread = useThread(props.threadId).data;
  const environment = useEnvironment(thread?.environmentId).data;
  const view = result.plans[props.threadId];
  const onOpenThread =
    props.onOpenThread ??
    (() => void sdk.threads.open({ threadId: props.threadId, file: null }));
  const root = useRef<HTMLDivElement>(null);
  const focused = useOptionalPaneContext()?.isFocused ?? true;
  const [focusRequest, setFocusRequest] = useState<ThreadPlanFocusRequest>();
  const current = useRef({ view, interactions, focused });
  current.current = { view, interactions, focused };
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useEffect(() => {
    const container =
      props.placement === "overlay"
        ? (root.current?.closest("[data-thread-chat]") ??
          root.current?.closest("[data-thread-window]") ??
          root.current?.parentElement)
        : root.current;
    if (!container) return;
    if (typeof ResizeObserver === "undefined") {
      setNarrow(container.getBoundingClientRect().width <= 640);
      return;
    }
    const resize = () => {
      const rect = container.getBoundingClientRect();
      setNarrow(rect.width <= 640);
      root.current?.style.setProperty(
        "--thread-plan-max-height",
        `${Math.max(96, Math.floor(rect.height * 0.6))}px`,
      );
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [props.placement]);
  const executing =
    thread?.runtime?.displayStatus === "active" &&
    !thread.serviceTurn &&
    !view?.attentionInteractionIds.length;
  const hidden =
    thread?.archivedAt != null ||
    (environment &&
      (environment.hostLifecycle !== "active" ||
        environment.status === "destroyed"));
  useEffect(() => {
    if (props.placement !== "overlay") return;
    return registerThreadPlanFocusTarget({
      threadId: props.threadId,
      isFocused: () => current.current.focused,
      request: ({ interactionId }) => {
        const { view, interactions } = current.current;
        if (!isThreadPlanVisible(root.current) || !view) return false;
        if (interactionId) {
          const pending = interactions.find(
            (item) =>
              item.id === interactionId &&
              item.threadId === props.threadId &&
              item.status === "pending" &&
              item.payload.kind === "user_question",
          );
          const displayed =
            view.unboundInteractionIds.includes(interactionId) ||
            [view.current, ...view.previousPlans].some((snapshot) =>
              snapshot?.items.some((step) =>
                step.interactionIds.includes(interactionId),
              ),
            );
          if (!pending || !displayed) return false;
        } else if (!view.current) return false;
        setFocusRequest(createThreadPlanFocusRequest(interactionId));
        return true;
      },
    });
  }, [props.threadId, props.placement]);
  useEffect(() => {
    if (!props.focusInteractionId) return;
    if (props.placement === "overlay")
      focusThreadPlan({
        threadId: props.threadId,
        interactionId: props.focusInteractionId,
      });
    else
      setFocusRequest(createThreadPlanFocusRequest(props.focusInteractionId));
  }, [
    props.focusInteractionId,
    props.threadId,
    props.placement,
    view?.revision,
    narrow,
  ]);
  return (
    <div
      hidden={Boolean(hidden)}
      ref={root}
      className={cn(
        "pointer-events-auto min-w-0 space-y-1",
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
          key={view.current.planId ?? view.current.sourceSeq}
          {...props}
          focusRequest={focusRequest}
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
            focusRequest={
              focusRequest?.interactionId ? focusRequest : undefined
            }
            snapshot={snapshot}
            earlier
            narrow={narrow}
            executing={false}
            interactions={interactions}
          />
        ))}
      {narrow !== null &&
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
      {view?.historyTruncated && (
        <span className="sr-only">Earlier plan history truncated</span>
      )}
    </div>
  );
}
