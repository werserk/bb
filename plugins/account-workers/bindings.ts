import type Database from "better-sqlite3";
import path from "node:path";
import type { InstructionFile } from "./contract.js";

export interface Binding {
  id: string;
  threadId: string | null;
  workerHostId: string;
  scratchPath: string;
  workspaceHostId: string;
  workspaceHostName: string;
  root: string;
  instructions: InstructionFile[];
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function canonicalPath(value: string): string {
  return path.resolve(value);
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
      updated_at INTEGER NOT NULL
    )`);
  }

  create(binding: Omit<Binding, "threadId" | "createdAt" | "updatedAt">): Binding {
    const at = this.now();
    this.db
      .prepare(
        `INSERT INTO bindings VALUES (@id, NULL, @workerHostId, @scratchPath,
          @workspaceHostId, @workspaceHostName, @root, @instructions, @at, @at)`,
      )
      .run({
        ...binding,
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
           instructions = ?, updated_at = ? WHERE thread_id = ?`,
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

  remove(id: string): boolean {
    return this.db.prepare("DELETE FROM bindings WHERE id = ?").run(id).changes > 0;
  }

  list(): Binding[] {
    return (this.db.prepare("SELECT * FROM bindings ORDER BY created_at").all() as Row[]).map(
      toBinding,
    );
  }
}
