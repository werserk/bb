// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createContext, useContext, useLayoutEffect, useState } from "react";
import {
  ComposerContextProvider,
  ComposerContextSources,
  ComposerContextItem,
  useComposerContextStore,
} from "./composer-context";
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
  const toggle = screen.getByRole("button", { name: "Toggle thread context" });
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

it("keeps plan and native questions in the overview even when other sources mount first", () => {
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
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle thread context" }),
  );
  expect(screen.getByText("Preferred plan").closest("section")?.hidden).toBe(
    false,
  );
  expect(
    screen.getByText("Native question links").closest("section")?.hidden,
  ).toBe(false);
  expect(screen.getByText("Children detail").closest("section")?.hidden).toBe(
    true,
  );
  expect(screen.getByText("Machine detail").closest("section")?.hidden).toBe(
    true,
  );
  const footer = screen.getByRole("contentinfo", {
    name: "All thread context sections",
  });
  expect(footer.textContent).toContain("Machine status");
  expect(footer.textContent).toContain("Child threads");
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
