import { getThread } from "@bb/db";
import { listEvents } from "@bb/db/testing";
import {
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type ThreadParentNotifications,
} from "@bb/domain";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPeriodicSweeps } from "../../src/services/system/periodic-sweeps.js";
import { PROVIDER_RETRY_STALL_MS } from "../../src/services/threads/provider-retry-stall.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  internalAuthHeaders,
  listQueuedThreadCommands,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => {
  vi.useRealTimers();
});

const TURN_ID = "turn-retry-stall";

function seedChild(
  harness: TestAppHarness,
  value: number,
  parentNotifications: ThreadParentNotifications = "auto",
) {
  const { host, session } = seedHostSession(harness.deps, {
    id: `host-retry-stall-${value}`,
  });
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
    path: `/tmp/retry-stall-${value}`,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
    path: `/tmp/retry-stall-${value}`,
    status: "ready",
  });
  const parent = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
    title: "Parent",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId: `provider-retry-stall-parent-${value}`,
    threadId: parent.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
    parentThreadId: parent.id,
    parentNotifications,
  });
  const providerThreadId = `provider-retry-stall-${value}`;
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId,
    threadId: thread.id,
  });
  return {
    hostId: host.id,
    parentId: parent.id,
    providerThreadId,
    sessionId: session.id,
    threadId: thread.id,
    thread,
  };
}

type Fixture = ReturnType<typeof seedChild>;

async function postEvents(
  harness: TestAppHarness,
  fixture: Fixture,
  events: readonly Record<string, unknown>[],
): Promise<void> {
  const posted = await harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(harness, { hostId: fixture.hostId }),
    body: JSON.stringify({
      sessionId: fixture.sessionId,
      eventGroups: groupHostDaemonEvents(
        events.map((event) => ({
          threadId: fixture.threadId,
          event: {
            threadId: fixture.threadId,
            providerThreadId: fixture.providerThreadId,
            scope: turnScope(TURN_ID),
            ...event,
          },
        })) as unknown as Parameters<typeof groupHostDaemonEvents>[0],
      ),
    }),
  });
  expect(posted.status).toBe(200);
}

function retryError(attempt: number): Record<string, unknown> {
  return {
    type: "provider/error",
    message: "Provider error",
    detail: `Reconnecting... ${attempt}/5\nexceeded retry limit, last status: 429 Too Many Requests`,
    willRetry: true,
    errorInfo: {
      category: "stream-disconnected",
      providerCode: "responseStreamDisconnected",
      httpStatusCode: 429,
    },
  };
}

async function startTurnThatStallsOnRetry(
  harness: TestAppHarness,
  fixture: Fixture,
): Promise<number> {
  await acceptThreadSendRequest(harness.deps, {
    thread: fixture.thread,
    payload: { input: textInput("review this"), mode: "auto" },
  });
  const submit = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "turn.submit" && command.threadId === fixture.threadId,
  );
  await reportQueuedCommandSuccess(harness, submit, { trace: { spans: [] } });
  await postEvents(harness, fixture, [{ type: "turn/started" }]);
  const erroredAt = Date.now();
  await postEvents(harness, fixture, [retryError(1)]);
  expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
  return erroredAt;
}

async function sweepAt(harness: TestAppHarness, now: number): Promise<void> {
  vi.setSystemTime(now);
  await runPeriodicSweeps({
    ...harness.deps,
    pluginSchedules: harness.pluginService,
    plugins: harness.pluginService,
  });
}

function stopCommands(harness: TestAppHarness, threadId: string) {
  return listQueuedThreadCommands(harness, "thread.stop", threadId);
}

function stallErrors(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((event) => event.type === "system/error")
    .map((event) => JSON.parse(event.data))
    .filter((data) => data.code === "provider_retry_stalled");
}

function parentSystemRequests(harness: TestAppHarness, parentId: string) {
  return listEvents(harness.db, { threadId: parentId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.initiator === "system");
}

async function answerStop(harness: TestAppHarness, threadId: string) {
  const stop = await waitForQueuedCommand(
    harness,
    ({ command }) =>
      command.type === "thread.stop" && command.threadId === threadId,
  );
  await reportQueuedCommandSuccess(harness, stop, {
    providerCheckpointId: null,
  });
}

describe("provider retry stall", () => {
  it("fails a turn whose provider went silent after a retryable error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      const fixture = seedChild(harness, 1);
      const erroredAt = await startTurnThatStallsOnRetry(harness, fixture);

      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS - 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
      expect(stopCommands(harness, fixture.threadId)).toEqual([]);

      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS + 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("stopping");
      expect(stallErrors(harness, fixture.threadId)).toMatchObject([
        {
          message: expect.stringContaining(
            "retryable error (HTTP 429 stream-disconnected) and then made no progress for 8 minutes",
          ),
          detail: expect.stringContaining("429 Too Many Requests"),
        },
      ]);

      await answerStop(harness, fixture.threadId);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("error");

      await sweepAt(harness, Date.now() + PROVIDER_RETRY_STALL_MS * 2);
      expect(stallErrors(harness, fixture.threadId)).toHaveLength(1);
    });
  });

  it("fails the thread when the interrupted turn ends before the stop answer, and tells the parent once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      const fixture = seedChild(harness, 2);
      const erroredAt = await startTurnThatStallsOnRetry(harness, fixture);

      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS + 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("stopping");
      await postEvents(harness, fixture, [
        { type: "turn/completed", status: "interrupted" },
      ]);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("error");
      await answerStop(harness, fixture.threadId);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("error");

      vi.setSystemTime(Date.now() + 5_000);
      await vi.waitFor(
        () =>
          expect(parentSystemRequests(harness, fixture.parentId)).toMatchObject(
            [{ systemMessageKind: "child-failed" }],
          ),
        { timeout: 5_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const requests = parentSystemRequests(harness, fixture.parentId);
      expect(requests).toHaveLength(1);
      expect(JSON.stringify(requests[0]?.input)).toContain(
        "was stopped by bb because its provider reported a retryable error (HTTP 429 stream-disconnected) and then made no progress for 8 minutes",
      );
    });
  });

  it("leaves a retry alone while the provider keeps reporting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      const fixture = seedChild(harness, 3);
      const erroredAt = await startTurnThatStallsOnRetry(harness, fixture);

      vi.setSystemTime(erroredAt + 5 * 60_000);
      await postEvents(harness, fixture, [retryError(2)]);
      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS + 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");

      vi.setSystemTime(erroredAt + 6 * 60_000);
      await postEvents(harness, fixture, [
        { type: "item/agentMessage/delta", itemId: "msg-1", delta: "Done" },
      ]);
      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS * 4);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
      expect(stallErrors(harness, fixture.threadId)).toEqual([]);
      expect(stopCommands(harness, fixture.threadId)).toEqual([]);
    });
  });

  it("still fails a stalled retry after a message joins the turn, counting from that message", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      const fixture = seedChild(harness, 6);
      const erroredAt = await startTurnThatStallsOnRetry(harness, fixture);
      const toldAt = erroredAt + 5 * 60_000;
      vi.setSystemTime(toldAt);
      const thread = getThread(harness.db, fixture.threadId);
      if (thread === undefined || thread === null)
        throw new Error("missing thread");
      await acceptThreadSendRequest(harness.deps, {
        thread,
        payload: { input: textInput("are you there?"), mode: "auto" },
      });
      const requests = listEvents(harness.db, { threadId: fixture.threadId })
        .filter((event) => event.type === "client/turn/requested")
        .filter((event) => event.createdAt >= toldAt);
      expect(requests.length).toBeGreaterThan(0);
      await postEvents(harness, fixture, [
        {
          type: "turn/input/accepted",
          clientRequestId: JSON.parse(requests.at(-1)?.data ?? "{}").requestId,
        },
      ]);

      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS + 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
      expect(stallErrors(harness, fixture.threadId)).toEqual([]);

      await sweepAt(harness, toldAt + PROVIDER_RETRY_STALL_MS + 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("stopping");
      expect(stallErrors(harness, fixture.threadId)).toMatchObject([
        { message: expect.stringContaining("made no progress for 8 minutes") },
      ]);
    });
  });

  it("counts bookkeeping events after the error as silence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      const fixture = seedChild(harness, 4);
      const erroredAt = await startTurnThatStallsOnRetry(harness, fixture);
      vi.setSystemTime(erroredAt + 60_000);
      await postEvents(harness, fixture, [
        {
          type: "provider/unhandled",
          scope: threadScope(),
          providerId: "codex",
          rawType: "account/updated",
          rawEvent: {
            jsonrpc: "2.0",
            method: "account/updated",
            params: { authMode: "chatgpt" },
          },
        },
      ]);

      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS + 1_000);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("stopping");
      expect(stallErrors(harness, fixture.threadId)).toHaveLength(1);
    });
  });

  it("leaves a turn alone after an error the provider will not retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withTestHarness(async (harness) => {
      const fixture = seedChild(harness, 5);
      const erroredAt = await startTurnThatStallsOnRetry(harness, fixture);
      await postEvents(harness, fixture, [
        { ...retryError(5), willRetry: false },
      ]);

      await sweepAt(harness, erroredAt + PROVIDER_RETRY_STALL_MS * 2);
      expect(stallErrors(harness, fixture.threadId)).toEqual([]);
      expect(stopCommands(harness, fixture.threadId)).toEqual([]);
    });
  });
});
