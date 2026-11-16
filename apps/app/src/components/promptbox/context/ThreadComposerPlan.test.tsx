// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { PendingInteraction, ThreadPlanView } from "@bb/domain";
import {
  ComposerContextProvider,
  ComposerContextSources,
} from "./composer-context";
import { ComposerContextDock } from "./ComposerContextDock";
import { ThreadComposerPlan } from "./ThreadComposerPlan";
import { focusThreadPlan } from "@/views/thread-detail/thread-plan-focus";
const threadListeners = new Set<() => void>();
const subscribeThread = (listener: () => void) => {
  threadListeners.add(listener);
  return () => threadListeners.delete(listener);
};
const facts = vi.hoisted(() => ({
  view: undefined as ThreadPlanView | undefined,
  pending: [] as PendingInteraction[],
  thread: {
    archivedAt: null as number | null,
    runtime: { displayStatus: "idle" },
    serviceTurn: false,
  },
  reveal: vi.fn(),
  refresh: vi.fn(),
  status: "ready",
}));
vi.mock("@/hooks/queries/thread-plans", () => ({
  useThreadPlans: () => ({
    plans: { t: facts.view },
    status: facts.status,
    refresh: facts.refresh,
  }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({
    data: useSyncExternalStore(subscribeThread, () => facts.thread),
  }),
  useThreadPendingInteractions: () => ({ data: facts.pending }),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: null }),
}));
vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => null,
}));
vi.mock("@/views/thread-detail/native-question-focus", () => ({
  useNativeQuestionFocus: () => ({ reveal: facts.reveal }),
}));
beforeEach(() => {
  facts.thread = {
    archivedAt: null,
    runtime: { displayStatus: "idle" },
    serviceTurn: false,
  };
  facts.status = "ready";
  facts.pending = [];
  facts.reveal.mockReset();
  facts.view = {
    threadId: "t",
    revision: 1,
    current: {
      sourceSeq: 1,
      updatedAt: 100,
      items: [
        {
          id: "step",
          text: "Repair layout",
          status: "failed",
          interactionIds: [],
        },
      ],
    },
    previousPlans: [],
    historyTruncated: false,
    ownAttention: "none",
    attentionInteractionIds: [],
    unboundInteractionIds: [],
  };
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 700,
    height: 32,
    top: 400,
    left: 0,
    bottom: 432,
    right: 700,
    x: 0,
    y: 400,
    toJSON: () => ({}),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function Fixture() {
  return (
    <ComposerContextProvider>
      <ComposerContextSources>
        <ThreadComposerPlan threadId="t" />
      </ComposerContextSources>
      <ComposerContextDock>
        <textarea aria-label="Draft" defaultValue="Preserve" />
      </ComposerContextDock>
    </ComposerContextProvider>
  );
}
it("opens and focuses the native failed plan through the existing SDK focus target while collapsed", async () => {
  render(<Fixture />);
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  act(() => {
    expect(focusThreadPlan({ threadId: "t" })).toBe(true);
  });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByLabelText("failed: Repair layout"),
    ),
  );
  expect(
    screen.getByRole("textbox", { name: "Draft" }).getAttribute("value"),
  ).toBeNull();
  expect(
    (screen.getByRole("textbox", { name: "Draft" }) as HTMLTextAreaElement)
      .value,
  ).toBe("Preserve");
});
it("hands pending questions to the native form and hides settled answer controls", () => {
  facts.pending = [
    {
      id: "q",
      threadId: "t",
      status: "pending",
      payload: { kind: "user_question", questions: [] },
    } as unknown as PendingInteraction,
  ];
  facts.view!.current!.items[0]!.interactionIds = ["q", "settled"];
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Plan failed: 0/1" }));
  expect(screen.getAllByRole("button", { name: "Answer" })).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Answer" }));
  expect(facts.reveal).toHaveBeenCalledWith(
    expect.objectContaining({ interactionId: "q" }),
  );
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
});
it("does not present a running spinner while the agent is idle and removes archived plan facts", () => {
  facts.view!.current!.items[0]!.status = "in_progress";
  render(<Fixture />);
  fireEvent.click(screen.getByRole("button", { name: "Plan: 0/1" }));
  expect(
    screen
      .getByLabelText("in_progress: Repair layout")
      .querySelector(".motion-safe\\:animate-spin"),
  ).toBeNull();
  act(() => {
    facts.thread = { ...facts.thread, archivedAt: 100 };
    for (const listener of threadListeners) listener();
  });
  expect(screen.queryByRole("button", { name: "Plan: 0/1" })).toBeNull();
});
