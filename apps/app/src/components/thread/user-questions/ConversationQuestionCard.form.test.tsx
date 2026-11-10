// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ConversationQuestionCard } from "./ConversationQuestionCard";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  answer: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("@/lib/sdk", () => ({ sdk: { threads: { questions: api } } }));
vi.mock("../../ui/markdown-preview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("two open cards leave composer focus and ordinary typing independent", async () => {
  api.get.mockImplementation(({ questionId }: { questionId: string }) =>
    Promise.resolve({
      id: questionId,
      revision: 1,
      status: "open",
      delivery: { kind: "none", reason: null },
      dispatchedAt: null,
      response: null,
      queuedMessageId: null,
      publication: {
        body: "Read context",
        questions: [
          {
            id: "voice",
            prompt: `Voice ${questionId}`,
            multiSelect: false,
            allowFreeText: true,
            required: true,
            options: [],
          },
        ],
      },
      materialManifest: { materials: [] },
    }),
  );
  const harness = createQueryClientTestHarness();
  render(
    <>
      <input aria-label="Composer" autoFocus />
      <ConversationQuestionCard
        threadId="thr_test"
        questionId="qst_23456789ab"
      />
      <ConversationQuestionCard
        threadId="thr_test"
        questionId="qst_23456789ac"
      />
    </>,
    { wrapper: harness.wrapper },
  );
  await screen.findAllByText("Voice qst_23456789ab");
  await screen.findAllByText("Voice qst_23456789ac");
  const composer = screen.getByLabelText("Composer");
  expect(document.activeElement).toBe(composer);
  fireEvent.change(composer, { target: { value: "Continue working" } });
  expect((composer as HTMLInputElement).value).toBe("Continue working");
  expect(api.answer).not.toHaveBeenCalled();
  expect(api.dismiss).not.toHaveBeenCalled();
});
