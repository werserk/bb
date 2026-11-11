// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  parseQuestionResponse,
  questionResponseForHistory,
  QuestionAnswers,
  queuedQuestionResponse,
} from "./question-response-presentation";
import { MemoryRouter } from "react-router-dom";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { ConversationMessageContent } from "../timeline/ConversationMessageContent";
import { QuestionResponseEvent } from "./QuestionResponseEvent";
const api = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/lib/sdk", () => ({ sdk: { threads: { questions: api } } }));
const publication = {
  body: "Context",
  materials: [],
  questions: [
    {
      id: "choice",
      prompt: "Choose\ncarefully",
      required: true,
      multiSelect: true,
      allowFreeText: true,
      options: [
        { value: "one", label: "First label" },
        { value: "two", label: "Second label" },
      ],
    },
    {
      id: "optional",
      prompt: "Optional question",
      required: false,
      multiSelect: false,
      allowFreeText: true,
      options: [],
    },
  ],
};
const manifest = {
  hostId: null,
  storageRootPath: null,
  materials: [],
  files: [],
};
const answers = {
  choice: {
    selected: ["two", "one"],
    freeText: "<b>plain</b>\n" + ("long ".repeat(800) + "end"),
  },
};
const envelope = `Conversation question response: qst_23456789ab (revision 1)\nOriginal question:\n${JSON.stringify(publication)}\nFrozen materials:\n${JSON.stringify(manifest)}\nOwner answers:\n${JSON.stringify(answers)}`;
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("validates the entire current envelope and normalizes answers without losing optional questions or long free text", () => {
  const parsed = parseQuestionResponse(envelope)!;
  expect(parsed.answers.choice?.selected).toEqual(["one", "two"]);
  const view = render(
    <QuestionAnswers
      publication={parsed.publication}
      answers={parsed.answers}
    />,
  );
  expect(screen.getByText("First label")).toBeTruthy();
  expect(screen.getByText("Second label")).toBeTruthy();
  expect(screen.getByText("Not answered")).toBeTruthy();
  expect(view.container.textContent).toContain(answers.choice.freeText);
  expect(view.container.querySelector("b")).toBeNull();
});
it.each([
  "prefix" + envelope,
  envelope + "\nextra",
  envelope.replace('"one"]', '"unknown"]'),
  envelope.replace('"body":"Context"', '"unexpected":true,"body":"Context"'),
  envelope.replace('"files":[]', '"files":[{}]'),
  envelope.replace('"files":[]', '"files":[],"future":true'),
  envelope.replace('"choice":', '"unknown":'),
])("does not classify invalid or spoofed envelope", (text) => {
  expect(parseQuestionResponse(text)).toBeNull();
});
it("recognizes only plain owner history, leaving ordinary text and attachments visible", () => {
  const row = {
    text: envelope,
    initiator: "user",
    senderThreadId: null,
    mentions: [],
    attachments: null,
  };
  expect(questionResponseForHistory(row)).toBeTruthy();
  expect(
    questionResponseForHistory({
      ...row,
      attachments: {
        webImages: 0,
        localImages: 0,
        localFiles: 0,
        imageUrls: [],
        localImagePaths: [],
        localFilePaths: [],
        localFileDetails: [],
      },
    }),
  ).toBeTruthy();
  expect(questionResponseForHistory({ ...row, text: "hello" })).toBeNull();
  expect(questionResponseForHistory({ ...row, initiator: "agent" })).toBeNull();
  expect(
    questionResponseForHistory({ ...row, senderThreadId: "thr_other" }),
  ).toBeNull();
  expect(questionResponseForHistory({ ...row, mentions: [{}] })).toBeNull();
  expect(
    questionResponseForHistory({
      ...row,
      attachments: { imageUrls: ["image"] },
    }),
  ).toBeNull();
});
it("projects only matching typed queue responses and hides malformed transport", () => {
  const payload = {
    kind: "questionResponse",
    questionId: "qst_23456789ab",
    revision: 1,
  };
  const content = [{ type: "text", text: envelope, mentions: [] }];
  expect(queuedQuestionResponse(payload, content)?.questionId).toBe(
    payload.questionId,
  );
  expect(
    queuedQuestionResponse({ ...payload, revision: 2 }, content),
  ).toBeNull();
  expect(queuedQuestionResponse({ kind: "message" }, content)).toBeNull();
  expect(
    queuedQuestionResponse(payload, [{ ...content[0], text: "bad" }]),
  ).toBeNull();
});
it("retains readable snapshot when source is missing, with timestamp and inline original disclosure", async () => {
  api.get.mockRejectedValue(new Error("Not found"));
  const harness = createQueryClientTestHarness();
  render(
    <QuestionResponseEvent
      response={parseQuestionResponse(envelope)!}
      threadId="thr_test"
      timestamp={1000}
    />,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("You answered")).toBeTruthy();
  expect(screen.getByText("First label")).toBeTruthy();
  await screen.findByText("Source unavailable · delivery unverified");
  expect(document.querySelector("time")?.getAttribute("dateTime")).toBe(
    new Date(1000).toISOString(),
  );
  fireEvent.click(screen.getByText("Original question"));
  expect(screen.getByText("Context")).toBeTruthy();
  fireEvent.click(screen.getByText("Original question"));
  expect(screen.queryByText("Context")).toBeNull();
  expect(screen.queryByText("Submitted to agent")).toBeNull();
});
it.each([false, true])(
  "shows delivery only when current source matches snapshot (%s)",
  async (mismatch) => {
    api.get.mockResolvedValue({
      id: "qst_23456789ab",
      threadId: "thr_test",
      revision: mismatch ? 2 : 1,
      status: "answered",
      publication,
      materialManifest: manifest,
      response: answers,
      delivery: { kind: "submitted", reason: null },
    });
    const harness = createQueryClientTestHarness();
    render(
      <QuestionResponseEvent
        response={parseQuestionResponse(envelope)!}
        threadId="thr_test"
        timestamp={1000}
      />,
      { wrapper: harness.wrapper },
    );
    await screen.findByText(
      mismatch
        ? "Source unavailable · delivery unverified"
        : "Submitted to agent",
    );
    expect(screen.queryByText("Agent read")).toBeNull();
  },
);

it("renders the history envelope as an owner answer without user edit and preserves composer focus", async () => {
  api.get.mockRejectedValue(new Error("Missing"));
  const harness = createQueryClientTestHarness();
  render(
    <>
      <input aria-label="Composer" autoFocus />
      <ConversationMessageContent
        role="user"
        initiator="user"
        senderThreadId={null}
        senderThreadTitle={null}
        senderIsPluginSideChat={false}
        mentions={[]}
        attachments={null}
        systemMessageKind="unlabeled"
        systemMessageSubject={null}
        text={envelope}
        timestamp={1000}
        threadId="thr_test"
        turnRequest={{ kind: "message", status: "accepted", isGrouped: false }}
        onEdit={vi.fn()}
      />
    </>,
    { wrapper: harness.wrapper },
  );
  expect(
    screen.getByRole("region", { name: "Question response" }),
  ).toBeTruthy();
  expect(screen.queryByText("Owner answers:")).toBeNull();
  expect(screen.queryByRole("button", { name: /Edit/ })).toBeNull();
  await screen.findByText("Source unavailable · delivery unverified");
  expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
});
it.each(["ordinary", "attachment", "spoof"])(
  "preserves normal visible owner message: %s",
  (kind) => {
    const harness = createQueryClientTestHarness();
    const text =
      kind === "ordinary"
        ? "A normal owner message"
        : kind === "spoof"
          ? "prefix" + envelope
          : envelope;
    const view = render(
      <MemoryRouter>
        <RouteNavigationProvider>
          <ConversationMessageContent
            role="user"
            initiator="user"
            senderThreadId={null}
            senderThreadTitle={null}
            senderIsPluginSideChat={false}
            mentions={[]}
            attachments={
              kind === "attachment"
                ? {
                    webImages: 0,
                    localImages: 0,
                    localFiles: 1,
                    imageUrls: [],
                    localImagePaths: [],
                    localFilePaths: ["note.txt"],
                    localFileDetails: [],
                  }
                : null
            }
            systemMessageKind="unlabeled"
            systemMessageSubject={null}
            text={text}
            timestamp={1000}
            threadId="thr_test"
            projectId="proj_test"
            turnRequest={{
              kind: "message",
              status: "accepted",
              isGrouped: false,
            }}
          />
        </RouteNavigationProvider>
      </MemoryRouter>,
      { wrapper: harness.wrapper },
    );
    expect(
      screen.queryByRole("region", { name: "Question response" }),
    ).toBeNull();
    expect(view.container.textContent).toContain(
      kind === "ordinary" ? text : "Conversation question response:",
    );
    if (kind === "attachment")
      expect(screen.getByRole("link", { name: "note.txt" })).toBeTruthy();
  },
);

it("scrolls to a mounted original card without fetching history or moving focus", () => {
  api.get.mockRejectedValue(new Error("Missing"));
  const harness = createQueryClientTestHarness();
  const view = render(
    <div data-thread-window="">
      <input aria-label="Composer" autoFocus />
      <section id="conversation-question-thr_test-qst_23456789ab">
        Mounted original
      </section>
      <QuestionResponseEvent
        response={parseQuestionResponse(envelope)!}
        threadId="thr_test"
        timestamp={1000}
      />
    </div>,
    { wrapper: harness.wrapper },
  );
  const original = view.container.querySelector(
    "#conversation-question-thr_test-qst_23456789ab",
  )!;
  const scroll = vi.fn();
  Object.defineProperty(original, "scrollIntoView", { value: scroll });
  fireEvent.click(screen.getByText("Original question"));
  expect(scroll).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
  expect(
    screen.queryByRole("region", { name: "Original question snapshot" }),
  ).toBeNull();
  expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
});

it("does not scroll to an original card in another chat surface", async () => {
  api.get.mockRejectedValue(new Error("Missing"));
  const harness = createQueryClientTestHarness();
  const view = render(
    <>
      <section id="conversation-question-thr_test-qst_23456789ab">
        Other chat
      </section>
      <div data-thread-window="">
        <QuestionResponseEvent
          response={parseQuestionResponse(envelope)!}
          threadId="thr_test"
          timestamp={1000}
        />
      </div>
    </>,
    { wrapper: harness.wrapper },
  );
  const scroll = vi.fn();
  Object.defineProperty(
    view.container.querySelector("section")!,
    "scrollIntoView",
    { value: scroll },
  );
  await screen.findByText("Source unavailable · delivery unverified");
  fireEvent.click(screen.getByText("Original question"));
  expect(scroll).not.toHaveBeenCalled();
  expect(
    screen.getByRole("region", { name: "Original question snapshot" }),
  ).toBeTruthy();
});
it("closes an inline current original card after expanding it", async () => {
  api.get.mockResolvedValue({
    id: "qst_23456789ab",
    threadId: "thr_test",
    revision: 1,
    status: "answered",
    publication,
    materialManifest: manifest,
    response: answers,
    delivery: { kind: "submitted", reason: null },
  });
  const harness = createQueryClientTestHarness();
  render(
    <div data-thread-window="">
      <QuestionResponseEvent
        response={parseQuestionResponse(envelope)!}
        threadId="thr_test"
        timestamp={1000}
      />
    </div>,
    { wrapper: harness.wrapper },
  );
  await screen.findByText("Submitted to agent");
  fireEvent.click(screen.getByText("Original question"));
  expect(screen.getByRole("region", { name: "Question" })).toBeTruthy();
  fireEvent.click(screen.getByText("Original question"));
  expect(screen.queryByRole("region", { name: "Question" })).toBeNull();
});

it("identifies the owner answer and anchors a concise original quote without moving composer focus", async () => {
  api.get.mockRejectedValue(new Error("Missing"));
  const harness = createQueryClientTestHarness();
  const view = render(
    <>
      <input aria-label="Composer" autoFocus />
      <QuestionResponseEvent
        response={parseQuestionResponse(envelope)!}
        threadId="thr_test"
        timestamp={1000}
      />
    </>,
    { wrapper: harness.wrapper },
  );
  expect(screen.getByText("You answered")).toBeTruthy();
  expect(view.container.querySelector("blockquote")?.textContent).toBe(
    "Choose carefully",
  );
  expect(screen.getByRole("region", { name: "Question response" }).id).toBe(
    "conversation-question-response-thr_test-qst_23456789ab",
  );
  expect(document.activeElement).toBe(screen.getByLabelText("Composer"));
  await screen.findByText("Source unavailable · delivery unverified");
});
