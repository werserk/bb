// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadTodoCard } from "./ThreadTodoCard";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("always shows relative age, even collapsed, and advances with time", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-08T12:00:00Z"));
  const { rerender } = render(
    <ThreadTodoCard
      pendingTodos={{
        sourceSeq: 1,
        updatedAt: Date.now() - 12 * 60_000,
        items: [{ id: "a", text: "Review", status: "pending" }],
      }}
      isExpanded={false}
      onToggle={() => {}}
      locale="en-US"
    />,
  );
  expect(screen.getByRole("button", { name: /Updated 12/ })).toBeTruthy();
  expect(screen.getByText(/Updated 12/).getAttribute("datetime")).toBe(
    "2026-11-08T11:48:00.000Z",
  );
  act(() => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByText(/Updated 13/)).toBeTruthy();
  rerender(
    <ThreadTodoCard
      pendingTodos={{
        sourceSeq: 2,
        updatedAt: Date.now(),
        items: [{ id: "a", text: "Review", status: "pending" }],
      }}
      isExpanded={false}
      onToggle={() => {}}
      locale="en-US"
    />,
  );
  expect(screen.getByText(/Updated just now/)).toBeTruthy();
});

it("shows a completed plan with its step note and helper until cleared", () => {
  const { rerender } = render(
    <ThreadTodoCard
      pendingTodos={{
        sourceSeq: 1,
        updatedAt: 1,
        items: [
          {
            id: "step",
            text: "Review",
            status: "completed",
            note: "Changes checked",
            actor: "Reviewer",
          },
        ],
      }}
      isExpanded
      onToggle={() => {}}
    />,
  );
  expect(screen.getByText("Plan")).toBeTruthy();
  expect(screen.getByText("Changes checked")).toBeTruthy();
  expect(screen.getByText("Reviewer")).toBeTruthy();
  rerender(
    <ThreadTodoCard
      pendingTodos={{ sourceSeq: 2, updatedAt: 2, items: [] }}
      isExpanded
      onToggle={() => {}}
    />,
  );
  expect(screen.queryByText("Review")).toBeNull();
});

it("uses neutral Russian progress and a midnight h23 time in the collapsed header", () => {
  render(
    <ThreadTodoCard
      pendingTodos={{
        sourceSeq: 1,
        updatedAt: new Date(2026, 0, 1, 0, 5).getTime(),
        items: [{ id: "one", text: "Done", status: "completed" }],
      }}
      state="finished"
      isExpanded={false}
      onToggle={() => {}}
      locale="ru-RU"
    />,
  );
  expect(
    screen.getByRole("button", {
      name: /План завершён · 00:05 · 1\/1: Выполнено: 1\/1/,
    }),
  ).toBeTruthy();
});

it.each([
  ["en-US", "Failed"],
  ["ru-RU", "Ошибка"],
])("marks a failed step without counting it as done in %s", (locale, label) => {
  render(
    <ThreadTodoCard
      locale={locale}
      pendingTodos={{
        sourceSeq: 1,
        updatedAt: 1,
        staleSince: 2,
        items: [
          { id: "ok", text: "Build", status: "completed" },
          {
            id: "fail",
            text: "Verify",
            status: "failed",
            note: "Assertion failed",
            actor: "Reviewer",
          },
        ],
      }}
      isExpanded
      onToggle={() => {}}
    />,
  );
  expect(screen.getByRole("img", { name: label })).toBeTruthy();
  expect(screen.getByText("Assertion failed")).toBeTruthy();
  expect(
    screen.getByRole("button", {
      name: locale.startsWith("ru")
        ? /Выполнено: 1\/2/
        : /1 of 2 items complete/,
    }),
  ).toBeTruthy();
});

it("shows stale evidence while collapsed and removes it after a fresh update", () => {
  const plan = {
    sourceSeq: 1,
    updatedAt: 1,
    staleSince: 2,
    items: [{ id: "a", text: "Waiting", status: "pending" as const }],
  };
  const { rerender } = render(
    <ThreadTodoCard
      pendingTodos={plan}
      isExpanded={false}
      onToggle={() => {}}
      locale="en-US"
    />,
  );
  expect(screen.getByText("Not updated since a later turn ended")).toBeTruthy();
  expect(screen.queryByText("Stale")).toBeNull();
  rerender(
    <ThreadTodoCard
      pendingTodos={{ ...plan, staleSince: undefined }}
      isExpanded={false}
      onToggle={() => {}}
      locale="en-US"
    />,
  );
  expect(screen.queryByText("Not updated since a later turn ended")).toBeNull();
});
