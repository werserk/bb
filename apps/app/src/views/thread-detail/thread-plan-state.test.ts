import { it, expect } from "vitest";
import { planDisclosureState } from "./thread-plan-state";
import type { PlanSnapshotView } from "@bb/domain";
it("folds fresh completed or stale history while pending native input outranks quiet", () => {
  const snapshot: PlanSnapshotView = {
    sourceSeq: 1,
    updatedAt: 1,
    items: [
      { id: "a", text: "Verify", status: "completed", interactionIds: [] },
    ],
  };
  expect(planDisclosureState(snapshot, false)).toEqual({
    waiting: false,
    failed: false,
    finished: true,
    quiet: true,
  });
  expect(
    planDisclosureState(
      { ...snapshot, items: [{ ...snapshot.items[0]!, status: "failed" }] },
      false,
    ),
  ).toMatchObject({ failed: true, finished: false, quiet: false });
  expect(
    planDisclosureState(
      {
        ...snapshot,
        staleSince: 2,
        items: [{ ...snapshot.items[0]!, status: "failed" }],
      },
      false,
    ).quiet,
  ).toBe(true);
  expect(
    planDisclosureState(
      {
        ...snapshot,
        staleSince: 2,
        items: [
          {
            ...snapshot.items[0]!,
            status: "needs_input",
            interactionIds: ["native"],
          },
        ],
      },
      true,
    ).quiet,
  ).toBe(false);
});
