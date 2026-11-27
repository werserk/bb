import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type PluginRpcHandlers,
} from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { AuditLog } from "./audit-log.js";

// Per-thread passes (block P2). A pass is re-derived from the key on every
// send and never stored: SQLite holds only a random nonce per thread, which is
// useless without the key. Revoking a pass deletes its row; a new row gets a
// new nonce, so a revoked pass can never come back.
//
// This module knows nothing about machine roles. `mayHold(hostId)` decides
// which hosts are issued passes (block P2: role `worker`); `mayPresent(hostId)`
// decides whose passes are accepted (any role). They differ on purpose: a
// later build that issues passes on every role can roll back to this one
// without failing a turn in flight.

export const THREAD_PASS_PREFIX = "pt1";
export const CATALOG_PASS_PREFIX = "pc1";
export const ARCHIVE_UNDO_GRACE_MS = 30_000; // core's archive undo grace
export const PASS_KEY_FILE = "pass-key.json";

const ID = /^[A-Za-z0-9_-]+$/u;
const MAC = /^[A-Za-z0-9_-]{43}$/u;
const idSchema = z.string().min(1).regex(ID);
const keyFileSchema = z
  .object({ version: z.literal(1), key: z.string().regex(MAC) })
  .strict();

export type PassPrincipal =
  | { kind: "thread"; threadId: string; hostId: string }
  | { kind: "catalog"; hostId: string };

export function looksLikePass(presented: string): boolean {
  return (
    presented.startsWith(`${THREAD_PASS_PREFIX}.`) ||
    presented.startsWith(`${CATALOG_PASS_PREFIX}.`)
  );
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}

// The HMAC key. Created only when the first pass is issued and only if the file
// does not exist; never overwritten. Any other read failure leaves the key
// unusable until a restart: holders get no pass and every pass is refused,
// while host tokens are unaffected.
export class PassKey {
  private state:
    | { kind: "unloaded" }
    | { kind: "missing" }
    | { kind: "ready"; key: Buffer }
    | { kind: "broken" } = { kind: "unloaded" };
  private loading: Promise<void> | null = null;

  constructor(
    private readonly secretsDir: string,
    private readonly onBroken: (message: string) => void,
  ) {}

  get file(): string {
    return path.join(this.secretsDir, PASS_KEY_FILE);
  }

  // The key if it exists and is valid; with `create`, makes it when missing.
  async get(create: boolean): Promise<Buffer | null> {
    if (this.state.kind === "unloaded") await this.serialized(() => this.load());
    if (create && this.state.kind === "missing")
      await this.serialized(() => this.create());
    return this.state.kind === "ready" ? this.state.key : null;
  }

  private async serialized(operation: () => Promise<void>): Promise<void> {
    while (this.loading !== null) await this.loading;
    this.loading = operation().finally(() => {
      this.loading = null;
    });
    await this.loading;
  }

  private async load(): Promise<void> {
    if (this.state.kind !== "unloaded") return;
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        this.state = { kind: "missing" };
        return;
      }
      this.broken(`could not be read (${errorCode(error) ?? "error"})`);
      return;
    }
    this.accept(text);
  }

  private accept(text: string): void {
    let parsed: z.infer<typeof keyFileSchema>;
    try {
      parsed = keyFileSchema.parse(JSON.parse(text));
    } catch {
      this.broken("is not a valid key file");
      return;
    }
    this.state = { kind: "ready", key: Buffer.from(parsed.key, "base64url") };
  }

  private async create(): Promise<void> {
    if (this.state.kind !== "missing") return;
    await fs.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify({ version: 1, key: randomBytes(32).toString("base64url") })}\n`;
    try {
      await fs.writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      try {
        // link() fails if the file appeared meanwhile: the existing key wins.
        await fs.link(temporary, this.file);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
      }
    } catch (error) {
      this.broken(`could not be created (${errorCode(error) ?? "error"})`);
      return;
    } finally {
      await fs.rm(temporary, { force: true });
    }
    this.state = { kind: "unloaded" };
    await this.load();
  }

  private broken(reason: string): void {
    this.state = { kind: "broken" };
    this.onBroken(
      `Account Pooler pass key ${reason}; worker machines get no pass until it is fixed and the plugin restarts. The file is left as it is.`,
    );
  }
}

const passRowSchema = z.object({
  thread_id: idSchema,
  host_id: idSchema,
  nonce: z.string().min(1),
  issued_at: z.number(),
  archived_at: z.number().nullable(),
});
type PassRow = z.infer<typeof passRowSchema>;

export interface PassThread {
  hostId: string | null;
  archivedAt: number | null;
  deletedAt: number | null;
}

export interface ThreadPassOptions {
  db: Database.Database;
  key: PassKey;
  now: () => number;
  audit: AuditLog;
  mayHold: (hostId: string) => boolean;
  mayPresent: (hostId: string) => boolean;
  // null when the thread does not exist; other failures throw.
  getThread: (threadId: string) => Promise<PassThread | null>;
  // false when the machine was removed from bb; other failures throw.
  hostExists: (hostId: string) => Promise<boolean>;
}

export const passSummarySchema = z
  .object({
    threadId: idSchema,
    hostId: idSchema,
    issuedAt: z.number(),
    state: z.enum(["active", "archived-grace"]),
  })
  .strict();
export type PassSummary = z.infer<typeof passSummarySchema>;

export class ThreadPasses {
  private readonly select: Database.Statement<[string]>;

  constructor(private readonly options: ThreadPassOptions) {
    this.select = options.db.prepare(
      "SELECT thread_id, host_id, nonce, issued_at, archived_at FROM pool_thread_pass WHERE thread_id = ?",
    );
  }

  private row(threadId: string): PassRow | null {
    const row = this.select.get(threadId);
    return row === undefined ? null : passRowSchema.parse(row);
  }

  private inGrace(row: PassRow): boolean {
    return (
      row.archived_at === null ||
      this.options.now() < row.archived_at + ARCHIVE_UNDO_GRACE_MS
    );
  }

  private threadMac(key: Buffer, row: Pick<PassRow, "thread_id" | "host_id" | "nonce">) {
    return createHmac("sha256", key)
      .update(`${THREAD_PASS_PREFIX}\0${row.thread_id}\0${row.host_id}\0${row.nonce}`)
      .digest("base64url");
  }

  private catalogMac(key: Buffer, hostId: string) {
    return createHmac("sha256", key)
      .update(`${CATALOG_PASS_PREFIX}\0${hostId}`)
      .digest("base64url");
  }

  private write(threadId: string, hostId: string, archivedAt: number | null): PassRow {
    const row = {
      thread_id: threadId,
      host_id: hostId,
      nonce: randomBytes(16).toString("base64url"),
      issued_at: this.options.now(),
      archived_at: archivedAt,
    };
    this.options.db
      .prepare(
        "INSERT INTO pool_thread_pass(thread_id, host_id, nonce, issued_at, archived_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET host_id = excluded.host_id, nonce = excluded.nonce, issued_at = excluded.issued_at, archived_at = excluded.archived_at",
      )
      .run(row.thread_id, row.host_id, row.nonce, row.issued_at, row.archived_at);
    return row;
  }

  private remove(threadId: string): boolean {
    return (
      this.options.db
        .prepare("DELETE FROM pool_thread_pass WHERE thread_id = ?")
        .run(threadId).changes > 0
    );
  }

  // The thread's pass, issuing one when needed; null means "give no pass".
  async issue(threadId: string, hostId: string): Promise<string | null> {
    idSchema.parse(threadId);
    idSchema.parse(hostId);
    if (!this.options.mayHold(hostId)) return null;
    const key = await this.options.key.get(true);
    if (key === null) return null;
    let row = this.row(threadId);
    if (row !== null && row.host_id === hostId && row.archived_at !== null) {
      // Sent to while marked archived: an unarchive may have been missed.
      let thread: PassThread | null;
      try {
        thread = await this.options.getThread(threadId);
      } catch {
        return null;
      }
      if (thread === null || thread.deletedAt !== null || thread.archivedAt !== null)
        return null;
      row = this.row(threadId);
      if (row !== null && row.archived_at !== null) {
        if (this.inGrace(row)) {
          this.options.db
            .prepare(
              "UPDATE pool_thread_pass SET archived_at = NULL WHERE thread_id = ? AND nonce = ?",
            )
            .run(threadId, row.nonce);
          row = { ...row, archived_at: null };
          this.audit("pass-issued", row, "restored");
        } else {
          this.remove(threadId);
          row = null;
        }
      }
    }
    // Synchronous from here on: no role change or lifecycle event interleaves.
    if (!this.options.mayHold(hostId)) return null;
    if (row === null || row.host_id !== hostId) {
      row = this.write(threadId, hostId, null);
      this.audit("pass-issued", row, null);
    }
    return `${THREAD_PASS_PREFIX}.${threadId}.${this.threadMac(key, row)}`;
  }

  async catalogPass(hostId: string): Promise<string | null> {
    idSchema.parse(hostId);
    if (!this.options.mayHold(hostId)) return null;
    const key = await this.options.key.get(true);
    if (key === null || !this.options.mayHold(hostId)) return null;
    return `${CATALOG_PASS_PREFIX}.${hostId}.${this.catalogMac(key, hostId)}`;
  }

  async verify(presented: string): Promise<PassPrincipal | null> {
    const parts = presented.split(".");
    if (parts.length !== 3) return null;
    const [prefix, id, mac] = parts as [string, string, string];
    if (!ID.test(id) || !MAC.test(mac)) return null;
    if (prefix !== THREAD_PASS_PREFIX && prefix !== CATALOG_PASS_PREFIX)
      return null;
    const key = await this.options.key.get(false);
    if (key === null) return null;
    if (prefix === CATALOG_PASS_PREFIX) {
      if (!this.options.mayPresent(id)) return null;
      return equalMac(mac, this.catalogMac(key, id))
        ? { kind: "catalog", hostId: id }
        : null;
    }
    const row = this.row(id);
    if (row === null || !this.options.mayPresent(row.host_id) || !this.inGrace(row))
      return null;
    return equalMac(mac, this.threadMac(key, row))
      ? { kind: "thread", threadId: row.thread_id, hostId: row.host_id }
      : null;
  }

  // thread.archived. With no row yet, a worker thread still gets an archived
  // row, so an issue racing this event cannot leave a live pass behind.
  async archived(threadId: string, archivedAt: number): Promise<void> {
    const existing = this.row(threadId);
    if (existing !== null) {
      this.options.db
        .prepare("UPDATE pool_thread_pass SET archived_at = ? WHERE thread_id = ?")
        .run(archivedAt, threadId);
      this.audit("pass-revoked", existing, "archived");
      return;
    }
    let hostId: string | null;
    try {
      hostId = (await this.options.getThread(threadId))?.hostId ?? null;
    } catch {
      return; // the reconcile catches it
    }
    if (hostId === null || !this.options.mayHold(hostId)) return;
    const raced = this.row(threadId);
    if (raced !== null) {
      this.options.db
        .prepare("UPDATE pool_thread_pass SET archived_at = ? WHERE thread_id = ?")
        .run(archivedAt, threadId);
      this.audit("pass-revoked", raced, "archived");
      return;
    }
    this.write(threadId, hostId, archivedAt);
  }

  // thread.unarchived: within the grace the same pass works again; after it
  // the row goes and the next send issues a new pass.
  unarchived(threadId: string): void {
    const row = this.row(threadId);
    if (row === null || row.archived_at === null) return;
    if (this.inGrace(row)) {
      this.options.db
        .prepare("UPDATE pool_thread_pass SET archived_at = NULL WHERE thread_id = ?")
        .run(threadId);
      this.audit("pass-issued", row, "restored");
    } else {
      this.remove(threadId);
    }
  }

  revokeThread(threadId: string, detail: "deleted" | "manual" | "reconcile"): boolean {
    const row = this.row(threadId);
    if (row === null) return false;
    this.remove(threadId);
    this.audit("pass-revoked", row, detail);
    return true;
  }

  revokeHost(hostId: string, detail: "role" | "host-removed" | "reconcile"): number {
    const rows = this.rowsForHost(hostId);
    this.options.db.prepare("DELETE FROM pool_thread_pass WHERE host_id = ?").run(hostId);
    for (const row of rows) this.audit("pass-revoked", row, detail);
    return rows.length;
  }

  private rowsForHost(hostId: string): PassRow[] {
    return z
      .array(passRowSchema)
      .parse(
        this.options.db
          .prepare(
            "SELECT thread_id, host_id, nonce, issued_at, archived_at FROM pool_thread_pass WHERE host_id = ?",
          )
          .all(hostId),
      );
  }

  private allRows(): PassRow[] {
    return z
      .array(passRowSchema)
      .parse(
        this.options.db
          .prepare(
            "SELECT thread_id, host_id, nonce, issued_at, archived_at FROM pool_thread_pass ORDER BY thread_id",
          )
          .all(),
      );
  }

  list(): PassSummary[] {
    return this.allRows()
      .filter((row) => this.inGrace(row))
      .map((row) => ({
        threadId: row.thread_id,
        hostId: row.host_id,
        issuedAt: row.issued_at,
        state: row.archived_at === null ? "active" : "archived-grace",
      }));
  }

  // Catches lifecycle events missed while the plugin was down. Runs at start
  // and every 15 minutes. An SDK failure keeps the row for the next round.
  async reconcile(): Promise<void> {
    const hosts = new Map<string, boolean>();
    for (const row of this.allRows()) {
      if (!this.options.mayPresent(row.host_id)) {
        this.revokeHost(row.host_id, "reconcile");
        continue;
      }
      if (!this.inGrace(row)) {
        this.revokeThread(row.thread_id, "reconcile");
        continue;
      }
      if (!hosts.has(row.host_id)) {
        try {
          hosts.set(row.host_id, await this.options.hostExists(row.host_id));
        } catch {
          continue;
        }
      }
      if (hosts.get(row.host_id) === false) {
        this.revokeHost(row.host_id, "host-removed");
        continue;
      }
      let thread: PassThread | null;
      try {
        thread = await this.options.getThread(row.thread_id);
      } catch {
        continue;
      }
      const current = this.row(row.thread_id);
      if (current === null || current.nonce !== row.nonce) continue;
      if (
        thread === null ||
        thread.deletedAt !== null ||
        (thread.archivedAt !== null &&
          this.options.now() >= thread.archivedAt + ARCHIVE_UNDO_GRACE_MS)
      )
        this.revokeThread(row.thread_id, "reconcile");
    }
  }

  private audit(
    reason: "pass-issued" | "pass-revoked",
    row: Pick<PassRow, "thread_id" | "host_id">,
    detail: "archived" | "deleted" | "restored" | "manual" | "role" | "host-removed" | "reconcile" | null,
  ): void {
    this.options.audit.append({
      reason,
      threadId: row.thread_id,
      hostId: row.host_id,
      detail,
    });
  }
}

function equalMac(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const passRpcContract = defineRpcContract({
  "pass.list": { input: z.null(), output: z.array(passSummarySchema) },
  "pass.revoke": {
    input: z.object({ threadId: idSchema }).strict(),
    output: z.object({ threadId: idSchema, revoked: z.boolean() }).strict(),
  },
});

export function createPassHandlers(
  passes: ThreadPasses,
): PluginRpcHandlers<typeof passRpcContract> {
  return {
    "pass.list": () => passes.list(),
    "pass.revoke": ({ threadId }) => ({
      threadId,
      revoked: passes.revokeThread(threadId, "manual"),
    }),
  };
}

export function createPassCommands(passes: ThreadPasses) {
  const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
  return {
    "pass list": cliCommand({
      summary:
        "List the per-thread passes of worker machines (never the pass itself)",
      options: { json },
      run: async (input) => {
        const list = passes.list();
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify({ passes: list })}\n`
            : list.length === 0
              ? "No per-thread passes.\n"
              : `${list.map((p) => `${p.threadId}\t${p.hostId}\t${new Date(p.issuedAt).toISOString()}\t${p.state}`).join("\n")}\n`,
        };
      },
    }),
    "pass revoke": cliCommand({
      summary:
        "Revoke a thread's pass now; the thread gets a new one at its next message",
      positionals: [
        { name: "thread-id", description: "Exact thread ID", required: true },
      ],
      options: { json },
      run: async (input) => {
        const parsed = idSchema.safeParse(input.positionals["thread-id"]);
        if (!parsed.success)
          throw new PluginCliError("Invalid thread ID.", {
            code: "pool_command_failed",
          });
        const revoked = passes.revokeThread(parsed.data, "manual");
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify({ threadId: parsed.data, revoked })}\n`
            : revoked
              ? `Revoked the pass of ${parsed.data}; it gets a new one at its next message.\n`
              : `Thread ${parsed.data} has no pass.\n`,
        };
      },
    }),
  };
}
