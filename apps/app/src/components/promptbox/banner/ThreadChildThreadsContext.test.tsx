// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import {
  ComposerContextProvider,
  ComposerContextSources,
} from "../context/composer-context";
import { ComposerContextDock } from "../context/ComposerContextDock";
import {
  ThreadChildThreadsBanner,
  childThreadOutcome,
} from "./ThreadPromptContextBanner";

afterEach(cleanup);

const item = (
  id: string,
  state: "needs-you" | "working" | "finished",
  updatedAt = Date.now() - 120_000,
  outcome?: "done" | "error" | "idle",
) => ({
  id,
  title: `Thread ${id}`,
  href: `/threads/${id}`,
  needsOwnerAttention: state === "needs-you",
  finished: state === "finished",
  outcome,
  updatedAt,
});

function renderChildren(items: ReturnType<typeof item>[]) {
  render(
    <MemoryRouter>
      <ComposerContextProvider>
        <ComposerContextSources>
          <ThreadChildThreadsBanner
            childThreads={{ items }}
            isExpanded={false}
            onExpandedChange={() => {}}
          />
        </ComposerContextSources>
        <ComposerContextDock>
          <textarea aria-label="Draft" />
        </ComposerContextDock>
      </ComposerContextProvider>
    </MemoryRouter>,
  );
}

it("splits child threads into Needs you, Working and a collapsed Finished list", () => {
  renderChildren([
    item("w1", "needs-you"),
    item("w2", "needs-you"),
    item("a1", "working"),
    item("a2", "working"),
    item("a3", "working"),
    item("f1", "finished"),
    item("f2", "finished"),
  ]);
  const chips = within(screen.getByRole("toolbar"))
    .getAllByRole("button")
    .map((button) => button.getAttribute("aria-label"));
  expect(chips.slice(0, 2)).toEqual(["Needs you: 2", "Working: 3"]);
  fireEvent.click(screen.getByRole("button", { name: "Working: 3" }));
  const region = screen.getByRole("region", { name: "Thread context" });
  expect(within(region).getByRole("link", { name: /Thread a1/ })).toBeTruthy();
  expect(within(region).queryByRole("link", { name: /Thread f1/ })).toBeNull();
  const finished = within(region).getByRole("button", { name: /Finished · 2/ });
  expect(finished.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(finished);
  expect(within(region).getByRole("link", { name: /Thread f1/ })).toBeTruthy();
  expect(within(region).queryByRole("link", { name: /Thread w1/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Needs you: 2" }));
  expect(
    within(screen.getByRole("region", { name: "Thread context" }))
      .getByRole("link", { name: /Thread w1/ })
      .closest("[data-context-section]")
      ?.getAttribute("data-context-kind"),
  ).toBe("needs-you");
});

it("keeps Finished under Needs you when nothing is working", () => {
  renderChildren([item("w1", "needs-you"), item("f1", "finished")]);
  fireEvent.click(screen.getByRole("button", { name: "Needs you: 1" }));
  expect(screen.getByRole("button", { name: /Finished · 1/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Working/ })).toBeNull();
});

it("maps only an idle child to done and shows failures and unstarted children distinctly", () => {
  expect(childThreadOutcome("idle")).toBe("done");
  expect(childThreadOutcome("error")).toBe("error");
  for (const status of [
    "pending",
    "stopping",
    "starting",
    "active",
    "provisioning",
    "waiting-for-host",
  ] as const)
    expect(childThreadOutcome(status)).toBe("idle");
  renderChildren([
    item("w1", "needs-you"),
    item("ok", "finished", undefined, "done"),
    item("bad", "finished", undefined, "error"),
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Needs you: 1" }));
  fireEvent.click(screen.getByRole("button", { name: /Finished · 2/ }));
  const glyph = (id: string) =>
    screen
      .getByRole("link", { name: new RegExp(`Thread ${id}`) })
      .querySelector("svg")
      ?.getAttribute("class") ?? "";
  expect(glyph("ok")).toContain("text-success");
  expect(glyph("bad")).toContain("text-destructive-text");
});
