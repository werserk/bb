import {
  focusPlanElement,
  type ThreadPlanFocusRequest,
} from "@/views/thread-detail/thread-plan-focus";
import { ThreadQuestionFormHost } from "@/components/thread/user-questions/ThreadQuestionFormHost";
import { useEffect, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type {
  PlanSnapshotView,
  PlanStepView,
  PendingInteraction,
} from "@bb/domain";
import type { ThreadPlanStepsProps } from "@get-bb/plugin-sdk";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { UserQuestionAnswerForm } from "@/components/thread/user-questions/UserQuestionInteractionContent";
import { usePlanEditorOwner } from "@/components/thread/pending-interactions/plan-editor-ownership";
import { planDisclosureState } from "@/views/thread-detail/thread-plan-state";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
export function ThreadPlanQuestion({
  interaction,
  threadId,
  placement,
  focused,
  focusRequest,
}: {
  interaction: PendingInteraction;
  threadId: string;
  placement: "overlay" | "panel";
  focused: boolean;
  focusRequest?: ThreadPlanFocusRequest;
}) {
  const [skipped, setSkipped] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const requested = focusRequest?.interactionId === interaction.id;
  const priority = requested
    ? 40 + focusRequest.sequence
    : placement === "overlay"
      ? focused
        ? 30
        : 10
      : 20;
  const ownsEditor = usePlanEditorOwner(
    `${threadId}:${interaction.id}`,
    priority,
    interaction.payload.kind === "user_question",
  );
  useEffect(() => {
    if (requested) setSkipped(false);
  }, [requested, focusRequest]);
  useEffect(() => {
    if (!requested || skipped || !ownsEditor || !focusRequest.consumeFocus())
      return;
    const fields = root.current?.querySelectorAll<HTMLElement>(
      'textarea,input,select,[role="radio"],[role="checkbox"]',
    );
    const field = [...(fields ?? [])].find(
      (element) =>
        !element.matches(':disabled,[aria-disabled="true"],[type="hidden"]'),
    );
    focusPlanElement(
      field ??
        root.current?.querySelector<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ??
        null,
    );
  }, [focusRequest, requested, skipped, ownsEditor]);
  if (interaction.payload.kind !== "user_question") return null;
  return (
    <div
      ref={root}
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
        <ThreadQuestionFormHost
          density="default"
          promptShownAbove={null}
          closeInline={null}
        >
          <UserQuestionAnswerForm
            threadId={threadId}
            interactionId={interaction.id}
            isResolving={interaction.status === "resolving"}
            questions={interaction.payload.questions}
            plan={{ priority, onSkip: () => setSkipped(true) }}
          />
        </ThreadQuestionFormHost>
      )}
    </div>
  );
}
function Step({ step, executing }: { step: PlanStepView; executing: boolean }) {
  const state = step.status;
  return (
    <div
      className="flex h-8 min-w-0 items-center gap-2 px-3 text-xs"
      tabIndex={-1}
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
                : state === "in_progress" && executing
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
                  ? executing
                    ? "text-info"
                    : "text-muted-foreground"
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
export function ThreadTodoCard({
  snapshot,
  earlier,
  narrow,
  executing,
  interactions,
  focusRequest,
  ...props
}: ThreadPlanStepsProps & {
  snapshot: PlanSnapshotView;
  earlier: boolean;
  narrow: boolean;
  executing: boolean;
  interactions: readonly PendingInteraction[];
  focusRequest?: ThreadPlanFocusRequest;
}) {
  const focused = useOptionalPaneContext()?.isFocused ?? true;
  const { waiting, failed, finished, quiet } = planDisclosureState(
    snapshot,
    earlier,
  );
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
    if (!focusRequest) return;
    if (
      focusRequest.interactionId &&
      !snapshot.items.some((step) =>
        step.interactionIds.includes(focusRequest.interactionId!),
      )
    )
      return;
    if (!focusRequest.consumeReveal()) return;
    if (focusRequest.interactionId || failed) setExpanded(true);
  }, [focusRequest, snapshot.items, failed]);
  useEffect(() => {
    if (
      !focusRequest ||
      focusRequest.interactionId ||
      (failed && !expanded) ||
      !focusRequest.consumeFocus()
    )
      return;
    const failedRow = list.current?.querySelector<HTMLElement>(
      '[data-plan-step-status="failed"]',
    );
    focusPlanElement(failedRow ?? trigger.current);
  }, [focusRequest, expanded, failed]);
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
          flushSync(() => setExpanded(false));
          focusPlanElement(trigger.current);
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
            waiting
              ? "max-h-[min(var(--thread-plan-max-height,60dvh),32rem)]"
              : "max-h-32",
          )}
        >
          {snapshot.items.map((step) => (
            <div key={step.id}>
              <Step step={step} executing={executing && !quiet} />
              {step.interactionIds.map((id) => {
                const interaction = interactions.find((i) => i.id === id);
                return interaction ? (
                  <ThreadPlanQuestion
                    key={id}
                    interaction={interaction}
                    threadId={props.threadId}
                    placement={props.placement}
                    focused={focused}
                    focusRequest={focusRequest}
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
