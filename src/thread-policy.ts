import type Database from "better-sqlite3";
import { z } from "zod";
import { ON_LIMIT_RULES, type OnLimit, type PoolProvider } from "./contracts.js";
import {
  RECONCILE_BATCH,
  lookUpThreads,
  type ThreadPassOptions,
} from "./thread-pass.js";

// Thread account policy (block P3). A thread runs `auto` (the pool picks) or
// is pinned to one named account with a rule for when that account hits its
// limit. No row means `auto` at revision 0. Every change bumps the revision,
// so concurrent writers compare-and-set.

export { ON_LIMIT_RULES, type OnLimit } from "./contracts.js";

export type ThreadPolicy =
  | { mode: "auto"; revision: number; updatedAt: number | null }
  | {
      mode: "named";
      provider: PoolProvider;
      accountId: string;
      onLimit: OnLimit;
      revision: number;
      updatedAt: number | null;
    };

export type PolicyContent =
  | { mode: "auto" }
  | {
      mode: "named";
      provider: PoolProvider;
      accountId: string;
      onLimit: OnLimit;
    };

// The named-account rules live with the quota rules, which the app also
// imports (it cannot load this module's node-only imports).
export {
  NAMED_LIMIT_THRESHOLD,
  namedAccountState,
  type NamedAccountState,
} from "./quota.js";

export function policyDetail(policy: PolicyContent): string {
  return policy.mode === "auto" ? "auto" : `named-${policy.onLimit}`;
}

// The caller recorded in a `policy` audit row. `client` and `cli` are caller
// kinds only: the UI, agents and bb itself are all `client`.
export type PolicyCaller =
  | { kind: "client" }
  | { kind: "cli" }
  | { kind: "limit" }
  | { kind: "revert" }
  | { kind: "plugin"; pluginId: string };

export function callerDetail(caller: PolicyCaller): string {
  if (caller.kind !== "plugin") return caller.kind;
  const id = caller.pluginId
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/gu, "");
  return `plugin-${id === "" ? "unknown" : id}`;
}

const rowSchema = z.object({
  thread_id: z.string(),
  mode: z.enum(["auto", "named"]),
  provider: z.enum(["claude", "codex"]).nullable(),
  account_id: z.string().nullable(),
  on_limit: z.enum(ON_LIMIT_RULES).nullable(),
  revision: z.number().int().nonnegative(),
  updated_at: z.number().int().nonnegative(),
});

const MAX_SERVING_ENTRIES = 10_000;

export interface Serving {
  accountId: string;
  at: number;
}

export class ThreadPolicyStore {
  private readonly selectRow: Database.Statement<[string]>;
  private readonly serving = new Map<string, Serving>();
  readonly passEpoch: number;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
    // The latest account that served the thread, from the audit log.
    private readonly servingFromAudit: (threadId: string) => Serving | null,
  ) {
    this.selectRow = db.prepare(
      "SELECT thread_id, mode, provider, account_id, on_limit, revision, updated_at FROM pool_thread_policy WHERE thread_id = ?",
    );
    db.prepare(
      "INSERT OR IGNORE INTO pool_pass_epoch(id, started_at) VALUES (1, ?)",
    ).run(now());
    this.passEpoch = z
      .object({ started_at: z.number().int() })
      .parse(
        db.prepare("SELECT started_at FROM pool_pass_epoch WHERE id = 1").get(),
      ).started_at;
  }

  has(threadId: string): boolean {
    return this.selectRow.get(threadId) !== undefined;
  }

  get(threadId: string): ThreadPolicy {
    const raw = this.selectRow.get(threadId);
    if (raw === undefined) return { mode: "auto", revision: 0, updatedAt: null };
    const row = rowSchema.parse(raw);
    if (
      row.mode === "named" &&
      row.provider !== null &&
      row.account_id !== null &&
      row.on_limit !== null
    )
      return {
        mode: "named",
        provider: row.provider,
        accountId: row.account_id,
        onLimit: row.on_limit,
        revision: row.revision,
        updatedAt: row.updated_at,
      };
    return { mode: "auto", revision: row.revision, updatedAt: row.updated_at };
  }

  // Writes `next` if the stored revision is still `expected`. Returns the new
  // revision, or null when another writer won.
  write(threadId: string, next: PolicyContent, expected: number): number | null {
    const named = next.mode === "named" ? next : null;
    const values = [
      next.mode,
      named?.provider ?? null,
      named?.accountId ?? null,
      named?.onLimit ?? null,
      expected + 1,
      this.now(),
    ] as const;
    return this.db.transaction(() => {
      const current = this.get(threadId).revision;
      if (current !== expected) return null;
      if (expected === 0 && !this.has(threadId))
        this.db
          .prepare(
            "INSERT INTO pool_thread_policy(mode, provider, account_id, on_limit, revision, updated_at, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(...values, threadId);
      else
        this.db
          .prepare(
            "UPDATE pool_thread_policy SET mode = ?, provider = ?, account_id = ?, on_limit = ?, revision = ?, updated_at = ? WHERE thread_id = ? AND revision = ?",
          )
          .run(...values, threadId, expected);
      return expected + 1;
    })();
  }

  // Deletes the row if its revision is still `expected`: puts a thread that
  // had no row back to "no row" (it stays grandfathered). False when another
  // writer won.
  deleteIf(threadId: string, expected: number): boolean {
    return (
      this.db
        .prepare(
          "DELETE FROM pool_thread_policy WHERE thread_id = ? AND revision = ?",
        )
        .run(threadId, expected).changes > 0
    );
  }

  delete(threadId: string): boolean {
    this.serving.delete(threadId);
    return (
      this.db
        .prepare("DELETE FROM pool_thread_policy WHERE thread_id = ?")
        .run(threadId).changes > 0
    );
  }

  threadIds(): string[] {
    return z
      .array(z.object({ thread_id: z.string() }))
      .parse(
        this.db
          .prepare("SELECT thread_id FROM pool_thread_policy ORDER BY thread_id")
          .all(),
      )
      .map((row) => row.thread_id);
  }

  named(): Array<{ threadId: string; policy: ThreadPolicy }> {
    return z
      .array(z.object({ thread_id: z.string() }))
      .parse(
        this.db
          .prepare(
            "SELECT thread_id FROM pool_thread_policy WHERE mode = 'named' ORDER BY thread_id",
          )
          .all(),
      )
      .map((row) => ({ threadId: row.thread_id, policy: this.get(row.thread_id) }));
  }

  // Drops the policies of deleted threads. Archived threads keep theirs, so an
  // unarchive restores the policy. Runs with the pass reconcile.
  async reconcile(
    sdk: Pick<ThreadPassOptions, "getThread" | "listThreads">,
    onDeleted: (threadId: string) => void = () => {},
  ): Promise<void> {
    const ids = this.threadIds();
    for (let start = 0; start < ids.length; start += RECONCILE_BATCH) {
      const batch = ids.slice(start, start + RECONCILE_BATCH);
      const found = await lookUpThreads(batch, sdk);
      if (found === null) continue;
      for (const threadId of batch) {
        const thread = found.get(threadId);
        if (thread === undefined) continue;
        if (thread === null || thread.deletedAt !== null) {
          if (this.delete(threadId)) onDeleted(threadId);
        }
      }
    }
  }

  servingFor(threadId: string): Serving | null {
    const cached = this.serving.get(threadId);
    if (cached !== undefined) return cached;
    const stored = this.servingFromAudit(threadId);
    if (stored !== null) this.remember(threadId, stored);
    return stored;
  }

  noteServing(threadId: string, accountId: string, at: number): void {
    this.remember(threadId, { accountId, at });
  }

  private remember(threadId: string, serving: Serving): void {
    this.serving.delete(threadId);
    this.serving.set(threadId, serving);
    while (this.serving.size > MAX_SERVING_ENTRIES) {
      const oldest = this.serving.keys().next();
      if (oldest.done) break;
      this.serving.delete(oldest.value);
    }
  }
}
