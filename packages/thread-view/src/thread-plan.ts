import {
  getThreadEventScopeTurnId,
  type PlanSnapshotView,
  type ThreadPlanView,
  type ThreadStatus,
} from "@bb/domain";
import type { ThreadEventWithMeta } from "./build-event-projection.js";
import { extractThreadTimelinePendingTodos } from "./todo-snapshot-extraction.js";

export interface PlanInteractionAnchor {
  interactionId: string;
  turnId: string | null;
  event: ThreadEventWithMeta | null;
}
export function projectThreadPlan(args: {
  threadId: string;
  revision: number;
  status: ThreadStatus;
  events: readonly ThreadEventWithMeta[];
  turnEvents?: readonly ThreadEventWithMeta[];
  anchors: readonly PlanInteractionAnchor[];
  attentionInteractionIds: readonly string[];
  historyTruncated: boolean;
  ownInputRequired?: boolean;
  sendFailed?: boolean;
}): ThreadPlanView {
  const ordered = [...args.events].sort((a, b) => b.meta.seq - a.meta.seq);
  const snapshots: PlanSnapshotView[] = [];
  const seen = new Set<string>();
  let truncated = args.historyTruncated;
  let outputTruncated = false;
  for (const event of ordered) {
    const snapshot = extractThreadTimelinePendingTodos(
      args.status,
      [event],
      args.turnEvents ?? [],
    );
    if (!snapshot) continue;
    if (!snapshot.items.length) {
      truncated = false;
      break;
    }
    if (snapshot.planId && seen.has(snapshot.planId)) continue;
    if (snapshot.planId) seen.add(snapshot.planId);
    if (snapshots.length && !snapshot.planId) continue;
    if (snapshots.length === 4) {
      outputTruncated = true;
      continue;
    }
    snapshots.push({
      ...snapshot,
      items: snapshot.items.map((item) => ({ ...item, interactionIds: [] })),
    });
  }
  const unbound = new Set(args.attentionInteractionIds);
  for (const anchor of args.anchors) {
    const event = anchor.event?.event;
    if (
      !event ||
      event.type !== "item/completed" ||
      event.item.type !== "planSteps" ||
      getThreadEventScopeTurnId(event.scope) !== anchor.turnId
    )
      continue;
    const active = event.item.steps.filter((step) => step.status === "active");
    if (active.length !== 1) continue;
    const step = active[0]!;
    const target = snapshots.find((snapshot) =>
      event.item.type === "planSteps" && event.item.planId && step.id
        ? snapshot.planId === event.item.planId
        : snapshot.sourceSeq === anchor.event!.meta.seq,
    );
    if (!target) continue;
    const index = event.item.steps.indexOf(step);
    const row = target.items.find(
      (item) =>
        item.id === (step.id ?? `seq:${anchor.event!.meta.seq}:${index}`),
    );
    if (!row) continue;
    row.status = "needs_input";
    row.interactionIds = [...row.interactionIds, anchor.interactionId];
    unbound.delete(anchor.interactionId);
  }
  const current = snapshots[0] ?? null;
  const failed =
    args.status === "error" ||
    args.sendFailed ||
    (current?.staleSince === undefined &&
      current?.items.some((item) => item.status === "failed"));
  return {
    threadId: args.threadId,
    revision: args.revision,
    current,
    previousPlans: snapshots.slice(1),
    historyTruncated: truncated || outputTruncated,
    ownAttention:
      args.attentionInteractionIds.length || args.ownInputRequired
        ? "needs_input"
        : failed
          ? "failed"
          : "none",
    attentionInteractionIds: args.attentionInteractionIds,
    unboundInteractionIds: [...unbound],
  };
}
