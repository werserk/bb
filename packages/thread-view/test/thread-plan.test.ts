import { describe, it, expect } from "vitest";
import { turnScope } from "@bb/domain";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";
import { projectThreadPlan } from "../src/thread-plan.js";
const plan = (
  seq: number,
  planId?: string,
  steps = [{ id: "a", step: "Work", status: "active" as const }],
): ThreadEventWithMeta => ({
  meta: { id: `${seq}`, seq, createdAt: seq },
  event: {
    type: "item/completed",
    threadId: "t",
    providerThreadId: "p",
    scope: turnScope("turn"),
    item: {
      type: "planSteps",
      id: `p${seq}`,
      planId,
      steps,
      status: "completed",
    },
  },
});
const read = (
  events: ThreadEventWithMeta[],
  anchors: Parameters<typeof projectThreadPlan>[0]["anchors"] = [],
) =>
  projectThreadPlan({
    threadId: "t",
    revision: 100,
    status: "idle",
    events,
    anchors,
    attentionInteractionIds: anchors.map((a) => a.interactionId),
    historyTruncated: false,
  });
describe("canonical plan projection", () => {
  it("binds stable identity through reorder and never rebinds a different plan", () => {
    const anchor = {
      interactionId: "q",
      event: plan(1, "work"),
      turnId: "turn",
    };
    const next = plan(2, "work", [
      { id: "b", step: "Other", status: "active" },
      { id: "a", step: "Work", status: "active" },
    ]);
    expect(
      read([next], [anchor]).current?.items.map((s) => s.interactionIds),
    ).toEqual([[], ["q"]]);
    expect(read([plan(3, "other")], [anchor]).unboundInteractionIds).toEqual([
      "q",
    ]);
  });
  it("retains ambiguous, deleted, foreign-turn and legacy replacements as unbound", () => {
    const ambiguous = plan(1, "work", [
      { id: "a", step: "A", status: "active" },
      { id: "b", step: "B", status: "active" },
    ]);
    for (const anchor of [
      { interactionId: "q", event: ambiguous, turnId: "turn" },
      { interactionId: "q", event: plan(1, "work"), turnId: "foreign" },
      { interactionId: "q", event: plan(1), turnId: "turn" },
    ])
      expect(read([plan(2, "other")], [anchor]).unboundInteractionIds).toEqual([
        "q",
      ]);
  });
  it("deduplicates history, bounds it and respects empty clear", () => {
    const result = read([
      plan(1, "old"),
      plan(2, "current"),
      plan(3, "current"),
    ]);
    expect(result.previousPlans.map((p) => p.planId)).toEqual(["old"]);
    expect(read([plan(1, "old"), plan(2, "clear", [])]).current).toBeNull();
    expect(
      read(Array.from({ length: 6 }, (_, i) => plan(i + 1, `p${i}`)))
        .historyTruncated,
    ).toBe(true);
  });
});
