// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  act,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ThreadPlanView } from "@bb/domain";
import { ThreadPlanCard } from "./ThreadPlanCard";
const facts = vi.hoisted(() => ({
  view: null as ThreadPlanView | null,
  width: 768,
  resize: () => {},
}));
vi.mock("@/hooks/queries/thread-plans", () => ({
  useThreadPlans: () => ({ status: "ready", plans: { t: facts.view } }),
}));
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { status: "idle" } }),
  useThreadPendingInteractions: () => ({ data: [] }),
}));
vi.mock("./PaneContext", () => ({ useOptionalPaneContext: () => null }));
beforeEach(() => {
  facts.width = 768;
  facts.view = {
    threadId: "t",
    revision: 1,
    current: {
      sourceSeq: 1,
      updatedAt: 100,
      planId: "work",
      items: [
        {
          id: "a",
          text: "Check",
          status: "in_progress",
          note: "Reviewing output",
          actor: "Reviewer",
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
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({
      width: facts.width,
      height: 900,
      top: 0,
      left: 0,
      right: facts.width,
      bottom: 900,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(fn: () => void) {
        facts.resize = fn;
      }
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount() {
  return render(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
}
it.each([480, 640, 641, 768])(
  "uses the real %i px container on first mount",
  (width) => {
    facts.width = width;
    const { container } = mount();
    expect(
      screen
        .getByRole("button", { name: "Plan" })
        .getAttribute("aria-expanded"),
    ).toBe(String(width > 640));
    expect(container.querySelector("[data-thread-plan]")?.className).toContain(
      "w-[340px]",
    );
  },
);
it("collapses at 640, stays collapsed on growth, preserves manual disclosure and Escape focus", () => {
  const view = mount();
  facts.width = 640;
  act(() => facts.resize());
  const toggle = screen.getByRole("button", { name: "Plan" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  facts.width = 768;
  act(() => facts.resize());
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  view.rerender(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  const region = screen.getByRole("region", { name: "Plan steps" });
  region.focus();
  fireEvent.keyDown(region, { key: "Escape" });
  expect(document.activeElement).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
});
it("finishes immediately, keeps note/actor on reopen and retains earlier disclosures", () => {
  const view = mount();
  facts.view!.current!.items[0]!.status = "completed";
  view.rerender(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
  const toggle = screen.getByRole("button", { name: /Plan finished/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(screen.getByText("Reviewer")).toBeDefined();
  expect(screen.getByText("Reviewing output")).toBeDefined();
  facts.view!.previousPlans = [
    { ...facts.view!.current!, sourceSeq: 0, planId: "old" },
  ];
  view.rerender(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
  expect(
    screen
      .getByRole("button", { name: /earlier task/ })
      .getAttribute("aria-expanded"),
  ).toBe("false");
  facts.view!.current = null;
  facts.view!.previousPlans = [];
  view.rerender(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
  expect(screen.queryByRole("button")).toBeNull();
});
it("keeps failure factual and progress static while idle", () => {
  const { container, rerender } = mount();
  expect(container.querySelector(".motion-safe\\:animate-spin")).toBeNull();
  facts.view!.current!.items[0]!.status = "failed";
  rerender(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
  expect(screen.getByLabelText("Failed: Check")).toBeDefined();
  expect(screen.getByText("Failed · Reviewing output")).toBeDefined();
});
