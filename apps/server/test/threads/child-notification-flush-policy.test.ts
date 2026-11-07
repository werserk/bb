import {
  getThread,
  listEvents,
  listQueuedThreadMessages,
  updateThread,
} from "@bb/db";
import {
  turnRequestEventDataSchema,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  buildChildThreadTurnStatusBatchInput,
  queueChildThreadTurnNotificationBestEffort,
} from "../../src/services/threads/child-thread-notifications.js";
import {
  flushChildThreadNotifications,
  withChildThreadNotificationClock,
} from "../helpers/child-thread-notification-clock.js";
import {
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withThreadContextClearGuard } from "../../src/services/threads/thread-context-mutation-guard.js";
import type { TestAppHarness } from "../helpers/test-app.js";

function systemRequests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((row) => row.type === "client/turn/requested")
    .map((row) => turnRequestEventDataSchema.parse(JSON.parse(row.data)))
    .filter((data) => data.initiator === "system");
}

function seedFamily(harness: TestAppHarness) {
  const { project, environment, thread: parent } = seedThreadFixture(harness);
  seedThreadRuntimeState(harness.deps, {
    threadId: parent.id,
    environmentId: environment.id,
    providerThreadId: "parent-provider",
  });
  const child = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    parentThreadId: parent.id,
    parentNotifications: "auto",
    title: "Worker",
  });
  return { parent, child, project };
}

describe("child notification flush policy", () => {
  it.each<ThreadEventTurnStatus>(["completed", "failed", "interrupted"])(
    "drops a queued %s outcome when the child switches from auto to off",
    async (turnStatus) => {
      await withChildThreadNotificationClock(async (harness) => {
        const { parent, child } = seedFamily(harness);
        expect(getThread(harness.db, child.id)?.parentNotifications).toBe(
          "auto",
        );
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: child,
          parentThreadId: parent.id,
          turnStatus,
        });
        updateThread(harness.db, harness.deps.hub, child.id, {
          parentNotifications: "off",
        });
        expect(getThread(harness.db, child.id)?.parentNotifications).toBe(
          "off",
        );
        await flushChildThreadNotifications();
        await vi.waitFor(() =>
          withThreadContextClearGuard(parent.id, async () => {}),
        );
        expect(systemRequests(harness, parent.id)).toEqual([]);
        expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      });
    },
  );

  it("delivers only unchanged auto items and metadata from a mixed batch", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { parent, child, project } = seedFamily(harness);
      const retained = (["completed", "failed"] as const).map((turnStatus) => ({
        activeWorkflowCount: 0,
        childThread: seedThread(harness.deps, {
          projectId: project.id,
          parentThreadId: parent.id,
          title: turnStatus,
        }),
        terminalOutput: null,
        turnStatus,
      }));
      for (const item of [
        { childThread: child, turnStatus: "interrupted" as const },
        ...retained,
      ]) {
        await queueChildThreadTurnNotificationBestEffort(harness.deps, {
          childThread: item.childThread,
          parentThreadId: parent.id,
          turnStatus: item.turnStatus,
        });
      }
      updateThread(harness.db, harness.deps.hub, child.id, {
        parentNotifications: "off",
      });
      await flushChildThreadNotifications();
      await vi.waitFor(() =>
        expect(systemRequests(harness, parent.id)).toHaveLength(1),
      );
      const [request] = systemRequests(harness, parent.id);
      expect(request?.input).toEqual(
        buildChildThreadTurnStatusBatchInput({ items: retained }),
      );
      expect(request?.systemMessageKind).toBe("child-outcome-batch");
      expect(request?.systemMessageSubject).toEqual({
        kind: "thread-batch",
        count: 2,
        outcomes: retained.map((item) => ({
          threadId: item.childThread.id,
          status: item.turnStatus,
        })),
      });
    });
  });
});
