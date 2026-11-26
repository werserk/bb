import { ComposerContextRow } from "./ComposerContextRow";
import { useEffect, useRef, useState } from "react";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useThreadPendingInteractions } from "@/hooks/queries/thread-queries";
import { useThreadPlanFocus } from "@/views/thread-detail/useThreadPlanFocus";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { Icon } from "@bb/shared-ui/icon";
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

export function ComposerPlanSteps({
  snapshot,
  executing,
  onQuestion,
}: {
  snapshot: PlanSnapshotView;
  executing: boolean;
  onQuestion: (id: string) => void;
}) {
  const [doneOpen, setDoneOpen] = useState(false);
  const done = snapshot.items.filter(
    (step) => step.status === "completed",
  ).length;
  return (
    <div className="composer-context-plan space-y-2">
      {snapshot.staleSince !== undefined && (
        <p className="text-xs text-muted-foreground">
          Plan from an earlier turn
        </p>
      )}
      <div
        role="progressbar"
        aria-label="Completed plan steps"
        aria-valuenow={done}
        aria-valuemin={0}
        aria-valuemax={snapshot.items.length}
        className="composer-plan-segments"
      >
        {snapshot.items.map((step) => (
          <span key={step.id} data-status={step.status} />
        ))}
      </div>
      {done > 0 && (
        <button
          type="button"
          className="composer-plan-done"
          aria-expanded={doneOpen}
          onClick={() => setDoneOpen(!doneOpen)}
        >
          ✓ {done} done {doneOpen ? "▾" : "▸"}
        </button>
      )}
      {snapshot.items
        .filter((step) => doneOpen || step.status !== "completed")
        .map((step) => (
          <div
            key={step.id}
            className="composer-plan-step text-xs"
            tabIndex={-1}
            data-plan-step={step.id}
            data-plan-step-status={step.status}
            aria-label={`${step.status}: ${step.text}`}
          >
            <ComposerContextRow
              icon={
                step.status === "completed"
                  ? "Check"
                  : step.status === "failed"
                    ? "CircleX"
                    : step.status === "needs_input"
                      ? "CircleQuestion"
                      : step.status === "in_progress" && executing
                        ? "Spinner"
                        : "Circle"
              }
              tone={
                step.status === "needs_input"
                  ? "attention"
                  : step.status === "in_progress"
                    ? "working"
                    : undefined
              }
              title={step.text}
              subline={[step.actor, step.note].filter(Boolean).join(" · ")}
              action={
                step.interactionIds.length > 0
                  ? step.interactionIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onQuestion(id)}
                      >
                        Answer
                      </button>
                    ))
                  : undefined
              }
            />
          </div>
        ))}
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
      overview
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
        {plan?.previousPlans.map((snapshot) => (
          <section
            key={snapshot.planId ?? snapshot.sourceSeq}
            className="mt-3 border-t border-border pt-2"
          >
            <h4 className="mb-2 text-xs text-muted-foreground">Earlier plan</h4>
            <ComposerPlanSteps
              snapshot={displayed(snapshot)}
              executing={false}
              onQuestion={onQuestion}
            />
          </section>
        ))}
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
        {plan?.historyTruncated && (
          <p className="mt-2 text-2xs text-subtle-foreground">
            Earlier plan history truncated
          </p>
        )}
      </div>
    </ComposerContextItem>
  );
}
