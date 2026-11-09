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
  resolve: vi.fn(),
}));
vi.mock("@/hooks/queries/thread-plans", () => ({
  useThreadPlans: () => ({ status: "ready", plans: { focus: facts.view } }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { status: "idle" } }),
  useThreadPendingInteractions: () => ({ data: facts.interactions }),
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
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    width: 480,
    height: 900,
    top: 0,
    left: 0,
    bottom: 900,
    right: 480,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
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
