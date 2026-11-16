// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createComposerSuggestionController } from "@get-bb/plugin-sdk/internal/composer-handle";
import { ComposerSuggestion } from "../../../../../plugins/composer/src/ComposerSuggestion";
import { handleComposerSuggestionKey } from "../../../../../plugins/composer/src/composer-suggestion-keys";

afterEach(cleanup);
function setup() {
  const replace = vi.fn();
  const store = createComposerSuggestionController(replace);
  store.update({
    composerKey: "pane",
    threadId: "thread",
    completedTurnId: "turn",
    contextRevision: "turn",
    eligible: true,
  });
  store.controller.show({
    requestId: "one",
    snapshot: store.controller.getSnapshot().snapshot!,
    text: "Continue",
  });
  return { controller: store.controller, replace };
}
describe("suggestion interactions", () => {
  it("touch and keyboard use the same acceptance operation", () => {
    const { controller, replace } = setup();
    render(<ComposerSuggestion controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: /Use suggestion/ }));
    expect(replace).toHaveBeenCalledExactlyOnceWith("Continue");
    expect(screen.queryByLabelText("Suggested message")).toBeNull();
  });
  it.each([
    { key: "Enter" },
    { key: "Tab", shiftKey: true },
    { key: "Tab", repeat: true },
    { key: "Tab", isComposing: true },
  ])("preserves ordinary key behavior for %j", (init) => {
    const { controller, replace } = setup();
    expect(
      handleComposerSuggestionKey(
        new KeyboardEvent("keydown", init),
        controller,
        false,
      ),
    ).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
  it("accepts Tab once and gives menus precedence", () => {
    const { controller, replace } = setup();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    expect(handleComposerSuggestionKey(event, controller, true)).toBe(false);
    expect(handleComposerSuggestionKey(event, controller, false)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(handleComposerSuggestionKey(event, controller, false)).toBe(false);
    expect(replace).toHaveBeenCalledTimes(1);
  });
  it("Escape dismisses without consuming existing escape behavior", () => {
    const { controller, replace } = setup();
    expect(
      handleComposerSuggestionKey(
        new KeyboardEvent("keydown", { key: "Escape" }),
        controller,
        false,
      ),
    ).toBe(false);
    expect(controller.getSnapshot().candidate).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
