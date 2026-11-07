// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ThreadTodoCard } from "./ThreadTodoCard";

afterEach(cleanup);

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

it("marks a failed step without counting it as done", () => {
  render(
    <ThreadTodoCard
      pendingTodos={{
        sourceSeq: 1,
        updatedAt: 1,
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
  expect(screen.getByRole("img", { name: "Failed" })).toBeTruthy();
  expect(screen.getByText("Assertion failed")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: /1 of 2 items complete/ }),
  ).toBeTruthy();
});
