import {
  deleteThread,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  updateThread,
  updateQueuedThreadMessage,
} from "@bb/db";
import {
  turnRequestEventDataSchema,
  turnScope,
  type ThreadEventTurnStatus,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import {
  type ChildThreadTurnNotificationBatchItem,
  buildChildThreadTurnStatusBatchInput,
  queueChildThreadTurnNotificationBestEffort,
} from "../../src/services/threads/child-thread-notifications.js";
import {
  flushChildThreadNotifications,
  withChildThreadNotificationClock,
} from "../helpers/child-thread-notification-clock.js";
import {
  seedEvent,
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
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
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
      const debug = vi.spyOn(harness.deps.logger, "debug");
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
      if (change === "auto")
        expect(debug).toHaveBeenCalledWith(
          expect.objectContaining({
            reason: "missing-render-snapshots",
            dropped: false,
          }),
          "Queued child notice uses legacy policy",
        );
      if (change === "needs-attention")
        expect(debug).not.toHaveBeenCalledWith(
          expect.objectContaining({ reason: "missing-render-snapshots" }),
          expect.any(String),
        );
      debug.mockRestore();
      if (change === "auto" || change === "unrelated") {
        expect(systemRequests(harness, parent.id)).toHaveLength(1);
        expect(systemRequests(harness, parent.id)[0]?.input).toEqual(input);
      } else {
        expect(systemRequests(harness, parent.id)).toEqual([]);
      }
    });
  });

  it.each([
    "off",
    "reparented",
    "deleted",
    "stuck",
    "all-off",
    "auto",
    "two-survivors",
    "long-output",
    "edited-content",
    "requeue",
    "requeue-all",
    "failure-context",
    "interruption",
  ] as const)("re-renders queued snapshots after %s", async (change) => {
    await withChildThreadNotificationClock(async (harness) => {
      const { parent, child, project } = seedFamily(harness);
      const sibling = seedThread(harness.deps, {
        projectId: project.id,
        parentThreadId: parent.id,
        title: "Dropped child",
      });
      const status =
        change === "failure-context"
          ? "failed"
          : change === "interruption"
            ? "interrupted"
            : "completed";
      const output =
        change === "long-output" ? `  ${"x".repeat(6000)}  ` : "Original reply";
      const capturedOutput = output.trim();
      const retained: ChildThreadTurnNotificationBatchItem[] = [
        {
          childThread: child,
          turnStatus: status,
          terminalOutput: status === "completed" ? capturedOutput : null,
          activeWorkflowCount: 0,
          ...(change === "failure-context"
            ? {
                failureContext:
                  "failed during workspace setup before a turn began",
              }
            : {}),
          ...(change === "interruption"
            ? {
                interruption: {
                  reason: "host-daemon-restarted" as const,
                  cause: "host-connection-lost" as const,
                },
              }
            : {}),
        },
      ];
      if (change === "two-survivors")
        retained.push({
          ...retained[0]!,
          childThread: seedThread(harness.deps, {
            projectId: project.id,
            parentThreadId: parent.id,
            title: "Other survivor",
          }),
          terminalOutput: null,
        });
      seedEvent(harness.deps, {
        threadId: child.id,
        providerThreadId: "child-provider",
        sequence: 1,
        type: "item/completed",
        scope: turnScope("old-turn"),
        data: {
          item: {
            type: "agentMessage",
            id: "old-reply",
            text: output,
          },
        },
      });
      const dropped: ChildThreadTurnNotificationBatchItem = {
        childThread: sibling,
        turnStatus: "completed" as const,
        terminalOutput: null,
        activeWorkflowCount: 0,
      };
      await withThreadContextClearGuard(parent.id, async () => {
        for (const item of [...retained, dropped])
          await queueChildThreadTurnNotificationBestEffort(harness.deps, {
            childThread: item.childThread,
            parentThreadId: parent.id,
            turnStatus: item.turnStatus,
            ...("failureContext" in item
              ? { failureContext: item.failureContext }
              : {}),
            ...("interruption" in item
              ? { interruption: item.interruption }
              : {}),
          });
        await flushChildThreadNotifications();
        await vi.waitFor(() =>
          expect(listQueuedThreadMessages(harness.db, parent.id)).toHaveLength(
            1,
          ),
        );
      });
      const row = listQueuedThreadMessages(harness.db, parent.id)[0]!;
      const edited = [
        {
          type: "text" as const,
          text: "  Edited notice\n\nUnicode: ё 🚀\n ",
          mentions: [],
        },
      ];
      if (change === "edited-content") {
        expect(
          updateQueuedThreadMessage(harness.db, harness.deps.hub, {
            id: row.id,
            threadId: parent.id,
            expectedUpdatedAt: row.updatedAt,
            content: edited,
          }).kind,
        ).toBe("updated");
      }
      seedEvent(harness.deps, {
        threadId: child.id,
        providerThreadId: "child-provider",
        sequence: 2,
        type: "item/completed",
        scope: turnScope("new-turn"),
        data: {
          item: {
            type: "agentMessage",
            id: "new-reply",
            text: "Later reply must not replace the snapshot",
          },
        },
      });
      updateThread(harness.db, harness.deps.hub, child.id, {
        title: "Renamed after queue",
      });
      if (change === "reparented") {
        const p2 = seedThread(harness.deps, { projectId: project.id });
        updateThread(harness.db, harness.deps.hub, sibling.id, {
          parentThreadId: p2.id,
        });
      } else if (change === "deleted")
        deleteThread(harness.db, harness.deps.hub, sibling.id);
      else if (
        change !== "auto" &&
        change !== "edited-content" &&
        change !== "requeue-all"
      )
        updateThread(harness.db, harness.deps.hub, sibling.id, {
          parentNotifications: change === "stuck" ? "stuck" : "off",
        });
      if (change === "all-off")
        updateThread(harness.db, harness.deps.hub, child.id, {
          parentNotifications: "off",
        });
      if (change === "requeue" || change === "requeue-all")
        applyLoggedThreadLifecycleEvent(harness.deps, {
          threadId: parent.id,
          event: { type: "run.started" },
        });
      if (change === "two-survivors")
        await sendNextQueuedMessageIfPresent(harness.deps, {
          threadId: parent.id,
        });
      else
        await sendQueuedMessage(harness.deps, {
          claimPolicy: { kind: "explicit-send" },
          mode: "auto",
          queuedMessageId: row.id,
          threadId: parent.id,
        });
      if (change === "requeue" || change === "requeue-all") {
        expect(systemRequests(harness, parent.id)).toEqual([]);
        const [requeued] = listQueuedThreadMessages(harness.db, parent.id);
        expect(requeued!.id).not.toBe(row.id);
        expect(JSON.parse(requeued!.waitingOn!)).toEqual({
          kind: "turn-starting",
        });
        expect(
          JSON.parse(requeued!.systemNotice!).childOutcomeSnapshots,
        ).toHaveLength(change === "requeue-all" ? 2 : 1);
        expect(JSON.parse(requeued!.content)).toEqual(
          buildChildThreadTurnStatusBatchInput({
            items: change === "requeue-all" ? [...retained, dropped] : retained,
          }),
        );
        updateThread(harness.db, harness.deps.hub, child.id, {
          parentNotifications: "off",
        });
        updateThread(harness.db, harness.deps.hub, sibling.id, {
          parentNotifications: "off",
        });
        applyLoggedThreadLifecycleEvent(harness.deps, {
          threadId: parent.id,
          event: { type: "run.succeeded" },
        });
        await sendQueuedMessage(harness.deps, {
          claimPolicy: { kind: "explicit-send" },
          mode: "auto",
          queuedMessageId: requeued!.id,
          threadId: parent.id,
        });
      }
      expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
      const requests = systemRequests(harness, parent.id);
      if (
        change === "all-off" ||
        change === "requeue" ||
        change === "requeue-all"
      )
        expect(requests).toEqual([]);
      else {
        const items =
          change === "auto" || change === "edited-content"
            ? [...retained, dropped]
            : retained;
        expect(requests).toHaveLength(1);
        expect(requests[0]?.input).toEqual(
          change === "edited-content"
            ? edited
            : buildChildThreadTurnStatusBatchInput({ items }),
        );
        if (change === "edited-content")
          expect(JSON.stringify(requests[0]?.input)).toBe(
            JSON.stringify(edited),
          );
        expect(requests[0]?.systemMessageKind).toBe(
          items.length > 1
            ? "child-outcome-batch"
            : status === "completed"
              ? "child-completed"
              : status === "failed"
                ? "child-failed"
                : "child-interrupted",
        );
        expect(requests[0]?.systemMessageSubject).toMatchObject({
          kind: items.length > 1 ? "thread-batch" : "thread",
          ...(items.length > 1
            ? { count: items.length }
            : { threadId: child.id, threadName: "Worker" }),
          outcomes: items.map((item) => ({
            threadId: item.childThread.id,
            status: item.turnStatus,
            ...(item.interruption ? { interruption: item.interruption } : {}),
          })),
        });
      }
      const stored = JSON.parse(row.systemNotice!);
      expect(stored.childOutcomeSnapshots).toHaveLength(retained.length + 1);
      expect(stored.childOutcomeSnapshots[0]).toMatchObject({
        ...retained[0]!,
        childThread: {
          id: child.id,
          projectId: child.projectId,
          title: child.title,
        },
      });
      expect(
        Object.keys(stored.childOutcomeSnapshots[0].childThread).sort(),
      ).toEqual(["id", "projectId", "title"]);
    });
  });

  it.each(["null-subject", "no-outcomes"] as const)(
    "logs a consumed legacy %s notice",
    async (legacy) => {
      await withChildThreadNotificationClock(async (harness) => {
        const { parent } = seedFamily(harness);
        await withThreadContextClearGuard(parent.id, async () => {
          await queueParentSystemMessage(harness.deps, {
            parentThreadId: parent.id,
            input: [{ type: "text", text: "Legacy batch", mentions: [] }],
            systemMessageKind: "child-outcome-batch",
            systemMessageSubject:
              legacy === "null-subject"
                ? null
                : { kind: "thread-batch", count: 2 },
          });
        });
        const row = listQueuedThreadMessages(harness.db, parent.id)[0]!;
        const debug = vi.spyOn(harness.deps.logger, "debug");
        try {
          await sendQueuedMessage(harness.deps, {
            claimPolicy: { kind: "explicit-send" },
            mode: "auto",
            queuedMessageId: row.id,
            threadId: parent.id,
          });
          expect(systemRequests(harness, parent.id)).toEqual([]);
          expect(listQueuedThreadMessages(harness.db, parent.id)).toEqual([]);
          expect(debug).toHaveBeenCalledWith(
            expect.objectContaining({
              parentThreadId: parent.id,
              systemMessageKind: "child-outcome-batch",
              reason: "missing-render-snapshots",
              dropped: true,
            }),
            "Queued child notice uses legacy policy",
          );
        } finally {
          debug.mockRestore();
        }
      });
    },
  );
});
