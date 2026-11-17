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

it.each(["pending", "error", "none"])(
  "never accepts or submits %s progress text",
  (phase) => {
    const { controller, replace, submit } = setup();
    controller.dismiss();
    const snapshot = controller.getSnapshot().snapshot!;
    controller.experimental_begin("progress", snapshot);
    if (phase !== "pending")
      controller.experimental_finish(
        "progress",
        snapshot,
        phase === "error" ? "failed" : null,
      );
    for (const key of ["Tab", "Enter"]) {
      expect(
        handleComposerSuggestionKey(
          new KeyboardEvent("keydown", { key }),
          controller,
          false,
          true,
          submit,
        ),
      ).toBe(false);
    }
    expect(acceptComposerSuggestion(controller)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

describe("manual composer assistance suspension", () => {
  it("clears ghost text without accepting it and resumes only after every holder releases", () => {
    const { controller, replace } = setup();
    const snapshot = controller.getSnapshot().snapshot!;
    const first = controller.experimental_suspend();
    const second = controller.experimental_suspend();
    expect(controller.getSnapshot().candidate).toBeNull();
    expect(controller.getSnapshot().snapshot).toBe(snapshot);
    expect(controller.experimental_begin("new", snapshot)).toBe(false);
    expect(
      controller.show({ requestId: "new", snapshot, text: "Ignored" }),
    ).toBe(false);
    expect(controller.accept("one")).toBe("ineligible");
    first();
    first();
    expect(controller.getSnapshot().eligible).toBe(false);
    second();
    expect(controller.getSnapshot().eligible).toBe(true);
    expect(replace).not.toHaveBeenCalled();
  });
  it("does not resurrect a disposed composer when releasing a suspension", () => {
    const store = createComposerSuggestionController(vi.fn());
    store.update({
      composerKey: "pane",
      threadId: "thread",
      completedTurnId: "turn",
      contextRevision: "r",
      eligible: true,
    });
    const release = store.controller.experimental_suspend();
    store.dispose();
    release();
    expect(store.controller.getSnapshot()).toMatchObject({
      eligible: false,
      snapshot: null,
    });
  });
});
