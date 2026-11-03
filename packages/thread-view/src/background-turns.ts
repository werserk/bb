import type { TimelineRowBase, TimelineRowStatus } from "@bb/server-contract";
import type { ThreadTimelineViewRow } from "./timeline-view.js";

export interface TimelineBackgroundTurnsRow extends TimelineRowBase {
  kind: "background-turns";
  status: TimelineRowStatus;
  turnCount: number;
  children: ThreadTimelineViewRow[];
}

export interface CollapseBackgroundTurnsOptions {
  /** True while the thread's root run is active; the trailing segment is then in flight. */
  threadRunning: boolean;
}

function isAgentInitiatedRequest(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.initiator !== "user" &&
    row.turnRequest.kind !== "steer" &&
    row.turnRequest.status !== "rejected"
  );
}

function isOwnerRow(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.initiator === "user"
  );
}

function isOwnerSteer(row: ThreadTimelineViewRow): boolean {
  return (
    row.kind === "conversation" &&
    row.role === "user" &&
    row.initiator === "user" &&
    row.turnRequest.kind === "steer"
  );
}

function hasFailure(rows: readonly ThreadTimelineViewRow[]): boolean {
  return rows.some((row) => row.kind === "turn" && row.status === "error");
}

function buildRow(
  segment: ThreadTimelineViewRow[],
  turnCount: number,
  running: boolean,
): TimelineBackgroundTurnsRow {
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  return {
    id: `background-turns:${first.id}`,
    threadId: first.threadId,
    turnId: null,
    sourceSeqStart: first.sourceSeqStart,
    sourceSeqEnd: last.sourceSeqEnd,
    startedAt: first.startedAt,
    createdAt: first.createdAt,
    kind: "background-turns",
    status: running ? "pending" : "completed",
    turnCount,
    children: segment,
  };
}

/**
 * Folds runs of agent- or system-initiated turns into one `background-turns`
 * row. A run starts at a non-owner turn request and ends at the next owner
 * message. Runs that contain a failed turn stay visible as they are. When the
 * owner steers a run, only the turn being steered stays visible. A system or
 * agent steer never starts a run, so it cannot pull an owner turn into one.
 */
export function collapseBackgroundTurns(
  rows: readonly ThreadTimelineViewRow[],
  options: CollapseBackgroundTurnsOptions,
): ThreadTimelineViewRow[] {
  const out: ThreadTimelineViewRow[] = [];
  let segment: ThreadTimelineViewRow[] = [];
  let turnCount = 0;

  const flush = (endedBy: ThreadTimelineViewRow | null): void => {
    if (segment.length === 0) return;
    if (hasFailure(segment)) {
      out.push(...segment);
    } else if (endedBy !== null && isOwnerSteer(endedBy)) {
      let steeredFrom = segment.length - 1;
      while (
        steeredFrom > 0 &&
        !isAgentInitiatedRequest(segment[steeredFrom]!)
      ) {
        steeredFrom -= 1;
      }
      const earlier = segment.slice(0, steeredFrom);
      if (earlier.length > 0) {
        out.push(buildRow(earlier, turnCount - 1, false));
      }
      out.push(...segment.slice(steeredFrom));
    } else {
      out.push(
        buildRow(segment, turnCount, endedBy === null && options.threadRunning),
      );
    }
    segment = [];
    turnCount = 0;
  };

  for (const row of rows) {
    if (segment.length > 0) {
      if (isOwnerRow(row)) {
        flush(row);
        out.push(row);
        continue;
      }
      if (isAgentInitiatedRequest(row)) turnCount += 1;
      segment.push(row);
      continue;
    }
    if (isAgentInitiatedRequest(row)) {
      segment.push(row);
      turnCount = 1;
      continue;
    }
    out.push(row);
  }
  flush(null);
  return out;
}
