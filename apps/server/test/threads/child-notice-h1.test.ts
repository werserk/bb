import { sql } from "drizzle-orm";
import {
  getLatestThreadSequence,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import { threadScope, turnScope, turnRequestEventDataSchema } from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import type { ThreadEvent } from "@bb/domain";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  seedEvent,
  seedStoredEvent,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { settleDanglingBackgroundTasks } from "../../src/services/threads/background-task-reconciliation.js";
import { reconcileChildThreadNotices } from "../../src/services/threads/child-notice-reconcile.js";
import { runPeriodicSweeps } from "../../src/services/system/periodic-sweeps.js";
import * as threadGuards from "../../src/services/threads/thread-context-mutation-guard.js";
import * as parentMessages from "../../src/services/threads/parent-system-messages.js";
import { queueChildThreadTurnNotificationBestEffort } from "../../src/services/threads/child-thread-notifications.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function setup(harness: TestAppHarness, status: "active" | "idle" = "active") {
  const {
    project,
    environment,
    session,
    thread: parent,
  } = seedThreadFixture(harness);
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: "parent-provider-thread",
  });
  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    parentNotifications: "auto",
    status,
    title: "Leaf",
  });
  return { parent, child, environment, session, project };
}
type Family = ReturnType<typeof setup>;

function notices(harness: TestAppHarness, parentId: string) {
  return listEvents(harness.db, { threadId: parentId })
    .filter((row) => row.type === "client/turn/requested")
    .flatMap((row) => {
      const parsed = turnRequestEventDataSchema.safeParse(JSON.parse(row.data));
      return parsed.success ? [parsed.data] : [];
    })
    .filter((data) => data.initiator === "system");
}
/** Notices sent plus notices still queued behind a busy parent. */
function noticeCount(harness: TestAppHarness, parentId: string): number {
  return (
    notices(harness, parentId).length +
    listQueuedThreadMessages(harness.db, parentId).filter(
      (row) => row.systemNotice !== null,
    ).length
  );
}
function noticeText(harness: TestAppHarness, parentId: string): string[] {
  return notices(harness, parentId).map((n) =>
    n.input.map((i) => (i.type === "text" ? i.text : "")).join(""),
  );
}

async function post(harness: TestAppHarness, f: Family, events: ThreadEvent[]) {
  const response = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness),
    body: JSON.stringify({
      sessionId: f.session.id,
      eventGroups: groupHostDaemonEvents(
        events.map((event) => ({ threadId: f.child.id, event })),
      ),
    }),
  });
  expect(response.status).toBe(200);
}
const PROVIDER = "provider-child-turn";
/** Advance fake time in small steps, letting deferred follow-ups run in between. */
async function tick(ms: number) {
  for (let left = ms; left > 0; left -= 500) {
    await setImmediate();
    await vi.advanceTimersByTimeAsync(Math.min(500, left));
  }
  await setImmediate();
}
function turnCompleted(f: Family, turnId: string): ThreadEvent {
  return {
    type: "turn/completed",
    threadId: f.child.id,
    providerThreadId: PROVIDER,
    scope: turnScope(turnId),
    status: "completed",
  } as ThreadEvent;
}
function turnStarted(f: Family, turnId: string): ThreadEvent {
  return {
    type: "turn/started",
    threadId: f.child.id,
    providerThreadId: PROVIDER,
    scope: turnScope(turnId),
  } as ThreadEvent;
}
function bgTask(
  f: Family,
  id: string,
  taskType: string,
  done: boolean,
): ThreadEvent {
  const item = {
    id,
    type: "backgroundTask",
    taskType,
    description: id,
    status: done ? "completed" : "pending",
    taskStatus: done ? "completed" : "running",
    skipTranscript: false,
    foreground: false,
  };
  return (
    done
      ? {
          type: "item/backgroundTask/completed",
          threadId: f.child.id,
          providerThreadId: PROVIDER,
          scope: threadScope(),
          item,
        }
      : {
          type: "item/started",
          threadId: f.child.id,
          providerThreadId: PROVIDER,
          scope: turnScope("t1"),
          item,
        }
  ) as ThreadEvent;
}
function say(
  harness: TestAppHarness,
  f: Family,
  turnId: string,
  id: string,
  text: string,
  seq: number,
) {
  seedEvent(harness.deps, {
    threadId: f.child.id,
    environmentId: f.environment.id,
    providerThreadId: PROVIDER,
    sequence: seq,
    type: "item/completed",
    scope: turnScope(turnId),
    data: { item: { type: "agentMessage", id, text } },
  });
}

describe("H1 row 1: hold while background work runs", () => {
  it("holds a completed notice while a background command runs, then sends one after the settle grace", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "STARTED the build", 2);
      await post(harness, f, [bgTask(f, "task-1", "local_bash", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      expect(noticeCount(harness, f.parent.id)).toBe(0);

      await post(harness, f, [bgTask(f, "task-1", "local_bash", true)]);
      await tick(29_000);
      expect(noticeCount(harness, f.parent.id)).toBe(0);
      await tick(5_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      const [text] = noticeText(harness, f.parent.id);
      expect(text).toContain("STARTED the build");
      expect(text).toContain(
        "background work finished without a follow-up turn",
      );
    });
  });

  it("sends only the resume turn's notice when the resume starts inside the grace", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "STARTED the build", 2);
      await post(harness, f, [bgTask(f, "task-1", "local_bash", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await post(harness, f, [bgTask(f, "task-1", "local_bash", true)]);
      await tick(2_200);
      await post(harness, f, [turnStarted(f, "t2")]);
      say(harness, f, "t2", "m2", "FINAL build result", 40);
      await post(harness, f, [turnCompleted(f, "t2")]);
      await tick(40_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      const [text] = noticeText(harness, f.parent.id);
      expect(text).toContain("FINAL build result");
      expect(text).not.toContain("follow-up turn");
    });
  });

  it("holds while a background agent runs", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "agent still waiting", 2);
      await post(harness, f, [bgTask(f, "agent-1", "local_agent", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      expect(noticeCount(harness, f.parent.id)).toBe(0);
    });
  });

  it("still reports a turn that ends with only a workflow running, with the workflow clause", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "workflow started", 2);
      await post(harness, f, [bgTask(f, "wf-1", "local_workflow", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      expect(noticeText(harness, f.parent.id)[0]).toContain(
        "1 workflow still running",
      );
    });
  });
});

describe("H1 row 3: turn-scoped, episode-aware text", () => {
  it("reports the turn's own final message, not a later sub-agent message", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "ROOT final result", 2);
      seedStoredEvent(harness.deps, {
        threadId: f.child.id,
        environmentId: f.environment.id,
        providerThreadId: PROVIDER,
        sequence: 3,
        type: "item/completed",
        scope: turnScope("t1"),
        itemId: "sub-1",
        itemKind: "agentMessage",
        parentToolCallId: "tool-1",
        data: {
          item: { type: "agentMessage", id: "sub-1", text: "SUBAGENT chatter" },
        },
      });
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      const [text] = noticeText(harness, f.parent.id);
      expect(text).toContain("ROOT final result");
      expect(text).not.toContain("SUBAGENT chatter");
    });
  });

  it("sends nothing for a silent turn after a delivered result", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "FINAL line", 2);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      await post(harness, f, [turnStarted(f, "t2")]);
      await post(harness, f, [turnCompleted(f, "t2")]);
      await tick(5_000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
    });
  });

  it("labels the held head text when the resume turn is textless", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "HEAD result before the wait", 2);
      await post(harness, f, [bgTask(f, "task-1", "local_bash", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await post(harness, f, [bgTask(f, "task-1", "local_bash", true)]);
      await tick(2_000);
      await post(harness, f, [turnStarted(f, "t2")]);
      await post(harness, f, [turnCompleted(f, "t2")]);
      await tick(5_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      const [text] = noticeText(harness, f.parent.id);
      expect(text).toContain("Earlier in this episode");
      expect(text).toContain("HEAD result before the wait");
    });
  });
});

describe("H1 row 4: head and tail truncation", () => {
  it("keeps both ends of a result over the limit and states how much was omitted", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      const long = `KEY-HEAD ${"x".repeat(6_000)} KEY-TAIL`;
      say(harness, f, "t1", "m1", long, 2);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      const [text] = noticeText(harness, f.parent.id);
      expect(text).toContain("KEY-HEAD");
      expect(text).toContain("KEY-TAIL");
      expect(text).toMatch(/\[\.\.\. \d+ characters omitted/);
      expect(text!.length).toBeLessThan(4_400);
    });
  });

  it("leaves a result under the limit untouched", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "short result", 2);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      expect(noticeText(harness, f.parent.id)[0]).not.toContain("omitted");
    });
  });
});

/** A finished child turn whose notice was lost: events exist, no notice does. */
function seedLostCompletion(
  harness: TestAppHarness,
  f: Family,
  text: string | null,
) {
  seedTurnStarted(harness.deps, {
    environmentId: f.environment.id,
    threadId: f.child.id,
    turnId: "t1",
    providerThreadId: PROVIDER,
  });
  if (text) say(harness, f, "t1", "m1", text, 2);
  seedEvent(harness.deps, {
    threadId: f.child.id,
    environmentId: f.environment.id,
    providerThreadId: PROVIDER,
    sequence: 10,
    type: "turn/completed",
    scope: turnScope("t1"),
    data: { status: "completed" },
  });
}

describe("H1 row 5: boot reconcile", () => {
  it("sends the notice a restart lost, once, even if reconcile runs twice", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness, "idle");
      vi.useFakeTimers();
      seedLostCompletion(harness, f, "LOST result");
      await reconcileChildThreadNotices(harness.deps);
      await tick(3_000);
      await vi.waitFor(() =>
        expect(notices(harness, f.parent.id)).toHaveLength(1),
      );
      expect(noticeText(harness, f.parent.id)[0]).toContain("LOST result");
      await reconcileChildThreadNotices(harness.deps);
      await tick(3_000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
    });
  });

  it("does not repeat a notice written before notices named their turn", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness, "idle");
      vi.useFakeTimers();
      seedLostCompletion(harness, f, "OLD result");
      await tick(5_000);
      seedStoredEvent(harness.deps, {
        threadId: f.parent.id,
        environmentId: f.environment.id,
        providerThreadId: "parent-provider-thread",
        sequence: 50,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          systemMessageKind: "child-completed",
          systemMessageSubject: {
            kind: "thread",
            threadId: f.child.id,
            threadName: "Leaf",
            outcomes: [{ threadId: f.child.id, status: "completed" }],
          },
        },
      });
      await reconcileChildThreadNotices(harness.deps);
      await tick(3_000);
      const requests = listEvents(harness.db, { threadId: f.parent.id }).filter(
        (row) =>
          row.type === "client/turn/requested" &&
          row.data.includes("systemMessageKind"),
      );
      expect(requests).toHaveLength(1);
      expect(listQueuedThreadMessages(harness.db, f.parent.id)).toEqual([]);
    });
  });

  it("sends nothing for an archived parent", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness, "idle");
      vi.useFakeTimers();
      seedLostCompletion(harness, f, "orphan");
      harness.db.run(
        sql`UPDATE threads SET archived_at = ${Date.now()} WHERE id = ${f.parent.id}`,
      );
      await reconcileChildThreadNotices(harness.deps);
      await tick(3_000);
      expect(noticeCount(harness, f.parent.id)).toBe(0);
    });
  });
});

describe("H1 review regressions", () => {
  it("F1 releases exactly once after daemon restart settles dangling work", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "HELD final result", 2);
      await post(harness, f, [bgTask(f, "dangling", "local_bash", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3000);
      await reconcileChildThreadNotices(harness.deps);
      expect(noticeCount(harness, f.parent.id)).toBe(0);
      settleDanglingBackgroundTasks(harness.deps, { hostId: f.session.hostId });
      await tick(35000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
      await reconcileChildThreadNotices(harness.deps);
      await tick(3000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
    });
  });
  it("F1 bounds a hold even when background work never settles", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "HELD result", 2);
      await post(harness, f, [bgTask(f, "stuck", "local_bash", false)]);
      await post(harness, f, [turnCompleted(f, "t1")]);
      await tick(3000);
      harness.db.run(
        sql`UPDATE events SET created_at = ${Date.now() - 3 * 60 * 60 * 1000} WHERE thread_id = ${f.child.id} AND type = 'turn/completed'`,
      );
      await reconcileChildThreadNotices(harness.deps);
      await tick(3000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
      expect(noticeText(harness, f.parent.id)[0]).toContain(
        "background work still reported running after 3 h",
      );
    });
  });
  it("F4 delivers all results in a nine-round parent-driven loop", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      for (let n = 1; n <= 9; n++) {
        const turnId = `loop-${n}`;
        await post(harness, f, [turnStarted(f, turnId)]);
        say(
          harness,
          f,
          turnId,
          `m-${n}`,
          `result ${n}`,
          getLatestThreadSequence(harness.db, { threadId: f.child.id }) + 1,
        );
        await post(harness, f, [turnCompleted(f, turnId)]);
        await tick(3000);
      }
      expect(noticeCount(harness, f.parent.id)).toBe(9);
      const text = [
        ...noticeText(harness, f.parent.id),
        ...listQueuedThreadMessages(harness.db, f.parent.id).map(
          (r) => r.content,
        ),
      ].join("\n");
      expect(text).toContain("result 9");
      expect(text).not.toContain("Update cap reached");
    });
  });
  it("F5 reports a textless completion after a failed notice", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      await post(harness, f, [
        { ...turnCompleted(f, "t1"), status: "failed" } as ThreadEvent,
      ]);
      await tick(3000);
      await post(harness, f, [turnStarted(f, "t2"), turnCompleted(f, "t2")]);
      await tick(3000);
      expect(noticeCount(harness, f.parent.id)).toBe(2);
    });
  });
});

describe("H1 re-review regressions", () => {
  it.each(["failed", "interrupted"] as const)(
    "N1 a turnless %s notice does not consume a held result",
    async (status) => {
      await withTestHarness(async (harness) => {
        const f = setup(harness);
        vi.useFakeTimers();
        seedTurnStarted(harness.deps, {
          environmentId: f.environment.id,
          threadId: f.child.id,
          turnId: "t1",
          providerThreadId: PROVIDER,
        });
        say(harness, f, "t1", "m1", "N1 held result", 2);
        await post(harness, f, [
          bgTask(f, "n1-bg", "local_bash", false),
          turnCompleted(f, "t1"),
        ]);
        await tick(3000);
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: f.child,
          parentThreadId: f.parent.id,
          turnStatus: status,
        });
        await tick(3000);
        await vi.waitFor(() =>
          expect(noticeCount(harness, f.parent.id)).toBe(1),
        );
        settleDanglingBackgroundTasks(harness.deps, {
          hostId: f.session.hostId,
        });
        await tick(35000);
        await vi.waitFor(() =>
          expect(noticeCount(harness, f.parent.id)).toBe(2),
        );
        expect(
          [
            ...noticeText(harness, f.parent.id),
            ...listQueuedThreadMessages(harness.db, f.parent.id).map(
              (r) => r.content,
            ),
          ].join("\n"),
        ).toContain("N1 held result");
      });
    },
  );

  it("N2 a sweep during an in-flight flush sends the result only once", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness, "idle");
      vi.useFakeTimers();
      seedLostCompletion(harness, f, "N2 single result");
      let entered = 0;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = threadGuards.withThreadSendGuard;
      vi.spyOn(threadGuards, "withThreadSendGuard").mockImplementation(
        async (id, work) => {
          if (id === f.parent.id) {
            entered++;
            await blocked;
          }
          return original(id, work);
        },
      );
      try {
        await reconcileChildThreadNotices(harness.deps);
        await tick(3000);
        await vi.waitFor(() => expect(entered).toBeGreaterThan(0));
        expect(noticeCount(harness, f.parent.id)).toBe(0);
        await reconcileChildThreadNotices(harness.deps);
        await tick(3000);
        await reconcileChildThreadNotices(harness.deps);
        await tick(3000);
      } finally {
        release();
      }
      await tick(3000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
      await reconcileChildThreadNotices(harness.deps);
      await tick(3000);
      expect(noticeCount(harness, f.parent.id)).toBe(1);
    });
  });

  it("N3 holds a still-running 110-minute gate without an interim notice", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness);
      vi.useFakeTimers();
      const send = vi.spyOn(parentMessages, "queueParentSystemMessage");
      seedTurnStarted(harness.deps, {
        environmentId: f.environment.id,
        threadId: f.child.id,
        turnId: "t1",
        providerThreadId: PROVIDER,
      });
      say(harness, f, "t1", "m1", "N3 interim text", 2);
      await post(harness, f, [
        bgTask(f, "n3-bg", "local_bash", false),
        turnCompleted(f, "t1"),
      ]);
      harness.db.run(
        sql`UPDATE events SET created_at = ${Date.now() - 110 * 60 * 1000} WHERE thread_id = ${f.child.id} AND type = 'turn/completed'`,
      );
      await reconcileChildThreadNotices(harness.deps);
      await tick(3000);
      expect(send).not.toHaveBeenCalled();
      expect(noticeCount(harness, f.parent.id)).toBe(0);
    });
  });

  it("N4 the registered periodic sweep releases an otherwise lost notice", async () => {
    await withTestHarness(async (harness) => {
      const f = setup(harness, "idle");
      vi.useFakeTimers();
      seedLostCompletion(harness, f, "N4 periodic recovery");
      const sweep = runPeriodicSweeps({
        ...harness.deps,
        pluginSchedules: harness.pluginService,
        plugins: harness.pluginService,
      });
      await tick(3000);
      await sweep;
      await tick(3000);
      await vi.waitFor(() => expect(noticeCount(harness, f.parent.id)).toBe(1));
      expect(noticeText(harness, f.parent.id)[0]).toContain(
        "N4 periodic recovery",
      );
    });
  });
});
