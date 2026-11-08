import { describe, expect, it } from "vitest";
import { threadScope, turnScope } from "@bb/domain";
import { createMigratedConnection } from "../../src/testing.js";
import { noopNotifier } from "../../src/notifier.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import {
  insertEvents,
  listTodoSnapshotEventRowsForThread,
  type InsertEventInput,
} from "../../src/data/events.js";
import { listPlanStalenessEventRows } from "../../src/data/plan-staleness.js";

function lifecycle(
  sequence: number,
  turnId: string,
  type: "turn/started" | "turn/completed" = "turn/started",
  parentToolCallId: string | null = null,
): Omit<InsertEventInput, "threadId"> {
  return {
    sequence,
    type,
    scope: turnScope(turnId),
    providerThreadId: "provider-root",
    parentToolCallId,
    itemId: null,
    itemKind: null,
    data: JSON.stringify(
      type === "turn/completed" ? { status: "completed" } : {},
    ),
  };
}

function setup(extra: Omit<InsertEventInput, "threadId">[]) {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { name: "test-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  insertEvents(db, noopNotifier, [
    { ...lifecycle(1, "posting"), threadId: thread.id },
    {
      sequence: 10,
      threadId: thread.id,
      type: "item/completed",
      scope: turnScope("posting"),
      providerThreadId: "provider-root",
      parentToolCallId: null,
      itemId: "plan",
      itemKind: "planSteps",
      data: JSON.stringify({
        item: {
          type: "planSteps",
          id: "plan",
          steps: [{ step: "Wait", status: "pending" }],
          status: "completed",
        },
      }),
    },
    ...extra.map((event) => ({ ...event, threadId: thread.id })),
  ]);
  const [plan] = listTodoSnapshotEventRowsForThread(db, {
    threadId: thread.id,
  });
  if (!plan) throw new Error("Missing plan fixture");
  return { db, plan };
}

describe("plan staleness evidence query", () => {
  it.each(["completed", "failed", "interrupted"])(
    "returns only the first later root start and end for a %s turn",
    (status) => {
      const { db, plan } = setup([
        lifecycle(11, "posting", "turn/completed"),
        lifecycle(20, "later"),
        {
          ...lifecycle(21, "later", "turn/completed"),
          data: JSON.stringify({ status }),
        },
        lifecycle(22, "later", "turn/completed"),
        lifecycle(30, "another"),
        lifecycle(31, "another", "turn/completed"),
      ]);
      try {
        expect(listPlanStalenessEventRows(db, plan, 20)).toEqual([]);
        expect(
          listPlanStalenessEventRows(db, plan, 31).map((row) => row.sequence),
        ).toEqual([20, 21]);
      } finally {
        db.$client.close();
      }
    },
  );

  it("excludes posting, duplicated old starts, nested turns, and unfinished turns", () => {
    const { db, plan } = setup([
      lifecycle(2, "old"),
      lifecycle(11, "posting", "turn/completed"),
      lifecycle(12, "old"),
      lifecycle(13, "old", "turn/completed"),
      lifecycle(14, "nested", "turn/started", "parent-tool"),
      lifecycle(15, "nested", "turn/completed", "parent-tool"),
      lifecycle(20, "running"),
    ]);
    try {
      expect(listPlanStalenessEventRows(db, plan, 20)).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("uses thread interruption only after a later root turn starts", () => {
    const interruption = (
      sequence: number,
    ): Omit<InsertEventInput, "threadId"> => ({
      sequence,
      type: "system/thread/interrupted",
      scope: threadScope(),
      parentToolCallId: null,
      itemId: null,
      itemKind: null,
      data: JSON.stringify({ reason: "manual-stop" }),
    });
    const { db, plan } = setup([
      interruption(11),
      lifecycle(20, "later"),
      interruption(21),
    ]);
    try {
      expect(listPlanStalenessEventRows(db, plan, 19)).toEqual([]);
      expect(
        listPlanStalenessEventRows(db, plan, 21).map((row) => row.sequence),
      ).toEqual([20, 21]);
    } finally {
      db.$client.close();
    }
  });
});
