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

const facts = vi.hoisted(() => ({
  stop: vi.fn(),
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
vi.mock("@/hooks/mutations/thread-runtime-mutations", () => ({
  useStopThread: () => ({ mutateAsync: facts.stop, isPending: false }),
}));
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
  facts.composerFocus.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([false, true])(
  "Escape retains disclosure focus through native editor handoff (unbound=%s)",
  async (unbound) => {
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
    plan.unboundInteractionIds = unbound ? [question.id] : [];
    plan.current = unbound
      ? null
      : {
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
    const draft = `Handoff draft ${unbound ? "unbound" : "anchored"}`;
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
