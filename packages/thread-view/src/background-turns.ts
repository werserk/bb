import type { TimelineRowBase, TimelineRowStatus } from "@bb/server-contract";
import { isOwnerPostRow } from "./owner-post.js";
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
  running: boolean,
): TimelineBackgroundTurnsRow {
  const first = segment[0]!;
  const last = segment[segment.length - 1]!;
  const requestCount = segment.filter(isAgentInitiatedRequest).length;
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
    turnCount: Math.max(1, requestCount),
    children: segment,
  };
}

function collapseAroundOwnerPosts(
  segment: ThreadTimelineViewRow[],
  running: boolean,
): ThreadTimelineViewRow[] {
  const out: ThreadTimelineViewRow[] = [];
  let chunk: ThreadTimelineViewRow[] = [];
  const flushChunk = (last: boolean): void => {
    if (chunk.length === 0) return;
    out.push(buildRow(chunk, last && running));
    chunk = [];
  };
  for (const row of segment) {
    if (isOwnerPostRow(row)) {
      flushChunk(false);
      out.push(row);
      continue;
    }
    chunk.push(row);
  }
  flushChunk(true);
  return out;
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
      out.push(...collapseAroundOwnerPosts(earlier, false));
      out.push(...segment.slice(steeredFrom));
    } else {
      out.push(
        ...collapseAroundOwnerPosts(
          segment,
          endedBy === null && options.threadRunning,
        ),
      );
    }
    segment = [];
  };

  for (const row of rows) {
    if (segment.length > 0) {
      if (isOwnerRow(row)) {
        flush(row);
        out.push(row);
        continue;
      }
      segment.push(row);
      continue;
    }
    if (isAgentInitiatedRequest(row)) {
      segment.push(row);
      continue;
    }
    out.push(row);
  }
  flush(null);
  return out;
}
