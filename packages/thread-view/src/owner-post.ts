import type { JsonObject, ThreadEventItemPresentation } from "@bb/domain";
import type { ThreadTimelineViewRow } from "./timeline-view.js";

interface OwnerPostCandidate {
  presentation?: ThreadEventItemPresentation | undefined;
  status: string;
  toolArgs: JsonObject | null;
}

export type TimelineOwnerPostRow = Extract<
  ThreadTimelineViewRow,
  { kind: "work"; workKind: "tool" }
>;

export function ownerPostText(candidate: OwnerPostCandidate): string | null {
  if (candidate.presentation?.ownerPost !== true) return null;
  if (candidate.status !== "pending" && candidate.status !== "completed") {
    return null;
  }
  const text = candidate.toolArgs?.["text"];
  return typeof text === "string" && text.trim().length > 0 ? text : null;
}

export function isOwnerPostRow(
  row: ThreadTimelineViewRow,
): row is TimelineOwnerPostRow {
  return (
    row.kind === "work" &&
    row.workKind === "tool" &&
    ownerPostText(row) !== null
  );
}
