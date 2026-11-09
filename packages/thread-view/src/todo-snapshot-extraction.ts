import type {
  Thread,
  ThreadEvent,
  ThreadEventPlanStep,
  ThreadTimelinePendingTodoItem,
  ThreadTimelinePendingTodoItemStatus,
  ThreadTimelinePendingTodos,
} from "@bb/domain";
import { sliceUtf16Head } from "@bb/text-utils";
import { getThreadEventScopeTurnId } from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { getOrderedThreadEvents } from "./group-event-projection-turns.js";

const TODO_TEXT_MAX_LENGTH = 240;

function trimAndTruncate(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TODO_TEXT_MAX_LENGTH) return trimmed;
  return sliceUtf16Head(trimmed, TODO_TEXT_MAX_LENGTH);
}

interface SnapshotCandidate {
  planId?: string;
  seq: number;
  createdAt: number;
  turnId: string | null;
  items: ThreadTimelinePendingTodoItem[];
}

interface SnapshotCandidateMeta {
  seq: number;
  createdAt: number;
}

function todoIdFor(seq: number, index: number): string {
  return `seq:${seq}:${index}`;
}

const PLAN_STEP_TODO_STATUSES: Readonly<
  Record<
    NonNullable<ThreadEventPlanStep["status"]>,
    ThreadTimelinePendingTodoItemStatus
  >
> = {
  pending: "pending",
  active: "in_progress",
  completed: "completed",
  failed: "failed",
};

function extractPlanStepsCandidate(
  event: ThreadEvent,
  meta: SnapshotCandidateMeta,
): SnapshotCandidate | null {
  if (event.type !== "item/completed" || event.item.type !== "planSteps") {
    return null;
  }
  const items: ThreadTimelinePendingTodoItem[] = [];
  for (const [index, step] of event.item.steps.entries()) {
    const text = trimAndTruncate(step.step);
    if (text.length === 0) continue;
    items.push({
      id: step.id ?? todoIdFor(meta.seq, index),
      text,
      ...(step.note === undefined ? {} : { note: step.note }),
      ...(step.actor === undefined ? {} : { actor: step.actor }),
      status: PLAN_STEP_TODO_STATUSES[step.status ?? "pending"],
    });
  }
  return {
    ...(event.item.planId ? { planId: event.item.planId } : {}),
    seq: meta.seq,
    createdAt: meta.createdAt,
    turnId: getThreadEventScopeTurnId(event.scope) ?? null,
    items,
  };
}

function staleSince(
  plan: SnapshotCandidate,
  events: readonly ThreadEventWithMeta[],
): number | undefined {
  if (!plan.items.some((item) => item.status !== "completed")) return undefined;
  const seen = new Set<string>();
  const later = new Set<string>();
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const turnId = getThreadEventScopeTurnId(event.scope) ?? null;
    if (event.type === "turn/started" && turnId !== null && !seen.has(turnId)) {
      seen.add(turnId);
      if (
        !event.parentToolCallId &&
        meta.seq > plan.seq &&
        turnId !== plan.turnId
      )
        later.add(turnId);
    }
    if (meta.seq <= plan.seq) continue;
    if (
      (event.type === "turn/completed" &&
        turnId !== null &&
        later.has(turnId)) ||
      (event.type === "system/thread/interrupted" && later.size > 0)
    )
      return meta.createdAt;
  }
  return undefined;
}

export function extractThreadTimelinePendingTodos(
  _threadStatus: Thread["status"],
  events: readonly ThreadEventWithMeta[],
  turnEvents: readonly ThreadEventWithMeta[] = events,
): ThreadTimelinePendingTodos | null {
  let best: SnapshotCandidate | null = null;
  for (const { event, meta } of getOrderedThreadEvents(events)) {
    const candidate = extractPlanStepsCandidate(event, meta);
    if (!candidate) continue;
    if (best === null || candidate.seq > best.seq) {
      best = candidate;
    }
  }
  if (best === null) return null;
  const staleAt = staleSince(best, turnEvents);
  return {
    ...(best.planId ? { planId: best.planId } : {}),
    sourceSeq: best.seq,
    updatedAt: best.createdAt,
    ...(staleAt === undefined ? {} : { staleSince: staleAt }),
    items: best.items,
  };
}
