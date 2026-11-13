import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getLastStoredProviderThreadId, getThreadSendIntake, listQueuedThreadMessages, listStoredEventRows, setQueuedThreadMessageGroupBoundary } from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { turnRequestEventDataSchema } from "@bb/domain";
import { getThreadSendIntakeService } from "../../src/services/threads/thread-send-request.js";
import { sendNextQueuedMessageIfPresent } from "../../src/services/threads/queued-messages.js";
import * as commands from "../../src/services/threads/thread-commands.js";
import { EMPTY_WORKSPACE_AGENT_CONTEXT, registerHostRpcResponder, type HostRpcHandlerResult } from "../helpers/host-rpc.js";
import { seedQueuedMessage, seedThreadFixture, seedThreadIdentity, seedThreadRuntimeState, seedTurnStarted } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const execution = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" } as const;
afterEach(() => vi.restoreAllMocks());

function runtime(h: TestAppHarness, stop: () => Promise<void>, submit: () => Promise<void> = async () => {}) {
  const f = seedThreadFixture(h);
  seedThreadRuntimeState(h.deps, { threadId: f.thread.id, environmentId: f.environment.id, providerThreadId: "before-intake-clear" });
  const responder = registerHostRpcResponder(h, { hostId: f.host.id, sessionId: f.session.id,
    handle: async ({ command }): Promise<HostRpcHandlerResult> => {
      switch (command.type) {
        case "thread.stop": await stop(); return { ok: true, result: { providerCheckpointId: null } };
        case "thread.start": return { ok: true, result: { providerThreadId: "after-intake-clear" } };
        case "turn.submit": await submit(); return { ok: true, result: { trace: { spans: [] } } };
        case "host.read_workspace_agent_context": return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        default: throw new Error(`Unexpected command ${command.type}`);
      }
    },
  });
  const beforeSequence = listStoredEventRows(h.db, { threadId: f.thread.id, order: "desc", limit: 1 })[0]!.sequence;
  return { ...f, responder, beforeSequence };
}

function admit(h: TestAppHarness, threadId: string, id: string) {
  return h.app.request(`/api/v1/threads/${threadId}/send-admission`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ admissionVersion: 1, clientSubmissionId: id, input: textInput("admitted original"), mode: "auto" }) });
}

describe("intake and dedicated context boundaries", () => {
  it("hands off once to the native queue while a dedicated compact's submit remains held", async () => {
    await withTestHarness(async h => {
      const submitted = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      const f = runtime(h, async () => {}, async () => { submitted.resolve(); await release.promise; });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      vi.spyOn(h.deps.providerRegistry, "supportsManualCompaction").mockReturnValue(true);
      const compacting = h.app.request(`/api/v1/threads/${f.thread.id}/compact`, { method: "POST" });
      const id = randomUUID();
      try {
        await submitted.promise;
        expect((await admit(h, f.thread.id, id)).status).toBe(200);
        await expect(getThreadSendIntakeService(h.deps).wait(`qsub_${id}`)).resolves.toMatchObject({ delivery: "queued", queuedMessage: { id: `qsub_${id}` } });
        expect(getThreadSendIntake(h.db, `qsub_${id}`)?.state).toBe("transferred");
        expect(listQueuedThreadMessages(h.db, f.thread.id).map(row => row.id)).toEqual([`qsub_${id}`]);
        release.resolve(); expect((await compacting).status).toBe(200);
        expect(listStoredEventRows(h.db, { threadId: f.thread.id, afterSequence: f.beforeSequence, types: ["client/turn/requested"] })).toHaveLength(1);
      } finally { release.resolve(); await compacting; f.responder.unregister(); }
    });
  });

  it("recovers a real held dedicated clear collision before seal and appends once after clear", async () => {
    await withTestHarness(async h => {
      const stopping = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      const f = runtime(h, async () => { stopping.resolve(); await release.promise; });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      const clearing = h.app.request(`/api/v1/threads/${f.thread.id}/context/clear`, { method: "POST" });
      const id = randomUUID();
      try {
        await stopping.promise;
        expect((await admit(h, f.thread.id, id)).status).toBe(200);
        await vi.waitFor(() => expect(getThreadSendIntake(h.db, `qsub_${id}`)).toMatchObject({ state: "pending", sealedAt: null, claimEpoch: 1 }));
        release.resolve(); expect((await clearing).status).toBe(200);
        await getThreadSendIntakeService(h.deps).wait(`qsub_${id}`);
        const events = listStoredEventRows(h.db, { threadId: f.thread.id, afterSequence: f.beforeSequence, types: ["client/turn/requested", "system/operation"], order: "asc" });
        expect(events.filter(row => row.type === "system/operation")).toHaveLength(1);
        const requests = events.filter(row => row.type === "client/turn/requested");
        expect(requests).toHaveLength(1);
        expect(requests[0]!.sequence).toBeGreaterThan(events.find(row => row.type === "system/operation")!.sequence);
        expect(getThreadSendIntake(h.db, `qsub_${id}`)?.state).toBe("transferred");
      } finally { release.resolve(); await clearing; f.responder.unregister(); }
    });
  });

  it("allows dedicated clear and ordered native drain during pure intake preparation", async () => {
    await withTestHarness(async h => {
      const f = runtime(h, async () => {});
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>(); let builds = 0;
      vi.spyOn(commands, "buildExecutionOptions").mockImplementation(async () => {
        if (++builds === 1) { entered.resolve(); await release.promise; }
        return execution;
      });
      const id = randomUUID();
      try {
        expect((await admit(h, f.thread.id, id)).status).toBe(200); await entered.promise;
        expect((await h.app.request(`/api/v1/threads/${f.thread.id}/context/clear`, { method: "POST" })).status).toBe(200);
        expect(getLastStoredProviderThreadId(h.db, f.thread.id)).toBeNull();
        const first = seedQueuedMessage(h.deps, { threadId: f.thread.id, content: textInput("native first") });
        const second = seedQueuedMessage(h.deps, { threadId: f.thread.id, content: textInput("native second") });
        expect(setQueuedThreadMessageGroupBoundary({ db: h.db, notifier: h.hub, threadId: f.thread.id,
          expectedGroupedPrefixQueuedMessageIds: [first.id, second.id], groupBoundaryQueuedMessageId: second.id }).kind).toBe("updated");
        expect(await sendNextQueuedMessageIfPresent(h.deps, { threadId: f.thread.id })).toBe(true);
        expect(listQueuedThreadMessages(h.db, f.thread.id)).toEqual([]);
        expect(getThreadSendIntake(h.db, `qsub_${id}`)).toMatchObject({ state: "preparing", sealedAt: null });
        const native = listStoredEventRows(h.db, { threadId: f.thread.id, afterSequence: f.beforeSequence, types: ["client/turn/requested"], order: "asc" });
        expect(native).toHaveLength(1);
        const request = turnRequestEventDataSchema.parse(JSON.parse(native[0]!.data));
        expect(request.sourceQueuedMessageIds).toEqual([first.id, second.id]);
        expect(request.inputGroups).toEqual([textInput("native first"), textInput("native second")]);
        await vi.waitFor(() => expect(f.responder.requests.filter(({ command }) => command.type === "thread.start")).toHaveLength(1));
        seedThreadIdentity(h.deps, { threadId: f.thread.id, environmentId: f.environment.id,
          providerThreadId: "after-intake-clear" });
        seedTurnStarted(h.deps, { threadId: f.thread.id, environmentId: f.environment.id,
          providerThreadId: "after-intake-clear", turnId: "native-drain-turn" });
        expect(getLastStoredProviderThreadId(h.db, f.thread.id)).toBe("after-intake-clear");
        release.resolve(); await getThreadSendIntakeService(h.deps).wait(`qsub_${id}`);
        const events = listStoredEventRows(h.db, { threadId: f.thread.id, afterSequence: f.beforeSequence, types: ["client/turn/requested", "system/operation"], order: "asc" });
        expect(events.map(row => row.type)).toEqual(["system/operation", "client/turn/requested", "client/turn/requested"]);
        expect(turnRequestEventDataSchema.parse(JSON.parse(events[2]!.data)).clientSubmissions).toEqual([{ id, inputGroupIndex: 0 }]);
      } finally { release.resolve(); f.responder.unregister(); }
    });
  });
});
