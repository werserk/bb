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
import { ThreadPlanSteps } from "./ThreadPlanSteps";
const facts = vi.hoisted(() => ({
  view: null as ThreadPlanView | null,
  width: 768,
  resize: () => {},
  listeners: new Set<() => void>(),
}));
vi.mock("@/hooks/queries/thread-plans", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useThreadPlans: () => {
      const view = useSyncExternalStore(
        (listener) => {
          facts.listeners.add(listener);
          return () => {
            facts.listeners.delete(listener);
          };
        },
        () => facts.view,
      );
      return { status: "ready", plans: { t: view } };
    },
  };
});
vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: { status: "idle" } }),
  useThreadPendingInteractions: () => ({ data: [] }),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: null }),
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
function publish() {
  act(() => {
    for (const listener of facts.listeners) listener();
  });
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
  facts.view = structuredClone(facts.view);
  facts.view!.current!.items[0]!.status = "completed";
  publish();
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
  facts.view = structuredClone(facts.view);
  facts.view!.previousPlans = [
    { ...facts.view!.current!, sourceSeq: 0, planId: "old" },
  ];
  publish();
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
  facts.view = structuredClone(facts.view);
  facts.view!.current = null;
  facts.view!.previousPlans = [];
  publish();
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
  facts.view = structuredClone(facts.view);
  facts.view!.current!.items[0]!.status = "failed";
  publish();
  rerender(
    <div data-thread-window>
      <ThreadPlanCard threadId="t" />
    </div>,
  );
  expect(screen.getByLabelText("Failed: Check")).toBeDefined();
  expect(screen.getByText("Failed · Reviewing output")).toBeDefined();
});
it.each(["page", "panel", "embedded", "overlay"])(
  "%s bounds forms by the owning pane, never the plan's own height",
  (surface) => {
    let paneHeight = 800;
    const observed: Element[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          facts.resize = callback;
        }
        observe(element: Element) {
          observed.push(element);
        }
        disconnect() {}
      },
    );
    vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(
      function (this: Element) {
        const height = this.hasAttribute("data-owner") ? paneHeight : 34;
        return {
          width: 480,
          height,
          top: 0,
          left: 0,
          right: 480,
          bottom: height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      },
    );
    const { container } = render(
      <div
        data-owner
        data-thread-chat={
          surface === "page" || surface === "overlay" ? "" : undefined
        }
        style={{ overflowY: "auto" }}
      >
        <div>
          <ThreadPlanSteps
            threadId="t"
            placement={
              surface === "page" || surface === "overlay" ? "overlay" : "panel"
            }
          />
        </div>
      </div>,
    );
    const root = container.querySelector<HTMLElement>("[data-thread-plan]")!;
    expect(root.style.getPropertyValue("--thread-plan-max-height")).toBe(
      "480px",
    );
    expect(observed).toContain(container.firstElementChild);
    paneHeight = 600;
    act(() => facts.resize());
    expect(root.style.getPropertyValue("--thread-plan-max-height")).toBe(
      "360px",
    );
  },
);
it("uses a bounded viewport fallback without ResizeObserver", () => {
  vi.stubGlobal("ResizeObserver", undefined);
  vi.stubGlobal("innerHeight", 800);
  const { container } = render(
    <ThreadPlanSteps threadId="t" placement="panel" />,
  );
  const root = container.querySelector<HTMLElement>("[data-thread-plan]")!;
  expect(root.style.getPropertyValue("--thread-plan-max-height")).toBe("480px");
  vi.stubGlobal("innerHeight", 600);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(root.style.getPropertyValue("--thread-plan-max-height")).toBe("360px");
});
it("observes an owning pane mounted while hidden and measures it when revealed", () => {
  let height = 0;
  vi.mocked(Element.prototype.getBoundingClientRect).mockImplementation(
    function (this: Element) {
      const measured = this.hasAttribute("data-thread-chat") ? height : 34;
      return {
        width: 480,
        height: measured,
        top: 0,
        left: 0,
        right: 480,
        bottom: measured,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      };
    },
  );
  const { container } = render(
    <div data-thread-chat>
      <ThreadPlanSteps threadId="t" placement="panel" />
    </div>,
  );
  height = 800;
  act(() => facts.resize());
  expect(
    container
      .querySelector<HTMLElement>("[data-thread-plan]")!
      .style.getPropertyValue("--thread-plan-max-height"),
  ).toBe("480px");
});
