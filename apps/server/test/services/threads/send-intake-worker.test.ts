import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import {
  createProject, createThread, upsertHost, noopNotifier, reserveThreadSendIntake,
  finaliseThreadSendIntake, claimThreadSendIntake, getThreadSendIntake,
  mutateThreadSendIntake, rejectThreadSendIntake, type ThreadSendIntakeClaim,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import { createSendIntakeWorker } from "../../../src/services/threads/send-intake-worker.js";
import { assertSendIntake, commitSendIntake, sealSendIntake, type SendIntakeAuthority } from "../../../src/services/threads/send-intake-authority.js";
import { ApiError } from "../../../src/errors.js";
import { createClientTurnRequestId } from "../../../src/services/threads/thread-events.js";
import { acquireThreadSendGuard, ThreadContextClearInProgressError, withThreadContextClearGuard } from "../../../src/services/threads/thread-context-mutation-guard.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  vi.useRealTimers();
});
function fixture(execute: Parameters<typeof createSendIntakeWorker>[0]["execute"], prepare?: Parameters<typeof createSendIntakeWorker>[0]["prepare"], isReady = () => true) {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const db = createMigratedConnection();
  cleanups.push(() => db.$client.close());
  const host = upsertHost(db, noopNotifier, { name: "worker-host" });
  const { project } = createProject(db, noopNotifier, { name: "worker-project", source: { type: "local_path", hostId: host.id, path: "/worker" } });
  const thread = createThread(db, noopNotifier, { projectId: project.id, providerId: "codex", status: "error" });
  const worker = createSendIntakeWorker({ db, isReady, execute, prepare: prepare ?? (async () => {}), notify: vi.fn(), report: vi.fn() });
  cleanups.push(worker.stop);
  const add = (id: string, threadId = thread.id, staging = false) => {
    reserveThreadSendIntake(db, { id, threadId, clientSubmissionId: null, envelope: "{}", fingerprint: id, now: Date.now() });
    if (!staging) db.transaction(tx => finaliseThreadSendIntake(tx, { id, envelope: "{}", attachmentPaths: [], admissionReceipt: null, now: Date.now() }));
  };
  return { db, thread, project, worker, add };
}
const sent = { ok: true, delivery: "sent" } as const;

describe("send intake worker", () => {
  it("does not claim or schedule recovery until actual startup readiness", async () => {
    let ready = false;
    const execute = vi.fn(async (row: ThreadSendIntakeClaim, auth: SendIntakeAuthority) => {
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id })); return sent;
    });
    const f = fixture(execute, undefined, () => ready);
    f.add("early"); f.worker.recover(); f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(execute).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
    expect(getThreadSendIntake(f.db, "early")).toMatchObject({ state: "pending", claimEpoch: 0 });
    ready = true; f.worker.recover(); await vi.advanceTimersByTimeAsync(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(getThreadSendIntake(f.db, "early")?.state).toBe("transferred");
  });

  it("releases the intake lane at custody while legacy waiters await the original inline result", async () => {
    const held = createDeferredPromise<void>();
    const f = fixture(async (row, auth) => {
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "request", id: row.id, sequence: 1 }));
      if (row.id === "head") await held.promise;
      return sent;
    });
    f.add("head"); f.add("next");
    let settled = false;
    const origin = f.worker.wait("head").then(result => { settled = true; return result; });
    f.worker.wake(f.thread.id);
    await expect(f.worker.wait("next")).resolves.toEqual(sent);
    expect(getThreadSendIntake(f.db, "head")?.state).toBe("transferred");
    expect(settled).toBe(false);
    const replay = f.worker.wait("head");
    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toBe(false);
    expect(getThreadSendIntake(f.db, "next")?.state).toBe("transferred");
    held.resolve();
    await expect(origin).resolves.toEqual(sent);
    await expect(replay).resolves.toEqual(sent);
  });

  it("stops legacy inline waiters after lane release and fences their late receipt across restart", async () => {
    const committed = createDeferredPromise<void>();
    const held = createDeferredPromise<void>();
    const finished = createDeferredPromise<void>();
    let stoppedAfterRelease = false;
    const f = fixture(async (row, auth) => {
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "request", id: row.id, sequence: 1 }));
      committed.resolve();
      await held.promise;
      stoppedAfterRelease = auth.isStopped();
      finished.resolve();
      return { ...sent, requested: { requestId: "creq_late", sequence: 99 } };
    });
    f.add("released");
    const origin = expect(f.worker.wait("released")).rejects.toThrow(/stopped.*custody retained/i);
    f.worker.wake(f.thread.id);
    await committed.promise;
    const before = getThreadSendIntake(f.db, "released")!;
    expect(before.state).toBe("transferred");
    f.worker.stop(); await origin;
    const execute = vi.fn(async () => sent);
    const restarted = createSendIntakeWorker({ db: f.db, isReady: () => true, execute,
      prepare: async () => {}, notify: vi.fn(), report: vi.fn() });
    cleanups.push(restarted.stop);
    restarted.recover();
    await expect(restarted.wait("released")).resolves.toEqual(sent);
    held.resolve(); await finished.promise;
    await expect(restarted.wait("released")).resolves.toEqual(sent);
    expect(stoppedAfterRelease).toBe(true);
    expect(getThreadSendIntake(f.db, "released")).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
    await expect(f.worker.wait("released")).rejects.toThrow(/stopped/i);
  });

  it("rejects a proven pre-effect 4xx terminally, replays its original error and releases the next row", async () => {
    const f = fixture(async (row, auth) => {
      if (row.id === "bad") throw new ApiError(422, "invalid_attachment", "Original rejection", { details: { path: "missing.bin" } });
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id }));
      return sent;
    });
    f.add("bad"); f.add("good");
    const rejected = expect(f.worker.wait("bad")).rejects.toMatchObject({ status: 422, body: { code: "invalid_attachment", details: { path: "missing.bin" } } });
    f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(3); await rejected;
    expect(getThreadSendIntake(f.db, "bad")).toMatchObject({ state: "rejected", sealedAt: null, currentEnvelope: null });
    expect(getThreadSendIntake(f.db, "good")?.state).toBe("transferred");
    await expect(f.worker.wait("bad")).rejects.toMatchObject({ status: 422, message: "Original rejection" });
  });

  it("keeps sealed uncertainty and bounds both existing and new legacy waiters behind it", async () => {
    const held = createDeferredPromise<void>();
    const f = fixture(async (_row, auth) => { sealSendIntake(f.db, auth, "hook"); await held.promise; throw new ApiError(409, "hook_error", "Hook result uncertain"); });
    f.add("head"); f.add("next");
    const waiting = expect(f.worker.wait("next")).rejects.toMatchObject({ status: 409, body: { code: "intake_blocked", details: { custodyRetained: true, blockerId: "head" } } });
    const originalError = { status: 409, body: { code: "hook_error", message: "Hook result uncertain",
      details: { custodyRetained: true, recoveryRequired: true, intakeId: "head" } } };
    const originating = expect(f.worker.wait("head")).rejects.toMatchObject(originalError);
    f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(1);
    held.resolve(); await vi.advanceTimersByTimeAsync(1); await waiting; await originating;
    expect(getThreadSendIntake(f.db, "head")?.state).toBe("failed");
    await expect(f.worker.wait("head")).rejects.toMatchObject(originalError);
    expect(getThreadSendIntake(f.db, "head")).toMatchObject({ state: "failed", sealedAt: expect.any(Number), currentEnvelope: expect.any(String) });
    expect(getThreadSendIntake(f.db, "next")?.state).toBe("pending");
    await expect(f.worker.wait("next")).rejects.toMatchObject({ body: { code: "intake_blocked" } });
  });

  it("keeps healthy legacy preparation and its follower pending beyond 30s, then returns each original receipt once", async () => {
    const held = createDeferredPromise<void>();
    const executed: string[] = [];
    const receipts = new Map([
      ["held", { ...sent, requested: { requestId: createClientTurnRequestId(), sequence: 1 } }],
      ["following", { ...sent, requested: { requestId: createClientTurnRequestId(), sequence: 2 } }],
    ]);
    const f = fixture(async (row, auth) => {
      executed.push(row.id);
      if (row.id === "held") await held.promise;
      const receipt = receipts.get(row.id);
      if (!receipt) throw new Error("Unexpected intake identity");
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "request", id: receipt.requested.requestId, sequence: receipt.requested.sequence }, receipt));
      return receipt;
    });
    f.add("held"); f.add("following");
    const settled: string[] = [];
    const observe = (id: string) => f.worker.wait(id).then(
      receipt => { settled.push(id); return receipt; },
      error => { settled.push(id); throw error; },
    );
    const results = Promise.allSettled([observe("held"), observe("following")]);
    f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(settled).toEqual([]);
    expect(executed).toEqual(["held"]);
    expect(getThreadSendIntake(f.db, "held")).toMatchObject({ state: "preparing", currentEnvelope: "{}", claimEpoch: 1 });
    expect(getThreadSendIntake(f.db, "following")).toMatchObject({ state: "pending", currentEnvelope: "{}", claimEpoch: 0 });
    held.resolve();
    expect(await results).toEqual([
      { status: "fulfilled", value: receipts.get("held") },
      { status: "fulfilled", value: receipts.get("following") },
    ]);
    expect(settled).toEqual(["held", "following"]);
    expect(executed).toEqual(["held", "following"]);
    await expect(f.worker.wait("held")).resolves.toEqual(receipts.get("held"));
    await expect(f.worker.wait("following")).resolves.toEqual(receipts.get("following"));
    expect(executed).toEqual(["held", "following"]);
  });

  it("retains a timed-out sealed head and fences its late continuation while followers stay blocked", async () => {
    const held = createDeferredPromise<void>(); const executed: string[] = [];
    const f = fixture(async (row, auth) => {
      executed.push(row.id); sealSendIntake(f.db, auth, "mention"); await held.promise;
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id }));
      return sent;
    });
    f.add("timed-out"); f.add("following"); f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(300_001);
    expect(getThreadSendIntake(f.db, "timed-out")).toMatchObject({ state: "failed", lastError: expect.stringContaining("timed out"), currentEnvelope: expect.stringContaining("mention") });
    await expect(f.worker.wait("following")).rejects.toMatchObject({ status: 409, body: { code: "intake_blocked" } });
    held.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(executed).toEqual(["timed-out"]);
    expect(getThreadSendIntake(f.db, "timed-out")?.state).toBe("failed");
    expect(getThreadSendIntake(f.db, "following")?.state).toBe("pending");
  });

  it("waits pre-seal for a held clear guard, then enters exactly once on its release event", async () => {
    let deliveries = 0;
    const f = fixture(async (row, auth) => {
      const release = acquireThreadSendGuard(f.thread.id);
      try { deliveries++; f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id })); return sent; }
      finally { release(); }
    });
    const held = createDeferredPromise<void>();
    const clear = withThreadContextClearGuard(f.thread.id, () => held.promise);
    try {
      f.add("send"); f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(1);
      expect(getThreadSendIntake(f.db, "send")).toMatchObject({ state: "pending", sealedAt: null });
      expect(deliveries).toBe(0);
      f.add("following"); f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(1);
      expect(getThreadSendIntake(f.db, "send")?.claimEpoch).toBe(1);
      held.resolve(); await clear; await vi.advanceTimersByTimeAsync(2);
      expect(deliveries).toBe(2);
      expect(getThreadSendIntake(f.db, "send")?.state).toBe("transferred");
    } finally { held.resolve(); await clear; }
  });

  it("bounds automatic guard collision attempts and keeps exhaustion available for pre-seal recovery", async () => {
    let attempts = 0;
    const f = fixture(async () => { attempts++; throw new ThreadContextClearInProgressError(); });
    f.add("collision"); f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(10);
    expect(attempts).toBe(4);
    expect(getThreadSendIntake(f.db, "collision")).toMatchObject({ state: "failed", sealedAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases only after actual outer commit, independently of the old HTTP continuation", async () => {
    const tail = createDeferredPromise<void>();
    const seen: string[] = [];
    let authority: SendIntakeAuthority | undefined;
    const f = fixture(async (row, auth) => {
      seen.push(row.id);
      if (row.id === "a") { authority = auth; await tail.promise; }
      else f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id }));
      return sent;
    });
    f.add("a"); f.add("b"); f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(["a"]);
    expect(() => f.db.transaction(tx => {
      commitSendIntake(tx, authority, { kind: "queue", id: "a" });
      throw new Error("rollback");
    })).toThrow("rollback");
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(["a"]);
    expect(getThreadSendIntake(f.db, "a")?.state).toBe("preparing");
    f.db.transaction(tx => commitSendIntake(tx, authority, { kind: "queue", id: "a" }));
    let settled = false;
    const response = f.worker.wait("a").then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(["a", "b"]);
    expect(getThreadSendIntake(f.db, "a")?.state).toBe("transferred");
    expect(settled).toBe(false);
    await expect(f.worker.wait("b")).resolves.toEqual(sent);
    tail.resolve();
    await expect(response).resolves.toEqual(sent);
  });

  it("does not release compactFirst at its compact checkpoint", async () => {
    const tail = createDeferredPromise<void>();
    const seen: string[] = [];
    let authority: SendIntakeAuthority | undefined;
    const f = fixture(async (row, auth) => {
      seen.push(row.id); authority = auth;
      if (row.id === "parent") await tail.promise;
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id }));
      return sent;
    });
    f.add("parent"); f.add("next"); f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(1);
    f.db.transaction(tx => commitSendIntake(tx, { ...authority!, stage: "compact" }, { kind: "request", id: "creq_2222222222", sequence: 1 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(["parent"]);
    expect(getThreadSendIntake(f.db, "parent")?.state).toBe("preparing");
    tail.resolve();
    await vi.advanceTimersByTimeAsync(2);
    expect(seen).toEqual(["parent", "next"]);
  });

  it("recovers more than one bounded page across error/active statuses without spinning on held heads", async () => {
    const held = createDeferredPromise<void>();
    const seen: string[] = [];
    const f = fixture(async row => { seen.push(row.id); await held.promise; return sent; });
    for (let i = 0; i < 35; i++) {
      const thread = createThread(f.db, noopNotifier, { projectId: f.project.id, providerId: "codex", status: i % 2 === 0 ? "error" : "active" });
      f.add(`row-${i}`, thread.id);
    }
    f.worker.recover();
    await vi.advanceTimersByTimeAsync(5);
    expect(seen).toHaveLength(35);
    expect(vi.getTimerCount()).toBe(70);
    f.worker.stop(); held.resolve();
    await vi.advanceTimersByTimeAsync(1);
  });

  it("schedules one recovery wake for a live foreign lease instead of forgetting it at startup", async () => {
    const seen: string[] = [];
    const f = fixture(async (row, auth) => { seen.push(row.id); f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id })); return sent; });
    f.add("leased");
    claimThreadSendIntake(f.db, { threadId: f.thread.id, token: "dead-process", now: Date.now(), leaseMs: 100 });
    f.worker.recover(); await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(101);
    expect(seen).toEqual(["leased"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("invalidates an edited claim without letting its late finally or timeout remove the new slot", async () => {
    const old = createDeferredPromise<void>();
    const current = createDeferredPromise<void>();
    const claims: Array<{ row: ThreadSendIntakeClaim; auth: SendIntakeAuthority }> = [];
    const f = fixture(async (row, auth) => {
      claims.push({ row, auth });
      await (claims.length === 1 ? old.promise : current.promise);
      f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id }));
      return sent;
    });
    f.add("edited"); f.add("next"); f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(1);
    const before = getThreadSendIntake(f.db, "edited")!;
    mutateThreadSendIntake(f.db, { id: before.id, revision: before.revision, now: Date.now(), action: { kind: "edit", envelope: "new", attachmentPaths: [] } });
    f.worker.changed(f.thread.id, "edited"); f.worker.wake(f.thread.id);
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toHaveLength(2);
    old.resolve(); await vi.advanceTimersByTimeAsync(1);
    expect(() => f.db.transaction(tx => assertSendIntake(tx, claims[0]!.auth))).toThrow(/claim|stopped/i);
    f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(1);
    expect(claims).toHaveLength(2);
    current.resolve(); await vi.advanceTimersByTimeAsync(2);
    expect(getThreadSendIntake(f.db, "edited")?.state).toBe("transferred");
  });

  it("settles a rejected staging waiter and lets its successor enter", async () => {
    const seen: string[] = [];
    const f = fixture(async (row, auth) => { seen.push(row.id); f.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: row.id })); return sent; }, async row => {
      rejectThreadSendIntake(f.db, row.id, "source missing", Date.now()); throw new Error("source missing");
    });
    f.add("bad", f.thread.id, true); f.add("good");
    const waiting = expect(f.worker.wait("bad")).rejects.toThrow("source missing");
    f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(3);
    await waiting;
    expect(seen).toEqual(["good"]);
  });

  it("stops renewal, leaves safe work recoverable and fences late effects before DB close", async () => {
    const held = createDeferredPromise<void>();
    const authorities: SendIntakeAuthority[] = [];
    const f = fixture(async (_row, auth) => { authorities.push(auth); await held.promise; return sent; });
    f.add("preseal"); f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(1);
    f.worker.stop();
    expect(getThreadSendIntake(f.db, "preseal")?.state).toBe("pending");
    expect(() => f.db.transaction(tx => assertSendIntake(tx, authorities[0]))).toThrow(/stopped/i);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve(); await vi.advanceTimersByTimeAsync(1);
  });

  it("keeps sealed work failed with recovery after stop", async () => {
    const held = createDeferredPromise<void>();
    const f = fixture(async (_row, auth) => { sealSendIntake(f.db, auth); await held.promise; return sent; });
    f.add("sealed"); f.worker.wake(f.thread.id); await vi.advanceTimersByTimeAsync(1);
    f.worker.stop();
    expect(getThreadSendIntake(f.db, "sealed")).toMatchObject({ state: "failed", lastError: expect.stringContaining("recovery") });
    held.resolve(); await vi.advanceTimersByTimeAsync(1);
  });
});
