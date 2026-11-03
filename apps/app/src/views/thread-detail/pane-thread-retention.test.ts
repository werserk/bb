import { describe, expect, it } from "vitest";
import {
  initialPaneRetention,
  reconcilePaneRetention,
  type CanRetainThread,
} from "./pane-thread-retention";

const A = { projectId: "p", threadId: "a" };
const B = { projectId: "p", threadId: "b" };
const C = { projectId: "p", threadId: "c" };
const retainAll: CanRetainThread = () => true;

function ids(state: ReturnType<typeof initialPaneRetention>) {
  return state.slots.map((slot) => slot.threadId);
}

describe("reconcilePaneRetention", () => {
  it("starts with the active thread only", () => {
    expect(ids(initialPaneRetention(A))).toEqual(["a"]);
  });

  it("keeps the thread it left next to the new one", () => {
    const state = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.activeThreadId).toBe("b");
  });

  it("reuses both slots when switching back", () => {
    const toB = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    const back = reconcilePaneRetention(toB, A, retainAll);
    expect(ids(back)).toEqual(["a", "b"]);
    expect(back.slots[0]).toBe(toB.slots[0]);
    expect(back.slots[1]).toBe(toB.slots[1]);
  });

  it("evicts the older hidden thread, never the one just left", () => {
    const toB = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    const toC = reconcilePaneRetention(toB, C, retainAll);
    expect(ids(toC)).toEqual(["c", "b"]);
    expect(ids(toC).sort()).toEqual(["b", "c"]);
    expect(toC.slots.find((slot) => slot.threadId === "a")).toBeUndefined();
  });

  it("returns the same state when nothing changed", () => {
    const toB = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    expect(reconcilePaneRetention(toB, B, retainAll)).toBe(toB);
  });

  it("drops a hidden thread that is no longer retainable", () => {
    const toB = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    const state = reconcilePaneRetention(toB, B, (id) => id !== "a");
    expect(ids(state)).toEqual(["b"]);
  });

  it("does not keep the thread it left when it fails the row check", () => {
    const calls: Array<{ id: string; checkRows: boolean }> = [];
    const state = reconcilePaneRetention(
      initialPaneRetention(A),
      B,
      (id, options) => {
        calls.push({ id, checkRows: options.checkRows });
        return !options.checkRows;
      },
    );
    expect(ids(state)).toEqual(["b"]);
    expect(calls).toEqual([{ id: "a", checkRows: true }]);
  });

  it("checks rows only at the moment a thread is left", () => {
    const toB = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    const seen: boolean[] = [];
    reconcilePaneRetention(toB, B, (_id, options) => {
      seen.push(options.checkRows);
      return true;
    });
    expect(seen).toEqual([false]);
  });

  it("refills the freed slot when the left thread is not retainable and a third arrives", () => {
    const toB = reconcilePaneRetention(initialPaneRetention(A), B, retainAll);
    const state = reconcilePaneRetention(toB, C, (id, options) =>
      id === "b" ? !options.checkRows : true,
    );
    expect(ids(state).sort()).toEqual(["a", "c"]);
  });
});
