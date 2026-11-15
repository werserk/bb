// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  QuestionNavigationProvider,
  useQuestionNavigation,
} from "./question-navigation";
import {
  SearchMessageLocationProvider,
  useScrollToSearchedMessage,
} from "../timeline/useScrollToSearchedMessage";
import { questionCardId } from "./question-response-presentation";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { QuestionFallback } from "./QuestionFallback";
const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { events: { list: api.list }, questions: { get: api.get } } },
}));
vi.mock("./ConversationQuestionCard", async () => {
  const { questionCardId } = await import("./question-response-presentation");
  return {
    ConversationQuestionCard: ({
      threadId,
      questionId,
    }: {
      threadId: string;
      questionId: string;
    }) => (
      <section tabIndex={-1} id={questionCardId(threadId, questionId)}>
        Native fallback card
      </section>
    ),
  };
});
function render(ui: React.ReactElement) {
  return renderView(ui, { wrapper: createQueryClientTestHarness().wrapper });
}
const qid = "qst_23456789ab";
const row = { id: "old-row", sourceSeqStart: 1, sourceSeqEnd: 1 };
function History({ name, older = false }: { name: string; older?: boolean }) {
  const navigation = useQuestionNavigation()!;
  const [loaded, setLoaded] = useState(!older);
  useScrollToSearchedMessage(
    loaded ? [row] : [{ id: "new-row", sourceSeqStart: 90, sourceSeqEnd: 100 }],
    "thr_test",
    {
      hasOlderRows: !loaded,
      onLoadOlderRows: () => setLoaded(true),
      reportsMissingTarget: true,
    },
  );
  return (
    <>
      <button onClick={() => void navigation.navigate(qid, "question")}>
        {name}
      </button>
      {loaded && (
        <div data-timeline-row-id="old-row">
          <section id={questionCardId("thr_test", qid)} tabIndex={-1}>
            {name} question
          </section>
        </div>
      )}
    </>
  );
}
function Pane({ name, older }: { name: string; older?: boolean }) {
  return (
    <QuestionNavigationProvider threadId="thr_test">
      <SearchMessageLocationProvider threadId="thr_test">
        <History name={name} older={older} />
        <QuestionFallback threadId="thr_test" />
      </SearchMessageLocationProvider>
    </QuestionNavigationProvider>
  );
}
beforeEach(() => {
  api.get.mockReset().mockResolvedValue({ id: qid, threadId: "thr_test" });
  api.list.mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("opens an unloaded question by ID and focuses only the requesting pane", async () => {
  const scroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = scroll;
  render(
    <MemoryRouter>
      <Pane name="Other pane" />
      <Pane name="This pane" older />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "This pane" }));
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("Native fallback card"),
  );
  expect(
    scroll.mock.instances.every(
      (element) =>
        element instanceof HTMLElement &&
        element.textContent !== "Other pane question",
    ),
  ).toBe(true);
});

function QueuedAnswer() {
  const navigation = useQuestionNavigation()!;
  const { registerQueuedAnswer } = navigation;
  const [expanded, setExpanded] = useState(false);
  useEffect(
    () =>
      registerQueuedAnswer(qid, async () => {
        setExpanded(true);
        await new Promise(requestAnimationFrame);
        return document.querySelector<HTMLElement>(
          "[data-fixture-queued-answer]",
        );
      }),
    [registerQueuedAnswer],
  );
  return (
    <>
      <button onClick={() => void navigation.navigate(qid, "answer")}>
        View queued answer
      </button>
      {expanded ? (
        <section tabIndex={-1} data-fixture-queued-answer="">
          Queued owner answer
        </section>
      ) : null}
    </>
  );
}
it("reveals the saved answer in a collapsed queue before looking for dispatched history", async () => {
  api.list.mockClear();
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(
    <MemoryRouter>
      <QuestionNavigationProvider threadId="thr_test">
        <QueuedAnswer />
      </QuestionNavigationProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "View queued answer" }));
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("Queued owner answer"),
  );
  expect(api.list).not.toHaveBeenCalled();
});

function FallbackIdentity() {
  const navigation = useQuestionNavigation()!;
  return (
    <>
      <button onClick={() => void navigation.navigate(qid, "question")}>
        Open missing marker
      </button>
      <output>{navigation.fallbackQuestionId}</output>
    </>
  );
}
it("makes a persistent question reachable when its timeline marker no longer exists", async () => {
  api.list.mockResolvedValue([]);
  render(
    <MemoryRouter>
      <QuestionNavigationProvider threadId="thr_test">
        <FallbackIdentity />
      </QuestionNavigationProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open missing marker" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe(qid));
});

it("refuses navigation when the fresh record read fails, leaving an actionable error", async () => {
  api.get.mockRejectedValue(new Error("offline"));
  function Failure() {
    const navigation = useQuestionNavigation()!;
    return (
      <>
        <button onClick={() => void navigation.navigate(qid, "question")}>
          Open
        </button>
        <output>{navigation.error}</output>
      </>
    );
  }
  render(
    <MemoryRouter>
      <QuestionNavigationProvider threadId="thr_test">
        <Failure />
      </QuestionNavigationProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("offline"),
  );
  expect(screen.queryByText("Native fallback card")).toBeNull();
});

it("reuses a loaded native card and never scans history for a question", async () => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(
    <MemoryRouter>
      <Pane name="Loaded pane" />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Loaded pane" }));
  await waitFor(() =>
    expect(document.activeElement?.textContent).toBe("Loaded pane question"),
  );
  expect(api.get).toHaveBeenCalledTimes(1);
  expect(api.list).not.toHaveBeenCalled();
  expect(screen.queryByText("Native fallback card")).toBeNull();
});

it("removes the fallback if its original native marker becomes loaded", async () => {
  function Original() {
    const [loaded, setLoaded] = useState(false);
    const navigation = useQuestionNavigation()!;
    return (
      <>
        <button onClick={() => void navigation.navigate(qid, "question")}>
          Open
        </button>
        <button onClick={() => setLoaded(true)}>Load history</button>
        {loaded && (
          <section id={questionCardId("thr_test", qid)} tabIndex={-1}>
            Original card
          </section>
        )}
        <QuestionFallback threadId="thr_test" />
      </>
    );
  }
  HTMLElement.prototype.scrollIntoView = vi.fn();
  render(
    <MemoryRouter>
      <QuestionNavigationProvider threadId="thr_test">
        <Original />
      </QuestionNavigationProvider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await screen.findByText("Native fallback card");
  fireEvent.click(screen.getByRole("button", { name: "Load history" }));
  await waitFor(() =>
    expect(screen.queryByText("Native fallback card")).toBeNull(),
  );
  expect(document.activeElement?.textContent).toBe("Original card");
});

it("updates the shared native card from the fresh record before focusing a loaded marker", async () => {
  const harness = createQueryClientTestHarness();
  const key = ["conversationQuestions", "thr_test", qid];
  harness.queryClient.setQueryData(key, { id: qid, status: "open" });
  const answered = {
    id: qid,
    threadId: "thr_test",
    status: "answered",
    revision: 2,
  };
  api.get.mockResolvedValue(answered);
  HTMLElement.prototype.scrollIntoView = vi.fn();
  renderView(
    <MemoryRouter>
      <Pane name="Loaded pane" />
    </MemoryRouter>,
    { wrapper: harness.wrapper },
  );
  fireEvent.click(screen.getByRole("button", { name: "Loaded pane" }));
  await waitFor(() =>
    expect(harness.queryClient.getQueryData(key)).toEqual(answered),
  );
  expect(document.activeElement?.textContent).toBe("Loaded pane question");
});
