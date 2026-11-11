// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ConversationQuestionCard } from "./ConversationQuestionCard";
vi.mock("@/components/promptbox/VoiceInputTextarea", () => ({
  VoiceInputTextarea: ({
    onValueChange,
    onVoiceInputActiveChange,
    ...props
  }: import("@bb/shared-ui/voice-input-textarea").VoiceInputTextareaProps) => (
    <div>
      <textarea {...props} onChange={(e) => onValueChange(e.target.value)} />
      <button type="button">Start voice input</button>
    </div>
  ),
}));
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

it.each([
  { key: "Enter" },
  { key: "Enter", ctrlKey: true },
  { key: "Enter", metaKey: true },
])("persistent answer supports local keyboard submit %j", async (key) => {
  api.get.mockResolvedValue({
    id: "qst_23456789ab",
    revision: 1,
    status: "open",
    delivery: { kind: "none", reason: null },
    response: null,
    queuedMessageId: null,
    publication: {
      questions: [
        {
          id: "answer",
          prompt: "Your answer",
          allowFreeText: true,
          multiSelect: false,
          required: true,
          options: [],
        },
      ],
    },
    materialManifest: { materials: [] },
  });
  api.answer.mockImplementation(async () => ({
    ...(await api.get()),
    status: "answered",
    response: { answer: { selected: [], freeText: "Approved" } },
  }));
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard
      threadId="thr_test"
      questionId="qst_23456789ab"
    />,
    { wrapper: harness.wrapper },
  );
  const field = await screen.findByRole("textbox");
  fireEvent.change(field, { target: { value: "Approved" } });
  fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(api.answer).not.toHaveBeenCalled();
  fireEvent.keyDown(field, key);
  await waitFor(() => expect(api.answer).toHaveBeenCalledTimes(1));
});

it("persistent answers use the app voice input", async () => {
  api.get.mockResolvedValue({
    id: "qst_23456789ab",
    revision: 1,
    status: "open",
    delivery: { kind: "none", reason: null },
    publication: {
      questions: [
        {
          id: "answer",
          prompt: "Your answer",
          allowFreeText: true,
          multiSelect: false,
          required: true,
          options: [],
        },
      ],
    },
    materialManifest: { materials: [] },
  });
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard
      threadId="thr_test"
      questionId="qst_23456789ab"
    />,
    { wrapper: harness.wrapper },
  );
  expect(
    await screen.findByRole("button", { name: "Start voice input" }),
  ).toBeTruthy();
});
