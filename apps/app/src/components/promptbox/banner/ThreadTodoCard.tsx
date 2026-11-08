import { threadPresentationText as t } from "@bb/thread-view";
import { useEffect, useId, useRef, useState } from "react";
import type {
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import {
  PROMPT_STACK_CARD_HEADER_BUTTON_CLASS,
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
  regionLabel,
}: {
  regionLabel: string;
  items: readonly ThreadTimelinePendingTodoItem[];
  failedLabel: string;
  stale: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const activeIndex = items.findIndex((item) => item.status === "in_progress");
  useEffect(() => {
    const viewport = listRef.current;
    const first = viewport?.querySelector("li");
    if (viewport && first)
      viewport.scrollTop =
        Math.max(0, activeIndex - 1) * first.getBoundingClientRect().height;
  }, [activeIndex]);
  return (
    <div
      ref={listRef}
      className="max-h-36 overflow-y-auto overscroll-contain snap-y snap-mandatory outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-ring"
      role="region"
      aria-label={regionLabel}
      tabIndex={0}
    >
      <ul className="m-0 list-none p-0">
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
                  "flex h-9 min-w-0 snap-start items-center gap-2 overflow-hidden px-2.5 py-0 text-xs",
                  isActive && TODO_ACTIVE_ROW_CLASS,
                  muted &&
                    "!text-muted-foreground [&_span]:!text-muted-foreground [&_[data-icon-root]]:!text-muted-foreground",
                ),
              )}
            >
              <TodoStatusIcon status={item.status} failedLabel={failedLabel} />
              <div className="min-w-0 flex-1">
                <span
                  className={activityTextClass(
                    activityState,
                    "block min-w-0 truncate leading-4",
                  )}
                  title={item.text}
                >
                  {item.text}
                </span>
                {item.note && (
                  <span
                    className="block truncate text-2xs leading-3.5 text-muted-foreground"
                    title={item.note}
                  >
                    {item.note}
                  </span>
                )}
              </div>
              {item.actor && (
                <span
                  className="max-w-16 shrink-0 truncate rounded border px-1 text-2xs text-muted-foreground"
                  title={item.actor}
                >
                  {item.actor}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
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
  const triggerRef = useRef<HTMLButtonElement>(null);
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
        "max-w-full overflow-hidden shadow-lg",
        isExpanded
          ? "w-76 rounded-xl @min-[880px]/thread-chat:w-80"
          : "w-auto rounded-full",
        state === "waiting" && "border-warning text-warning",
        muted &&
          "text-muted-foreground [&_li]:!text-muted-foreground [&_li_span]:!text-muted-foreground [&_li_[data-icon-root]]:!text-muted-foreground",
      )}
      onKeyDown={(event) => {
        if (event.key === "Escape" && isExpanded) {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
          triggerRef.current?.focus();
        }
      }}
    >
      <button
        type="button"
        id={toggleId}
        aria-expanded={isExpanded}
        aria-controls={isExpanded ? bodyId : undefined}
        aria-label={`${title}: ${progressLabel} · ${metadata}${stale ? ` · ${staleLabel}` : ""}`}
        ref={triggerRef}
        onClick={onToggle}
        className={cn(
          TODO_HEADER_BUTTON_CLASS,
          "h-8 py-0 focus-visible:outline-offset-[-2px]",
          isExpanded && "border-b",
          state === "waiting" && "!text-warning",
          muted && "!text-muted-foreground",
        )}
      >
        <Icon
          name={
            state === "finished"
              ? "Check"
              : state === "waiting" || stale
                ? "CircleAlert"
                : "ListTodo"
          }
          className="size-3.5 shrink-0"
          aria-hidden="true"
        />
        <span
          className="shrink-0"
          title={`${metadata}${stale ? ` · ${staleLabel}` : ""}`}
        >
          {labels[state]}
        </span>
        {isExpanded && (
          <span
            className="h-1 w-8 shrink-0 overflow-hidden rounded-full bg-surface-recessed"
            aria-hidden="true"
          >
            <span
              className="block h-full bg-success"
              style={{ width: `${(summary.count / items.length) * 100}%` }}
            />
          </span>
        )}
        <span className="shrink-0 tabular-nums">
          {summary.count}/{items.length}
        </span>
        <span
          className={
            isExpanded
              ? "ml-auto min-w-0 truncate text-2xs text-muted-foreground"
              : "sr-only"
          }
          data-plan-age=""
        >
          <time dateTime={new Date(pendingTodos?.updatedAt ?? 0).toISOString()}>
            {metadata}
          </time>
          {stale && <span className="sr-only">{staleLabel}</span>}
        </span>
        {isExpanded && (
          <Icon
            name="ChevronUp"
            className="size-3 shrink-0"
            aria-hidden="true"
          />
        )}
      </button>
      {isExpanded && (
        <div id={bodyId}>
          <TodoBody
            items={items}
            failedLabel={t("plan.failed", locale)}
            stale={stale}
            regionLabel={ru ? "Шаги плана" : "Plan steps"}
          />
        </div>
      )}
    </PromptStackCard>
  );
}
