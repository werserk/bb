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
  return {
    requestIds,
    turnIds,
    latestIsService:
      latest?.event.type === "client/turn/requested" &&
      latest.event.serviceTurn !== undefined,
    hides({ event, meta }: ThreadEventWithMetaLike) {
      const turnId = getThreadEventScopeTurnId(event.scope);
      return (
        hiddenAt(meta.seq) ||
        (event.type === "system/thread/interrupted" &&
          event.serviceTurn !== undefined) ||
        requestSequences.has(meta.seq) ||
        (turnId !== undefined && turnIds.has(turnId))
      );
    },
    filterRows(rows: readonly TimelineRow[]): TimelineRow[] {
      const exceptions = (row: TimelineRow): TimelineRow[] => {
        if (row.kind === "turn")
          return (row.children ?? []).flatMap(exceptions);
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
      return rows.flatMap((row) =>
        hiddenAt(row.sourceSeqStart) ||
        (row.turnId !== null && turnIds.has(row.turnId)) ||
        requestSequences.has(row.sourceSeqStart)
          ? exceptions(row)
          : [row],
      );
    },
  };
}
