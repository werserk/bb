// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import {
  ComposerContextProvider,
  ComposerContextSources,
  ComposerContextItem,
  useComposerContextStore,
} from "./composer-context";
import { ComposerContextDock } from "./ComposerContextDock";
import { ComposerContextStrip } from "./ComposerContextStrip";

afterEach(cleanup);

const REGION = { name: "Thread context" };

function Fixture() {
  const [queue, setQueue] = useState(true);
  return (
    <ComposerContextProvider>
      <ComposerContextSources>
        <ComposerContextItem
          id="queue"
          label="Queue"
          summary="3"
          icon="ListView"
          group="queue"
          kind="queue"
        >
          {queue ? (
            <button onClick={() => setQueue(false)}>
              Remove queued messages
            </button>
          ) : (
            <span />
          )}
        </ComposerContextItem>
        <ComposerContextItem
          id="plan"
          label="Plan"
          summary="2/6"
          progress={{ done: 2, total: 6 }}
          icon="ListTodo"
          group="work"
          kind="plan"
        >
          <p>Current work</p>
        </ComposerContextItem>
        <ComposerContextItem
          id="questions"
          label="Questions unavailable"
          icon="AlertCircle"
          group="attention"
          tone="error"
        >
          <button>Retry questions</button>
        </ComposerContextItem>
      </ComposerContextSources>
      <ComposerContextDock>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
      </ComposerContextDock>
    </ComposerContextProvider>
  );
}

function chipNames() {
  return within(screen.getByRole("toolbar"))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
}

describe("composer context strip", () => {
  it("orders chips error, needs you, working, plan, changes, queue, other and keeps tone", () => {
    render(
      <ComposerContextProvider>
        <ComposerContextSources>
          <ComposerContextItem
            id="other"
            label="Machine"
            icon="Info"
            group="context"
          >
            <p>Machine detail</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="queue"
            label="Queue"
            summary={2}
            icon="ListView"
            group="queue"
            kind="queue"
          >
            <p>Queue detail</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="changes"
            label="Changes"
            icon="FileDiff"
            group="context"
            kind="changes"
          >
            <p>Changes detail</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="plan"
            label="Plan"
            summary="1/4"
            progress={{ done: 1, total: 4 }}
            icon="ListTodo"
            group="work"
            kind="plan"
          >
            <p>Plan detail</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="children"
            label="Working"
            summary={2}
            icon="Loading"
            group="work"
            kind="working"
          >
            <p>Working detail</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="questions"
            label="Needs you"
            summary={1}
            icon="CircleQuestion"
            group="attention"
            tone="attention"
            kind="needs-you"
          >
            <p>Question detail</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="error"
            label="Questions unavailable"
            icon="AlertCircle"
            group="attention"
            tone="error"
          >
            <p>Error detail</p>
          </ComposerContextItem>
        </ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    expect(chipNames().slice(0, 7)).toEqual([
      "Questions unavailable",
      "Needs you: 1",
      "Working: 2",
      "Plan: 1/4",
      "Changes",
      "Queue: 2",
      "Machine",
    ]);
    const tones = within(screen.getByRole("toolbar"))
      .getAllByRole("button")
      .slice(0, 7)
      .map((button) => button.getAttribute("data-context-tone"));
    expect(tones).toEqual(["error", "attention", null, null, null, null, null]);
    const plan = screen.getByRole("button", { name: "Plan: 1/4" });
    expect(plan.querySelector("[data-context-progress]")).not.toBeNull();
  });

  it("merges this thread's questions with child threads waiting for the owner", () => {
    render(
      <ComposerContextProvider>
        <ComposerContextSources>
          <ComposerContextItem
            id="questions"
            label="Needs you"
            summary={2}
            icon="CircleQuestion"
            group="attention"
            tone="attention"
            kind="needs-you"
          >
            <p>Question rows</p>
          </ComposerContextItem>
          <ComposerContextItem
            id="waiting-children"
            label="Needs you"
            summary={3}
            icon="CircleQuestion"
            group="attention"
            tone="attention"
            kind="needs-you"
          >
            <p>Waiting child rows</p>
          </ComposerContextItem>
        </ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    expect(chipNames()).toEqual(["Needs you: 5"]);
    fireEvent.click(screen.getByRole("button", { name: "Needs you: 5" }));
    const region = screen.getByRole("region", REGION);
    const sections = region.querySelectorAll("[data-context-section]");
    expect(sections).toHaveLength(1);
    expect(within(region).getByText("Question rows")).toBeTruthy();
    expect(within(region).getByText("Waiting child rows")).toBeTruthy();
    const heading = within(region).getByRole("heading");
    expect(heading.textContent).toContain("Needs you");
    expect(heading.textContent).toContain("5");
  });

  it("shows the reported tally on the Changes chip", () => {
    render(
      <ComposerContextProvider>
        <ComposerContextSources>
          <ComposerContextItem
            id="changes"
            label="Changes"
            icon="FileDiff"
            group="context"
            kind="changes"
            tally={{ added: 12, removed: 3 }}
          >
            <span />
          </ComposerContextItem>
        </ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    const chip = screen.getByRole("button", { name: /^Changes/ });
    expect(chip.textContent).toContain("+12");
    expect(chip.textContent).toContain("3");
    expect(chip.getAttribute("aria-label")).toBe("Changes: +12 −3");
  });

  it("offers All only with two or more entries", () => {
    const { unmount } = render(<Fixture />);
    expect(
      screen.getByRole("button", { name: "All thread context" }),
    ).toBeTruthy();
    unmount();
    render(
      <ComposerContextProvider>
        <ComposerContextSources>
          <ComposerContextItem
            id="plan"
            label="Plan"
            icon="ListTodo"
            group="work"
            kind="plan"
          >
            <p>Only plan</p>
          </ComposerContextItem>
        </ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    expect(
      screen.queryByRole("button", { name: "All thread context" }),
    ).toBeNull();
  });

  it("stacks every section in one sheet", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Plan: 2/6" }));
    const region = screen.getByRole("region", REGION);
    expect(
      [...region.querySelectorAll("[data-context-section]")].map(
        (section) => (section as HTMLElement).dataset.contextKind,
      ),
    ).toEqual(["error", "plan", "queue"]);
    expect(within(region).getByText("Current work")).toBeTruthy();
    expect(
      within(region).getByRole("button", { name: "Retry questions" }),
    ).toBeTruthy();
  });
});

describe("composer context sheet open and close", () => {
  it("closes on a second click of the same chip and returns focus to the input", () => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    const plan = screen.getByRole("button", { name: "Plan: 2/6" });
    fireEvent.click(plan);
    expect(plan.getAttribute("aria-expanded")).toBe("true");
    expect(plan.getAttribute("aria-controls")).toBe(
      screen.getByRole("region", REGION).id,
    );
    fireEvent.click(plan);
    expect(screen.queryByRole("region", REGION)).toBeNull();
    expect(plan.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(draft);
  });

  it("switches sections on another chip without closing", () => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.change(draft, { target: { value: "Unsaved draft" } });
    const plan = screen.getByRole("button", { name: "Plan: 2/6" });
    const queue = screen.getByRole("button", { name: "Queue: 3" });
    fireEvent.click(plan);
    fireEvent.click(queue);
    expect(screen.getByRole("region", REGION)).toBeTruthy();
    expect(queue.getAttribute("aria-expanded")).toBe("true");
    expect(plan.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Unsaved draft");
  });

  it("closes with Escape and returns focus to the input", () => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.click(screen.getByRole("button", { name: "Plan: 2/6" }));
    fireEvent.keyDown(screen.getByRole("region", REGION), { key: "Escape" });
    expect(screen.queryByRole("region", REGION)).toBeNull();
    expect(document.activeElement).toBe(draft);
  });

  it("stays open on a pointer-down outside and inside the dock", () => {
    render(
      <div>
        <button>Elsewhere</button>
        <Fixture />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Plan: 2/6" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Elsewhere" }));
    expect(screen.getByRole("region", REGION)).toBeTruthy();
    fireEvent.pointerDown(screen.getByText("Current work"));
    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Draft" }));
    expect(screen.getByRole("region", REGION)).toBeTruthy();
  });

  it("opens in the flow above the strip, inside the dock", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Plan: 2/6" }));
    const dock = document.querySelector(".composer-context-dock")!;
    const region = screen.getByRole("region", REGION);
    const strip = screen.getByRole("toolbar");
    expect(region.parentElement).toBe(dock);
    expect(region.nextElementSibling).toBe(strip);
    expect(
      dock.querySelector("[data-radix-popper-content-wrapper]"),
    ).toBeNull();
    expect(
      screen
        .getByRole("button", { name: "Plan: 2/6" })
        .getAttribute("aria-controls"),
    ).toBe(region.id);
  });

  it("stays open while the input is focused and typed into", () => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    fireEvent.click(screen.getByRole("button", { name: "Plan: 2/6" }));
    draft.focus();
    fireEvent.change(draft, { target: { value: "Typing on" } });
    fireEvent.keyDown(draft, { key: "a" });
    expect(screen.getByRole("region", REGION)).toBeTruthy();
    expect((draft as HTMLTextAreaElement).value).toBe("Typing on");
  });

  it("toggles All and closes it again", () => {
    render(<Fixture />);
    const all = screen.getByRole("button", { name: "All thread context" });
    fireEvent.click(all);
    expect(all.getAttribute("aria-expanded")).toBe("true");
    const region = screen.getByRole("region", REGION);
    expect(region.querySelectorAll("[data-context-section]")).toHaveLength(3);
    fireEvent.click(all);
    expect(screen.queryByRole("region", REGION)).toBeNull();
  });

  it("leaves Escape in the editor alone when the sheet is closed", () => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    draft.focus();
    fireEvent.keyDown(draft, { key: "Escape" });
    expect(document.activeElement).toBe(draft);
  });

  it("keeps programmatic reveal force-open when the same section is already selected", () => {
    function Reveal() {
      const store = useComposerContextStore();
      return <button onClick={() => store?.reveal("plan")}>Reveal plan</button>;
    }
    render(
      <ComposerContextProvider>
        <ComposerContextSources>
          <ComposerContextItem
            id="plan"
            label="Plan"
            icon="ListTodo"
            group="work"
            kind="plan"
          >
            <p>Current work</p>
          </ComposerContextItem>
        </ComposerContextSources>
        <Reveal />
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    const reveal = screen.getByRole("button", { name: "Reveal plan" });
    fireEvent.click(reveal);
    fireEvent.click(reveal);
    expect(screen.getByRole("region", REGION)).toBeTruthy();
    const plan = within(screen.getByRole("toolbar")).getByRole("button", {
      name: "Plan",
    });
    fireEvent.click(plan);
    expect(screen.queryByRole("region", REGION)).toBeNull();
  });
});

describe("composer context sources", () => {
  it("removes settled contributions without leaving stale badges or losing the visible error", () => {
    function Settled() {
      const [queue, setQueue] = useState(true);
      return (
        <ComposerContextProvider>
          <ComposerContextSources>
            {queue && (
              <ComposerContextItem
                id="queue"
                label="Queue"
                summary="3"
                icon="ListView"
                group="queue"
                kind="queue"
              >
                <button onClick={() => setQueue(false)}>
                  Remove queued messages
                </button>
              </ComposerContextItem>
            )}
            <ComposerContextItem
              id="questions"
              label="Questions unavailable"
              icon="AlertCircle"
              group="attention"
              tone="error"
            >
              <button>Retry questions</button>
            </ComposerContextItem>
          </ComposerContextSources>
          <ComposerContextDock>
            <textarea aria-label="Draft" />
          </ComposerContextDock>
        </ComposerContextProvider>
      );
    }
    render(<Settled />);
    fireEvent.click(screen.getByRole("button", { name: "Queue: 3" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Remove queued messages" }),
    );
    expect(screen.queryByRole("button", { name: "Queue: 3" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Questions unavailable" }),
    ).toBeTruthy();
  });

  it("renders no passive strip when no source has facts", () => {
    render(
      <ComposerContextProvider>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    expect(screen.queryByRole("toolbar")).toBeNull();
  });

  it("updates native detail content without republishing unchanged summary metadata", () => {
    const listener = vi.fn();
    function Source({ tick, summary }: { tick: number; summary: number }) {
      const store = useComposerContextStore();
      useLayoutEffect(() => store?.subscribe(listener), [store]);
      return (
        <ComposerContextSources>
          <ComposerContextItem
            id="questions"
            label="Needs you"
            icon="CircleQuestion"
            group="attention"
            kind="needs-you"
            summary={summary}
          >
            <p>Countdown {tick}</p>
          </ComposerContextItem>
        </ComposerContextSources>
      );
    }
    const fixture = (tick: number, summary: number) => (
      <ComposerContextProvider>
        <Source tick={tick} summary={summary} />
        <ComposerContextDock>
          <textarea />
        </ComposerContextDock>
      </ComposerContextProvider>
    );
    const { rerender } = render(fixture(60, 2));
    listener.mockClear();
    rerender(fixture(59, 2));
    expect(listener).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Needs you: 2" }));
    expect(screen.getByText("Countdown 59")).toBeTruthy();
    rerender(fixture(58, 3));
    expect(listener).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Needs you: 3" })).toBeTruthy();
  });

  const NativeContext = createContext("missing");
  function StatefulDetail() {
    const label = useContext(NativeContext);
    const [count, setCount] = useState(0);
    return (
      <button onClick={() => setCount(count + 1)}>
        {label} {count}
      </button>
    );
  }
  it("keeps native provider context and local detail state while the sheet is closed", () => {
    render(
      <ComposerContextProvider>
        <NativeContext.Provider value="Native queue">
          <ComposerContextSources>
            <ComposerContextItem
              id="native"
              label="Queue"
              icon="ListView"
              group="queue"
              kind="queue"
            >
              <StatefulDetail />
            </ComposerContextItem>
          </ComposerContextSources>
        </NativeContext.Provider>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    const chip = screen.getByRole("button", { name: "Queue" });
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: "Native queue 0" }));
    fireEvent.click(chip);
    expect(screen.queryByRole("region", REGION)).toBeNull();
    fireEvent.click(chip);
    expect(screen.getByRole("button", { name: "Native queue 1" })).toBeTruthy();
  });
});

describe("composer context toolbar keyboard", () => {
  it("moves focus between chips without changing the selected section", () => {
    render(<Fixture />);
    const plan = screen.getByRole("button", { name: "Plan: 2/6" });
    const queue = screen.getByRole("button", { name: "Queue: 3" });
    fireEvent.click(plan);
    plan.focus();
    fireEvent.keyDown(plan, { key: "ArrowRight" });
    expect(document.activeElement).toBe(queue);
    expect(plan.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(queue, { key: "Home" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Questions unavailable" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "All thread context" }),
    );
  });
});

describe("composer context preview", () => {
  it("moves one mounted plugin preview between strip and panel and routes Escape from the editor", () => {
    const accept = vi.fn();
    const dismiss = vi.fn();
    const mounted = vi.fn();
    function Preview() {
      useLayoutEffect(mounted, []);
      return <span>Snapshot proposal</span>;
    }
    render(
      <ComposerContextProvider>
        <ComposerContextDock>
          <ComposerContextStrip onAccept={accept} onDismiss={dismiss}>
            <Preview />
          </ComposerContextStrip>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    expect(
      screen.getByText("Snapshot proposal").closest(".composer-context-strip"),
    ).toBeTruthy();
    fireEvent.click(screen.getByText("Snapshot proposal"));
    expect(
      screen.getByText("Snapshot proposal").closest(".composer-context-panel"),
    ).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Tab" });
    expect(accept).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("region", REGION)).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("keeps the preview out of the chips and shows it above the sections when expanded", () => {
    render(
      <ComposerContextProvider>
        <ComposerContextSources>
          <ComposerContextItem
            id="plan"
            label="Plan"
            summary="1/2"
            icon="ListTodo"
            group="work"
            kind="plan"
          >
            <p>Plan body</p>
          </ComposerContextItem>
        </ComposerContextSources>
        <ComposerContextDock>
          <ComposerContextStrip onDismiss={() => {}}>
            <span>Snapshot proposal</span>
          </ComposerContextStrip>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>,
    );
    expect(chipNames()).toEqual(["Plan: 1/2"]);
    fireEvent.click(screen.getByText("Snapshot proposal"));
    const region = screen.getByRole("region", REGION);
    const order = [
      ...region.querySelectorAll("p, span, [data-context-section]"),
    ].map((node) => node.textContent);
    expect(order.indexOf("Snapshot proposal")).toBeLessThan(
      order.indexOf("Plan body"),
    );
  });
});
