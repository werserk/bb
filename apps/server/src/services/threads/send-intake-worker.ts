import { ApiError } from "../../errors.js";
import { randomUUID } from "node:crypto";
import {
  claimThreadSendIntake,
  failThreadSendIntake,
  getThreadSendIntake,
  listThreadSendIntakes,
  listRecoverableThreadSendIntakeThreads,
  releaseThreadSendIntakeForStop,
  renewThreadSendIntakeClaim,
  setThreadSendIntakeNativeReceipt,
  deferThreadSendIntakeClaim,
  rejectClaimedThreadSendIntake,
  type DbConnection,
  type ThreadSendIntakeClaim,
  type ThreadSendIntakeRow,
} from "@bb/db";
import { sendMessageResponseSchema, type SendMessageResponse } from "@bb/server-contract";
import type { SendIntakeAuthority } from "./send-intake-authority.js";
import { deterministicIntakeError, encodeIntakeErrorOutcome, intakeBlockedError, readIntakeErrorOutcome } from "./send-intake-errors.js";
import { onThreadContextMutationAvailable, ThreadContextMutationBusyError } from "./thread-context-mutation-guard.js";

interface IntakeWorkerDeps {
  db: DbConnection;
  isReady: () => boolean;
  prepare: (row: ThreadSendIntakeRow) => Promise<void>;
  execute: (row: ThreadSendIntakeClaim, authority: SendIntakeAuthority) => Promise<SendMessageResponse>;
  notify: (threadId: string) => void;
  report: (error: unknown, id: string) => void;
}
interface WorkSlot {
  claim: ThreadSendIntakeClaim | null;
  invalidated: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
  cleanups: Set<() => void>;
}
interface LegacyWaiter {
  resolve: (response: SendMessageResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LEASE_MS = 30_000;
const ATTEMPT_MS = 5 * 60_000;
const LEGACY_WAIT_MS = 30_000;

export function createSendIntakeWorker(deps: IntakeWorkerDeps) {
  let stopped = false;
  const running = new Map<string, WorkSlot>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const expiryWakes = new Map<string, ReturnType<typeof setTimeout>>();
  const guardWakes = new Map<string, { id: string; cancel: () => void }>();
  const waiters = new Map<string, Set<LegacyWaiter>>();
  const awaitingInlineResult = new Set<string>();

  function settle(id: string, failure?: Error): void {
    const listeners = waiters.get(id);
    if (!listeners) return;
    const row = getThreadSendIntake(deps.db, id);
    if (row?.state === "transferred" && awaitingInlineResult.has(id)) return;
    if (row?.nativeReceipt) {
      const outcome: unknown = JSON.parse(row.nativeReceipt);
      const rejection = readIntakeErrorOutcome(outcome);
      if (rejection) for (const listener of listeners) listener.reject(rejection);
      else {
        const receipt = sendMessageResponseSchema.parse(outcome);
        for (const listener of listeners) listener.resolve(receipt);
      }
    } else if (row?.state === "failed") {
      for (const listener of listeners) listener.reject(intakeBlockedError(id, row.id));
    } else if (!row || row.state === "rejected" || row.state === "cancelled") {
      for (const listener of listeners) listener.reject(failure ?? new ApiError(row?.state === "cancelled" ? 409 : 503, "intake_not_deliverable", row?.lastError ?? "Intake no longer deliverable"));
    } else {
      const head = listThreadSendIntakes(deps.db, row.threadId, 1)[0];
      if (head?.state !== "failed") return;
      for (const listener of listeners) listener.reject(intakeBlockedError(id, head.id));
    }
    for (const listener of listeners) clearTimer(listener.timer);
    waiters.delete(id);
  }

  function later(work: () => void, delay: number, slot?: WorkSlot) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      slot?.timers.delete(timer);
      if (!stopped && !slot?.invalidated) {
        try { work(); } catch (error) { deps.report(error, slot?.claim?.id ?? "intake-timer"); }
      }
    }, delay);
    timer.unref();
    timers.add(timer);
    slot?.timers.add(timer);
    return timer;
  }

  function clearTimer(timer: ReturnType<typeof setTimeout>) {
    clearTimeout(timer);
    timers.delete(timer);
  }

  function release(threadId: string, slot: WorkSlot) {
    for (const timer of slot.timers) clearTimer(timer);
    slot.timers.clear();
    for (const cleanup of slot.cleanups) cleanup();
    slot.cleanups.clear();
    if (running.get(threadId) === slot) running.delete(threadId);
  }

  function changed(threadId: string, id: string, failure?: Error) {
    if (stopped) return;
    deps.notify(threadId);
    settle(id, failure);
    for (const waitingId of waiters.keys()) {
      if (waitingId !== id && getThreadSendIntake(deps.db, waitingId)?.threadId === threadId) settle(waitingId);
    }
  }

  function wake(threadId: string): void {
    if (stopped || !deps.isReady()) return;
    const guardWait = guardWakes.get(threadId);
    if (guardWait) {
      const head = listThreadSendIntakes(deps.db, threadId, 1)[0];
      if (head?.id === guardWait.id && head.state === "pending") return;
      guardWait.cancel();
      guardWakes.delete(threadId);
    }
    const previous = running.get(threadId);
    if (previous) {
      if (previous.claim === null) return;
      const row = getThreadSendIntake(deps.db, previous.claim.id);
      if (row?.state === "preparing" && row.claimToken === previous.claim.claimToken && row.claimEpoch === previous.claim.claimEpoch) return;
      previous.invalidated = true;
      release(threadId, previous);
    }
    const expiry = expiryWakes.get(threadId);
    if (expiry) { clearTimer(expiry); expiryWakes.delete(threadId); }
    const slot: WorkSlot = { claim: null, invalidated: false, timers: new Set(), cleanups: new Set() };
    running.set(threadId, slot);
    void Promise.resolve().then(() => {
      if (!stopped && !slot.invalidated) return work(threadId, slot);
    }).catch(error => deps.report(error, threadId));
  }

  function waitForLease(threadId: string, expiresAt: number) {
    const previous = expiryWakes.get(threadId);
    if (previous) clearTimer(previous);
    expiryWakes.set(threadId, later(() => {
      expiryWakes.delete(threadId);
      wake(threadId);
    }, Math.max(1, expiresAt - Date.now())));
  }

  function waitForGuard(threadId: string, id: string) {
    const resume = () => {
      guardWakes.get(threadId)?.cancel();
      guardWakes.delete(threadId);
      wake(threadId);
    };
    const timer = later(resume, 10_000);
    const unsubscribe = onThreadContextMutationAvailable(threadId, resume);
    guardWakes.set(threadId, { id, cancel: () => { clearTimer(timer); unsubscribe(); } });
  }

  async function work(threadId: string, slot: WorkSlot): Promise<void> {
    let head: ThreadSendIntakeRow | undefined;
    try {
      head = listThreadSendIntakes(deps.db, threadId, 1)[0];
      if (!head) return;
      if (head.state === "staging") {
        await deps.prepare(head);
        if (stopped || slot.invalidated) return;
        changed(threadId, head.id);
      }
      const claim = claimThreadSendIntake(deps.db, { threadId, token: randomUUID(), now: Date.now(), leaseMs: LEASE_MS });
      slot.claim = claim;
      if (!claim) {
        const pending = listThreadSendIntakes(deps.db, threadId, 1)[0];
        if (pending?.state === "preparing" && pending.leaseExpiresAt !== null) waitForLease(threadId, pending.leaseExpiresAt);
        if (pending) changed(threadId, pending.id);
        return;
      }
      const renew = () => {
        if (renewThreadSendIntakeClaim(deps.db, claim, Date.now(), LEASE_MS)) later(renew, LEASE_MS / 3, slot);
      };
      later(renew, LEASE_MS / 3, slot);
      later(() => {
        failThreadSendIntake(deps.db, claim, "Preparation timed out; custody retained", Date.now());
        slot.invalidated = true;
        release(threadId, slot);
        changed(threadId, claim.id);
      }, ATTEMPT_MS, slot);
      const authority: SendIntakeAuthority = {
        claim, stage: "message", isStopped: () => stopped || slot.invalidated,
        onRelease: cleanup => {
          if (stopped || slot.invalidated || running.get(threadId) !== slot) cleanup();
          else slot.cleanups.add(cleanup);
        },
        committed: () => {
          release(threadId, slot);
          changed(threadId, claim.id);
          wake(threadId);
        },
      };
      awaitingInlineResult.add(claim.id);
      let result: SendMessageResponse;
      try { result = await deps.execute(claim, authority); }
      finally { awaitingInlineResult.delete(claim.id); }
      if (stopped || slot.invalidated) return;
      if (getThreadSendIntake(deps.db, claim.id)?.state !== "transferred")
        throw new Error("Inline send returned without committed native custody");
      setThreadSendIntakeNativeReceipt(deps.db, claim.id, JSON.stringify(result));
      changed(threadId, claim.id);
    } catch (error) {
      if (!stopped && !slot.invalidated) {
        const id = slot.claim?.id ?? head?.id;
        if (slot.claim) {
          const claim = slot.claim;
          const rejection = deterministicIntakeError(error);
          if (error instanceof ThreadContextMutationBusyError && claim.claimEpoch <= 3 && deferThreadSendIntakeClaim(deps.db, claim, Date.now())) {
            release(threadId, slot);
            waitForGuard(threadId, claim.id);
          } else if (!(rejection && !(error instanceof ThreadContextMutationBusyError) &&
            rejectClaimedThreadSendIntake(deps.db, claim, encodeIntakeErrorOutcome(rejection), rejection.message, Date.now()))) {
            const row = getThreadSendIntake(deps.db, claim.id);
            const sealed = row !== null && row.sealedAt !== null;
            failThreadSendIntake(deps.db, claim, error instanceof Error ? error.message : "Preparation failed", Date.now(),
              rejection && sealed && !(error instanceof ThreadContextMutationBusyError) ? encodeIntakeErrorOutcome(rejection, claim.id) : null);
          }
        }
        if (id) changed(threadId, id, error instanceof Error ? error : new Error("Preparation failed"));
        deps.report(error, id ?? threadId);
      }
    } finally {
      release(threadId, slot);
      if (!stopped && head && getThreadSendIntake(deps.db, head.id)?.state === "rejected") wake(threadId);
    }
  }

  function recover(afterThreadId: string | null = null): void {
    if (stopped || !deps.isReady()) return;
    const batch = listRecoverableThreadSendIntakeThreads(deps.db, afterThreadId, 32);
    for (const threadId of batch) wake(threadId);
    if (batch.length === 32) later(() => recover(batch[batch.length - 1]!), 0);
  }

  return {
    wake,
    recover: () => recover(),
    changed,
    wait(id: string): Promise<SendMessageResponse> {
      if (stopped) return Promise.reject(new Error("Intake worker stopped"));
      return new Promise((resolve, reject) => {
        const listeners = waiters.get(id) ?? new Set<LegacyWaiter>();
        const listener: LegacyWaiter = { resolve, reject, timer: later(() => {
          listeners.delete(listener);
          if (listeners.size === 0) waiters.delete(id);
          const row = getThreadSendIntake(deps.db, id);
          const head = row ? listThreadSendIntakes(deps.db, row.threadId, 1)[0] : undefined;
          reject(intakeBlockedError(id, head?.id ?? null));
        }, LEGACY_WAIT_MS) };
        listeners.add(listener);
        waiters.set(id, listeners);
        settle(id);
      });
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); expiryWakes.clear();
      for (const wait of guardWakes.values()) wait.cancel();
      guardWakes.clear();
      for (const slot of running.values()) {
        slot.invalidated = true;
        for (const cleanup of slot.cleanups) cleanup();
        slot.cleanups.clear();
        if (slot.claim) releaseThreadSendIntakeForStop(deps.db, slot.claim, Date.now());
      }
      running.clear();
      for (const listeners of waiters.values())
        for (const listener of listeners) listener.reject(new Error("Intake worker stopped; custody retained"));
      waiters.clear();
    },
  };
}
