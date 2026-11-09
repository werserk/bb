import type { PlanSnapshotView } from "@bb/domain";
export function planDisclosureState(
  snapshot: PlanSnapshotView,
  earlier: boolean,
) {
  const waiting = snapshot.items.some((item) => item.interactionIds.length > 0);
  const failed = snapshot.items.some((item) => item.status === "failed");
  const finished =
    snapshot.items.length > 0 &&
    snapshot.items.every((item) => item.status === "completed");
  return {
    waiting,
    failed,
    finished,
    quiet:
      !waiting && (earlier || finished || snapshot.staleSince !== undefined),
  };
}
