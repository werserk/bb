import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BindingStore } from "./bindings.js";

const BLOCK1_SCHEMA = `CREATE TABLE bindings (
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
)`;

const target = { workspaceHostId: "w2", workspaceHostName: "ws2", root: "/r2", instructions: [] };

describe("binding store", () => {
  it("migrates a block 1 database: old rows read as the claude profile, not broken", () => {
    const db = new Database(":memory:");
    db.exec(BLOCK1_SCHEMA);
    db.prepare("INSERT INTO bindings VALUES ('aw_old', 't1', 'h1', '/s/aw_old', 'h2', 'ws', '/r', '[]', 1, 1)").run();
    const store = new BindingStore(db);
    expect(store.byThread("t1")).toMatchObject({ id: "aw_old", profile: "claude", brokenReason: null, root: "/r", ready: true, releasedAt: null, cleanedAt: null, owner: "cli" });
    new BindingStore(db);
    const created = store.create({ id: "aw_new", workerHostId: "h1", scratchPath: "/s/aw_new", workspaceHostId: "h2", workspaceHostName: "ws", root: "/r", instructions: [], profile: "opencode" });
    expect(created).toMatchObject({ profile: "opencode", brokenReason: null, threadId: null });
  });

  it("a binding from before owner existed reads as a CLI binding", () => {
    const db = new Database(":memory:");
    new BindingStore(db);
    db.exec("ALTER TABLE bindings DROP COLUMN owner");
    db.prepare("INSERT INTO bindings (id, thread_id, worker_host_id, scratch_path, workspace_host_id, workspace_host_name, root, instructions, created_at, updated_at) VALUES ('aw_pre', 't2', 'h1', '/s/aw_pre', 'h2', 'ws', '/r', '[]', 1, 1)").run();
    expect(new BindingStore(db).recordByThread("t2")?.owner).toBe("cli");
  });

  it("markBroken sticks until rebind clears it", () => {
    const store = new BindingStore(new Database(":memory:"));
    store.create({ id: "aw_b", workerHostId: "h1", scratchPath: "/s/aw_b", workspaceHostId: "h2", workspaceHostName: "ws", root: "/r", instructions: [], profile: "claude" });
    store.claimById("aw_b", "t");
    store.markBroken("aw_b", "no heartbeat");
    expect(store.byThread("t")?.brokenReason).toBe("no heartbeat");
    expect(store.rebind("t", target)).toMatchObject({ brokenReason: null, root: "/r2" });
  });

  it("a tombstoned binding is gone for tools and rebind but its record stays", () => {
    const store = new BindingStore(new Database(":memory:"), () => 5);
    store.create({ id: "aw_t", workerHostId: "h1", scratchPath: "/s/aw_t", workspaceHostId: "h2", workspaceHostName: "ws", root: "/r", instructions: [], profile: "claude" });
    store.claimById("aw_t", "t");
    store.tombstone("aw_t", 10, "unbind");
    expect(store.byThread("t")).toBeNull();
    expect(store.rebind("t", target)).toBeNull();
    expect(store.recordByThread("t")).toMatchObject({ releasedAt: 5, releaseDue: 10, releaseReason: "unbind", root: "/r" });
    expect(store.claim("t2", "h1", "/s/aw_t")).toBeNull();
    store.tombstone("aw_t", 99, "archive");
    expect(store.recordByThread("t")).toMatchObject({ releaseDue: 10, releaseReason: "unbind" });
  });
});
