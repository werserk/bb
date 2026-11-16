import type { ThreadEventRow } from "@bb/domain";
import type { ThreadTimelineResponse } from "@bb/server-contract";

export function composerSuggestionContext(
  timeline:
    | Pick<ThreadTimelineResponse, "tag" | "maxSeq" | "contextBoundarySeq">
    | undefined,
  lifecycle: string,
  questions: readonly { id: string }[],
  queued: number,
  connected: boolean,
  events: readonly ThreadEventRow[] = [],
  openQuestions:
    | { total: number; readRevision: string }
    | undefined = undefined,
) {
  const ordered = [...events].sort((a, b) => b.seq - a.seq);
  const root = ordered.find(
    (event) => event.type === "turn/started" && !event.data.parentToolCallId,
  );
  const rootTurnId = root?.scope.kind === "turn" ? root.scope.turnId : null;
  const completed =
    root && rootTurnId !== null
      ? ordered.find(
          (event) =>
            event.type === "turn/completed" &&
            event.scope.kind === "turn" &&
            event.scope.turnId === rootTurnId &&
            event.seq > root.seq,
        )
      : undefined;
  const completedTurnId =
    completed?.scope.kind === "turn" ? completed.scope.turnId : "";
  return {
    completedTurnId,
    contextRevision: JSON.stringify([
      timeline?.tag,
      timeline?.maxSeq,
      timeline?.contextBoundarySeq,
      openQuestions?.readRevision,
      openQuestions?.total,
      root?.id,
      completed?.id,
      lifecycle,
      questions.map((q) => q.id),
      queued,
      connected,
    ]),
    eligible:
      openQuestions !== undefined &&
      openQuestions.total === 0 &&
      timeline !== undefined &&
      connected &&
      lifecycle === "idle" &&
      queued === 0 &&
      questions.length === 0 &&
      completed?.type === "turn/completed" &&
      completed.data.status === "completed" &&
      completed.seq > (timeline.contextBoundarySeq ?? -1) &&
      !ordered.some(
        (event) =>
          event.seq > completed.seq &&
          event.type === "system/thread/interrupted",
      ),
  };
}
