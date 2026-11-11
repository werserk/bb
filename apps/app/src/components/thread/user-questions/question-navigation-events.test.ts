import { expect, it, vi } from "vitest";
import { conversationQuestionMarker, type ThreadEventRow } from "@bb/domain";
import { resolveQuestionEventSequence } from "./question-navigation-events";
const questionId = "qst_23456789ab";
const marker = (seq: number, threadId = "thr_test", id = questionId) =>
  ({
    seq,
    threadId,
    type: "item/completed",
    data: {
      item: {
        type: "agentMessage",
        id: `question:${id}`,
        text: conversationQuestionMarker(id),
      },
    },
  }) as ThreadEventRow;
it("pages filtered events until the exact question in its own thread is found", async () => {
  const list = vi
    .fn()
    .mockResolvedValueOnce([
      marker(90, "thr_other"),
      marker(80, "thr_test", "qst_abcdefghij"),
    ])
    .mockResolvedValueOnce([marker(20)]);
  await expect(
    resolveQuestionEventSequence({
      list,
      threadId: "thr_test",
      questionId,
      kind: "question",
      signal: new AbortController().signal,
    }),
  ).resolves.toBe(20);
  expect(list.mock.calls[1]![0]).toMatchObject({
    beforeSeq: "80",
    order: "desc",
    types: ["item/completed"],
    limit: "100",
  });
});
it("does not follow an unchanging cursor or return a raw response prefix", async () => {
  const list = vi
    .fn()
    .mockResolvedValue([
      {
        seq: 9,
        threadId: "thr_test",
        type: "client/turn/requested",
        data: {
          initiator: "user",
          senderThreadId: null,
          input: [
            {
              type: "text",
              text: `Conversation question response: ${questionId}`,
            },
          ],
        },
      },
    ]);
  await expect(
    resolveQuestionEventSequence({
      list,
      threadId: "thr_test",
      questionId,
      kind: "answer",
      signal: new AbortController().signal,
    }),
  ).resolves.toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});
it("aborts before reading the next page", async () => {
  const abort = new AbortController();
  const list = vi.fn().mockImplementation(async () => {
    abort.abort();
    return [marker(90, "thr_other")];
  });
  await expect(
    resolveQuestionEventSequence({
      list,
      threadId: "thr_test",
      questionId,
      kind: "question",
      signal: abort.signal,
    }),
  ).rejects.toThrow();
  expect(list).toHaveBeenCalledTimes(1);
});
