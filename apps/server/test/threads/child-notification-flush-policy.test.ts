import {
  deleteThread,
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
import {
  sendQueuedMessage,
  sendNextQueuedMessageIfPresent,
} from "../../src/services/threads/queued-messages.js";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
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
  it.each(["reparented", "deleted", "stuck", "all-off"] as const)(
    "drops buffered outcomes when %s before flush",
    async (change) => {
      await withChildThreadNotificationClock(async (harness) => {
        const { parent, child, project } = seedFamily(harness);
        const children = [child];
        if (change === "all-off")
          children.push(
            seedThread(harness.deps, {
              projectId: project.id,
              parentThreadId: parent.id,
            }),
          );
        for (const child of children) {
          await queueChildThreadTurnNotificationBestEffort(harness.deps, {
            childThread: child,
            parentThreadId: parent.id,
            turnStatus: "completed",
          });
          if (change === "deleted") {
            deleteThread(harness.db, harness.deps.hub, child.id);
            expect(getThread(harness.db, child.id)).toBeNull();
          } else if (change === "reparented") {
            const p2 = seedThread(harness.deps, { projectId: project.id });
            updateThread(harness.db, harness.deps.hub, child.id, {
              parentThreadId: p2.id,
            });
          } else {
            updateThread(harness.db, harness.deps.hub, child.id, {
              parentNotifications: change === "stuck" ? "stuck" : "off",
            });
          }
        }
        await flushChildThreadNotifications();
        await vi.waitFor(() =>
          withThreadContextClearGuard(parent.id, async () => {}),
        );
        expect(systemRequests(harness, parent.id)).toEqual([]);
        expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      });
    },
  );

  it("keeps failed outcomes after switching to stuck", async () => {
    await withChildThreadNotificationClock(async (harness) => {
      const { parent, child } = seedFamily(harness);
      await queueChildThreadTurnNotificationBestEffort(harness.deps, {
        childThread: child,
        parentThreadId: parent.id,
        turnStatus: "failed",
      });
      updateThread(harness.db, harness.deps.hub, child.id, {
        parentNotifications: "stuck",
      });
      await flushChildThreadNotifications();
      await vi.waitFor(() =>
        expect(systemRequests(harness, parent.id)).toHaveLength(1),
      );
      expect(systemRequests(harness, parent.id)[0]?.systemMessageKind).toBe(
        "child-failed",
      );
    });
  });
  it.each([
    "off",
    "off-auto",
    "needs-attention",
    "reparented",
    "auto",
    "unrelated",
    "mixed",
  ] as const)("rechecks a queued notice at drain: %s", async (change) => {
    await withChildThreadNotificationClock(async (harness) => {
      const { parent, child, project } = seedFamily(harness);
      const children = [child];
      if (change === "mixed")
        children.push(
          seedThread(harness.deps, {
            projectId: project.id,
            parentThreadId: parent.id,
          }),
        );
      const outcomes = children.map((child) => ({
        threadId: child.id,
        status: "failed" as const,
      }));
      const input = [
        { type: "text" as const, text: "Saved child result", mentions: [] },
      ];
      await withThreadContextClearGuard(parent.id, async () => {
        await queueParentSystemMessage(harness.deps, {
          parentThreadId: parent.id,
          input,
          systemMessageKind:
            change === "needs-attention"
              ? "child-needs-attention"
              : change === "unrelated"
                ? "ownership-removed"
                : children.length > 1
                  ? "child-outcome-batch"
                  : "child-failed",
          systemMessageSubject:
            children.length > 1
              ? { kind: "thread-batch", count: children.length, outcomes }
              : {
                  kind: "thread",
                  threadId: child.id,
                  threadName: "Worker",
                  outcomes,
                },
        });
        expect(listQueuedThreadMessages(harness.db, parent.id)).toHaveLength(1);
      });
      const row = listQueuedThreadMessages(harness.db, parent.id)[0]!;
      if (change === "reparented") {
        const p2 = seedThread(harness.deps, { projectId: project.id });
        updateThread(harness.db, harness.deps.hub, child.id, {
          parentThreadId: p2.id,
        });
      } else if (change !== "auto") {
        updateThread(harness.db, harness.deps.hub, child.id, {
          parentNotifications: "off",
        });
      }
      if (change === "off-auto") {
        await sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: parent.id,
        });
      } else {
        await sendQueuedMessage(harness.deps, {
          claimPolicy: { kind: "explicit-send" },
          mode: "auto",
          queuedMessageId: row.id,
          threadId: parent.id,
        });
      }
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      if (change === "auto" || change === "unrelated") {
        expect(systemRequests(harness, parent.id)).toHaveLength(1);
        expect(systemRequests(harness, parent.id)[0]?.input).toEqual(input);
      } else {
        expect(systemRequests(harness, parent.id)).toEqual([]);
      }
    });
  });
});
