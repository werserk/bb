import {
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessage,
  getQueuedThreadMessage,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
  setQueuedThreadMessageFailureReason,
} from "@bb/db";
import type { QueuedMessageWaitingOn } from "@bb/domain";
import { afterEach, expect, it, vi } from "vitest";
import * as events from "../../src/services/plugins/plugin-thread-events.js";
import { recordQueuedMessageWait } from "../../src/services/threads/queue-waits.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

afterEach(() => vi.restoreAllMocks());

function fixture(h: TestAppHarness) {
  const { host } = seedHostSession(h.deps);
  const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
  const environment = seedEnvironment(h.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(h.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "idle",
  });
  seedThreadRuntimeState(h.deps, {
    environmentId: environment.id,
    threadId: thread.id,
    providerThreadId: "queue-amplification",
  });
  const service = createQueuedThreadMessage(h.db, h.deps.hub, {
    threadId: thread.id,
    content: textInput("service"),
    model: "gpt-5",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    waitingOn: { kind: "thread-busy" },
    sendAt: null,
    payload: { kind: "inline" },
    systemNotice: null,
    serviceTurn: {
      version: 1,
      visibility: "hidden",
      reason: "helper-result",
      origin: { pluginId: "wprojects", senderThreadId: null },
    },
  });
  return { thread, service };
}

it.each([
  {
    waitingOn: { kind: "thread-busy" } satisfies QueuedMessageWaitingOn,
    sendAt: null,
    notifications: 0,
  },
  {
    waitingOn: { kind: "interaction" } satisfies QueuedMessageWaitingOn,
    sendAt: null,
    notifications: 1,
  },
  {
    waitingOn: { kind: "time" } satisfies QueuedMessageWaitingOn,
    sendAt: 9_000_000_000_000,
    notifications: 1,
  },
])(
  "publishes only a changed pre-claim wait: $waitingOn.kind",
  async ({ waitingOn, sendAt, notifications }) => {
    await withTestHarness(async (h) => {
      const { thread, service } = fixture(h);
      const claims = claimQueuedThreadMessageGroup(
        h.db,
        h.deps.hub,
        service.id,
        { kind: "explicit-send" },
      );
      expect(claims).not.toBeNull();
      const emit = vi.spyOn(events, "emitPluginMessageQueued");
      const result = recordQueuedMessageWait(h.deps, {
        thread,
        claimed: claims,
        waitingOn,
        sendAt,
        message: {
          input: textInput("service"),
          execution: {
            source: "client/turn/requested",
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "default",
          },
          senderThreadId: null,
          origin: null,
          originPluginId: null,
          requestedBy: null,
          payload: { kind: "inline" },
          systemNotice: null,
        },
      });
      expect(result?.id).toBe(service.id);
      expect(emit).toHaveBeenCalledTimes(notifications);
    });
  },
);

it("does not repeatedly claim a service blocked by an exhausted ordinary row and wakes on its deletion", async () => {
  await withTestHarness(async (h) => {
    const { thread, service } = fixture(h);
    const ordinary = seedQueuedMessage(h.deps, {
      threadId: thread.id,
      content: textInput("ordinary"),
    });
    setQueuedThreadMessageFailureReason(h.db, h.deps.hub, {
      id: ordinary.id,
      threadId: thread.id,
      failureReason: "exhausted",
      now: Date.now(),
      retryDelaysMs: [],
    });
    const before = getQueuedThreadMessage(h.db, service.id);
    expect(
      listIdleThreadsWithQueuedMessages(h.db).map((r) => r.threadId),
    ).not.toContain(thread.id);
    const emit = vi.spyOn(events, "emitPluginMessageQueued");
    for (let n = 0; n < 3; n++)
      await runQueuedMessageDispatch(h.deps, {
        kind: "idle-recovery",
        now: Date.now(),
      });
    await runQueuedMessageDispatch(h.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    expect(getQueuedThreadMessage(h.db, service.id)).toEqual(before);
    expect(emit).not.toHaveBeenCalled();
    const response = await h.app.request(
      `/api/v1/threads/${thread.id}/queued-messages/${ordinary.id}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    await vi.waitFor(() =>
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(0),
    );
  });
});

it("publishes a newly created wait even when other queued rows have the same reason", async () => {
  await withTestHarness(async (h) => {
    const { thread } = fixture(h);
    const emit = vi.spyOn(events, "emitPluginMessageQueued");
    const result = recordQueuedMessageWait(h.deps, {
      thread,
      claimed: null,
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      message: {
        input: textInput("new ordinary"),
        execution: {
          source: "client/turn/requested",
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
        },
        senderThreadId: null,
        origin: null,
        originPluginId: null,
        requestedBy: null,
        payload: { kind: "inline" },
        systemNotice: null,
      },
    });
    expect(result).not.toBeNull();
    expect(emit).toHaveBeenCalledOnce();
  });
});
