import { parseConversationQuestionMarker } from "@bb/domain";
import type { ThreadEventsListArgs, ThreadEventsListResult } from "@bb/sdk";
import { questionResponseForHistory } from "./question-response-presentation";

export type QuestionNavigationKind = "question" | "answer";

export async function resolveQuestionEventSequence({
  list,
  threadId,
  questionId,
  kind,
  signal,
}: {
  list: (args: ThreadEventsListArgs) => Promise<ThreadEventsListResult>;
  threadId: string;
  questionId: string;
  kind: QuestionNavigationKind;
  signal: AbortSignal;
}): Promise<number | null> {
  let beforeSeq: string | undefined;
  while (true) {
    signal.throwIfAborted();
    const events = await list({
      threadId,
      beforeSeq,
      signal,
      limit: "100",
      order: "desc",
      types: [kind === "question" ? "item/completed" : "client/turn/requested"],
    });
    signal.throwIfAborted();
    for (const event of events) {
      if (event.threadId !== threadId) continue;
      if (
        kind === "question" &&
        event.type === "item/completed" &&
        event.data.item.type === "agentMessage" &&
        parseConversationQuestionMarker(event.data.item.text) === questionId
      )
        return event.seq;
      if (kind === "answer" && event.type === "client/turn/requested") {
        const input = event.data.input;
        const part = input.length === 1 ? input[0] : undefined;
        if (part?.type !== "text") continue;
        const response = questionResponseForHistory({
          text: part.text,
          initiator: event.data.initiator,
          senderThreadId: event.data.senderThreadId,
          mentions: part.mentions ?? [],
          attachments: null,
        });
        if (response?.questionId === questionId) return event.seq;
      }
    }
    if (events.length === 0) return null;
    const next = Math.min(...events.map((event) => event.seq));
    if (
      !Number.isSafeInteger(next) ||
      (beforeSeq !== undefined && next >= Number(beforeSeq))
    )
      return null;
    beforeSeq = String(next);
  }
}
