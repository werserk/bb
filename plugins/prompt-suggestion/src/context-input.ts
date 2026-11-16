import { createHash } from "node:crypto";
import type { SourceMessage, TaskMemory } from "./task-state.js";

export const textRevision = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function contextInput(
  messages: readonly SourceMessage[],
  limit: number,
  memory: TaskMemory | null,
  boundary: number | null,
  hasOlder: boolean,
) {
  const usable = memory?.boundary === boundary ? memory : null;
  const current = new Map(
    messages.map((message) => [message.messageId, message]),
  );
  const anchors = (usable?.sources ?? [])
    .map((message) => current.get(message.messageId) ?? message)
    .filter((message) => message.sequence > (boundary ?? -1));
  let state = usable?.state ?? null;
  let selected = [...anchors];
  let complete = !hasOlder;
  const serialize = (items: SourceMessage[]) =>
    JSON.stringify({
      messages: [...items].sort((a, b) => a.sequence - b.sequence),
      priorState: state,
      contextComplete: complete,
    });
  const last = messages.at(-1);
  if (!last) return null;
  if (serialize([...selected, last]).length > limit) {
    selected = [];
    state = null;
    complete = false;
  }
  for (const message of [...messages].reverse()) {
    if (selected.some((item) => item.messageId === message.messageId)) continue;
    if (serialize([...selected, message]).length > limit) {
      complete = false;
      break;
    }
    selected.push(message);
  }
  const ids = new Set(
    selected.map((message) => `${message.messageId}:${message.revision}`),
  );
  if (
    usable?.sources.some(
      (message) => !ids.has(`${message.messageId}:${message.revision}`),
    )
  ) {
    state = null;
    complete = false;
  }
  if (!selected.some((message) => message.messageId === last.messageId))
    return null;
  selected.sort((a, b) => a.sequence - b.sequence);
  const text = serialize(selected);
  if (text.length > limit) return null;
  return { text, messages: selected, contextComplete: complete };
}

export function sourceMessage(
  messageId: string,
  role: "user" | "assistant",
  text: string,
  sequence: number,
): SourceMessage {
  return { messageId, role, text, sequence, revision: textRevision(text) };
}
