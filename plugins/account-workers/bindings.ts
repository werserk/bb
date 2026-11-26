import type Database from "better-sqlite3";
import path from "node:path";
import type { InstructionFile } from "./contract.js";

export type ReleaseReason = "unbind" | "archive" | "delete" | "spawn-failed" | "abandoned";

export interface Binding {
  id: string;
  threadId: string | null;
  workerHostId: string;
  scratchPath: string;
  workspaceHostId: string;
  workspaceHostName: string;
  root: string;
  instructions: InstructionFile[];
  profile: string;
  brokenReason: string | null;
  ready: boolean;
  releasedAt: number | null;
  releaseReason: ReleaseReason | null;
  releaseDue: number | null;
  cleanedAt: number | null;
  releaseError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  thread_id: string | null;
  worker_host_id: string;
  scratch_path: string;
  workspace_host_id: string;
  workspace_host_name: string;
  root: string;
  instructions: string;
  profile: string;
  broken_reason: string | null;
  ready: number;
  released_at: number | null;
  release_reason: ReleaseReason | null;
  release_due: number | null;
  cleaned_at: number | null;
  release_error: string | null;
  created_at: number;
  updated_at: number;
}

function toBinding(row: Row): Binding {
  return {
    id: row.id,
    threadId: row.thread_id,
    workerHostId: row.worker_host_id,
    scratchPath: row.scratch_path,
    workspaceHostId: row.workspace_host_id,
    workspaceHostName: row.workspace_host_name,
    root: row.root,
    instructions: JSON.parse(row.instructions) as InstructionFile[],
    profile: row.profile,
    brokenReason: row.broken_reason,
    ready: row.ready === 1,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    releaseDue: row.release_due,
    cleanedAt: row.cleaned_at,
    releaseError: row.release_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ADDED_COLUMNS: readonly (readonly [string, string])[] = [
  ["ready", "INTEGER NOT NULL DEFAULT 1"],
  ["released_at", "INTEGER"],
  ["release_reason", "TEXT"],
  ["release_due", "INTEGER"],
  ["cleaned_at", "INTEGER"],
  ["release_error", "TEXT"],
];

export function canonicalPath(value: string): string {
  return path.resolve(value);
}

export function isReleased(binding: Binding): boolean {
  return binding.releasedAt !== null || binding.cleanedAt !== null;
}

export class BindingStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS bindings (
      id TEXT PRIMARY KEY,
      thread_id TEXT UNIQUE,
      worker_host_id TEXT NOT NULL,
      scratch_path TEXT NOT NULL,
      workspace_host_id TEXT NOT NULL,
      workspace_host_name TEXT NOT NULL,
      root TEXT NOT NULL,
      instructions TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      profile TEXT NOT NULL DEFAULT 'claude',
      broken_reason TEXT
    )`);
    const columns = new Set(
      (db.prepare("PRAGMA table_info(bindings)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has("profile")) {
      db.exec("ALTER TABLE bindings ADD COLUMN profile TEXT NOT NULL DEFAULT 'claude'");
    }
    if (!columns.has("broken_reason")) db.exec("ALTER TABLE bindings ADD COLUMN broken_reason TEXT");
    for (const [name, type] of ADDED_COLUMNS) {
      if (!columns.has(name)) db.exec(`ALTER TABLE bindings ADD COLUMN ${name} ${type}`);
    }
  }

  create(
    binding: Pick<Binding, "id" | "workerHostId" | "scratchPath" | "workspaceHostId" | "workspaceHostName" | "root" | "instructions" | "profile">
      & Partial<Pick<Binding, "ready">>,
  ): Binding {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO bindings (id, thread_id, worker_host_id, scratch_path, workspace_host_id,
          workspace_host_name, root, instructions, profile, broken_reason, ready, created_at, updated_at)
         VALUES (@id, NULL, @workerHostId, @scratchPath, @workspaceHostId,
          @workspaceHostName, @root, @instructions, @profile, NULL, @ready, @at, @at)`,
      )
      .run({
        ...binding,
        ready: binding.ready === false ? 0 : 1,
        scratchPath: canonicalPath(binding.scratchPath),
        instructions: JSON.stringify(binding.instructions),
        at,
      });
    return this.byId(binding.id)!;
  }

  byId(id: string): Binding | null {
    const row = this.db.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as Row | undefined;
    return row ? toBinding(row) : null;
  }

  byThread(threadId: string): Binding | null {
    const binding = this.recordByThread(threadId);
    return binding !== null && !isReleased(binding) ? binding : null;
  }

  recordByThread(threadId: string): Binding | null {
    const row = this.db
      .prepare("SELECT * FROM bindings WHERE thread_id = ?")
      .get(threadId) as Row | undefined;
    return row ? toBinding(row) : null;
  }

  claim(threadId: string, hostId: string, environmentPath: string): Binding | null {
    this.db
      .prepare(
        `UPDATE bindings SET thread_id = ?, updated_at = ?
         WHERE thread_id IS NULL AND worker_host_id = ? AND scratch_path = ?`,
      )
      .run(threadId, this.now(), hostId, canonicalPath(environmentPath));
    return this.byThread(threadId);
  }

  claimById(id: string, threadId: string): Binding | null {
    this.db
      .prepare("UPDATE bindings SET thread_id = ?, updated_at = ? WHERE id = ? AND thread_id IS NULL")
      .run(threadId, this.now(), id);
    return this.byId(id);
  }

  rebind(
    threadId: string,
    target: Pick<Binding, "workspaceHostId" | "workspaceHostName" | "root" | "instructions">,
  ): Binding | null {
    this.db
      .prepare(
        `UPDATE bindings SET workspace_host_id = ?, workspace_host_name = ?, root = ?,
           instructions = ?, broken_reason = NULL, updated_at = ? WHERE thread_id = ? AND released_at IS NULL AND cleaned_at IS NULL`,
      )
      .run(
        target.workspaceHostId,
        target.workspaceHostName,
        target.root,
        JSON.stringify(target.instructions),
        this.now(),
        threadId,
      );
    return this.byThread(threadId);
  }

  markBroken(id: string, reason: string): void {
    this.db
      .prepare("UPDATE bindings SET broken_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason, this.now(), id);
  }

  markReady(id: string): void {
    this.set(id, "ready = 1");
  }

  tombstone(id: string, due: number, reason: ReleaseReason): Binding | null {
    const at = this.now();
    this.db
      .prepare(
        `UPDATE bindings SET released_at = ?, release_due = ?, release_reason = ?, updated_at = ?
         WHERE id = ? AND released_at IS NULL`,
      )
      .run(at, due, reason, at, id);
    if (reason === "delete") this.set(id, "release_reason = 'delete'");
    return this.byId(id);
  }

  untombstone(id: string): boolean {
    return (
      this.db
        .prepare(
          `UPDATE bindings SET released_at = NULL, release_due = NULL, release_reason = NULL, release_error = NULL,
             updated_at = ? WHERE id = ? AND release_reason = 'archive' AND cleaned_at IS NULL AND release_due > ?`,
        )
        .run(this.now(), id, this.now()).changes > 0
    );
  }

  dueNow(id: string): void {
    this.set(id, "release_due = ?", this.now());
  }

  markCleaned(id: string): void {
    const at = this.now();
    this.db
      .prepare("UPDATE bindings SET cleaned_at = ?, release_error = NULL, updated_at = ? WHERE id = ? AND released_at IS NOT NULL")
      .run(at, at, id);
  }

  setReleaseError(id: string, error: string): void {
    this.set(id, "release_error = ?", error);
  }

  pendingRelease(): Binding[] {
    return (
      this.db
        .prepare("SELECT * FROM bindings WHERE released_at IS NOT NULL AND cleaned_at IS NULL ORDER BY release_due")
        .all() as Row[]
    ).map(toBinding);
  }

  private set(id: string, assignment: string, ...values: unknown[]): void {
    this.db.prepare(`UPDATE bindings SET ${assignment}, updated_at = ? WHERE id = ?`).run(...values, this.now(), id);
  }

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM bindings WHERE id = ?").run(id).changes > 0;
  }

  list(): Binding[] {
    return (this.db.prepare("SELECT * FROM bindings ORDER BY created_at").all() as Row[]).map(
      toBinding,
    );
  }
}
