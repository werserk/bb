// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { PendingInteraction, ThreadPlanView } from "@bb/domain";
import {
  AppCommandProvider,
  useAppCommandContext,
  useAppCommandHandler,
} from "@/components/commands/AppCommandProvider";
import { ThreadPendingInteractionBanners } from "@/components/thread/pending-interactions/ThreadPendingInteractionBanner";
import { ThreadPlanSteps } from "./ThreadPlanSteps";
import { ThreadPlanQuestion } from "@/components/promptbox/banner/ThreadTodoCard";
import { createThreadPlanFocusRequest } from "./thread-plan-focus";

const facts = vi.hoisted(() => ({
  stop: vi.fn(),
  stopping: false,
  stoppingListeners: new Set<() => void>(),
  setStopping(value: boolean) {
    facts.stopping = value;
    for (const listener of facts.stoppingListeners) listener();
  },
  resolve: vi.fn(),
  composerFocus: vi.fn(),
}));
vi.mock("@/hooks/queries/system-queries", async () => {
  const { useSystemConfig } =
    await import("@/test/question-shortcuts-system-queries-mock");
  return {
    useSystemConfig: () => {
      const config = useSystemConfig();
      return {
        data: {
          ...config.data,
          keybindings: [
            ...config.data.keybindings,
            {
              command: "composer.focus",
              desktopOnly: false,
              shortcut: {
                key: "Escape",
                mod: false,
                meta: false,
                control: false,
                alt: false,
                shift: false,
              },
              when: { all: ["mainSurface", "promptAvailable"], none: [] },
            },
          ],
        },
      };
    },
  };
});
vi.mock("@/lib/bb-desktop", () => ({ getBbDesktopInfo: () => null }));
vi.mock("@/hooks/queries/thread-plans", () => ({
  useThreadPlans: () => ({ status: "ready", plans: { native: plan } }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { status: "idle" } }),
  useThreadPendingInteractions: () => ({ data: [question] }),
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
vi.mock("@/hooks/mutations/thread-runtime-mutations", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    facts.stoppingListeners.add(listener);
    return () => facts.stoppingListeners.delete(listener);
  };
  return {
    useStopThread: () => ({
      mutateAsync: facts.stop,
      isPending: useSyncExternalStore(subscribe, () => facts.stopping),
    }),
  };
});
const question: PendingInteraction = {
  id: "native-input",
  threadId: "native",
  turnId: "turn",
  providerId: "codex",
  providerThreadId: "provider",
  providerRequestId: "request",
  status: "pending",
  statusReason: null,
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
  payload: {
    kind: "user_question",
    questions: [
      {
        id: "answer",
        prompt: "Native answer",
        shortLabel: "Answer",
        multiSelect: false,
        allowFreeText: true,
        required: true,
        options: [],
      },
    ],
  },
};
const plan: ThreadPlanView = {
  threadId: "native",
  revision: 1,
  current: {
    sourceSeq: 1,
    updatedAt: 1,
    items: [
      {
        id: "step",
        text: "Native question",
        status: "needs_input",
        interactionIds: [question.id],
      },
    ],
  },
  previousPlans: [],
  historyTruncated: false,
  ownAttention: "needs_input",
  attentionInteractionIds: [question.id],
  unboundInteractionIds: [],
};
function ComposerCommand() {
  useAppCommandContext("promptAvailable", true);
  useAppCommandHandler("composer.focus", () => {
    facts.composerFocus();
    document
      .querySelector<HTMLTextAreaElement>('[aria-label="Composer"]')
      ?.focus();
    return true;
  });
  return <textarea aria-label="Composer" />;
}
afterEach(() => {
  cleanup();
  facts.stopping = false;
  facts.composerFocus.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each(["anchored", "unbound", "overflow"] as const)(
  "Escape retains disclosure focus through native editor handoff (%s)",
  async (scenario) => {
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
    const unbound = scenario !== "anchored";
    plan.unboundInteractionIds = unbound ? [question.id] : [];
    plan.current =
      scenario === "unbound"
        ? null
        : {
            sourceSeq: 1,
            updatedAt: 1,
            items: [
              {
                id: "step",
                text: "Native question",
                status: unbound ? "in_progress" : "needs_input",
                interactionIds: unbound ? [] : [question.id],
              },
            ],
          };
    const view = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <AppCommandProvider>
            <div data-thread-chat>
              <ThreadPlanSteps threadId="native" placement="overlay" />
            </div>
            <ThreadPendingInteractionBanners
              threadId="native"
              interactions={[question]}
            />
            <ComposerCommand />
          </AppCommandProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const root =
      view.container.querySelector<HTMLElement>("[data-thread-plan]")!;
    const toggle = within(root).getByRole("button", {
      name: unbound ? "Needs you" : "Plan · Needs you",
    });
    fireEvent.click(toggle);
    const editor = within(root).getByRole("textbox");
    if (scenario === "overflow")
      expect(within(root).getByRole("button", { name: "Plan" })).toBeDefined();
    const draft = `Handoff draft ${scenario}`;
    fireEvent.change(editor, { target: { value: draft } });
    editor.focus();
    fireEvent.keyDown(editor, { key: "Escape" });
    await act(async () => {});
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(document.activeElement).toBe(toggle);
    expect(facts.composerFocus).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    expect(
      (within(root).getByRole("textbox") as HTMLTextAreaElement).value,
    ).toBe(draft);
    expect(facts.stop).not.toHaveBeenCalled();
    expect(facts.resolve).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Composer" }), {
      key: "Escape",
    });
    expect(facts.composerFocus).toHaveBeenCalledOnce();
  },
);

function custodyHost(children: React.ReactNode) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AppCommandProvider>
          {children}
          <ThreadPendingInteractionBanners
            threadId="native"
            interactions={[question]}
          />
          <ComposerCommand />
        </AppCommandProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
it.each(
  (
    [
      { hidden: true },
      { "aria-hidden": true },
      { style: { contentVisibility: "hidden" } },
      { style: { visibility: "hidden" } },
      { style: { display: "none" } },
      { inert: true },
    ] as const
  ).flatMap((hidden) =>
    ["plan", "native"].map((surface) => ({ hidden, surface })),
  ),
)(
  "initially hidden $surface leaves a real native Answer available ($hidden)",
  ({ hidden, surface }) => {
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
    const view = render(
      custodyHost(
        <div data-testid="hidden-editor" {...hidden}>
          {surface === "plan" ? (
            <ThreadPlanQuestion
              interaction={question}
              threadId="native"
              placement="panel"
              focused
              focusRequest={createThreadPlanFocusRequest(question.id)}
            />
          ) : (
            <ThreadPendingInteractionBanners
              threadId="native"
              interactions={[question]}
            />
          )}
        </div>,
      ),
    );
    expect(
      view.container.querySelector('[data-testid="hidden-editor"] textarea'),
    ).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "Answer answer" }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeDefined();
  },
);
it("releases hidden requested custody, preserves real drafts through panels/native, and never replays focus on reveal", async () => {
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
  const request = createThreadPlanFocusRequest(question.id);
  const panels = (a: boolean, b: boolean) => (
    <>
      {a && (
        <div data-testid="panel-a">
          <ThreadPlanQuestion
            interaction={question}
            threadId="native"
            placement="panel"
            focused
            focusRequest={request}
          />
        </div>
      )}
      {b && (
        <div data-testid="panel-b">
          <ThreadPlanQuestion
            interaction={question}
            threadId="native"
            placement="panel"
            focused
          />
        </div>
      )}
    </>
  );
  const view = render(custodyHost(panels(true, true)));
  const a = screen.getByTestId("panel-a"),
    b = screen.getByTestId("panel-b");
  const fieldA = within(a).getByRole("textbox");
  fireEvent.change(fieldA, { target: { value: "Panel A draft" } });
  await act(async () => {
    a.setAttribute("aria-hidden", "true");
    a.style.contentVisibility = "hidden";
    a.style.visibility = "hidden";
  });
  expect(a.querySelector("textarea")).toBeNull();
  const fieldB = within(b).getByRole("textbox");
  expect((fieldB as HTMLTextAreaElement).value).toBe("Panel A draft");
  fireEvent.change(fieldB, { target: { value: "Panel B draft" } });
  await act(async () => {
    b.hidden = true;
  });
  expect(b.querySelector("textarea")).toBeNull();
  const native = screen.getByRole("textbox", { name: "Answer answer" });
  expect((native as HTMLTextAreaElement).value).toBe("Panel B draft");
  fireEvent.change(native, { target: { value: "Native handoff draft" } });
  const composer = screen.getByRole("textbox", { name: "Composer" });
  composer.focus();
  await act(async () => {
    b.hidden = false;
  });
  const retained = within(b).getByRole("textbox");
  expect((retained as HTMLTextAreaElement).value).toBe("Native handoff draft");
  expect(document.activeElement).toBe(composer);
  await act(async () => {
    a.removeAttribute("aria-hidden");
    a.style.contentVisibility = "";
    a.style.visibility = "";
  });
  expect(within(b).getByRole("textbox")).toBe(retained);
  expect(a.querySelector("textarea")).toBeNull();
  expect(document.activeElement).toBe(composer);
  view.rerender(custodyHost(panels(true, false)));
  expect((within(a).getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    "Native handoff draft",
  );
  expect(document.activeElement).toBe(composer);
  view.rerender(custodyHost(panels(false, false)));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Answer answer",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Native handoff draft");
  expect(facts.stop).not.toHaveBeenCalled();
  expect(facts.resolve).not.toHaveBeenCalled();
});

it("cancels an in-flow question through the real stop action instead of hiding it", async () => {
  facts.stop.mockResolvedValue(undefined);
  render(
    custodyHost(
      <ThreadPlanQuestion
        interaction={question}
        threadId="native"
        placement="overlay"
        focused
        inFlow
      />,
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await act(async () => {});
  expect(facts.stop).toHaveBeenCalledWith("native");
  expect(facts.resolve).not.toHaveBeenCalled();
});

it("keeps cancellation retryable after a failed stop", async () => {
  facts.stop
    .mockRejectedValueOnce(new Error("stop failed"))
    .mockResolvedValue(undefined);
  render(
    custodyHost(
      <ThreadPlanQuestion
        interaction={question}
        threadId="native"
        placement="overlay"
        focused
        inFlow
      />,
    ),
  );
  const cancel = screen.getByRole("button", { name: "Cancel" });
  await act(async () => fireEvent.click(cancel));
  expect(cancel.hasAttribute("disabled")).toBe(false);
  await act(async () => fireEvent.click(cancel));
  expect(facts.stop).toHaveBeenLastCalledWith("native");
});

it("locks both answer and cancel while the stop mutation is pending", () => {
  const body = () => (
    <ThreadPlanQuestion
      interaction={question}
      threadId="native"
      placement="overlay"
      focused
      inFlow
    />
  );
  const view = render(custodyHost(body()));
  fireEvent.change(screen.getByRole("textbox", { name: "Answer answer" }), {
    target: { value: "An answer" },
  });
  expect(
    screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled"),
  ).toBe(false);
  act(() => facts.setStopping(true));
  view.rerender(custodyHost(body()));
  expect(
    screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled"),
  ).toBe(true);
  expect(
    screen.getByRole("button", { name: "Cancel" }).hasAttribute("disabled"),
  ).toBe(true);
  act(() => facts.setStopping(false));
  view.rerender(custodyHost(body()));
  expect(
    screen.getByRole("button", { name: "Answer" }).hasAttribute("disabled"),
  ).toBe(false);
});
