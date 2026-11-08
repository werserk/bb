import { threadPresentationText as t } from "@bb/thread-view";
import { useEffect, useId, useState } from "react";
import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
  PROMPT_STACK_CARD_ROW_HEIGHT,
  PromptStackCard,
} from "@/components/promptbox/banner/PromptStackCard";
import {
  activityIconClass,
  activityRowClass,
  activityTextClass,
  type ActivityRowState,
} from "@bb/shared-ui/activity-row-styles";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
  PromptStackHoverChevron,
  useDisclosureFocusHandoff,
  AnimatedDisclosureBody,
} from "@bb/shared-ui/prompt-stack-disclosure";

const STATUS_ACTIVITY_STATE: Record<
  ThreadTimelinePendingTodoItemStatus,
  ActivityRowState
> = {
  in_progress: "active",
  pending: "pending",
  completed: "completed",
  failed: "failed",
};

interface ThreadTodoCardProps {
  pendingTodos: ThreadTimelinePendingTodos | null;
  state?: "active" | "waiting" | "finished";
  locale?: string;
  isExpanded: boolean;
  onToggle: () => void;
}

const TODO_HEADER_BUTTON_CLASS = activityRowClass(
  "active",
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
);
const TODO_ACTIVE_ROW_CLASS = "shadow-none ring-0";
const TODO_ACTIVE_ICON_CLASS = "text-foreground";

function getTodoSummary(items: readonly ThreadTimelinePendingTodoItem[]) {
  const count = items.filter((item) => item.status === "completed").length;
  return { count, aria: `${count} of ${items.length} items complete` };
}

function TodoStatusIcon({
  status,
  failedLabel,
}: {
  status: ThreadTimelinePendingTodoItemStatus;
  failedLabel: string;
}) {
  const className = "size-3.5 shrink-0";
  const activityState = STATUS_ACTIVITY_STATE[status];
  switch (status) {
    case "in_progress":
      return (
        <Icon
          name="Square"
          className={cn(className, TODO_ACTIVE_ICON_CLASS)}
          aria-hidden="true"
        />
      );
    case "completed":
      return (
        <Icon
          name="Check"
          className={cn(className, activityIconClass(activityState))}
          aria-hidden="true"
        />
      );
    case "failed":
      return (
        <span role="img" aria-label={failedLabel}>
          <Icon
            name="CircleX"
            aria-hidden="true"
            className={cn(className, activityIconClass(activityState))}
          />
        </span>
      );
    case "pending":
      return (
        <Icon
          name="Square"
          className={cn(className, activityIconClass(activityState))}
          aria-hidden="true"
        />
      );
  }
}

function TodoBody({
  items,
  failedLabel,
  stale,
}: {
  items: readonly ThreadTimelinePendingTodoItem[];
  failedLabel: string;
  stale: boolean;
}) {
  return (
    <ul className="max-h-40 @min-[880px]/thread-chat:max-h-96 space-y-1 overflow-y-auto px-2.5 pb-2 pt-2">
      {items.map((item) => {
        const activityState = STATUS_ACTIVITY_STATE[item.status];
        const isActive = activityState === "active";
        const muted =
          stale && item.status !== "completed" && item.status !== "failed";
        return (
          <li
            key={item.id}
            className={activityRowClass(
              activityState,
              cn(
                "flex min-w-0 items-start gap-2 text-xs",
                isActive && TODO_ACTIVE_ROW_CLASS,
                muted &&
                  "!text-muted-foreground [&_span]:!text-muted-foreground [&_svg]:!text-muted-foreground",
              ),
            )}
          >
            <TodoStatusIcon status={item.status} failedLabel={failedLabel} />
            <div className="min-w-0 flex-1">
              <span
                className={activityTextClass(
                  activityState,
                  "min-w-0 break-words",
                )}
                title={item.text}
              >
                {item.text}
              </span>
              {item.actor && (
                <span
                  className="ml-2 inline-block max-w-24 truncate rounded border px-1 text-muted-foreground align-bottom"
                  title={item.actor}
                >
                  {item.actor}
                </span>
              )}
              {item.note && (
                <span
                  className="mt-1 block break-words text-muted-foreground"
                  title={item.note}
                >
                  {item.note}
                </span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function ThreadTodoCard({
  pendingTodos,
  state = "active",
  locale = typeof navigator === "undefined" ? "en" : navigator.language,
  isExpanded,
  onToggle,
}: ThreadTodoCardProps) {
  const bodyId = useId();
  const toggleId = useId();
  const focus = useDisclosureFocusHandoff(isExpanded, onToggle);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const items = pendingTodos?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  const summary = getTodoSummary(items);
  const ru = locale.toLowerCase().startsWith("ru");
  const labels = ru
    ? {
        active: "План",
        waiting: "План · ждёт тебя",
        finished: "План завершён",
      }
    : {
        active: "Plan",
        waiting: "Plan · waiting for you",
        finished: "Plan completed",
      };
  const muted = state === "finished";
  const time = new Date(pendingTodos?.updatedAt ?? 0).toLocaleTimeString(
    locale,
    {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    },
  );
  const progressLabel = ru
    ? `Выполнено: ${summary.count}/${items.length}`
    : summary.aria;
  const title = `${labels[state]}${!isExpanded && muted ? ` · ${time}` : ""}${!isExpanded ? ` · ${summary.count}/${items.length}` : ""}`;
  const elapsedMinutes = Math.max(
    0,
    Math.floor((now - (pendingTodos?.updatedAt ?? now)) / 60_000),
  );
  const age =
    elapsedMinutes === 0
      ? ru
        ? "только что"
        : "just now"
      : new Intl.RelativeTimeFormat(locale, {
          style: "short",
          numeric: "always",
        }).format(
          -Math.floor(
            elapsedMinutes >= 1440
              ? elapsedMinutes / 1440
              : elapsedMinutes >= 60
                ? elapsedMinutes / 60
                : elapsedMinutes,
          ),
          elapsedMinutes >= 1440
            ? "day"
            : elapsedMinutes >= 60
              ? "hour"
              : "minute",
        );
  const metadata = `${ru ? "Обновлено" : "Updated"} ${age}`;
  const stale =
    pendingTodos?.staleSince !== undefined &&
    items.some((item) => item.status !== "completed");
  const staleLabel = ru
    ? "Не обновлён после завершения более позднего хода"
    : "Not updated since a later turn ended";
  return (
    <PromptStackCard
      ariaLabel={labels[state]}
      className={cn(
        "overflow-hidden rounded-xl",
        state === "waiting" && "border-warning text-warning",
        muted &&
          "text-muted-foreground [&_li]:!text-muted-foreground [&_li_span]:!text-muted-foreground [&_li_svg]:!text-muted-foreground",
      )}
      style={{ minHeight: PROMPT_STACK_CARD_ROW_HEIGHT }}
    >
      <div className="flex items-center">
        <button
          type="button"
          id={toggleId}
          aria-expanded={isExpanded}
          aria-controls={bodyId}
          aria-label={`${title}: ${progressLabel}`}
          ref={focus.triggerRef}
          onClick={focus.onTriggerClick}
          className={cn(
            TODO_HEADER_BUTTON_CLASS,
            state === "waiting" && "!text-warning",
            muted && "!text-muted-foreground",
            PROMPT_STACK_DISCLOSURE_TRIGGER_CLASS,
          )}
        >
          <Icon
            name={
              state === "finished"
                ? "Check"
                : state === "waiting"
                  ? "CircleAlert"
                  : "ListTodo"
            }
            className="size-3.5 shrink-0"
            aria-hidden="true"
          />
          <span
            className={activityTextClass(
              "active",
              "min-w-0 flex-1 truncate text-left",
            )}
          >
            {title}
          </span>
          <PromptStackHoverChevron isExpanded={isExpanded} />
        </button>
      </div>
      <div className="px-3 pb-2 text-xs text-muted-foreground" data-plan-age="">
        <time
          dateTime={new Date(pendingTodos?.updatedAt ?? 0).toISOString()}
          title={new Date(pendingTodos?.updatedAt ?? 0).toLocaleString(locale)}
        >
          {metadata}
        </time>
        {stale && (
          <p
            className="mt-1 leading-relaxed"
            title={new Date(pendingTodos?.staleSince ?? 0).toLocaleString(
              locale,
            )}
          >
            {staleLabel}
          </p>
        )}
      </div>
      <AnimatedDisclosureBody
        id={bodyId}
        labelledBy={toggleId}
        isExpanded={isExpanded}
        collapsedBorder="none"
        collapseLabel={ru ? "Свернуть план" : "Collapse plan"}
        collapseRef={focus.collapseRef}
        onCollapse={focus.onCollapseClick}
      >
        <TodoBody
          items={items}
          failedLabel={t("plan.failed", locale)}
          stale={stale}
        />
      </AnimatedDisclosureBody>
    </PromptStackCard>
  );
}
