import { describe, expect, it } from "vitest";
import type {
  TimelineConversationRow,
  TimelineRowStatus,
  TimelineTurnRow,
} from "@bb/server-contract";
import { collapseBackgroundTurns } from "../src/background-turns.js";
import { buildTimelineRowTitle } from "../src/timeline-row-title.js";
import type { ThreadTimelineViewRow } from "../src/timeline-view.js";

let seq = 0;

function base(id: string) {
  seq += 1;
  return {
    id,
    threadId: "thread-1",
    turnId: null,
    sourceSeqStart: seq,
    sourceSeqEnd: seq,
    startedAt: 1_700_000_000_000 + seq * 1000,
    createdAt: 1_700_000_000_000 + seq * 1000,
  };
}

function request(
  id: string,
  initiator: "user" | "agent" | "system",
  kind: "message" | "steer" = "message",
): TimelineConversationRow {
  return {
    ...base(id),
    kind: "conversation",
    messageSeq: seq,
    role: "user",
    text: id,
    attachments: null,
    initiator,
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    turnRequest: { isGrouped: false, kind, status: "accepted" },
    mentions: [],
  };
}

function turn(id: string, status: TimelineRowStatus = "completed") {
  const row: TimelineTurnRow = {
    ...base(id),
    kind: "turn",
    turnId: id,
    status,
    summaryCount: 1,
    completedAt: status === "pending" ? null : 1,
    children: null,
  };
  return { ...row, children: null } satisfies ThreadTimelineViewRow;
}

function reply(id: string): TimelineConversationRow {
  return {
    ...base(id),
    kind: "conversation",
    messageSeq: seq,
    role: "assistant",
    text: id,
    attachments: null,
    turnRequest: null,
  };
}

function kinds(rows: readonly ThreadTimelineViewRow[]): string[] {
  return rows.map((row) => `${row.kind}:${row.id}`);
}

describe("collapseBackgroundTurns", () => {
  it("returns the same rows when no turn is background", () => {
    const rows = [request("u1", "user"), turn("t1"), reply("a1")];
    expect(collapseBackgroundTurns(rows, { threadRunning: false })).toEqual(
      rows,
    );
  });

  it("folds consecutive agent and system turns into one row", () => {
    const rows = [
      request("u1", "user"),
      turn("t1"),
      reply("a1"),
      request("g1", "agent"),
      turn("t2"),
      reply("a2"),
      request("s1", "system"),
      turn("t3"),
      reply("a3"),
    ];
    const out = collapseBackgroundTurns(rows, { threadRunning: false });
    expect(kinds(out)).toEqual([
      "conversation:u1",
      "turn:t1",
      "conversation:a1",
      "background-turns:background-turns:g1",
    ]);
    const group = out[3]!;
    if (group.kind !== "background-turns") throw new Error("expected group");
    expect(group.turnCount).toBe(2);
    expect(group.status).toBe("completed");
    expect(group.children).toHaveLength(6);
  });

  it("ends a background run at the next owner message", () => {
    const rows = [
      request("g1", "agent"),
      turn("t1"),
      request("u1", "user"),
      turn("t2"),
      request("g2", "agent"),
      turn("t3"),
    ];
    const out = collapseBackgroundTurns(rows, { threadRunning: false });
    expect(kinds(out)).toEqual([
      "background-turns:background-turns:g1",
      "conversation:u1",
      "turn:t2",
      "background-turns:background-turns:g2",
    ]);
  });

  it("marks the trailing run as running only while the thread runs", () => {
    const rows = [request("g1", "agent"), turn("t1", "pending")];
    const running = collapseBackgroundTurns(rows, { threadRunning: true })[0]!;
    const idle = collapseBackgroundTurns(rows, { threadRunning: false })[0]!;
    expect(running.kind === "background-turns" && running.status).toBe(
      "pending",
    );
    expect(idle.kind === "background-turns" && idle.status).toBe("completed");
  });

  it("keeps a run visible when the owner steers it", () => {
    const rows = [
      request("g1", "agent"),
      turn("t1", "pending"),
      request("u1", "user", "steer"),
      turn("t2"),
    ];
    const out = collapseBackgroundTurns(rows, { threadRunning: false });
    expect(kinds(out)).toEqual([
      "conversation:g1",
      "turn:t1",
      "conversation:u1",
      "turn:t2",
    ]);
  });

  it.each(["agent", "system"] as const)(
    "keeps an owner turn visible when a %s steer joins it",
    (initiator) => {
      const rows = [
        request("u1", "user"),
        turn("t1", "pending"),
        request("s1", initiator, "steer"),
        reply("a1"),
      ];
      expect(collapseBackgroundTurns(rows, { threadRunning: true })).toEqual(
        rows,
      );
    },
  );

  it("does not count a background steer as another turn", () => {
    const rows = [
      request("g1", "agent"),
      turn("t1", "pending"),
      request("s1", "system", "steer"),
      reply("a1"),
    ];
    const out = collapseBackgroundTurns(rows, { threadRunning: false });
    expect(kinds(out)).toEqual(["background-turns:background-turns:g1"]);
    const group = out[0]!;
    if (group.kind !== "background-turns") throw new Error("expected group");
    expect(group.turnCount).toBe(1);
    expect(group.children).toHaveLength(4);
  });

  it("shows only the steered turn of a run in full when the owner steers", () => {
    const rows = [
      request("g1", "agent"),
      turn("t1"),
      request("g2", "agent"),
      turn("t2"),
      request("g3", "agent"),
      turn("t3", "pending"),
      request("u1", "user", "steer"),
      turn("t4"),
    ];
    const out = collapseBackgroundTurns(rows, { threadRunning: false });
    expect(kinds(out)).toEqual([
      "background-turns:background-turns:g1",
      "conversation:g3",
      "turn:t3",
      "conversation:u1",
      "turn:t4",
    ]);
    const group = out[0]!;
    if (group.kind !== "background-turns") throw new Error("expected group");
    expect(group.turnCount).toBe(2);
    expect(group.status).toBe("completed");
  });

  it("keeps a run visible when one of its turns failed", () => {
    const rows = [
      request("g1", "agent"),
      turn("t1"),
      request("g2", "agent"),
      turn("t2", "error"),
    ];
    expect(collapseBackgroundTurns(rows, { threadRunning: false })).toEqual(
      rows,
    );
  });

  it("collapses 60 background turns into a single row", () => {
    const rows: ThreadTimelineViewRow[] = [request("u1", "user")];
    for (let i = 0; i < 60; i += 1) {
      rows.push(request(`g${i}`, "agent"), turn(`t${i}`));
    }
    const out = collapseBackgroundTurns(rows, { threadRunning: false });
    expect(out).toHaveLength(2);
    const group = out[1]!;
    if (group.kind !== "background-turns") throw new Error("expected group");
    expect(group.turnCount).toBe(60);
  });

  it("titles the row with count and time", () => {
    const rows = [request("g1", "agent"), turn("t1"), request("g2", "agent")];
    const group = collapseBackgroundTurns(rows, { threadRunning: false })[0]!;
    const options = { summaryStyle: "bundle", workStyle: "default" } as const;
    const title = buildTimelineRowTitle(group, options);
    expect(title.plain).toMatch(/^Background · 2 turns · \d{1,2}:\d{2}/);
    const single = collapseBackgroundTurns([request("g1", "agent")], {
      threadRunning: false,
    })[0]!;
    expect(buildTimelineRowTitle(single, options).plain).toMatch(
      /^Background · 1 turn · /,
    );
  });
});
