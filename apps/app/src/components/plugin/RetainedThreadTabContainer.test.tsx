// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useRetainedThreadTabContainer } from "./RetainedThreadTabContainer";
afterEach(cleanup);
// jsdom has no layout; connectivity remains real, rectangles model visible bodies.
const laidOut = (element: HTMLElement) => {
  element.getClientRects = () =>
    [new DOMRect(0, 0, 300, 800)] as unknown as DOMRectList;
};
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
  laidOut(hook.result.current.container);
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
  laidOut(hook.result.current.container);
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
  laidOut(hook.result.current.container);
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
it("restores the visible offset while the cold-loading bridge is painted", () => {
  const outlet = document.createElement("div"),
    parking = document.createElement("div");
  document.body.append(outlet, parking);
  const hook = renderHook(
    ({ attached, bridge }) =>
      useRetainedThreadTabContainer({
        attached,
        bridge,
        outlet: { element: outlet },
        tabId: "test",
      }),
    { initialProps: { attached: true, bridge: false } },
  );
  hook.result.current.parking.current = parking;
  outlet.getBoundingClientRect = () => new DOMRect(500, 50, 300, 800);
  laidOut(hook.result.current.container);
  const scroller = document.createElement("div"),
    row = document.createElement("span");
  scroller.append(row);
  hook.result.current.container.append(scroller);
  scroller.scrollTop = 317;
  scroller.getBoundingClientRect = () => new DOMRect(500, 50, 300, 800);
  row.getBoundingClientRect = () =>
    new DOMRect(500, 387 - scroller.scrollTop, 100, 20);
  const append = parking.append.bind(parking);
  parking.append = (...nodes) => {
    append(...nodes);
    scroller.scrollTop = 0;
  };
  hook.rerender({ attached: false, bridge: true });
  expect(hook.result.current.container.style.position).toBe("fixed");
  expect(scroller.scrollTop).toBe(317);
  outlet.remove();
  parking.remove();
});

it("does not attach to or capture from a removed outlet before host publication catches up", () => {
  const first = document.createElement("div"),
    second = document.createElement("div"),
    parking = document.createElement("div");
  document.body.append(first, second, parking);
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
  const { container } = hook.result.current;
  laidOut(container);
  hook.result.current.parking.current = parking;
  const scroller = document.createElement("div");
  container.append(scroller);
  scroller.scrollTop = 317;
  act(() => hook.result.current.capture(first));
  first.remove();
  scroller.scrollTop = 0;
  hook.rerender({ outlet: first });
  expect(container.parentElement).toBe(parking);
  act(() => hook.result.current.capture(first));
  const append = second.append.bind(second);
  second.append = (...nodes) => {
    append(...nodes);
    scroller.scrollTop = 0;
  };
  hook.rerender({ outlet: second });
  expect(container.isConnected).toBe(true);
  expect(scroller.scrollTop).toBe(317);
  first.remove();
  second.remove();
  parking.remove();
});
it("ignores parking and layoutless captures but records a real zero offset", () => {
  const first = document.createElement("div"),
    second = document.createElement("div"),
    parking = document.createElement("div");
  document.body.append(first, second, parking);
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
  const { container } = hook.result.current;
  laidOut(container);
  hook.result.current.parking.current = parking;
  const scroller = document.createElement("div");
  container.append(scroller);
  scroller.scrollTop = 317;
  act(() => hook.result.current.capture(first));
  container.getClientRects = () => [] as unknown as DOMRectList;
  scroller.scrollTop = 0;
  act(() => hook.result.current.capture(first));
  act(() => hook.result.current.park());
  act(() => hook.result.current.capture(first));
  laidOut(container);
  hook.rerender({ outlet: second });
  expect(scroller.scrollTop).toBe(317);
  scroller.scrollTop = 0;
  act(() => hook.result.current.capture(second));
  act(() => hook.result.current.park());
  hook.rerender({ outlet: first });
  expect(scroller.scrollTop).toBe(0);
  first.remove();
  second.remove();
  parking.remove();
});
