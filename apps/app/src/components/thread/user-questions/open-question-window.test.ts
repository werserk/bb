import { expect, it, vi } from "vitest";
import type {
  ConversationQuestion,
  ConversationQuestionsOpenPage,
} from "@bb/domain";
import { BbHttpError } from "@bb/sdk/browser";
import { readOpenQuestionWindow } from "./open-question-window";

const question = (id: string) => ({ id }) as ConversationQuestion;
const page = (
  id: string,
  nextCursor: string | null,
  readRevision = "r1",
): ConversationQuestionsOpenPage => ({
  questions: [question(id)],
  nextCursor,
  readRevision,
  total: 201,
});
const stale = () =>
  new BbHttpError({
    status: 409,
    code: "stale-question-cursor",
    message: "changed",
    body: null,
  });

it("loads sequential pages beyond 200 without using historical cards", async () => {
  const rows = Array.from({ length: 201 }, (_, index) => question(`q${index}`));
  const open = vi
    .fn()
    .mockResolvedValueOnce({
      questions: rows.slice(0, 100),
      nextCursor: "p2",
      total: 201,
      readRevision: "r1",
    })
    .mockResolvedValueOnce({
      questions: rows.slice(100, 200),
      nextCursor: "p3",
      total: 201,
      readRevision: "r1",
    })
    .mockResolvedValueOnce({
      questions: rows.slice(200),
      nextCursor: null,
      total: 201,
      readRevision: "r1",
    });
  const result = await readOpenQuestionWindow({
    open,
    threadId: "thr_test",
    pages: 3,
    signal: new AbortController().signal,
  });
  expect(result.questions).toEqual(rows);
  expect(result.total).toBe(201);
  expect(result.nextCursor).toBeNull();
  expect(open.mock.calls.map(([args]) => args.cursor)).toEqual([
    undefined,
    "p2",
    "p3",
  ]);
});

it("discards mixed pages and restarts once after an answer invalidates the cursor", async () => {
  const open = vi
    .fn()
    .mockResolvedValueOnce(page("removed", "p2"))
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce(page("current", "p2-new", "r2"))
    .mockResolvedValueOnce(page("old", null, "r2"));
  const result = await readOpenQuestionWindow({
    open,
    threadId: "thr_test",
    pages: 2,
    signal: new AbortController().signal,
  });
  expect(result.questions.map((q) => q.id)).toEqual(["current", "old"]);
  expect(result.incomplete).toBe(false);
  expect(open).toHaveBeenCalledTimes(4);
});

it("stops after a second cursor change with only the restarted snapshot and Retry coverage", async () => {
  const open = vi
    .fn()
    .mockResolvedValueOnce(page("discard", "p2"))
    .mockRejectedValueOnce(stale())
    .mockResolvedValueOnce(page("current", "p2-new", "r2"))
    .mockRejectedValueOnce(stale());
  const result = await readOpenQuestionWindow({
    open,
    threadId: "thr_test",
    pages: 2,
    signal: new AbortController().signal,
  });
  expect(result.questions.map((q) => q.id)).toEqual(["current"]);
  expect(result.incomplete).toBe(true);
  expect(open).toHaveBeenCalledTimes(4);
});

it("rejects inconsistent revisions even if a server fails to return 409", async () => {
  const open = vi
    .fn()
    .mockResolvedValueOnce(page("a", "p2"))
    .mockResolvedValueOnce(page("b", null, "r2"))
    .mockResolvedValueOnce(page("c", null, "r3"));
  const result = await readOpenQuestionWindow({
    open,
    threadId: "thr_test",
    pages: 2,
    signal: new AbortController().signal,
  });
  expect(result.questions.map((q) => q.id)).toEqual(["c"]);
});

it("propagates read errors and cancellation instead of returning an empty view", async () => {
  const signal = new AbortController().signal;
  const open = vi.fn().mockRejectedValue(new Error("offline"));
  await expect(
    readOpenQuestionWindow({ open, threadId: "thr_test", pages: 1, signal }),
  ).rejects.toThrow("offline");
  const controller = new AbortController();
  controller.abort();
  await expect(
    readOpenQuestionWindow({
      open,
      threadId: "thr_test",
      pages: 2,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(open).toHaveBeenCalledTimes(1);
});
