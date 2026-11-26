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
import { ComposerContextStrip } from "./ComposerContextStrip";
import { ComposerContextDock } from "./ComposerContextDock";

afterEach(cleanup);

function Fixture() {
  const [queue, setQueue] = useState(true);
  return (
    <ComposerContextProvider>
      <ComposerContextSources>
        <ComposerContextItem
          id="plan"
          label="Plan"
          summary="2/6"
          icon="ListTodo"
          group="work"
        >
          <p>Current work</p>
        </ComposerContextItem>
        {queue && (
          <ComposerContextItem
            id="queue"
            label="Queue"
            summary="3"
            icon="ListView"
            group="queue"
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
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
      </ComposerContextDock>
    </ComposerContextProvider>
  );
}

describe("composer context", () => {
  it("keeps the editor mounted while details switch, closes with Escape and restores trigger focus", () => {
    render(<Fixture />);
    const draft = screen.getByRole("textbox", { name: "Draft" });
    const trigger = screen.getByRole("button", { name: "Plan: 2/6" });
    expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("Current work")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Queue: 3" }));
    expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
    expect((draft as HTMLTextAreaElement).value).toBe("Keep this draft");
    fireEvent.keyDown(screen.getByRole("region", { name: "Thread context" }), {
      key: "Escape",
    });
    expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Queue: 3" }),
    );
  });
  it("removes settled contributions without leaving stale badges or losing the visible error", () => {
    render(<Fixture />);
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
    expect(
      screen.queryByRole("button", { name: "Toggle thread context" }),
    ).toBeNull();
  });
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
it("keeps native provider context and local detail state while the panel is closed", () => {
  render(
    <ComposerContextProvider>
      <NativeContext.Provider value="Native queue">
        <ComposerContextSources>
          <ComposerContextItem
            id="native"
            label="Queue"
            icon="ListView"
            group="queue"
          >
            <StatefulDetail />
          </ComposerContextItem>
        </ComposerContextSources>
      </NativeContext.Provider>
      <ComposerContextDock>
        <textarea />
      </ComposerContextDock>
    </ComposerContextProvider>,
  );
  const toggle = screen.getByRole("button", { name: "Queue" });
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Native queue 0" }));
  fireEvent.keyDown(toggle, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  fireEvent.click(toggle);
  expect(screen.getByRole("button", { name: "Native queue 1" })).toBeTruthy();
});

it("leaves Escape in the editor alone when the disclosure is closed", () => {
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Draft" });
  draft.focus();
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(document.activeElement).toBe(draft);
});

it("shows only the selected section even when attention and other sources mount first", () => {
  render(
    <ComposerContextProvider>
      <ComposerContextSources>
        <ComposerContextItem
          id="children"
          label="Child threads"
          icon="ChildThread"
          group="work"
        >
          <p>Children detail</p>
        </ComposerContextItem>
        <ComposerContextItem
          id="machine"
          label="Machine status"
          icon="Info"
          group="attention"
          tone="error"
        >
          <p>Machine detail</p>
        </ComposerContextItem>
        <ComposerContextItem
          id="plan"
          label="Plan"
          icon="ListTodo"
          group="work"
          overview
        >
          <p>Preferred plan</p>
        </ComposerContextItem>
        <ComposerContextItem
          id="questions"
          label="Needs you"
          icon="MessageQuestion"
          group="attention"
          tone="attention"
          overview
        >
          <p>Native question links</p>
        </ComposerContextItem>
      </ComposerContextSources>
      <ComposerContextDock>
        <textarea />
      </ComposerContextDock>
    </ComposerContextProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  expect(screen.getByText("Preferred plan").closest("section")?.hidden).toBe(
    false,
  );
  expect(
    screen.getByText("Native question links").closest("section")?.hidden,
  ).toBe(true);
  expect(screen.getByText("Children detail").closest("section")?.hidden).toBe(
    true,
  );
  expect(screen.getByText("Machine detail").closest("section")?.hidden).toBe(
    true,
  );
  expect(screen.queryByRole("contentinfo")).toBeNull();
  expect(screen.getByRole("button", { name: "Machine status" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Child threads" })).toBeTruthy();
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
          icon="MessageQuestion"
          group="attention"
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

it("toggles the selected summary, switches sections and preserves draft and clicked-button focus", () => {
  render(<Fixture />);
  const draft = screen.getByRole("textbox", { name: "Draft" });
  fireEvent.change(draft, { target: { value: "Unsaved draft" } });
  const plan = screen.getByRole("button", { name: "Plan: 2/6" });
  const queue = screen.getByRole("button", { name: "Queue: 3" });
  fireEvent.click(plan);
  expect(plan.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(plan);
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  expect(document.activeElement).toBe(plan);
  fireEvent.click(plan);
  fireEvent.click(queue);
  expect(screen.getByRole("region", { name: "Thread context" })).toBeTruthy();
  expect(queue.getAttribute("aria-expanded")).toBe("true");
  expect(plan.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(queue);
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  expect(document.activeElement).toBe(queue);
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
  expect((draft as HTMLTextAreaElement).value).toBe("Unsaved draft");
});

it("labels counted sections and keeps attention hidden until selected", () => {
  render(<Fixture />);
  const plan = screen.getByRole("button", { name: "Plan: 2/6" });
  expect(plan.getAttribute("aria-label")).toBe("Plan: 2/6");
  fireEvent.click(plan);
  expect(screen.queryByRole("button", { name: "Retry questions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Queue: 3" }));
  expect(screen.queryByRole("button", { name: "Retry questions" })).toBeNull();
  const disclosure = screen.getByRole("button", { name: "Queue: 3" });
  fireEvent.keyDown(disclosure, { key: "Escape" });
  expect(document.activeElement).toBe(disclosure);
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
});

it("moves keyboard focus between summary buttons without changing the selected section", () => {
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
  expect(document.activeElement).toBe(queue);
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
  expect(screen.getByRole("region", { name: "Thread context" })).toBeTruthy();
  const plan = within(screen.getByRole("toolbar")).getByRole("button", {
    name: "Plan",
  });
  fireEvent.click(plan);
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  expect(document.activeElement).toBe(plan);
});

it("opens overflow sections and returns Escape focus to the external disclosure", () => {
  render(
    <ComposerContextProvider>
      <ComposerContextSources>
        {Array.from({ length: 7 }, (_, index) => (
          <ComposerContextItem
            key={index}
            id={`item-${index}`}
            label={`Context ${index}`}
            icon="Info"
            group="context"
          >
            <button>Action {index}</button>
          </ComposerContextItem>
        ))}
      </ComposerContextSources>
      <ComposerContextDock>
        <textarea aria-label="Draft" />
      </ComposerContextDock>
    </ComposerContextProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "Toggle thread context" }),
  ).toBeNull();
  const counter = screen.getByRole("button", { name: "Context 6" });
  fireEvent.click(counter);
  const action = screen.getByRole("button", { name: "Action 6" });
  action.focus();
  fireEvent.keyDown(action, { key: "Escape" });
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  expect(document.activeElement).toBe(counter);
});

it("moves one mounted plugin preview between strip and panel and routes Tab/Escape from the editor", () => {
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
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});

it("connects each counter to its panel and closes it from the same tab", () => {
  render(<Fixture />);
  const plan = screen.getByRole("button", { name: "Plan: 2/6" });
  expect(plan.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(plan);
  const panel = screen.getByRole("region", { name: "Thread context" });
  expect(plan.getAttribute("aria-controls")).toBe(panel.id);
  expect(panel.querySelector("header")).toBeNull();
  expect(
    within(panel).queryByRole("button", { name: "Retry questions" }),
  ).toBeNull();
  fireEvent.click(plan);
  expect(screen.queryByRole("region", { name: "Thread context" })).toBeNull();
  expect(plan.getAttribute("aria-expanded")).toBe("false");
  expect(document.activeElement).toBe(plan);
});
