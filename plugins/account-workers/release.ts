import type { Binding, BindingStore, ReleaseReason } from "./bindings.js";
import type { HostClient } from "./tools.js";

export const ARCHIVE_UNDO_MS = 30_000;

const LIVE = new Set(["starting", "active", "stopping"]);

export type ThreadState = { kind: "live" } | { kind: "quiet" };

export interface ReleaseDeps {
  store: BindingStore;
  host: Pick<HostClient, "call">;
  threadState(threadId: string): Promise<ThreadState>;
  now(): number;
  log(message: string): void;
  setTimer(run: () => void, ms: number): { cancel(): void };
}

export type ReleaseOutcome =
  | { kind: "cleaned" }
  | { kind: "not-due" }
  | { kind: "live" }
  | { kind: "failed"; error: string };

export class Releaser {
  private timer: { cancel(): void } | null = null;
  private sweeping: Promise<void> | null = null;
  private rerun = false;

  constructor(private readonly deps: ReleaseDeps) {}

  retire(binding: Binding, due: number, reason: ReleaseReason): Binding | null {
    const row = this.deps.store.tombstone(binding.id, due, reason);
    this.schedule();
    return row;
  }

  restore(binding: Binding): boolean {
    const restored = this.deps.store.untombstone(binding.id);
    this.schedule();
    return restored;
  }

  async release(binding: Binding): Promise<ReleaseOutcome> {
    const { store, host, now } = this.deps;
    const row = store.byId(binding.id);
    if (row === null || row.releasedAt === null) return { kind: "not-due" };
    if (row.cleanedAt !== null) return { kind: "cleaned" };
    if (row.releaseDue !== null && row.releaseDue > now()) return { kind: "not-due" };
    try {
      if (row.threadId !== null && (await this.deps.threadState(row.threadId)).kind === "live") return { kind: "live" };
      const result = await host.call(
        "releaseScratch",
        { bindingId: row.id, profile: row.profile, scratchPath: row.scratchPath },
        { hostId: row.workerHostId },
      );
      if (!result.ok) throw new Error(result.error);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.setReleaseError(row.id, message);
      this.deps.log(`account-workers: release of ${row.id} failed: ${message}`);
      return { kind: "failed", error: message };
    }
    store.markCleaned(row.id);
    return { kind: "cleaned" };
  }

  sweep(): Promise<void> {
    if (this.sweeping !== null) {
      this.rerun = true;
      return this.sweeping;
    }
    const run = this.releaseUntilSettled().finally(() => {
      this.sweeping = null;
      this.schedule();
    });
    this.sweeping = run;
    return run;
  }

  private async releaseUntilSettled(): Promise<void> {
    do {
      this.rerun = false;
      await this.releasePending();
    } while (this.rerun);
  }

  private async releasePending(): Promise<void> {
    for (const binding of this.deps.store.pendingRelease()) {
      if (binding.releaseError === null) await this.release(binding);
    }
  }

  private schedule(): void {
    this.timer?.cancel();
    this.timer = null;
    const next = this.deps.store
      .pendingRelease()
      .find((b) => b.releaseError === null && b.releaseDue !== null && b.releaseDue > this.deps.now());
    if (next === undefined) return;
    this.timer = this.deps.setTimer(() => void this.sweep(), next.releaseDue! - this.deps.now());
  }

  dispose(): void {
    this.timer?.cancel();
    this.timer = null;
  }
}

export function isLive(status: string): boolean {
  return LIVE.has(status);
}
