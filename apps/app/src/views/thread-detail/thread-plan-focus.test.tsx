import { NativeQuestionFocusProvider } from "./native-question-focus";
import { ThreadPendingQuestions } from "./ThreadPendingQuestions";
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, it, expect, vi } from "vitest";
import type { PendingInteraction, ThreadPlanView } from "@bb/domain";
import { experimental_focusThreadPlan } from "@get-bb/plugin-sdk/app";
import { ThreadPlanSteps } from "./ThreadPlanSteps";
import {
  focusThreadPlan,
  registerThreadPlanFocusTarget,
} from "./thread-plan-focus";
const facts = vi.hoisted(() => ({
  view: null as ThreadPlanView | null,
  interactions: [] as PendingInteraction[],
  stop: vi.fn(),
  navigate: vi.fn().mockResolvedValue(true),
  resolve: vi.fn(),
  pendingReady: true,
  pendingFetching: false,
  resize: () => {},
  width: 480,
}));
vi.mock("@/components/thread/user-questions/question-navigation", () => ({
  useQuestionNavigation: () => ({ navigate: facts.navigate }),
}));
vi.mock("@/hooks/queries/thread-plans", () => ({
  useThreadPlans: () => ({ status: "ready", plans: { focus: facts.view } }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { status: "idle" } }),
  useThreadPendingInteractions: () => ({
    data: facts.pendingReady ? facts.interactions : undefined,
    isFetching: facts.pendingFetching,
  }),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: null }),
}));
vi.mock("@/hooks/mutations/thread-interaction-mutations", () => ({
  useResolveThreadPendingInteraction: () => ({
    mutateAsync: facts.resolve,
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({ mutateAsync: facts.stop, isPending: false }),
}));
vi.mock("@/components/thread/user-questions/ThreadQuestionFormHost", () => ({
  ThreadQuestionFormHost: ({ children }: { children: React.ReactNode }) =>
    children,
}));
const host = globalThis as typeof globalThis & { __bbPluginRuntime?: unknown };
const originalRuntime = host.__bbPluginRuntime;
beforeEach(() => {
  facts.pendingReady = true;
  facts.pendingFetching = false;
  facts.width = 480;
  host.__bbPluginRuntime = {
    pluginSdkApp: { experimental_focusThreadPlan: focusThreadPlan },
  };
  facts.view = {
    threadId: "focus",
    revision: 1,
    current: {
      sourceSeq: 1,
      planId: "stable",
      updatedAt: 1,
      items: [
        {
          id: "step",
          text: "Choose",
          status: "needs_input",
          interactionIds: ["input"],
        },
      ],
    },
    previousPlans: [],
    historyTruncated: false,
    ownAttention: "needs_input",
    attentionInteractionIds: ["input"],
    unboundInteractionIds: [],
  };
  facts.interactions = [
    {
      id: "input",
      threadId: "focus",
      turnId: "turn",
      providerId: "codex",
      providerThreadId: "provider-thread",
      providerRequestId: "provider-request",
      status: "pending",
      statusReason: null,
      createdAt: 1,
      resolvedAt: null,
      resolution: null,
      payload: {
        kind: "user_question",
        questions: [
          {
            id: "q",
            prompt: "Your answer",
            shortLabel: "Answer",
            multiSelect: false,
            allowFreeText: true,
            required: true,
            options: [],
          },
        ],
      },
    },
  ];
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      width: facts.width,
      height: 900,
      top: 0,
      left: 0,
      bottom: 900,
      right: 480,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        facts.resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
});
it.each(["overlay", "panel"] as const)(
  "%s consumes serial requests once, supports repeat and wrap without losing the native draft",
  (placement) => {
    const element = (focusSerial: number) => (
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={focusSerial}
        focusInteractionId="input"
      />
    );
    const view = render(element(2));
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "Serial draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    view.rerender(element(3));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Serial draft",
    );
    expect(screen.getByRole("textbox")).not.toBe(field);
    const retained = screen.getByRole("textbox");
    view.rerender(element(1));
    expect(screen.getByRole("textbox")).toBe(retained);
    expect(document.activeElement).toBe(retained);
    facts.width = 900;
    act(() => facts.resize());
    facts.width = 480;
    act(() => facts.resize());
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Plan · Needs you" }));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    facts.view = structuredClone(facts.view);
    facts.view!.revision++;
    view.rerender(element(1));
    act(() => facts.resize());
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Plan · Needs you" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  },
);
it.each(["overlay", "panel"] as const)(
  "%s waits for view and native input data, and refuses stale, foreign or hidden prop targets",
  (placement) => {
    const saved = facts.view;
    facts.view = null;
    facts.pendingReady = false;
    const element = (id: string, serial: number, hidden = false) => (
      <div hidden={hidden}>
        <ThreadPlanSteps
          threadId="focus"
          placement={placement}
          focusSerial={serial}
          focusInteractionId={id}
        />
      </div>
    );
    const view = render(element("input", 1));
    facts.view = saved;
    view.rerender(element("input", 1));
    expect(screen.queryByRole("textbox")).toBeNull();
    facts.pendingReady = true;
    view.rerender(element("input", 1));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    facts.interactions[0]!.threadId = "foreign";
    view.rerender(element("input", 2));
    expect(screen.queryByRole("textbox")).toBeNull();
    facts.interactions[0]!.threadId = "focus";
    facts.interactions[0]!.status = "resolved";
    view.rerender(element("input", 3));
    expect(screen.queryByRole("textbox")).toBeNull();
    facts.interactions[0]!.status = "pending";
    view.rerender(element("input", 4, true));
    view.rerender(element("input", 4));
    expect(screen.queryByRole("textbox")).toBeNull();
  },
);
it.each(["overlay", "panel"] as const)(
  "%s rejects nonpositive serials and focuses a quiet disclosure without waiting for question payloads",
  (placement) => {
    facts.view!.current!.items[0]!.status = "completed";
    facts.view!.current!.items[0]!.interactionIds = [];
    facts.pendingReady = false;
    const view = render(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={0}
      />,
    );
    const toggle = screen.getByRole("button", { name: /Plan finished/ });
    expect(document.activeElement).not.toBe(toggle);
    view.rerender(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={1}
      />,
    );
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    toggle.blur();
    view.rerender(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={0}
      />,
    );
    expect(document.activeElement).not.toBe(toggle);
    view.rerender(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={1}
      />,
    );
    expect(document.activeElement).toBe(toggle);
  },
);
it("waits for an in-flight native payload refresh before refusing a prop request", () => {
  const interactions = facts.interactions;
  facts.interactions = [];
  facts.pendingFetching = true;
  const view = render(
    <ThreadPlanSteps
      threadId="focus"
      placement="panel"
      focusSerial={1}
      focusInteractionId="input"
    />,
  );
  facts.interactions = interactions;
  facts.pendingFetching = false;
  view.rerender(
    <ThreadPlanSteps
      threadId="focus"
      placement="panel"
      focusSerial={1}
      focusInteractionId="input"
    />,
  );
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});
it("a hidden component serial cannot redirect focus to a different visible overlay", () => {
  const view = render(
    <>
      <ThreadPlanSteps threadId="focus" placement="overlay" />
      <div hidden>
        <ThreadPlanSteps
          threadId="focus"
          placement="overlay"
          focusInteractionId="input"
          focusSerial={1}
        />
      </div>
    </>,
  );
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(
    view.container.querySelectorAll('[aria-expanded="true"]'),
  ).toHaveLength(0);
});
it.each(["replacement", "empty clear"])(
  "a consumed request cannot reopen a plan after %s",
  (change) => {
    if (change === "empty clear") delete facts.view!.current!.planId;
    facts.view!.current!.items[0]!.status = "failed";
    facts.view!.current!.items[0]!.interactionIds = [];
    const view = render(
      <ThreadPlanSteps threadId="focus" placement="panel" focusSerial={1} />,
    );
    fireEvent.keyDown(screen.getByLabelText("Failed: Choose"), {
      key: "Escape",
    });
    if (change === "empty clear") {
      const current = facts.view!.current;
      facts.view = { ...facts.view!, current: null };
      view.rerender(
        <ThreadPlanSteps threadId="focus" placement="panel" focusSerial={1} />,
      );
      facts.view = { ...facts.view!, current };
    }
    facts.view = structuredClone(facts.view);
    if (change === "replacement") facts.view!.current!.planId = "replacement";
    facts.view!.current!.sourceSeq++;
    facts.view!.revision++;
    view.rerender(
      <ThreadPlanSteps threadId="focus" placement="panel" focusSerial={1} />,
    );
    expect(screen.queryByLabelText("Failed: Choose")).toBeNull();
  },
);
it.each(["overlay", "panel"] as const)(
  "%s serial without an ID reveals failure once and legacy ID-only requests still work",
  (placement) => {
    facts.view!.current!.items[0]!.status = "failed";
    facts.view!.current!.items[0]!.interactionIds = [];
    const view = render(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={1}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("Failed: Choose"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    facts.view = structuredClone(facts.view);
    view.rerender(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={1}
      />,
    );
    expect(screen.queryByLabelText("Failed: Choose")).toBeNull();
    view.rerender(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusSerial={2}
      />,
    );
    expect(document.activeElement).toBe(
      screen.getByLabelText("Failed: Choose"),
    );
    facts.view!.current!.items[0]!.status = "needs_input";
    facts.view!.current!.items[0]!.interactionIds = ["input"];
    view.rerender(
      <ThreadPlanSteps
        threadId="focus"
        placement={placement}
        focusInteractionId="input"
      />,
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  },
);
afterEach(() => {
  host.__bbPluginRuntime = originalRuntime;
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([
  ["core", focusThreadPlan],
  ["SDK", experimental_focusThreadPlan!],
] as const)(
  "%s reveals the exact native editor repeatedly without remounting or losing its draft and reopens local Skip",
  (_surface, focus) => {
    render(<ThreadPlanSteps threadId="focus" placement="overlay" />);
    expect(screen.queryByRole("textbox")).toBeNull();
    act(() =>
      expect(focus({ threadId: "focus", interactionId: "input" })).toBe(true),
    );
    const field = screen.getByRole("textbox");
    expect(document.activeElement).toBe(field);
    fireEvent.change(field, { target: { value: "Preserved draft" } });
    screen.getByRole("button", { name: "Skip" }).focus();
    act(() =>
      expect(focus({ threadId: "focus", interactionId: "input" })).toBe(true),
    );
    expect(screen.getByRole("textbox")).toBe(field);
    expect(document.activeElement).toBe(field);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    act(() =>
      expect(focus({ threadId: "focus", interactionId: "input" })).toBe(true),
    );
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "Preserved draft",
    );
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    expect(facts.stop).not.toHaveBeenCalled();
    expect(facts.resolve).not.toHaveBeenCalled();
  },
);
it.each([
  ["core", focusThreadPlan],
  ["SDK", experimental_focusThreadPlan!],
] as const)(
  "%s declines foreign, stale, hidden, panel-only and absent targets without opening anything",
  (_surface, focus) => {
    expect(focus({ threadId: "focus" })).toBe(false);
    const view = render(
      <div>
        <ThreadPlanSteps threadId="focus" placement="overlay" />
      </div>,
    );
    expect(focus({ threadId: "other", interactionId: "input" })).toBe(false);
    expect(focus({ threadId: "focus", interactionId: "old" })).toBe(false);
    facts.interactions = [];
    view.rerender(
      <div>
        <ThreadPlanSteps threadId="focus" placement="overlay" />
      </div>,
    );
    expect(focus({ threadId: "focus", interactionId: "input" })).toBe(false);
    view.rerender(
      <div hidden>
        <ThreadPlanSteps threadId="focus" placement="overlay" />
      </div>,
    );
    expect(focus({ threadId: "focus" })).toBe(false);
    view.rerender(<ThreadPlanSteps threadId="focus" placement="panel" />);
    expect(focus({ threadId: "focus" })).toBe(false);
  },
);
it.each([
  ["core", focusThreadPlan],
  ["SDK", experimental_focusThreadPlan!],
] as const)(
  "%s focuses the current failed step, or disclosure when no step failed",
  (_surface, focus) => {
    facts.view!.current!.items[0]!.status = "failed";
    facts.view!.current!.items[0]!.interactionIds = [];
    render(<ThreadPlanSteps threadId="focus" placement="overlay" />);
    act(() => expect(focus({ threadId: "focus" })).toBe(true));
    expect(document.activeElement).toBe(
      screen.getByLabelText("Failed: Choose"),
    );
    facts.view!.current!.items[0]!.status = "completed";
    cleanup();
    render(<ThreadPlanSteps threadId="focus" placement="overlay" />);
    act(() => expect(focus({ threadId: "focus" })).toBe(true));
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: /Plan finished/ }),
    );
  },
);
it("prefers a focused eligible pane and unregisters its controller", () => {
  const accept = vi.fn(() => true),
    other = vi.fn(() => true);
  const dispose = registerThreadPlanFocusTarget({
    threadId: "preference",
    isFocused: () => true,
    request: accept,
  });
  const disposeOther = registerThreadPlanFocusTarget({
    threadId: "preference",
    isFocused: () => false,
    request: other,
  });
  expect(focusThreadPlan({ threadId: "preference" })).toBe(true);
  expect(accept).toHaveBeenCalledOnce();
  expect(other).not.toHaveBeenCalled();
  dispose();
  expect(focusThreadPlan({ threadId: "preference" })).toBe(true);
  expect(other).toHaveBeenCalledOnce();
  disposeOther();
  expect(focusThreadPlan({ threadId: "preference" })).toBe(false);
});

it("native compact SDK focus restores a skipped form and reclaims a panel-owned draft", () => {
  const element = (serial: number) => (
    <NativeQuestionFocusProvider>
      <div data-thread-chat>
        <ThreadPendingQuestions threadId="focus" />
        <ThreadPlanSteps threadId="focus" placement="overlay" compact />
      </div>
      <ThreadPlanSteps
        threadId="focus"
        placement="panel"
        focusSerial={serial}
        focusInteractionId="input"
      />
    </NativeQuestionFocusProvider>
  );
  const view = render(element(0));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Retain this draft" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Skip" }));
  act(() => {
    expect(focusThreadPlan({ threadId: "focus", interactionId: "input" })).toBe(
      true,
    );
  });
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Retain this draft",
  );
  view.rerender(element(9));
  expect(
    screen.getByRole("textbox").closest("[data-thread-questions]"),
  ).toBeNull();
  act(() => {
    expect(focusThreadPlan({ threadId: "focus", interactionId: "input" })).toBe(
      true,
    );
  });
  expect(
    screen.getByRole("textbox").closest("[data-thread-questions]"),
  ).not.toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});

it("focuses a persistent-only question without requiring a plan or treating its ID as a native interaction", () => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      width: 480,
      height: 0,
      top: 0,
      left: 0,
      right: 480,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  );
  facts.view!.current = null;
  facts.view!.questionAttention = { total: 2, firstQuestionId: "qst_oldest" };
  facts.view!.attentionInteractionIds = [];
  facts.view!.unboundInteractionIds = [];
  facts.interactions = [];
  render(<ThreadPlanSteps threadId="focus" placement="overlay" />);
  expect(
    experimental_focusThreadPlan!({
      threadId: "focus",
      questionId: "qst_oldest",
    }),
  ).toBe(true);
  expect(facts.navigate).toHaveBeenCalledWith("qst_oldest", "question");
});

it("gives an existing native pending interaction precedence over a persistent focus target", () => {
  facts.navigate.mockClear();
  render(<ThreadPlanSteps threadId="focus" placement="overlay" />);
  act(() => {
    expect(
      experimental_focusThreadPlan!({
        threadId: "focus",
        questionId: "qst_oldest",
      }),
    ).toBe(true);
  });
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
  expect(facts.navigate).not.toHaveBeenCalled();
});

it("refuses a persistent target in a hidden chat even when its plan is empty", () => {
  facts.navigate.mockClear();
  facts.view!.current = null;
  facts.view!.attentionInteractionIds = [];
  facts.view!.unboundInteractionIds = [];
  facts.interactions = [];
  render(
    <div hidden>
      <ThreadPlanSteps threadId="focus" placement="overlay" />
    </div>,
  );
  expect(
    experimental_focusThreadPlan!({
      threadId: "focus",
      questionId: "qst_oldest",
    }),
  ).toBe(false);
  expect(facts.navigate).not.toHaveBeenCalled();
});
