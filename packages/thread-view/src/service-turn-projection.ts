import {
  getThreadEventScopeTurnId,
  type ClientTurnRequestId,
} from "@bb/domain";
import type { TimelineRow } from "@bb/server-contract";
import type { ThreadEventWithMetaLike } from "./accepted-client-request-context.js";

export function classifyServiceTurns(
  events: readonly ThreadEventWithMetaLike[],
) {
  const requestIds = new Set<ClientTurnRequestId>();
  const turnIds = new Set<string>();
  const requestSequences = new Set<number>();
  for (const { event, meta } of events) {
    if (event.type === "system/thread/interrupted" && event.serviceTurn)
      requestSequences.add(meta.seq);
    if (event.type === "client/turn/requested" && event.serviceTurn) {
      requestIds.add(event.requestId);
      requestSequences.add(meta.seq);
    }
  }
  for (const { event } of events) {
    if (
      event.type === "turn/input/accepted" &&
      requestIds.has(event.clientRequestId)
    ) {
      const turnId = getThreadEventScopeTurnId(event.scope);
      if (turnId) turnIds.add(turnId);
    }
  }
  const requests = events
    .filter(({ event }) => event.type === "client/turn/requested")
    .sort((a, b) => a.meta.seq - b.meta.seq);
  const latest = requests[requests.length - 1];
  const hiddenAt = (seq: number) => {
    let left = 0,
      right = requests.length;
    while (left < right) {
      const mid = (left + right) >>> 1;
      if (requests[mid]!.meta.seq <= seq) left = mid + 1;
      else right = mid;
    }
    const request = requests[left - 1]?.event;
    return (
      request?.type === "client/turn/requested" &&
      request.serviceTurn !== undefined
    );
  };
  const liveTurns = new Map<string, ThreadEventWithMetaLike>();
  for (const entry of [...events].sort((a, b) => a.meta.seq - b.meta.seq)) {
    if (entry.event.type === "system/thread/interrupted") liveTurns.clear();
    const turnId = getThreadEventScopeTurnId(entry.event.scope);
    if (!turnId) continue;
    if (entry.event.type === "turn/started" && !entry.event.parentToolCallId)
      liveTurns.clear();
    if (
      entry.event.type === "turn/started" &&
      (turnIds.has(turnId) || hiddenAt(entry.meta.seq))
    )
      liveTurns.set(turnId, entry);
    if (entry.event.type === "turn/completed") liveTurns.delete(turnId);
  }
  return {
    requestIds,
    turnIds,
    latestIsService:
      latest?.event.type === "client/turn/requested" &&
      latest.event.serviceTurn !== undefined,
    hides({ event, meta }: ThreadEventWithMetaLike) {
      return (
        hiddenAt(meta.seq) ||
        (event.type === "system/thread/interrupted" &&
          event.serviceTurn !== undefined) ||
        requestSequences.has(meta.seq)
      );
    },
    filterRows(
      rows: readonly TimelineRow[],
      showLiveWork = false,
    ): TimelineRow[] {
      const exceptions = (row: TimelineRow): TimelineRow[] => {
        if (
          row.kind === "conversation" &&
          row.role === "user" &&
          row.initiator === "user"
        )
          return [row];
        if (row.kind === "turn")
          return (row.children ?? []).flatMap(exceptions);
        if (
          showLiveWork &&
          row.turnId !== null &&
          liveTurns.has(row.turnId) &&
          row.kind === "work"
        )
          return [row];
        if (
          row.kind === "work" &&
          (row.workKind === "question" ||
            row.workKind === "approval" ||
            (row.workKind === "tool" &&
              row.presentation?.ownerPost === true &&
              row.status === "completed"))
        )
          return [row];
        return [];
      };
      const visible = rows.flatMap((row) =>
        hiddenAt(row.sourceSeqStart) || requestSequences.has(row.sourceSeqStart)
          ? exceptions(row)
          : [row],
      );
      if (!showLiveWork || liveTurns.size === 0) return visible;
      for (const [turnId, { meta, event }] of liveTurns) {
        visible.push({
          id: `service-activity:${meta.id}`,
          threadId: event.threadId,
          turnId,
          sourceSeqStart: meta.seq,
          sourceSeqEnd: meta.seq,
          startedAt: meta.createdAt,
          createdAt: meta.createdAt,
          kind: "turn",
          status: "pending",
          summaryCount: 0,
          completedAt: null,
          children: [],
        });
      }
      return visible.sort((a, b) => a.sourceSeqStart - b.sourceSeqStart);
    },
  };
}
