import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimThreadSendIntake, failThreadSendIntake, getThreadSendIntake,
  sealThreadSendIntake, checkpointThreadSendIntake, listStoredEventRows,
  createQueuedThreadMessageInTransaction,
} from "@bb/db";
import {
  createStandaloneBuiltinCompactCommandInput,
  threadScope, THREAD_CONTEXT_CLEAR_OPERATION, type PromptInput, type Thread,
} from "@bb/domain";
import type { SendMessageRequest } from "@bb/server-contract";
import { createThreadSendIntakeService } from "../../../src/services/threads/thread-send-intake.js";
import { type SendIntakeAuthority, commitSendIntake } from "../../../src/services/threads/send-intake-authority.js";
import { appendClientTurnEvent, appendThreadEvent, appendPreparedClientTurnRequestedEventWithNotificationInTransaction, createClientTurnRequestId } from "../../../src/services/threads/thread-events.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "../../../src/services/threads/lifecycle-outcome.js";
import { createThreadStartup, saveThreadProvisionContext } from "../../../src/services/threads/thread-startup-store.js";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";
import { seedThreadFixture } from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";

const execution = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" } as const;
afterEach(() => vi.restoreAllMocks());

function clearInput(): PromptInput[] {
  return [{ type: "text", text: "/clear", mentions: [{ start: 0, end: 6, resource: { kind: "command", trigger: "/", name: "clear", source: "command", origin: "builtin", label: "clear", argumentHint: null } }] }];
}

async function failed(h: TestAppHarness, input: PromptInput[] = textInput("owned"), compactFirst = false) {
  const { thread, environment } = seedThreadFixture(h);
  const id = randomUUID();
  const payload: SendMessageRequest = { input, mode: "auto", clientSubmissionId: id, ...(compactFirst ? { compactFirst: true } : {}) };
  const key = `qsub_${id}`;
  const execute = vi.fn(async (_payload: SendMessageRequest, _thread: Thread, authority: SendIntakeAuthority) => {
    h.db.transaction(tx => commitSendIntake(tx, authority, { kind: "request", id: "next-native", sequence: 100 }));
    return { ok: true, delivery: "sent" } as const;
  });
  let ready = false;
  const service = createThreadSendIntakeService(h.deps, execute, () => ready);
  await service.admit(payload, thread);
  const claim = claimThreadSendIntake(h.db, { threadId: thread.id, token: randomUUID(), now: Date.now(), leaseMs: 30_000 })!;
  h.db.transaction(tx => sealThreadSendIntake(tx, claim, Date.now(), "hook"));
  ready = true;
  const stop = () => failThreadSendIntake(h.db, claim, "Effect outcome uncertain", Date.now());
  return { thread, environment, id, key, payload, claim, service, execute, stop };
}

function request(h: TestAppHarness, f: Awaited<ReturnType<typeof failed>>, input = f.payload.input, requestId?: string, identified = true) {
  return h.db.transaction(tx => appendPreparedClientTurnRequestedEventWithNotificationInTransaction(tx, { threadId: f.thread.id, environmentId: f.environment.id,
    type: "client/turn/requested", input, execution, initiator: "user", originPluginId: null, senderThreadId: null,
    requestMethod: "turn/start", source: "tell", target: { kind: "new-turn" },
    ...(identified ? { clientSubmissions: [{ id: f.id, inputGroupIndex: 0 }] } : {}),
    requestId: requestId ?? createClientTurnRequestId(),
  }));
}

describe("revisioned server-evidence intake recovery", () => {
  it("settles from an actual committed native queue row with a truthful resolved receipt", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = await failed(h); f.stop();
      try {
        const queued = h.db.transaction(tx => createQueuedThreadMessageInTransaction(tx, {
          threadId: f.thread.id, clientSubmissionId: f.id, content: f.payload.input,
          model: execution.model, reasoningLevel: execution.reasoningLevel, permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier, sendAt: null, waitingOn: { kind: "thread-busy" }, payload: { kind: "inline" }, systemNotice: null,
        }));
        const before = getThreadSendIntake(h.db, f.key)!;
        expect((await f.service.mutate(f.thread.id, { id: f.key, revision: before.revision, action: { kind: "reconcile" } })).handoff).toEqual({ kind: "queue", id: queued.id });
        await expect(f.service.wait(f.key)).resolves.toMatchObject({ delivery: "queued", queuedMessage: { id: queued.id, model: execution.model } });
        expect(f.execute).not.toHaveBeenCalled();
      } finally { f.service.stop(); }
    });
  });

  it("keeps absent proof unresolved, bounds legacy followers and preserves same-ID replay", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = await failed(h); f.stop();
      try {
        const before = getThreadSendIntake(h.db, f.key)!;
        const follower = await f.service.admit({ input: textInput("following"), mode: "auto" }, f.thread);
        await expect(f.service.wait(follower.id)).rejects.toMatchObject({ status: 409, body: { code: "intake_blocked" } });
        const unresolved = await f.service.mutate(f.thread.id, { id: f.key, revision: before.revision, action: { kind: "reconcile" } });
        expect(unresolved).toMatchObject({ state: "failed", recoveryRequired: true, effectStage: "hook", input: f.payload.input });
        expect((await f.service.admit(f.payload, f.thread)).admissionReceipt).toBe(before.admissionReceipt);
        expect(f.execute).not.toHaveBeenCalled();
        await expect(f.service.mutate(f.thread.id, { id: f.key, revision: before.revision, action: { kind: "reconcile" } })).rejects.toMatchObject({ status: 409 });
      } finally { f.service.stop(); }
    });
  });

  it("settles only from a genuine native request and releases the successor once without resending the head", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = await failed(h); f.stop();
      try {
        const follower = await f.service.admit({ input: textInput("following"), mode: "auto" }, f.thread);
        const event = request(h, f);
        const before = getThreadSendIntake(h.db, f.key)!;
        const resolved = await f.service.mutate(f.thread.id, { id: f.key, revision: before.revision, action: { kind: "reconcile" } });
        expect(resolved).toMatchObject({ state: "transferred", handoff: { kind: "request", id: event.requestId, sequence: event.sequence }, input: null });
        await expect(f.service.wait(f.key)).resolves.toMatchObject({ delivery: "sent", requested: { requestId: event.requestId, sequence: event.sequence } });
        await f.service.wait(follower.id);
        expect(f.execute).toHaveBeenCalledTimes(1);
        expect(listStoredEventRows(h.db, { threadId: f.thread.id, types: ["client/turn/requested"] })).toHaveLength(1);
        await expect(f.service.mutate(f.thread.id, { id: f.key, revision: resolved.revision, action: { kind: "reconcile" } })).rejects.toMatchObject({ status: 409 });
      } finally { f.service.stop(); }
    });
  });

  it("does not mistake compactFirst's native compact subrequest for the following original message", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = await failed(h, textInput("after compact"), true);
      try {
        const compactId = createClientTurnRequestId();
        h.db.transaction(tx => checkpointThreadSendIntake(tx, f.claim, { compactRequestId: compactId, compactCheckpoint: JSON.stringify({ kind: "request", id: compactId, sequence: 1 }) }, Date.now()));
        request(h, f, createStandaloneBuiltinCompactCommandInput(), compactId, false); f.stop();
        let current = getThreadSendIntake(h.db, f.key)!;
        const compactOnly = await f.service.mutate(f.thread.id, { id: f.key, revision: current.revision, action: { kind: "reconcile" } });
        expect(compactOnly.state).toBe("failed"); expect(f.execute).not.toHaveBeenCalled();
        const original = request(h, f); current = getThreadSendIntake(h.db, f.key)!;
        const complete = await f.service.mutate(f.thread.id, { id: f.key, revision: current.revision, action: { kind: "reconcile" } });
        expect(complete.handoff).toEqual({ kind: "request", id: original.requestId, sequence: original.sequence });
        expect(f.execute).not.toHaveBeenCalled();
      } finally { f.service.stop(); }
    });
  });

  it("does not treat a first-start intent/request without native startup custody as proof", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = await failed(h); f.stop();
      try {
        const intent = appendClientTurnEvent(h.deps, { threadId: f.thread.id, environmentId: f.environment.id,
          type: "client/turn/requested", input: f.payload.input, execution, initiator: "user", originPluginId: null, senderThreadId: null,
          requestMethod: "thread/start", source: "spawn", target: { kind: "thread-start" }, clientSubmissions: [{ id: f.id, inputGroupIndex: 0 }],
        });
        let current = getThreadSendIntake(h.db, f.key)!;
        expect((await f.service.mutate(f.thread.id, { id: f.key, revision: current.revision, action: { kind: "reconcile" } })).state).toBe("failed");
        h.db.transaction(tx => {
          expect(applyLoggedThreadLifecycleEventInTransaction({ db: tx, logger: h.deps.logger },
            { threadId: f.thread.id, event: { type: "run.preparing" } }).applied).toBe(true);
          saveThreadProvisionContext({ db: tx, threadId: f.thread.id, replace: true,
          context: createThreadStartup({ clientRequestId: intent.requestId, input: f.payload.input, execution,
            environmentIntent: { type: "reuse", environmentId: f.environment.id }, fork: null, initiator: "user", seedWithoutRun: false,
            titleProvided: false, clientSubmissions: [{ id: f.id, inputGroupIndex: 0 }],
          }),
          });
        }, { behavior: "immediate" });
        current = getThreadSendIntake(h.db, f.key)!;
        expect((await f.service.mutate(f.thread.id, { id: f.key, revision: current.revision, action: { kind: "reconcile" } })).handoff).toEqual({ kind: "startup", id: intent.requestId });
        expect(f.execute).not.toHaveBeenCalled();
      } finally { f.service.stop(); }
    });
  });

  it.each(["clear", "compact"] as const)("recovers only a committed standalone %s correlation after restart without re-execution", async kind => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = await failed(h, kind === "clear" ? clearInput() : createStandaloneBuiltinCompactCommandInput());
      try {
        const correlation = kind === "clear" ? `evt_${randomUUID()}` : createClientTurnRequestId();
        h.db.transaction(tx => checkpointThreadSendIntake(tx, f.claim, kind === "clear" ? { clearOperationId: correlation } : { compactRequestId: correlation }, Date.now()));
        f.stop(); f.service.stop();
        const execute = vi.fn(async () => ({ ok: true, delivery: "sent" } as const));
        const restarted = createThreadSendIntakeService(h.deps, execute);
        try {
          let current = getThreadSendIntake(h.db, f.key)!;
          expect((await restarted.mutate(f.thread.id, { id: f.key, revision: current.revision, action: { kind: "reconcile" } })).state).toBe("failed");
          if (kind === "clear") appendThreadEvent(h.deps, { threadId: f.thread.id, environmentId: f.environment.id,
            type: "system/operation", scope: threadScope(), data: { operation: THREAD_CONTEXT_CLEAR_OPERATION, status: "completed", operationId: correlation, message: "completed" } });
          else request(h, f, f.payload.input, correlation, false);
          if (kind === "compact") {
            const native = listStoredEventRows(h.db, { threadId: f.thread.id, types: ["client/turn/requested"] });
            expect(native).toHaveLength(1);
            expect(JSON.parse(native[0]!.data)).toMatchObject({ requestId: correlation, input: f.payload.input });
          }
          current = getThreadSendIntake(h.db, f.key)!;
          expect((await restarted.mutate(f.thread.id, { id: f.key, revision: current.revision, action: { kind: "reconcile" } })).state).toBe("transferred");
          expect(execute).not.toHaveBeenCalled();
        } finally { restarted.stop(); }
      } finally { f.service.stop(); }
    });
  });
});
