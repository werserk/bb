import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TaskMemory } from "./task-state.js";
import { contextInput, sourceMessage, textRevision } from "./context-input.js";

export async function readContext(
  bb: BbPluginApi,
  threadId: string,
  limit: number,
  signal?: AbortSignal,
  options: { allowActive?: boolean; memory?: TaskMemory | null } = {},
) {
  const [thread, timeline, questions, interactions, events] = await Promise.all(
    [
      bb.sdk.threads.get({ threadId, signal }),
      bb.sdk.threads.timeline({
        threadId,
        segmentLimit: "40",
        includeNestedRows: "true",
        includeService: "false",
        signal,
      }),
      bb.sdk.threads.questions.open({ threadId, limit: 1, signal }),
      bb.sdk.threads.interactions.list({ threadId, signal }),
      bb.sdk.threads.events.list({
        threadId,
        signal,
        types: ["turn/started", "turn/completed", "system/thread/interrupted"],
        order: "desc",
        limit: "64",
      }),
    ],
  );
  if (
    (thread.status !== "idle" &&
      !(options.allowActive && thread.status === "active")) ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.queuedMessageCount > 0 ||
    questions.total > 0 ||
    interactions.length > 0
  )
    return null;
  const start = events.find(
    (event) => event.type === "turn/started" && !event.data.parentToolCallId,
  );
  if (!start || start.scope.kind !== "turn") return null;
  const turnId = start.scope.turnId;
  const completion = events.find(
    (event) =>
      event.type === "turn/completed" &&
      event.scope.kind === "turn" &&
      event.scope.turnId === turnId,
  );
  const completed = !(
    !completion ||
    completion.type !== "turn/completed" ||
    completion.data.status !== "completed" ||
    completion.seq < start.seq ||
    events.some(
      (event) =>
        event.type === "system/thread/interrupted" &&
        event.seq > completion.seq,
    )
  );
  if (!completed && !options.allowActive) return null;
  const messages = timeline.rows
    .flatMap((row) => (row.kind === "turn" ? (row.children ?? []) : [row]))
    .filter((row) => row.kind === "conversation")
    .filter((row) => row.sourceSeqEnd > (timeline.contextBoundarySeq ?? -1))
    .filter(
      (row) =>
        row.role !== "user" ||
        (row.senderThreadId === null && row.initiator === "user"),
    )
    .sort((a, b) => a.sourceSeqEnd - b.sourceSeqEnd);
  const last = messages.at(-1);
  const eligible =
    thread.status === "idle" &&
    completed &&
    last?.role === "assistant" &&
    last.turnId === turnId;
  if (!eligible && !options.allowActive) return null;
  const input = contextInput(
    messages.map((message) =>
      sourceMessage(
        message.id,
        message.role,
        message.text,
        message.sourceSeqEnd,
      ),
    ),
    limit,
    options.memory ?? null,
    timeline.contextBoundarySeq ?? null,
    timeline.timelinePage.olderCursor !== null,
  );
  if (!input) return null;
  return {
    projectId: thread.projectId,
    turnId,
    eligible,
    boundary: timeline.contextBoundarySeq ?? null,
    revision: textRevision(
      JSON.stringify([
        timeline.contextBoundarySeq,
        turnId,
        messages.map((message) => [message.id, message.text]),
      ]),
    ),
    ...input,
  };
}
export type CompanionContext = NonNullable<
  Awaited<ReturnType<typeof readContext>>
>;
