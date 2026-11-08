import { listEvents, listQueuedThreadMessages } from "@bb/db";
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
import { internalAuthHeaders } from "../helpers/commands.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.useRealTimers());

function setup(harness: TestAppHarness) {
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
    status: "active",
    title: "Leaf",
  });
  return { parent, child, environment, session, project };
}
type Family = ReturnType<typeof setup>;

function notices(harness: TestAppHarness, parentId: string) {
  return listEvents(harness.db, { threadId: parentId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
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
      expect(noticeCount(harness, f.parent.id)).toBe(1);
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
