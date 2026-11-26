// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ComposerContextDock } from "../context/ComposerContextDock";
import {
  ComposerContextProvider,
  ComposerContextSources,
} from "../context/composer-context";
import { CollapsibleStackCard } from "./CollapsibleStackCard";
import { ThreadPromptModeCard } from "./ThreadPromptModeCard";

afterEach(cleanup);

function renderStrip(children: React.ReactNode) {
  render(
    <ComposerContextProvider>
      <ComposerContextSources>{children}</ComposerContextSources>
      <ComposerContextDock>
        <textarea aria-label="Draft" />
      </ComposerContextDock>
    </ComposerContextProvider>,
  );
  return within(screen.getByRole("toolbar"))
    .getAllByRole("button")
    .map((button) => ({
      name: button.getAttribute("aria-label"),
      category: button.getAttribute("data-context-category"),
    }))
    .filter((chip) => chip.name !== "All thread context");
}

it("keeps Plan mode out of the Working group", () => {
  const chips = renderStrip(
    <ThreadPromptModeCard
      activePromptMode={{
        mode: "plan",
        providerId: "claude-code",
        prompt: "inspect",
      }}
    />,
  );
  expect(chips).toEqual([{ name: "Plan", category: "other" }]);
});

it("shows a plugin stack card as Working only while it is active", () => {
  const inactive = renderStrip(
    <CollapsibleStackCard
      label="Goal"
      title="Goal paused"
      icon="Target"
      isActive={false}
    >
      body
    </CollapsibleStackCard>,
  );
  expect(inactive).toEqual([{ name: "Goal", category: "other" }]);
  cleanup();
  const active = renderStrip(
    <CollapsibleStackCard
      label="Goal"
      title="Goal active"
      icon="Target"
      isActive
    >
      body
    </CollapsibleStackCard>,
  );
  expect(active).toEqual([{ name: "Working", category: "working" }]);
});
