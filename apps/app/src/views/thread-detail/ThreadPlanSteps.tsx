import { usePlanEditorOwner } from "@/components/thread/pending-interactions/plan-editor-ownership";
import { useEffect, useId, useRef, useState } from "react";
import type {
  PlanSnapshotView,
  PlanStepView,
  PendingInteraction,
} from "@bb/domain";
import type { ThreadPlanStepsProps } from "@get-bb/plugin-sdk";
import { useThreadPlans } from "@/hooks/queries/thread-plans";
import {
  useThread,
  useThreadPendingInteractions,
} from "@/hooks/queries/thread-queries";
import { useOptionalPaneContext } from "./PaneContext";
import { UserQuestionAnswerForm } from "@/components/thread/user-questions/UserQuestionInteractionContent";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";

function Question({
  interaction,
  threadId,
  placement,
  focused,
}: {
  interaction: PendingInteraction;
  threadId: string;
  placement: "overlay" | "panel";
  focused: boolean;
}) {
  const [skipped, setSkipped] = useState(false);
  const priority = placement === "overlay" ? (focused ? 30 : 10) : 20;
  const ownsEditor = usePlanEditorOwner(
    `${threadId}:${interaction.id}`,
    priority,
    interaction.payload.kind === "user_question",
  );
  if (interaction.payload.kind !== "user_question") return null;
  return (
    <div
      className="m-2 rounded-md border border-warning bg-warning/5 p-3"
      data-plan-interaction={interaction.id}
    >
      {!ownsEditor ? (
        <span className="text-muted-foreground">Answer in the active view</span>
      ) : skipped ? (
        <button type="button" onClick={() => setSkipped(false)}>
          Needs you · Answer
        </button>
      ) : (
        <UserQuestionAnswerForm
          threadId={threadId}
          interactionId={interaction.id}
          isResolving={interaction.status === "resolving"}
          questions={interaction.payload.questions}
          plan={{ priority, onSkip: () => setSkipped(true) }}
        />
      )}
    </div>
  );
}
function Step({ step, executing }: { step: PlanStepView; executing: boolean }) {
  const state = step.status;
  return (
    <div
      className="flex h-8 min-w-0 items-center gap-2 px-3 text-xs"
      data-plan-step={step.id}
      data-plan-step-status={state}
      aria-label={`${state === "needs_input" ? "Waiting for you" : state === "in_progress" ? "In progress" : state === "completed" ? "Done" : state === "failed" ? "Failed" : "Next"}: ${step.text}`}
    >
      <Icon
        name={
          state === "completed"
            ? "Check"
            : state === "failed"
              ? "CircleX"
              : state === "needs_input"
                ? "Circle"
                : state === "in_progress"
                  ? "Spinner"
                  : "Circle"
        }
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          state === "completed"
            ? "text-success"
            : state === "failed"
              ? "text-destructive-text"
              : state === "needs_input"
                ? "fill-warning text-warning"
                : state === "in_progress"
                  ? "text-info"
                  : "text-muted-foreground",
          state === "in_progress" && executing && "motion-safe:animate-spin",
        )}
      />
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "truncate",
            state === "completed" && "text-muted-foreground line-through",
          )}
          title={step.text}
        >
          {step.text}
        </div>
        {(step.note || state === "needs_input" || state === "failed") && (
          <div
            className={cn(
              "truncate text-2xs",
              state === "needs_input"
                ? "text-warning"
                : state === "failed"
                  ? "text-destructive-text"
                  : "text-muted-foreground",
            )}
            title={step.note}
          >
            {state === "needs_input"
              ? "Needs you"
              : state === "failed"
                ? "Failed"
                : ""}
            {step.note &&
              `${state === "needs_input" || state === "failed" ? " · " : ""}${step.note}`}
          </div>
        )}
      </div>
      {step.actor && (
        <span
          className="max-w-20 truncate rounded border px-1 text-2xs text-muted-foreground"
          title={step.actor}
        >
          {step.actor}
        </span>
      )}
    </div>
  );
}
function Snapshot({
  snapshot,
  earlier,
  narrow,
  executing,
  interactions,
  ...props
}: ThreadPlanStepsProps & {
  snapshot: PlanSnapshotView;
  earlier: boolean;
  narrow: boolean;
  executing: boolean;
  interactions: readonly PendingInteraction[];
}) {
  const focused = useOptionalPaneContext()?.isFocused ?? true;
  const waiting = snapshot.items.some((item) => item.interactionIds.length > 0);
  const failed = snapshot.items.some((item) => item.status === "failed");
  const finished =
    snapshot.items.length > 0 &&
    snapshot.items.every((item) => item.status === "completed");
  const quiet =
    !waiting && (earlier || finished || snapshot.staleSince !== undefined);
  const [expanded, setExpanded] = useState(!narrow && !quiet);
  const previous = useRef({ narrow, quiet, waiting });
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  useEffect(() => {
    const before = previous.current;
    if ((narrow && !before.narrow) || (quiet && !before.quiet))
      setExpanded(false);
    else if (waiting && !before.waiting && !narrow) setExpanded(true);
    previous.current = { narrow, quiet, waiting };
  }, [narrow, quiet, waiting]);
  useEffect(() => {
    if (
      !props.focusInteractionId ||
      !snapshot.items.some((item) =>
        item.interactionIds.includes(props.focusInteractionId!),
      )
    )
      return;
    setExpanded(true);
  }, [props.focusInteractionId, snapshot.items]);
  const activeId = snapshot.items.find(
    (item) => item.status === "needs_input" || item.status === "in_progress",
  )?.id;
  useEffect(() => {
    if (!expanded || !list.current) return;
    const row = [
      ...list.current.querySelectorAll<HTMLElement>("[data-plan-step]"),
    ].find((el) => el.dataset.planStep === activeId);
    if (row)
      list.current.scrollTop = Math.max(
        0,
        row.offsetTop - list.current.offsetTop - 32,
      );
  }, [activeId, expanded]);
  const title = waiting
    ? "Plan · Needs you"
    : earlier
      ? "Plan from an earlier task"
      : finished
        ? "Plan finished"
        : snapshot.staleSince !== undefined
          ? "Earlier plan"
          : failed
            ? "Plan · Failed"
            : "Plan";
  return (
    <section
      className={cn(
        "min-w-0 overflow-hidden rounded-xl border bg-background shadow-lg",
        quiet && "text-muted-foreground",
        waiting && "border-warning",
        !quiet && !waiting && failed && "border-destructive-text",
      )}
      data-plan-snapshot={snapshot.sourceSeq}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
          trigger.current?.focus();
        }
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="flex h-8 w-full items-center gap-2 px-3 text-left text-xs"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="min-w-0 flex-1 truncate">
          {title}
          {quiet &&
            ` · ${new Date(snapshot.updatedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`}
        </span>
        <Icon
          name={expanded ? "ChevronUp" : "ChevronDown"}
          className="size-3"
          aria-hidden
        />
      </button>
      {expanded && (
        <div
          ref={list}
          id={bodyId}
          role="region"
          aria-label="Plan steps"
          tabIndex={0}
          className={cn(
            "relative overflow-y-auto overscroll-contain",
            waiting ? "max-h-[min(60dvh,32rem)]" : "max-h-32",
          )}
        >
          {snapshot.items.map((step) => (
            <div key={step.id}>
              <Step step={step} executing={executing && !quiet} />
              {step.interactionIds.map((id) => {
                const interaction = interactions.find((i) => i.id === id);
                return interaction ? (
                  <Question
                    key={id}
                    interaction={interaction}
                    threadId={props.threadId}
                    placement={props.placement}
                    focused={focused}
                  />
                ) : null;
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
export function ThreadPlanSteps(props: ThreadPlanStepsProps) {
  const result = useThreadPlans({ threadIds: [props.threadId] });
  const interactions = useThreadPendingInteractions(props.threadId).data ?? [];
  const thread = useThread(props.threadId).data;
  const view = result.plans[props.threadId];
  const root = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useEffect(() => {
    const container =
      props.placement === "overlay"
        ? (root.current?.closest("[data-thread-window]") ??
          root.current?.parentElement)
        : root.current;
    if (!container) return;
    if (typeof ResizeObserver === "undefined") {
      setNarrow(container.getBoundingClientRect().width <= 640);
      return;
    }
    const resize = () =>
      setNarrow(container.getBoundingClientRect().width <= 640);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, [props.placement]);
  const executing =
    thread?.status === "active" && !view?.attentionInteractionIds.length;
  return (
    <div
      ref={root}
      className={cn(
        "pointer-events-auto min-w-0 space-y-1",
        props.placement === "overlay" && "w-[340px] max-w-full",
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
      {narrow !== null && view?.current && (
        <Snapshot
          key={view.current.planId ?? view.current.sourceSeq}
          {...props}
          snapshot={view.current}
          earlier={false}
          narrow={narrow}
          executing={executing}
          interactions={interactions}
        />
      )}
      {narrow !== null &&
        view?.previousPlans.map((snapshot) => (
          <Snapshot
            key={snapshot.planId ?? snapshot.sourceSeq}
            {...props}
            snapshot={snapshot}
            earlier
            narrow={narrow}
            executing={false}
            interactions={interactions}
          />
        ))}
      {view?.unboundInteractionIds.map((id) => {
        const interaction = interactions.find((i) => i.id === id);
        return interaction?.payload.kind === "user_question" ? (
          <section
            key={id}
            className="rounded-xl border border-warning bg-background text-xs"
          >
            <div className="px-3 pt-2 text-warning">Needs you</div>
            <Question
              interaction={interaction}
              threadId={props.threadId}
              placement={props.placement}
              focused
            />
          </section>
        ) : (
          <button
            key={id}
            type="button"
            className="text-xs text-warning"
            onClick={props.onOpenThread}
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
