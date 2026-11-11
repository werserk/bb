// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ConversationQuestionCard } from "./ConversationQuestionCard";
const api = vi.hoisted(() => ({
  get: vi.fn(),
  answer: vi.fn(),
  dismiss: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { questions: api, queuedMessages: { send: api.send } } },
}));
vi.mock("../../ui/markdown-preview", () => ({
  MarkdownPreview: ({ content }: { content: string }) => <div>{content}</div>,
}));
vi.mock("@bb/shared-ui/question-form", () => ({
  QuestionForm: (props: {
    mode: string;
    onSubmit: (answer: object) => void;
    onCancel: () => Promise<void>;
  }) => (
    <div data-testid="form" data-mode={props.mode}>
      <button onClick={() => props.onSubmit({ voice: { selected: ["a"] } })}>
        Answer
      </button>
      <button onClick={() => void props.onCancel().catch(() => {})}>
        Cancel
      </button>
    </div>
  ),
}));
const question = {
  id: "qst_23456789ab",
  threadId: "thr_test",
  revision: 1,
  status: "open",
  dispatchedAt: null,
  delivery: { kind: "none", reason: null },
  queuedMessageId: "qmsg_test",
  publication: {
    body: "Listen before choosing",
    questions: [
      {
        id: "voice",
        prompt: "Which voice?",
        multiSelect: false,
        allowFreeText: true,
        options: [{ value: "a", label: "A" }],
      },
    ],
  },
  materialManifest: {
    materials: [
      {
        snapshotPath: "question-materials/qst_23456789ab/sample.mp3",
        label: "Sample",
        mimeType: "audio/mpeg",
        snapshotRevision: "rev-a",
      },
      {
        snapshotPath: "question-materials/qst_23456789ab/index.html",
        label: "Preview",
        mimeType: "text/html",
        snapshotRevision: "rev-b",
      },
    ],
  },
};
beforeEach(() =>
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  ),
);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it("renders materials before an independent form and saves the exact revision", async () => {
  api.get.mockResolvedValue(question);
  api.answer.mockResolvedValue({
    ...question,
    status: "answered",
    response: { voice: { selected: ["a"] } },
  });
  const harness = createQueryClientTestHarness();
  const view = render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await screen.findByTestId("form");
  expect(screen.getByTestId("form").getAttribute("data-mode")).toBe("plan");
  const audio = (await screen.findByLabelText("Sample")) as HTMLAudioElement;
  expect(audio.controls).toBe(true);
  expect(audio.src).toContain(
    "/api/v1/threads/thr_test/questions/qst_23456789ab/files/question-materials/",
  );
  expect(view.container.querySelector("iframe")?.getAttribute("sandbox")).toBe(
    "allow-scripts",
  );
  expect(
    audio.compareDocumentPosition(screen.getByTestId("form")) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  fireEvent.click(screen.getByText("Answer"));
  await waitFor(() =>
    expect(api.answer).toHaveBeenCalledWith({
      threadId: "thr_test",
      questionId: question.id,
      revision: 1,
      answers: { voice: { selected: ["a"] } },
    }),
  );
  await screen.findByRole("button", { name: "Which voice?" });
});
it("dismisses only its own question and shows errors without hiding materials", async () => {
  api.get.mockResolvedValue(question);
  api.dismiss.mockRejectedValue(new Error("Offline"));
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  fireEvent.click(await screen.findByText("Cancel"));
  await screen.findByText("Offline");
  expect(api.dismiss).toHaveBeenCalledWith({
    threadId: "thr_test",
    questionId: question.id,
    revision: 1,
  });
  expect(screen.getByLabelText("Sample")).toBeTruthy();
  fireEvent.error(screen.getByLabelText("Sample"));
  await screen.findByText("Unable to load Sample: Media unavailable");
});
it("shows an unavailable record explicitly", async () => {
  api.get.mockRejectedValue(new Error("Question not found"));
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await screen.findByText("Question not found");
});

it.each([404, 409])(
  "shows HTTP %s errors before embedding HTML",
  async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status }));
    api.get.mockResolvedValue(question);
    const harness = createQueryClientTestHarness();
    const view = render(
      <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
      { wrapper: harness.wrapper },
    );
    await screen.findByText(`Unable to load Preview: HTTP ${status}`);
    expect(view.container.querySelector("iframe")).toBeNull();
  },
);
it("renders a bounded Markdown snapshot in the normal renderer", async () => {
  vi.mocked(fetch).mockImplementation(async (_url, init) =>
    init?.method === "HEAD"
      ? new Response(null, { status: 200 })
      : new Response("# Snapshot body"),
  );
  api.get.mockResolvedValue({
    ...question,
    materialManifest: {
      materials: [
        {
          snapshotPath: "snapshot/note.md",
          snapshotRevision: "rev-md",
          label: "Notes",
          mimeType: "text/markdown",
        },
      ],
    },
  });
  const harness = createQueryClientTestHarness();
  const view = render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await screen.findByText("# Snapshot body");
  expect(view.container.querySelector("iframe")).toBeNull();
});
it.each(["queued", "held", "submitted", "removed"])(
  "shows actual %s delivery and guarded retry",
  async (kind) => {
    api.get.mockResolvedValue({
      ...question,
      status: "answered",
      delivery: { kind, reason: kind === "held" ? "Thread archived" : null },
    });
    api.send.mockResolvedValue({ delivery: "queued" });
    const harness = createQueryClientTestHarness();
    render(
      <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
      { wrapper: harness.wrapper },
    );
    const labels: Record<string, string> = {
      queued: "Queued · waiting to send",
      held: "Held · not sent",
      submitted: "Sent to agent",
      removed: "Queue entry removed; delivery unverified",
    };
    if (kind === "submitted") {
      await screen.findByRole("heading", { name: "Which voice?" });
      expect(screen.queryByText(labels[kind]!)).toBeNull();
    } else await screen.findByText(labels[kind]!);
    if (kind === "held") {
      await screen.findByText("Thread archived");
      fireEvent.click(screen.getByText("Send now"));
      await waitFor(() =>
        expect(api.send).toHaveBeenCalledWith({
          threadId: "thr_test",
          queuedMessageId: "qmsg_test",
          mode: "auto",
        }),
      );
    }
  },
);

it("bounds Markdown reads and leaves download available", async () => {
  vi.mocked(fetch).mockImplementation(async (_url, init) =>
    init?.method === "HEAD"
      ? new Response(null, { status: 200 })
      : new Response("a".repeat(1024 * 1024 + 1)),
  );
  api.get.mockResolvedValue({
    ...question,
    materialManifest: {
      materials: [
        {
          snapshotPath: "snapshot/large.md",
          snapshotRevision: "rev-large",
          label: "Large notes",
          mimeType: "text/markdown",
        },
      ],
    },
  });
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await screen.findByText(
    "Unable to load Large notes: Preview exceeds its byte limit; download the snapshot to read it",
  );
  expect(screen.getByText("Download Large notes")).toBeTruthy();
});

it("retains access to the accepted response and held reason after withdrawal without offering a futile retry", async () => {
  api.get.mockResolvedValue({
    ...question,
    status: "withdrawn",
    response: { voice: { selected: ["a"] } },
    delivery: { kind: "held", reason: "Question withdrawn" },
  });
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await screen.findByText("Held · not sent");
  expect(screen.getByText("View answer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Which voice?" }));
  expect(screen.getByText("A")).toBeTruthy();
  expect(await screen.findByLabelText("Sample")).toBeTruthy();
  expect(screen.queryByText("Send now")).toBeNull();
});

it("settles compactly without duplicating answers and keeps original options and materials available", async () => {
  api.get.mockResolvedValue({
    ...question,
    status: "answered",
    updatedAt: 2000,
    response: { voice: { selected: ["a"], freeText: "Owner detail" } },
    delivery: { kind: "held", reason: "Thread archived" },
  });
  const harness = createQueryClientTestHarness();
  render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await screen.findByRole("heading", { name: "Which voice?" });
  expect(
    await screen.findByRole("heading", { name: "Which voice?" }),
  ).toBeTruthy();
  expect(screen.getByText("answered")).toBeTruthy();
  expect(screen.getByText("View answer")).toBeTruthy();
  expect(screen.queryByTestId("form")).toBeNull();
  expect(screen.queryByText("Owner detail")).toBeNull();
  expect(screen.queryByLabelText("Sample")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Which voice?" }));
  expect(screen.getByText("Listen before choosing")).toBeTruthy();
  expect(screen.getByText("A")).toBeTruthy();
  expect(await screen.findByLabelText("Sample")).toBeTruthy();
  expect(screen.queryByText("Owner detail")).toBeNull();
  expect(screen.getByText("Send now")).toBeTruthy();
});

it("themes frozen HTML and fits only messages from its own frame", async () => {
  api.get.mockResolvedValue(question);
  vi.mocked(fetch).mockImplementation(
    async (_url, init) =>
      new Response(
        init?.method === "HEAD"
          ? null
          : '<html><head></head><body><h1>Material</h1><img src="sample.png"></body></html>',
        { status: 200 },
      ),
  );
  document.documentElement.classList.add("dark");
  const harness = createQueryClientTestHarness();
  const view = render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await waitFor(() =>
    expect(
      view.container.querySelector("iframe")?.getAttribute("srcdoc"),
    ).toContain("color-scheme:dark"),
  );
  const frame = view.container.querySelector("iframe")!;
  expect(frame.getAttribute("srcdoc")).toContain(
    '<base href="http://localhost',
  );
  const initial = frame.style.height;
  fireEvent(
    window,
    new MessageEvent("message", {
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 900 },
      },
      source: window,
    }),
  );
  expect(frame.style.height).toBe(initial);
  fireEvent(
    window,
    new MessageEvent("message", {
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 900 },
      },
      source: frame.contentWindow,
    }),
  );
  expect(frame.style.height).toBe("900px");
  for (const height of [Number.NaN, -10]) {
    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          jsonrpc: "2.0",
          method: "ui/notifications/size-changed",
          params: { height },
        },
        source: frame.contentWindow,
      }),
    );
    expect(frame.style.height).toBe("900px");
  }
  fireEvent(
    window,
    new MessageEvent("message", {
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/size-changed",
        params: { height: 10000 },
      },
      source: frame.contentWindow,
    }),
  );
  expect(frame.style.height).toBe("2000px");
  document.documentElement.classList.remove("dark");
});

it("preserves HTML material previews larger than the markdown limit", async () => {
  const content = "<body>" + "x".repeat(1024 * 1024 + 1) + "</body>";
  const material = question.materialManifest.materials.find(
    (m) => m.mimeType === "text/html",
  )!;
  api.get.mockResolvedValue({
    ...question,
    materialManifest: {
      materials: [
        { ...material, sizeBytes: new TextEncoder().encode(content).length },
      ],
    },
  });
  vi.mocked(fetch).mockImplementation(
    async (_url, init) =>
      new Response(init?.method === "HEAD" ? null : content, { status: 200 }),
  );
  const harness = createQueryClientTestHarness();
  const view = render(
    <ConversationQuestionCard threadId="thr_test" questionId={question.id} />,
    { wrapper: harness.wrapper },
  );
  await waitFor(() =>
    expect(
      view.container.querySelector("iframe")?.getAttribute("srcdoc"),
    ).toContain(content),
  );
});
