import type { BbPluginApi } from "@get-bb/plugin-sdk";

export async function readContext(
  bb: BbPluginApi,
  threadId: string,
  limit: number,
  signal?: AbortSignal,
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
    thread.status !== "idle" ||
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
  if (
    !completion ||
    completion.type !== "turn/completed" ||
    completion.data.status !== "completed" ||
    completion.seq < start.seq ||
    events.some(
      (event) =>
        event.type === "system/thread/interrupted" &&
        event.seq > completion.seq,
    )
  )
    return null;
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
  if (!last || last.role !== "assistant" || last.turnId !== turnId) return null;
  const selected: { role: string; text: string }[] = [];
  for (const message of [...messages].reverse()) {
    const next = [{ role: message.role, text: message.text }, ...selected];
    if (JSON.stringify(next).length > limit) break;
    selected.unshift({ role: message.role, text: message.text });
  }
  if (
    !selected.some((message) => message.role === "user") ||
    selected.at(-1)?.text !== last.text
  )
    return null;
  return {
    projectId: thread.projectId,
    turnId: turnId,
    revision: JSON.stringify([
      timeline.tag,
      timeline.contextBoundarySeq,
      turnId,
      questions.readRevision,
      thread.status,
      thread.queuedMessageCount,
    ]),
    text: JSON.stringify({
      source: "current thread; older messages may be omitted",
      messages: selected,
    }),
  };
}
