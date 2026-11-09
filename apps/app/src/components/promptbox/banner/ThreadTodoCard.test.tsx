// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import { ThreadTodoCard } from "./ThreadTodoCard";
vi.mock("@/views/thread-detail/PaneContext", () => ({
  useOptionalPaneContext: () => null,
}));
afterEach(cleanup);
it("retains failure, note and actor under a neutral stale disclosure without completion counts", () => {
  render(
    <ThreadTodoCard
      threadId="t"
      placement="overlay"
      snapshot={{
        sourceSeq: 1,
        updatedAt: 1,
        staleSince: 2,
        items: [
          {
            id: "a",
            text: "Verify",
            note: "refused",
            actor: "reviewer",
            status: "failed",
            interactionIds: [],
          },
        ],
      }}
      earlier={false}
      narrow={false}
      executing={false}
      interactions={[]}
    />,
  );
  const button = screen.getByRole("button", { name: /Earlier plan/ });
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  expect(screen.getByLabelText("Failed: Verify")).toBeDefined();
  expect(screen.getByText("Failed · refused")).toBeDefined();
  expect(screen.getByText("reviewer")).toBeDefined();
  expect(button.textContent).not.toMatch(/\d+\/\d+/);
});
