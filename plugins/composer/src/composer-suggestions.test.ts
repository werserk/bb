// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { resolveComposerSuggestions } from "./composer-suggestions";
import {
  acceptComposerSuggestion,
  handleComposerSuggestionKey,
} from "./composer-suggestion-keys";

describe("older composer hosts", () => {
  it("keeps an unavailable snapshot stable across reads and mounts", () => {
    const controller = resolveComposerSuggestions(undefined);
    expect(resolveComposerSuggestions(undefined)).toBe(controller);
    expect(controller.getSnapshot()).toBe(controller.getSnapshot());
    expect(controller.getSnapshot()).toEqual({
      eligible: false,
      snapshot: null,
      candidate: null,
      request: null,
    });
    const changed = vi.fn();
    controller.subscribe(changed)();
    controller.dismiss();
    expect(changed).not.toHaveBeenCalled();
    expect(acceptComposerSuggestion(controller)).toBe(false);
  });

  it.each(["Enter", "Tab", "Escape"])(
    "leaves ordinary %s handling intact",
    (key) => {
      const event = new KeyboardEvent("keydown", { key, cancelable: true });
      const preventDefault = vi.spyOn(event, "preventDefault");
      const submit = vi.fn();
      expect(
        handleComposerSuggestionKey(
          event,
          resolveComposerSuggestions(undefined),
          false,
          true,
          submit,
        ),
      ).toBe(false);
      expect(preventDefault).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    },
  );

  it("preserves the current host controller and its subscriptions", () => {
    const controller = {
      ...resolveComposerSuggestions(undefined),
      subscribe: vi.fn(() => vi.fn()),
    };
    expect(resolveComposerSuggestions(controller)).toBe(controller);
    const changed = vi.fn();
    resolveComposerSuggestions(controller).subscribe(changed);
    expect(controller.subscribe).toHaveBeenCalledWith(changed);
  });
});
