import { useEffect, useRef, useState } from "react";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { useThreadPlanFocus } from "@/views/thread-detail/useThreadPlanFocus";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { Icon, type IconName } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { PlanSnapshotView } from "@bb/domain";
import { useThreadPlans } from "@/hooks/queries/thread-plans";
import { useThread } from "@/hooks/queries/thread-queries";
import { useNativeQuestionFocus } from "@/views/thread-detail/native-question-focus";
import {
  isThreadPlanVisible,
  focusPlanElement,
  createThreadPlanFocusRequest,
} from "@/views/thread-detail/thread-plan-focus";
import {
  ComposerContextItem,
  useComposerContextSource,
} from "./composer-context";

type PlanStep = PlanSnapshotView["items"][number];

function planStepIcon(step: PlanStep, executing: boolean): IconName {
  if (step.status === "completed") return "Check";
  if (step.status === "failed") return "CircleX";
  if (step.status === "needs_input") return "CircleQuestion";
  return step.status === "in_progress" && executing ? "Spinner" : "Circle";
}

function PlanStepRow({
  step,
  executing,
  current,
  onQuestion,
}: {
  step: PlanStep;
  executing: boolean;
  current: boolean;
  onQuestion: (id: string) => void;
}) {
  return (
    <div
      data-context-row=""
      data-current={current || undefined}
      className={cn(
        "flex items-start gap-2.5 rounded-md px-1.5 py-1.5 text-xs",
        current && "bg-foreground/5",
      )}
      tabIndex={-1}
      data-plan-step={step.id}
      data-plan-step-status={step.status}
      aria-label={`${step.status}: ${step.text}`}
      aria-current={current ? "step" : undefined}
    >
      <Icon
        name={planStepIcon(step, executing)}
        className={cn(
          "mt-0.5 size-3.5 shrink-0 text-muted-foreground",
          step.status === "completed" && "text-success",
          step.status === "failed" && "text-destructive-text",
          step.status === "needs_input" && "text-attention",
          current && step.status === "in_progress" && "text-foreground",
          step.status === "in_progress" &&
            executing &&
            "motion-safe:animate-spin",
        )}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            current ? "font-medium text-foreground" : "text-foreground",
            step.status === "completed" && "font-normal text-muted-foreground",
          )}
        >
          {step.text}
        </p>
        {step.actor && <p className="text-muted-foreground">{step.actor}</p>}
        {step.note && (
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">
            {step.note}
          </p>
        )}
      </div>
      {step.interactionIds.map((id) => (
        <button
          key={id}
          type="button"
          className="shrink-0 rounded-md bg-attention px-2 py-0.5 font-medium text-attention-foreground"
          onClick={() => onQuestion(id)}
        >
          Answer
        </button>
      ))}
    </div>
  );
}

function PlanDisclosure({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-context-fit=""
      aria-expanded={open}
      onClick={onToggle}
      className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-xs text-muted-foreground hover:bg-foreground/5"
    >
      <span>{label}</span>
      <Icon
        name="ChevronRight"
        aria-hidden
        className={cn("size-3 transition-transform", open && "rotate-90")}
      />
    </button>
  );
}

export function ComposerPlanSteps({
  snapshot,
  executing,
  onQuestion,
}: {
  snapshot: PlanSnapshotView;
  executing: boolean;
  onQuestion: (id: string) => void;
}) {
  const [showDone, setShowDone] = useState(false);
  const done = snapshot.items.filter((step) => step.status === "completed");
  const remaining = snapshot.items.filter(
    (step) => step.status !== "completed",
  );
  const currentId = (
    remaining.find((step) => step.status !== "pending") ?? remaining[0]
  )?.id;
  const row = (step: PlanStep) => (
    <PlanStepRow
      key={step.id}
      step={step}
      executing={executing}
      current={step.id === currentId}
      onQuestion={onQuestion}
    />
  );
  return (
    <div className="composer-context-plan">
      {snapshot.staleSince !== undefined && (
        <p
          data-context-fit=""
          className="px-1.5 pb-1 text-xs text-muted-foreground"
        >
          Plan from an earlier turn
        </p>
      )}
      {done.length > 0 && (
        <PlanDisclosure
          label={`${done.length} ${done.length === 1 ? "step" : "steps"} done`}
          open={showDone}
          onToggle={() => setShowDone((value) => !value)}
        />
      )}
      {showDone ? done.map(row) : null}
      {remaining.map(row)}
    </div>
  );
}

export function ThreadComposerPlan({ threadId }: { threadId: string }) {
  const result = useThreadPlans({ threadIds: [threadId] });
  const thread = useThread(threadId).data;
  const focus = useNativeQuestionFocus();
  const revealQuestion = focus?.reveal;
  const store = useComposerContextSource();
  const plan = result.plans[threadId];
  const current = plan?.current;
  const environment = useEnvironment(thread?.environmentId).data;
  const pending = useThreadPendingInteractions(threadId);
  const [showEarlier, setShowEarlier] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const request = useThreadPlanFocus({
    props: { threadId, placement: "overlay" },
    root: store?.anchor ?? anchor,
    view: plan,
    interactions: pending.data,
    interactionsLoading: pending.isFetching === true,
    focused: useOptionalPaneContext()?.isFocused ?? true,
    ready: result.status === "ready",
  });
  useEffect(() => {
    if (!request) return;
    if (request.interactionId) {
      store?.dismiss();
      revealQuestion?.(request);
      return;
    }
    store?.reveal("plan");
    const frame = requestAnimationFrame(() => {
      if (!isThreadPlanVisible(root.current) || !request.consumeFocus()) return;
      focusPlanElement(
        root.current?.querySelector<HTMLElement>(
          '[data-plan-step-status="failed"]',
        ) ?? root.current,
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [request, store, revealQuestion]);
  const onQuestion = (id: string) => {
    store?.dismiss();
    focus?.reveal(createThreadPlanFocusRequest(id));
  };
  const pendingQuestions = (pending.data ?? []).filter(
    (item) =>
      item.status === "pending" && item.payload.kind === "user_question",
  );
  const displayed = (snapshot: PlanSnapshotView): PlanSnapshotView => ({
    ...snapshot,
    items: snapshot.items.map((step) => ({
      ...step,
      interactionIds: step.interactionIds.filter((id) =>
        pendingQuestions.some((question) => question.id === id),
      ),
    })),
  });
  const failed = current?.items.some((step) => step.status === "failed");
  const waiting = current?.items.some((step) => step.status === "needs_input");
  const hidden =
    thread?.archivedAt != null ||
    (environment &&
      (environment.hostLifecycle !== "active" ||
        environment.status === "destroyed"));
  const executing =
    thread?.runtime?.displayStatus === "active" &&
    !thread.serviceTurn &&
    !plan?.attentionInteractionIds.length;
  if (
    hidden ||
    (result.status !== "error" &&
      !current &&
      !plan?.previousPlans.length &&
      !pendingQuestions.length)
  )
    return null;
  const done =
    current?.items.filter((step) => step.status === "completed").length ?? 0;
  return (
    <ComposerContextItem
      id="plan"
      label={
        result.status === "error"
          ? "Plan unavailable"
          : failed
            ? "Plan failed"
            : waiting
              ? "Plan · Needs you"
              : "Plan"
      }
      summary={current ? `${done}/${current.items.length}` : undefined}
      progress={current ? { done, total: current.items.length } : undefined}
      kind="plan"
      icon="ListTodo"
      group="work"
      tone={
        result.status === "error" || failed
          ? "error"
          : waiting
            ? "attention"
            : undefined
      }
    >
      <div ref={root} tabIndex={-1} data-thread-plan="">
        {result.status === "error" && (
          <div role="alert" className="mb-2 text-xs text-destructive-text">
            Plan unavailable{" "}
            <button
              type="button"
              className="rounded border border-border px-2 py-1"
              onClick={() => void result.refresh()}
            >
              Retry
            </button>
          </div>
        )}
        {current && (
          <ComposerPlanSteps
            snapshot={displayed(current)}
            executing={Boolean(executing)}
            onQuestion={onQuestion}
          />
        )}
        {plan && plan.previousPlans.length > 0 && (
          <div data-context-earlier-plans="">
            <PlanDisclosure
              label={`Earlier plans · ${plan.previousPlans.length}`}
              open={showEarlier}
              onToggle={() => setShowEarlier((value) => !value)}
            />
            {showEarlier
              ? plan.previousPlans.map((snapshot) => (
                  <section
                    key={snapshot.planId ?? snapshot.sourceSeq}
                    className="mt-1 border-t border-border pt-1"
                  >
                    <ComposerPlanSteps
                      snapshot={displayed(snapshot)}
                      executing={false}
                      onQuestion={onQuestion}
                    />
                  </section>
                ))
              : null}
          </div>
        )}
        {pendingQuestions
          .filter(
            (question) =>
              ![current, ...(plan?.previousPlans ?? [])].some((snapshot) =>
                snapshot?.items.some((step) =>
                  step.interactionIds.includes(question.id),
                ),
              ),
          )
          .map((question) => (
            <button
              key={question.id}
              type="button"
              className="my-1 flex items-center gap-2 text-xs text-attention"
              onClick={() => onQuestion(question.id)}
            >
              <Icon name="ArrowUp" className="size-3" aria-hidden />
              Question above
            </button>
          ))}
      </div>
    </ComposerContextItem>
  );
}
