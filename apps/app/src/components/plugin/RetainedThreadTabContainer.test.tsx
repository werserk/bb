// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRetainedThreadTabContainer } from "./RetainedThreadTabContainer";
afterEach(cleanup);
it("restores the same visible content across a transient block above it", () => {
  const first = document.createElement("div"),
    second = document.createElement("div");
  document.body.append(first, second);
  const hook = renderHook(
    ({ outlet }) =>
      useRetainedThreadTabContainer({
        attached: true,
        bridge: false,
        outlet: { element: outlet },
        tabId: "test",
      }),
    { initialProps: { outlet: first } },
  );
  const scroller = document.createElement("div"),
    row = document.createElement("span");
  row.textContent = "Visible row";
  scroller.append(row);
  hook.result.current.container.append(scroller);
  let extra = 0;
  scroller.scrollTop = 317;
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 800);
  row.getBoundingClientRect = () =>
    new DOMRect(0, 337 + extra - scroller.scrollTop, 100, 20);
  act(() => hook.result.current.capture(first));
  // Browser reparenting loses the offset, while parked content gains a block.
  const append = second.append.bind(second);
  second.append = (...nodes) => {
    append(...nodes);
    scroller.scrollTop = 0;
    extra = 62;
  };
  hook.rerender({ outlet: second });
  expect(row.getBoundingClientRect().top).toBe(20);
  expect(scroller.scrollTop).toBe(379);
  // Native anchoring compensates when the transient block disappears.
  extra = 0;
  scroller.scrollTop -= 62;
  expect(scroller.scrollTop).toBe(317);
  first.remove();
  second.remove();
});
it("falls back to the saved offset when the visible node was removed", () => {
  const first = document.createElement("div"),
    second = document.createElement("div");
  document.body.append(first, second);
  const hook = renderHook(
    ({ outlet }) =>
      useRetainedThreadTabContainer({
        attached: true,
        bridge: false,
        outlet: { element: outlet },
        tabId: "test",
      }),
    { initialProps: { outlet: first } },
  );
  const scroller = document.createElement("div"),
    row = document.createElement("span");
  scroller.append(row);
  hook.result.current.container.append(scroller);
  scroller.scrollTop = 317;
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 800);
  row.getBoundingClientRect = () => new DOMRect(0, 20, 100, 20);
  act(() => hook.result.current.capture(first));
  row.remove();
  const append = second.append.bind(second);
  second.append = (...nodes) => {
    append(...nodes);
    scroller.scrollTop = 0;
  };
  hook.rerender({ outlet: second });
  expect(scroller.scrollTop).toBe(317);
  first.remove();
  second.remove();
});
it("captures the last visible position before parking hides the scroller", () => {
  const outlet = document.createElement("div"),
    parking = document.createElement("div");
  document.body.append(outlet, parking);
  const hook = renderHook(
    ({ attached }) =>
      useRetainedThreadTabContainer({
        attached,
        bridge: false,
        outlet: { element: outlet },
        tabId: "test",
      }),
    { initialProps: { attached: true } },
  );
  hook.result.current.parking.current = parking;
  const scroller = document.createElement("div"),
    row = document.createElement("span");
  scroller.append(row);
  hook.result.current.container.append(scroller);
  scroller.scrollTop = 317;
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 300, 800);
  row.getBoundingClientRect = () =>
    new DOMRect(0, 337 - scroller.scrollTop, 100, 20);
  hook.rerender({ attached: false });
  scroller.scrollTop = 0;
  // A late detach notification after hiding must not poison the saved position.
  act(() => hook.result.current.capture(outlet));
  hook.rerender({ attached: true });
  expect(scroller.scrollTop).toBe(317);
  outlet.remove();
  parking.remove();
});
