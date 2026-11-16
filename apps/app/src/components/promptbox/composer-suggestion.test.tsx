// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createComposerSuggestionController } from "@get-bb/plugin-sdk/internal/composer-handle";
import {
  acceptComposerSuggestion,
  handleComposerSuggestionKey,
} from "../../../../../plugins/composer/src/composer-suggestion-keys";
function setup() {
  const replace = vi.fn();
  const submit = vi.fn(() => acceptComposerSuggestion(store.controller));
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
  return { controller: store.controller, replace, submit };
}
describe("suggestion keys", () => {
  it.each([
    { key: "Tab", shiftKey: true },
    { key: "Tab", repeat: true },
    { key: "Enter", shiftKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "Enter", repeat: true },
    { key: "Enter", isComposing: true },
  ])("preserves ordinary key behavior for %j", (init) => {
    const { controller, replace, submit } = setup();
    expect(
      handleComposerSuggestionKey(
        new KeyboardEvent("keydown", init),
        controller,
        false,
        true,
        submit,
      ),
    ).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it("accepts Tab without submission and gives menus precedence", () => {
    const { controller, replace, submit } = setup();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      cancelable: true,
    });
    expect(
      handleComposerSuggestionKey(event, controller, true, true, submit),
    ).toBe(false);
    expect(
      handleComposerSuggestionKey(event, controller, false, true, submit),
    ).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(replace).toHaveBeenCalledExactlyOnceWith("Continue");
    expect(submit).not.toHaveBeenCalled();
  });
  it("sends accepted Enter once but preserves touch newline policy", () => {
    const { controller, replace, submit } = setup();
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      cancelable: true,
    });
    expect(
      handleComposerSuggestionKey(event, controller, false, false, submit),
    ).toBe(false);
    expect(
      handleComposerSuggestionKey(event, controller, false, true, submit),
    ).toBe(true);
    expect(
      handleComposerSuggestionKey(event, controller, false, true, submit),
    ).toBe(false);
    expect(replace).toHaveBeenCalledExactlyOnceWith("Continue");
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it("Escape dismisses without consuming existing escape behavior", () => {
    const { controller, replace, submit } = setup();
    expect(
      handleComposerSuggestionKey(
        new KeyboardEvent("keydown", { key: "Escape" }),
        controller,
        false,
        true,
        submit,
      ),
    ).toBe(false);
    expect(controller.getSnapshot().candidate).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });
});
