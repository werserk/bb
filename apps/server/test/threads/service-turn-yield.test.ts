import {
  createQueuedThreadMessage,
  getThread,
  listIdleThreadsWithQueuedMessages,
  listQueuedThreadMessages,
} from "@bb/db";
import { expect, it } from "vitest";
import { queueParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { textInput } from "../helpers/prompt-input.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

// werserk fork: a service turn yields to ordinary queued rows. A system notice
// on a thread with no environment waits on `provisioning`, which only this
// thread's first dispatch can end. When that first dispatch is the service
// turn, yielding to the notice is a cycle and the thread stays pending forever
// (WProjects coordinator replacement, thr_un9hv8t5qv).

async function pendingPluginThread(h: TestAppHarness) {
  const { host } = seedHostSession(h.deps);
  const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
  const response = await h.app.request("/api/v1/threads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: project.id,
      origin: "plugin",
      originPluginId: "wprojects",
      pluginMetadata: { coordinator: true },
      input: [],
      title: "Project chat",
      providerId: "codex",
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      environment: {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: "/tmp/service-turn-yield" },
      },
    }),
  });
  const body = (await response.json()) as { id: string; status: string };
  expect(response.status, JSON.stringify(body)).toBe(201);
  expect(body.status).toBe("pending");
  return body.id;
}

function queueBootstrap(h: TestAppHarness, threadId: string) {
  return createQueuedThreadMessage(h.db, h.deps.hub, {
    threadId,
    content: textInput("Wait for an owner task"),
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
      reason: "coordinator-background",
      origin: { pluginId: "wprojects", senderThreadId: null },
    },
  });
}

it("starts a pending thread's service turn although a system notice waits on its provisioning", async () => {
  await withTestHarness(async (h) => {
    const threadId = await pendingPluginThread(h);
    queueBootstrap(h, threadId);
    await expect(
      queueParentSystemMessage(h.deps, {
        input: textInput("@thread:child is now a child of this thread"),
        parentThreadId: threadId,
        systemMessageKind: "child-completed",
        systemMessageSubject: null,
      }),
    ).resolves.toBe(true);
    expect(
      listQueuedThreadMessages(h.db, threadId).find(
        (row) => row.serviceTurn === null,
      )?.waitingOn,
    ).toContain("provisioning");

    expect(
      listIdleThreadsWithQueuedMessages(h.db).map((row) => row.threadId),
    ).toContain(threadId);
    await runQueuedMessageDispatch(h.deps, {
      kind: "thread-ready",
      threadId,
    });

    // The service turn is now the thread's first dispatch: it provisions the
    // thread, and the notice stays queued until that turn starts.
    expect(getThread(h.db, threadId)?.status).toBe("starting");
    expect(
      listQueuedThreadMessages(h.db, threadId).map((row) => ({
        serviceTurn: row.serviceTurn,
        waitingOn: row.waitingOn,
      })),
    ).toEqual([
      expect.objectContaining({
        serviceTurn: null,
        waitingOn: JSON.stringify({ kind: "provisioning" }),
      }),
    ]);
  });
});
