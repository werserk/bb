import { describe, expect, it, vi } from "vitest";
import { createComposerSuggestionController } from "./composer-suggestion.js";

function setup() {
  const replace = vi.fn();
  const store = createComposerSuggestionController(replace);
  const input = {
    composerKey: "pane-a",
    threadId: "thread-a",
    completedTurnId: "turn-1",
    contextRevision: "turn-1",
    eligible: true,
  };
  store.update(input);
  const snapshot = store.controller.getSnapshot().snapshot!;
  const candidate = { requestId: "a", snapshot, text: "Continue" };
  return { ...store, replace, input, candidate };
}

describe("composer suggestions", () => {
  it("rejects a response after typing and erasing", () => {
    const { controller, draftChanged, candidate, replace } = setup();
    draftChanged();
    draftChanged();
    expect(controller.show(candidate)).toBe(false);
    expect(replace).not.toHaveBeenCalled();
  });
  it("keeps B when an obsolete A cleanup arrives", () => {
    const { controller, candidate } = setup();
    controller.show(candidate);
    controller.show({ ...candidate, requestId: "b" });
    controller.clear("a");
    expect(controller.getSnapshot().candidate?.requestId).toBe("b");
  });
  it.each(["contextRevision", "composerKey", "threadId"] as const)(
    "invalidates on changed %s",
    (key) => {
      const { controller, candidate, input, update, replace } = setup();
      controller.show(candidate);
      update({ ...input, [key]: "changed" });
      expect(controller.accept("a")).toBe("stale");
      expect(controller.show(candidate)).toBe(false);
      expect(replace).not.toHaveBeenCalled();
    },
  );
  it("blocks acceptance when a question appears", () => {
    const { controller, candidate, input, update, replace } = setup();
    controller.show(candidate);
    update({ ...input, eligible: false });
    expect(controller.accept("a")).toBe("ineligible");
    expect(replace).not.toHaveBeenCalled();
  });
  it("accepts once without exposing text in a draft before acceptance", () => {
    const { controller, candidate, replace } = setup();
    expect(controller.show(candidate)).toBe(true);
    expect(replace).not.toHaveBeenCalled();
    expect(controller.accept("a")).toBe("accepted");
    expect(controller.accept("a")).toBe("stale");
    expect(replace).toHaveBeenCalledExactlyOnceWith("Continue");
  });
  it("dismisses pending work and disposal rejects late results", () => {
    const { controller, candidate, dispose } = setup();
    controller.dismiss();
    expect(controller.show(candidate)).toBe(false);
    dispose();
    expect(controller.getSnapshot().snapshot).toBeNull();
    expect(controller.show(candidate)).toBe(false);
  });
});
