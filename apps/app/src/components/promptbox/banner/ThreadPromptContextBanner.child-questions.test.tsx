// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadChildThreadsBanner } from "./ThreadPromptContextBanner";

afterEach(cleanup);

it("keeps waiting child counts and navigation without mounting answer forms", () => {
  render(
    <MemoryRouter>
      <ThreadChildThreadsBanner
        isExpanded
        onExpandedChange={vi.fn()}
        childThreads={{
          items: [
            {
              id: "waiting",
              title: "Choose fixture",
              href: "/threads/waiting",
              needsOwnerAttention: true,
            },
            {
              id: "working",
              title: "Inspect fixture",
              href: "/threads/working",
              needsOwnerAttention: false,
            },
          ],
        }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("1 needs you · 1 working")).toBeTruthy();
  expect(
    screen.getByRole("link", { name: /Choose fixture/ }).getAttribute("href"),
  ).toBe("/threads/waiting");
  expect(
    screen.getByRole("link", { name: /Inspect fixture/ }).getAttribute("href"),
  ).toBe("/threads/working");
  expect(screen.getByLabelText("Needs you")).toBeTruthy();
  expect(screen.queryByTestId("user-question-banner")).toBeNull();
  expect(screen.queryByTestId("plugin-request-banner")).toBeNull();
});

it("keeps all waiting child links when there are more than three questions", () => {
  const children = Array.from({ length: 5 }, (_, i) => ({
    id: `child_${i}`,
    title: `Waiting ${i}`,
    href: `/threads/child_${i}`,
    needsOwnerAttention: true,
  }));
  render(
    <MemoryRouter>
      <ThreadChildThreadsBanner
        isExpanded
        onExpandedChange={vi.fn()}
        childThreads={{ items: children }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByText("5 needs you · 0 working")).toBeTruthy();
  expect(screen.getAllByRole("link")).toHaveLength(5);
  expect(
    screen.queryByRole("button", { name: /Submit answer|Answer/ }),
  ).toBeNull();
});
