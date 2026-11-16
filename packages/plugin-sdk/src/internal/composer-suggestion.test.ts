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

it("keeps snapshot stable and rejects stale progress completion and cleanup", () => {
  const { controller, candidate, draftChanged, replace } = setup();
  const snapshot = controller.getSnapshot().snapshot;
  expect(controller.experimental_begin("a", candidate.snapshot)).toBe(true);
  expect(controller.getSnapshot().snapshot).toBe(snapshot);
  expect(controller.accept("a")).toBe("stale");
  controller.experimental_begin("b", candidate.snapshot);
  controller.clear("a");
  expect(
    controller.experimental_finish("a", candidate.snapshot, "failed"),
  ).toBe(false);
  expect(controller.show(candidate)).toBe(false);
  expect(controller.getSnapshot().request?.requestId).toBe("b");
  controller.experimental_finish("b", candidate.snapshot, "timeout");
  expect(controller.getSnapshot().request?.error).toBe("timeout");
  expect(controller.getSnapshot().snapshot).toBe(snapshot);
  draftChanged();
  expect(controller.getSnapshot().request).toBeNull();
  expect(
    controller.experimental_finish("b", candidate.snapshot, "failed"),
  ).toBe(false);
  expect(replace).not.toHaveBeenCalled();
});

it("clears progress without changing the snapshot on none or cancellation", () => {
  const { controller, candidate } = setup();
  const snapshot = controller.getSnapshot().snapshot;
  controller.experimental_begin("a", candidate.snapshot);
  controller.experimental_finish("a", candidate.snapshot, null);
  expect(controller.getSnapshot().request).toBeNull();
  controller.experimental_begin("b", candidate.snapshot);
  controller.clear("b");
  expect(controller.getSnapshot().request).toBeNull();
  expect(controller.getSnapshot().snapshot).toBe(snapshot);
});

it("rejects an older response after a newer request completed without a suggestion", () => {
  const { controller, candidate } = setup();
  controller.experimental_begin("a", candidate.snapshot);
  controller.experimental_begin("b", candidate.snapshot);
  controller.experimental_finish("b", candidate.snapshot, null);
  expect(controller.show(candidate)).toBe(false);
});

it.each([
  ["clear", "programmatic"],
  ["context", "context"],
  ["draft", "user"],
  ["dismiss", "user"],
  ["accept", "user"],
] as const)("emits the explicit cause for %s", (action, cause) => {
  const store = setup();
  store.controller.show(store.candidate);
  const events = vi.fn();
  store.controller.onEvent(events);
  if (action === "clear") store.controller.clear("a");
  if (action === "context") store.update({ ...store.input, eligible: false });
  if (action === "draft") store.draftChanged();
  if (action === "dismiss") store.controller.dismiss();
  if (action === "accept") store.controller.accept("a");
  expect(events).toHaveBeenCalledExactlyOnceWith({
    kind: action === "accept" ? "accepted" : "dismissed",
    requestId: "a",
    experimental_cause: cause,
  });
});
