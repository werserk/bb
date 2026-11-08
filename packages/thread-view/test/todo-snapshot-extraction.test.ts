import {
  jsonObjectSchema,
  turnScope,
  threadTimelinePendingTodosSchema,
} from "@bb/domain";
import type { Thread, ThreadEventPlanStep } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { extractThreadTimelinePendingTodos } from "../src/todo-snapshot-extraction.js";
import type { ThreadEventWithMeta } from "../src/build-event-projection.js";

const ACTIVE: Thread["status"] = "active";

function planStepsEvent({
  steps,
  seq,
  type = "item/completed",
  explanation,
}: {
  steps: ThreadEventPlanStep[];
  seq: number;
  type?: "item/started" | "item/completed";
  explanation?: string;
}): ThreadEventWithMeta {
  return {
    event: {
      type,
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "planSteps",
        id: `plan-${seq}`,
        steps,
        ...(explanation === undefined ? {} : { explanation }),
        status: type === "item/completed" ? "completed" : "pending",
      },
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  };
}

function legacyTodoWriteToolCallEvent(seq: number): ThreadEventWithMeta {
  return {
    event: {
      type: "item/completed",
      threadId: "thread-1",
      providerThreadId: "provider-thread-1",
      scope: turnScope("turn-1"),
      item: {
        type: "toolCall",
        id: `todo-write-${seq}`,
        tool: "TodoWrite",
        arguments: jsonObjectSchema.parse({
          todos: [{ content: "Legacy todo", status: "pending" }],
        }),
        status: "completed",
      },
    },
    meta: { id: `event-${seq}`, seq, createdAt: seq },
  };
}

describe("extractThreadTimelinePendingTodos", () => {
  it("reads the latest planSteps snapshot, mapping step statuses to banner statuses", () => {
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 1,
        steps: [{ step: "Older snapshot", status: "active" }],
      }),
      planStepsEvent({
        seq: 2,
        steps: [
          { step: "Read the spec", status: "completed" },
          { step: "Writing the code", status: "active" },
          { step: "Run the tests", status: "pending" },
          { step: "Flaky step", status: "failed" },
          { step: "   ", status: "pending" },
          { step: "No status" },
        ],
      }),
    ]);
    expect(result).toEqual({
      sourceSeq: 2,
      updatedAt: 2,
      items: [
        { id: "seq:2:0", text: "Read the spec", status: "completed" },
        { id: "seq:2:1", text: "Writing the code", status: "in_progress" },
        { id: "seq:2:2", text: "Run the tests", status: "pending" },
        { id: "seq:2:3", text: "Flaky step", status: "failed" },
        { id: "seq:2:5", text: "No status", status: "pending" },
      ],
    });
  });

  it("retains failed truth and metadata through snapshot serialization", () => {
    const snapshot = extractThreadTimelinePendingTodos("idle", [
      planStepsEvent({
        seq: 8,
        steps: [
          { step: "Build", status: "completed" },
          {
            step: "Verify",
            status: "failed",
            note: "Assertion failed",
            actor: "Reviewer",
          },
        ],
      }),
    ]);
    const restored = threadTimelinePendingTodosSchema.parse(
      JSON.parse(JSON.stringify(snapshot)),
    );
    expect(restored.items.map((item) => item.status)).toEqual([
      "completed",
      "failed",
    ]);
    expect(restored.items[1]).toMatchObject({
      note: "Assertion failed",
      actor: "Reviewer",
    });
    expect(
      restored.items.filter((item) => item.status === "completed"),
    ).toHaveLength(1);
  });

  it("picks the newest snapshot by sequence even when the input is unordered", () => {
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({ seq: 30, steps: [{ step: "third", status: "active" }] }),
      planStepsEvent({ seq: 10, steps: [{ step: "first", status: "active" }] }),
      planStepsEvent({
        seq: 20,
        steps: [{ step: "second", status: "active" }],
      }),
    ]);
    expect(result?.sourceSeq).toBe(30);
    expect(result?.items.map((item) => item.text)).toEqual(["third"]);
  });

  it("does not split an astral character at the todo text limit", () => {
    const prefix = "x".repeat(239);
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 1,
        steps: [{ step: `${prefix}𠮷tail`, status: "active" }],
      }),
    ]);
    expect(result?.items[0]?.text).toBe(prefix);
  });

  it("ignores an opened (pending) snapshot and an empty one clears the banner", () => {
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        planStepsEvent({
          seq: 5,
          type: "item/started",
          steps: [{ step: "not settled", status: "active" }],
        }),
      ]),
    ).toBeNull();
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        planStepsEvent({ seq: 6, steps: [{ step: "old", status: "active" }] }),
        planStepsEvent({ seq: 7, steps: [] }),
      ]),
    ).toEqual({ sourceSeq: 7, updatedAt: 7, items: [] });
  });

  it("does not read a tool call by its name, whatever its arguments carry", () => {
    expect(
      extractThreadTimelinePendingTodos(ACTIVE, [
        legacyTodoWriteToolCallEvent(41),
      ]),
    ).toBeNull();
    const result = extractThreadTimelinePendingTodos(ACTIVE, [
      planStepsEvent({
        seq: 42,
        steps: [{ step: "planned", status: "active" }],
      }),
      legacyTodoWriteToolCallEvent(43),
    ]);
    expect(result?.sourceSeq).toBe(42);
  });

  it("preserves optional step notes and helper tags", () => {
    const step = {
      step: "Review",
      status: "active" as const,
      note: "Reviewer reads changes",
      actor: "Reviewer",
    };
    expect(
      extractThreadTimelinePendingTodos("idle", [
        planStepsEvent({ seq: 1, steps: [step] }),
      ])?.items[0],
    ).toMatchObject({ text: step.step, note: step.note, actor: step.actor });
  });

  it("keeps a completed plan until a replacement or explicit clear", () => {
    const done = planStepsEvent({
      seq: 1,
      steps: [{ step: "Done", status: "completed" }],
    });
    expect(
      extractThreadTimelinePendingTodos("idle", [done])?.items[0].status,
    ).toBe("completed");
    const next = planStepsEvent({
      seq: 2,
      steps: [{ step: "Next task", status: "pending" }],
    });
    expect(
      extractThreadTimelinePendingTodos("idle", [done, next])?.items[0].text,
    ).toBe("Next task");
    expect(
      extractThreadTimelinePendingTodos("idle", [
        done,
        next,
        planStepsEvent({ seq: 3, steps: [] }),
      ])?.items,
    ).toEqual([]);
  });

  it("keeps the latest plan after a turn ends, including errors", () => {
    const events = [
      planStepsEvent({ seq: 1, steps: [{ step: "x", status: "active" }] }),
    ];
    expect(extractThreadTimelinePendingTodos("idle", events)).toEqual(
      extractThreadTimelinePendingTodos(ACTIVE, events),
    );
    expect(extractThreadTimelinePendingTodos("error", events)).toEqual(
      extractThreadTimelinePendingTodos(ACTIVE, events),
    );
    expect(extractThreadTimelinePendingTodos(ACTIVE, events)).not.toBeNull();
  });
});

function lifecycle(
  seq: number,
  turnId: string,
  type: "turn/started" | "turn/completed",
  status: "completed" | "failed" | "interrupted" = "completed",
): ThreadEventWithMeta {
  return {
    event:
      type === "turn/started"
        ? {
            type,
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope: turnScope(turnId),
          }
        : {
            type,
            threadId: "thread-1",
            providerThreadId: "provider-thread-1",
            scope: turnScope(turnId),
            status,
          },
    meta: { id: `event-${seq}`, seq, createdAt: seq * 100 },
  };
}
const openPlan = () =>
  planStepsEvent({
    seq: 10,
    steps: [{ step: "Waiting for the owner", status: "pending" }],
  });

describe("plan staleness from normalized turn events", () => {
  it.each(["completed", "failed", "interrupted"] as const)(
    "marks an open plan after a later empty turn ends as %s",
    (status) => {
      const events = [
        lifecycle(1, "turn-1", "turn/started"),
        openPlan(),
        lifecycle(11, "turn-1", "turn/completed"),
        lifecycle(20, "turn-2", "turn/started"),
        lifecycle(21, "turn-2", "turn/completed", status),
      ];
      const snapshot = extractThreadTimelinePendingTodos("idle", events);
      expect(snapshot).toHaveProperty("staleSince", 2100);
      expect(
        threadTimelinePendingTodosSchema.parse(
          JSON.parse(JSON.stringify(snapshot)),
        ),
      ).toEqual(snapshot);
    },
  );
  it("never marks a plan updated in the turn that just ended stale, even after earlier missed turns", () => {
    const updated = openPlan();
    updated.event.scope = turnScope("turn-2");
    expect(
      extractThreadTimelinePendingTodos("idle", [
        lifecycle(1, "turn-1", "turn/started"),
        lifecycle(2, "turn-1", "turn/completed"),
        lifecycle(3, "turn-2", "turn/started"),
        updated,
        lifecycle(11, "turn-2", "turn/completed"),
      ]),
    ).not.toHaveProperty("staleSince");
  });
  it("waits for a later turn to end and ignores late completions from older turns", () => {
    expect(
      extractThreadTimelinePendingTodos("active", [
        lifecycle(1, "old", "turn/started"),
        openPlan(),
        lifecycle(11, "old", "turn/completed"),
        lifecycle(20, "later", "turn/started"),
      ]),
    ).not.toHaveProperty("staleSince");
  });
  it("keeps the first stale time through duplicates, unordered events, and later completions", () => {
    const ended = lifecycle(21, "later", "turn/completed");
    expect(
      extractThreadTimelinePendingTodos("idle", [
        lifecycle(31, "later", "turn/completed"),
        ended,
        openPlan(),
        lifecycle(20, "later", "turn/started"),
        ended,
      ]),
    ).toHaveProperty("staleSince", 2100);
  });
  it("ignores duplicate starts of the posting turn and nested provider work", () => {
    const nested = lifecycle(20, "nested", "turn/started");
    if (nested.event.type === "turn/started")
      nested.event.parentToolCallId = "parent";
    expect(
      extractThreadTimelinePendingTodos("idle", [
        lifecycle(1, "turn-1", "turn/started"),
        openPlan(),
        lifecycle(12, "turn-1", "turn/started"),
        lifecycle(13, "turn-1", "turn/completed"),
        nested,
        lifecycle(21, "nested", "turn/completed"),
      ]),
    ).not.toHaveProperty("staleSince");
  });
  it("uses a normalized thread interruption to end a later root turn", () => {
    const interrupted: ThreadEventWithMeta = {
      event: {
        type: "system/thread/interrupted",
        threadId: "thread-1",
        scope: { kind: "thread" },
        reason: "manual-stop",
      },
      meta: { id: "stop", seq: 21, createdAt: 2100 },
    };
    expect(
      extractThreadTimelinePendingTodos("idle", [
        openPlan(),
        lifecycle(20, "later", "turn/started"),
        interrupted,
      ]),
    ).toHaveProperty("staleSince", 2100);
    expect(
      extractThreadTimelinePendingTodos("idle", [
        lifecycle(1, "turn-1", "turn/started"),
        openPlan(),
        interrupted,
      ]),
    ).not.toHaveProperty("staleSince");
  });
  it("does not mark completed or explicitly cleared plans stale", () => {
    for (const steps of [
      [],
      [{ step: "Done", status: "completed" as const }],
    ]) {
      expect(
        extractThreadTimelinePendingTodos("idle", [
          planStepsEvent({ seq: 10, steps }),
          lifecycle(20, "later", "turn/started"),
          lifecycle(21, "later", "turn/completed"),
        ]),
      ).not.toHaveProperty("staleSince");
    }
  });
});
