import { describe, expect, it } from "vitest";
import type { ThreadEventItemPresentation } from "@bb/domain";
import type { TimelineToolWorkRow } from "@bb/server-contract";
import { isOwnerPostRow, ownerPostText } from "../src/owner-post.js";

const POST_PRESENTATION: ThreadEventItemPresentation = {
  label: { pending: "Posting", completed: "Posted" },
  icon: { glyph: "Zap" },
  ownerPost: true,
};

function toolRow(
  overrides: Partial<TimelineToolWorkRow> = {},
): TimelineToolWorkRow {
  return {
    id: "post-1",
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    workKind: "tool",
    status: "completed",
    callId: "call-1",
    toolName: "post_to_owner",
    toolArgs: { text: "## Report\n\nAll done." },
    output: "",
    completedAt: 2,
    approvalStatus: null,
    presentation: POST_PRESENTATION,
    ...overrides,
  };
}

describe("ownerPostText", () => {
  it.each(["pending", "completed"] as const)(
    "returns the text of a %s call",
    (status) => {
      expect(ownerPostText(toolRow({ status }))).toBe("## Report\n\nAll done.");
    },
  );

  it.each(["error", "interrupted"] as const)(
    "returns nothing for a %s call",
    (status) => {
      expect(ownerPostText(toolRow({ status }))).toBeNull();
    },
  );

  it("returns nothing without the flag, without text or with blank text", () => {
    expect(
      ownerPostText(
        toolRow({ presentation: { ...POST_PRESENTATION, ownerPost: false } }),
      ),
    ).toBeNull();
    expect(ownerPostText(toolRow({ presentation: undefined }))).toBeNull();
    expect(ownerPostText(toolRow({ toolArgs: null }))).toBeNull();
    expect(ownerPostText(toolRow({ toolArgs: { text: 3 } }))).toBeNull();
    expect(ownerPostText(toolRow({ toolArgs: { text: "  \n " } }))).toBeNull();
  });
});

describe("isOwnerPostRow", () => {
  it("matches only tool work rows that carry a post", () => {
    expect(isOwnerPostRow(toolRow())).toBe(true);
    expect(isOwnerPostRow(toolRow({ status: "error" }))).toBe(false);
    expect(isOwnerPostRow(toolRow({ presentation: undefined }))).toBe(false);
  });
});
