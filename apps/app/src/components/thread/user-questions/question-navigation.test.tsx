// @vitest-environment jsdom
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { conversationQuestionMarker } from "@bb/domain";
import {
  QuestionNavigationProvider,
  useQuestionNavigation,
} from "./question-navigation";
import {
  SearchMessageLocationProvider,
  useScrollToSearchedMessage,
} from "../timeline/useScrollToSearchedMessage";
import { questionCardId } from "./question-response-presentation";
const api = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/lib/sdk", () => ({ sdk: { threads: { events: api } } }));
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
      </SearchMessageLocationProvider>
    </QuestionNavigationProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("loads an older question and focuses it only in the pane that requested navigation", async () => {
  api.list.mockResolvedValue([
    {
      threadId: "thr_test",
      seq: 1,
      type: "item/completed",
      data: {
        item: { type: "agentMessage", text: conversationQuestionMarker(qid) },
      },
    },
  ]);
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
    expect(document.activeElement?.textContent).toBe("This pane question"),
  );
  expect(
    scroll.mock.instances.every(
      (element) =>
        element instanceof HTMLElement &&
        element.textContent !== "Other pane question",
    ),
  ).toBe(true);
});
