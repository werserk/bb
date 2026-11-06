// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { ThreadTimelinePendingTodos } from "@bb/domain";
import { ThreadPlanCard } from "./ThreadPlanCard";
import { ThreadTodoCard } from "@/components/promptbox/banner/ThreadTodoCard";

afterEach(cleanup);
const plan: ThreadTimelinePendingTodos = {
  sourceSeq: 10,
  updatedAt: 100,
  items: [
    {
      id: "a",
      text: "Check",
      status: "in_progress",
      note: "Reviewing output",
      actor: "Reviewer",
    },
  ],
};
it("collapses on completion, allows reopening, and clears explicitly", () => {
  const { rerender, container } = render(
    <ThreadPlanCard pendingTodos={plan} rows={[]} waitingForOwner={false} />,
  );
  expect(
    screen
      .getByRole("button", { name: /^Plan:/ })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  const done: ThreadTimelinePendingTodos = {
    ...plan,
    sourceSeq: 11,
    items: [{ ...plan.items[0]!, status: "completed" }],
  };
  rerender(
    <ThreadPlanCard pendingTodos={done} rows={[]} waitingForOwner={false} />,
  );
  const toggle = screen.getByRole("button", { name: /^Plan finished/ });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Reviewer")).toBeTruthy();
  expect(screen.getByText("Reviewing output")).toBeTruthy();
  rerender(
    <ThreadPlanCard
      pendingTodos={{ ...done, items: [] }}
      rows={[]}
      waitingForOwner={false}
    />,
  );
  expect(container.querySelector("aside")).toBeNull();
});
it("shows waiting and localized stale metadata with unique disclosure ids", () => {
  const { rerender } = render(
    <ThreadTodoCard
      pendingTodos={plan}
      state="waiting"
      isExpanded
      onToggle={() => {}}
      locale="ru-RU"
    />,
  );
  expect(screen.getByText("План · ждёт тебя")).toBeTruthy();
  rerender(
    <>
      <ThreadTodoCard
        pendingTodos={plan}
        state="earlier"
        isExpanded
        onToggle={() => {}}
        locale="ru-RU"
      />
      <ThreadTodoCard
        pendingTodos={plan}
        isExpanded
        onToggle={() => {}}
        locale="en-US"
      />
    </>,
  );
  expect(screen.getByText(/обновлено в .* · из прошлой задачи/)).toBeTruthy();
  const ids = screen
    .getAllByRole("button", { expanded: true })
    .map((button) => button.id)
    .filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
});
