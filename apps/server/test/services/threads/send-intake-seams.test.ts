import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  claimThreadSendIntake, finaliseThreadSendIntake, getThread, getThreadExecutionOverride,
  getThreadSendIntake, listStoredEventRows, listQueuedThreadMessages,
  reserveThreadSendIntake, setThreadExecutionOverride, threadSendIntakes,
} from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import { type ResolvedThreadExecutionOptions } from "@bb/domain";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";
import { seedThreadFixture, seedThreadRuntimeState } from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
import { availableModelFixture } from "../../helpers/available-models.js";
import { sendThreadMessage } from "../../../src/services/threads/thread-send.js";
import { clearThreadContext } from "../../../src/services/threads/thread-context-clear.js";
import { attemptDispatch, compactThreadContext } from "../../../src/services/threads/dispatch-attempt.js";
import { recoverThreadModelOverride } from "../../../src/services/threads/thread-execution-override.js";
import { recordQueuedMessageWait } from "../../../src/services/threads/queue-waits.js";
import type { SendIntakeAuthority } from "../../../src/services/threads/send-intake-authority.js";
import * as commands from "../../../src/services/threads/thread-commands.js";
import * as mentions from "../../../src/services/plugins/plugin-mentions.js";
import * as lifecycle from "../../../src/services/threads/thread-lifecycle.js";
import * as executionOptions from "../../../src/services/system/execution-options.js";

const execution: ResolvedThreadExecutionOptions = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" };
afterEach(() => vi.restoreAllMocks());
function authority(h: TestAppHarness, threadId: string): SendIntakeAuthority {
  const id = `qsub_${randomUUID()}`;
  reserveThreadSendIntake(h.db, { id, threadId, clientSubmissionId: id.slice(5), envelope: JSON.stringify({ input: textInput("owned"), mode: "auto" }), fingerprint: id, now: Date.now() });
  h.db.transaction(tx => finaliseThreadSendIntake(tx, { id, envelope: JSON.stringify({ input: textInput("owned"), mode: "auto" }), attachmentPaths: [], admissionReceipt: "receipt", now: Date.now() }));
  return { claim: claimThreadSendIntake(h.db, { threadId, token: randomUUID(), now: Date.now(), leaseMs: 30_000 })!, stage: "message", committed: vi.fn(), isStopped: () => false };
}
function expire(h: TestAppHarness, intake: SendIntakeAuthority) {
  h.db.update(threadSendIntakes).set({ leaseExpiresAt: Date.now() - 1 }).where(eq(threadSendIntakes.id, intake.claim.id)).run();
}
function assertNoNativeEffects(h: TestAppHarness, threadId: string, intake: SendIntakeAuthority, afterSequence = 0) {
  expect(listStoredEventRows(h.db, { threadId, afterSequence, types: ["client/turn/requested", "system/operation"], order: "asc", limit: 100 })).toEqual([]);
  expect(listQueuedThreadMessages(h.db, threadId)).toEqual([]);
  expect(getThreadSendIntake(h.db, intake.claim.id)?.currentEnvelope).not.toBeNull();
  expect(intake.committed).not.toHaveBeenCalled();
}

describe("intake transaction/effect seams", () => {
  it("rejects stale queue handoff within the actual queue transaction", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h); const intake = authority(h, thread.id); expire(h, intake);
      expect(() => recordQueuedMessageWait(h.deps, { intake, placement: "back", thread, claimed: null, sendAt: null, recheckAt: null,
        waitingOn: { kind: "thread-busy" }, message: { clientSubmissionId: intake.claim.clientSubmissionId!, input: textInput("owned"), execution,
          senderThreadId: null, origin: null, originPluginId: null, requestedBy: null, payload: { kind: "inline" }, systemNotice: null, deliveryMode: "queue" },
      })).toThrow(/claim/i);
      assertNoNativeEffects(h, thread.id, intake);
    });
  });

  it("rejects a late requested append after provider command preparation", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread, environment } = seedThreadFixture(h); const intake = authority(h, thread.id);
      seedThreadRuntimeState(h.deps, { environmentId: environment.id, providerThreadId: "provider-intake", threadId: thread.id });
      const beforeSequence = listStoredEventRows(h.db, { threadId: thread.id, order: "desc", limit: 1 })[0]!.sequence;
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      vi.spyOn(mentions, "resolvePluginMentionContextInputs").mockResolvedValue([]);
      const prepare = lifecycle.prepareReadyThreadTurnCommand;
      vi.spyOn(lifecycle, "prepareReadyThreadTurnCommand").mockImplementation(async (...args) => {
        const prepared = await prepare(...args);
        entered.resolve(); await release.promise;
        return prepared;
      });
      const sending = sendThreadMessage(h.deps, { intake, originPluginId: null, thread, environment, payload: { input: textInput("owned"), mode: "start" }, trigger: "user" });
      const rejected = expect(sending).rejects.toThrow(/claim/i);
      await entered.promise; expire(h, intake); release.resolve(); await rejected;
      assertNoNativeEffects(h, thread.id, intake, beforeSequence);
    });
  });

  it("fences first-start before lifecycle/startup custody in its outer transaction", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread, environment } = seedThreadFixture(h, { thread: { status: "pending" } }); const intake = authority(h, thread.id);
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>(); let calls = 0;
      vi.spyOn(commands, "buildExecutionOptions").mockImplementation(async () => {
        if (++calls === 2) { entered.resolve(); await release.promise; }
        return execution;
      });
      const attempt = attemptDispatch(h.deps, { intake, thread, payload: { input: textInput("owned"), mode: "auto" }, source: { kind: "inline" }, queuePayload: { kind: "inline" },
        pluginSubmission: null, systemNotice: null, origin: null, originPluginId: null, startedOnBehalfOf: null, trigger: "user",
        startContext: { environmentIntent: { type: "reuse", environmentId: environment.id }, fork: null, startedOnBehalfOf: null, titleProvided: false },
      });
      const rejected = expect(attempt).rejects.toThrow(/claim/i);
      await entered.promise; expire(h, intake); release.resolve(); await rejected;
      expect(getThread(h.db, thread.id)?.status).toBe("pending");
      assertNoNativeEffects(h, thread.id, intake);
    });
  });

  it("retains stable clear correlation but fences a late stop grant before completion", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread, environment } = seedThreadFixture(h); const intake = authority(h, thread.id);
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      vi.spyOn(lifecycle, "stopThreadForCurrentState").mockImplementation(async () => { entered.resolve(); await release.promise; });
      const clear = clearThreadContext(h.deps, { intake, thread, environment });
      const rejected = expect(clear).rejects.toThrow(/claim/i);
      await entered.promise;
      expect(getThreadSendIntake(h.db, intake.claim.id)?.clearOperationId).toMatch(/^evt_/);
      expire(h, intake); release.resolve(); await rejected;
      assertNoNativeEffects(h, thread.id, intake);
    });
  });

  it("allocates a stable compact request without sealing pure preparation and fences its late append", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h); const intake = authority(h, thread.id);
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      vi.spyOn(h.deps.providerRegistry, "supportsManualCompaction").mockReturnValue(true);
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      vi.spyOn(mentions, "resolvePluginMentionContextInputs").mockImplementation(async () => { entered.resolve(); await release.promise; return []; });
      const compact = compactThreadContext(h.deps, thread, intake);
      const rejected = expect(compact).rejects.toThrow(/claim/i);
      await entered.promise;
      expect(getThreadSendIntake(h.db, intake.claim.id)?.compactRequestId).toMatch(/^creq_/);
      expect(getThreadSendIntake(h.db, intake.claim.id)?.sealedAt).toBeNull();
      expire(h, intake); release.resolve(); await rejected;
      expect(getThreadSendIntake(h.db, intake.claim.id)?.compactCheckpoint).toBeNull();
      assertNoNativeEffects(h, thread.id, intake);
    });
  });

  it("fences model recovery after the catalog await without mutating the override", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h); const intake = authority(h, thread.id);
      setThreadExecutionOverride(h.db, { threadId: thread.id, modelOverride: "before" });
      const entered = createDeferredPromise<void>(); const release = createDeferredPromise<void>();
      vi.spyOn(executionOptions, "resolveSystemExecutionOptionsForValidation").mockImplementation(async () => {
        entered.resolve(); await release.promise;
        return { providers: [], permissionCeiling: "full", modelLoadError: null, models: [availableModelFixture({ model: "after" })], selectedOnlyModels: [] };
      });
      const recovery = recoverThreadModelOverride(h.deps, { intake, thread, model: "after", modelSource: "explicit", reasoningLevel: undefined, reasoningLevelSource: undefined });
      const rejected = expect(recovery).rejects.toThrow(/claim/i);
      await entered.promise; expire(h, intake); release.resolve(); await rejected;
      expect(getThreadExecutionOverride(h.db, thread.id)?.modelOverride).toBe("before");
      assertNoNativeEffects(h, thread.id, intake);
    });
  });
});
