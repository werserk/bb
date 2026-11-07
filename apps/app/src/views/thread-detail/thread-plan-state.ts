import type { ThreadTimelinePendingTodos } from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";

export function latestPlanTurn(rows: readonly TimelineRow[]) {
  let latest: { sourceSeq: number; startedAt: number } | null = null;
  for (const row of rows) {
    const newTurnMessage =
      row.kind === "conversation" &&
      row.role === "user" &&
      row.turnRequest.kind === "message" &&
      row.turnRequest.status === "accepted";
    if (row.kind !== "turn" && !newTurnMessage) continue;
    if (latest === null || row.sourceSeqStart > latest.sourceSeq) {
      latest = { sourceSeq: row.sourceSeqStart, startedAt: row.startedAt };
    }
  }
  return latest;
}

export function threadPlanState(
  plan: ThreadTimelinePendingTodos,
  latestTurn: ReturnType<typeof latestPlanTurn>,
  waitingForOwner: boolean,
) {
  const stale =
    latestTurn !== null &&
    latestTurn.sourceSeq > plan.sourceSeq &&
    latestTurn.startedAt >= plan.updatedAt;
  const completed =
    plan.items.length > 0 &&
    plan.items.every((item) => item.status === "completed");
  const state = completed ? "finished" : waitingForOwner ? "waiting" : "active";
  return { state, autoCollapse: stale && completed } as const;
}
