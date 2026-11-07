import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it } from "vitest";
import {
  createConnection,
  migrate,
  upsertHost,
  createProject,
  createThread,
  noopNotifier,
} from "../src/index.js";
it("upgrades old queue rows, retains the descriptor on restart, and permits old-column reads and writes on rollback", () => {
  const directory = mkdtempSync(join(tmpdir(), "bb-service-upgrade-"));
  let db = createConnection(join(directory, "bb.db"));
  try {
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    db.$client.exec(
      'CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY,hash text NOT NULL,created_at numeric)',
    );
    db.$client.exec(
      "CREATE TEMP TABLE bb_migration_queued_message_groups (id TEXT PRIMARY KEY, group_with_next INTEGER NOT NULL); CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY); CREATE TEMP TABLE bb_migration_existing_installation (existing INTEGER NOT NULL); INSERT INTO bb_migration_existing_installation VALUES (0)",
    );
    for (const migration of migrations.slice(0, -1)) {
      for (const statement of migration.sql) db.$client.exec(statement);
      db.$client
        .prepare(
          'INSERT INTO "__drizzle_migrations" (hash,created_at) VALUES (?,?)',
        )
        .run(migration.hash, migration.folderMillis);
    }
    const host = upsertHost(db, noopNotifier, { name: "fixture" });
    const { project } = createProject(db, noopNotifier, {
      name: "fixture",
      source: { type: "local_path", hostId: host.id, path: directory },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const oldInsert =
      "INSERT INTO queued_thread_messages (id,thread_id,content,model,reasoning_level,permission_mode,service_tier,state,sort_key,created_at,updated_at) VALUES (?,?,?,'fixture','low','full','default','queued',?,1,1)";
    db.$client
      .prepare(oldInsert)
      .run("old", thread.id, '[{"type":"text","text":"owner"}]', "a");
    migrate(db);
    expect(
      db.$client
        .prepare(
          "SELECT service_turn FROM queued_thread_messages WHERE id='old'",
        )
        .get(),
    ).toEqual({ service_turn: null });
    const descriptor = JSON.stringify({
      version: 1,
      visibility: "hidden",
      reason: "future-rotation",
      origin: { pluginId: "fixture", senderThreadId: null },
    });
    db.$client
      .prepare(oldInsert)
      .run("service", thread.id, '[{"type":"text","text":"private"}]', "b");
    db.$client
      .prepare(
        "UPDATE queued_thread_messages SET service_turn=? WHERE id='service'",
      )
      .run(descriptor);
    db.$client.close();
    db = createConnection(join(directory, "bb.db"));
    expect(
      db.$client
        .prepare(
          "SELECT service_turn FROM queued_thread_messages WHERE id='service'",
        )
        .get(),
    ).toEqual({ service_turn: descriptor });
    expect(
      db.$client
        .prepare(
          "SELECT id,content FROM queued_thread_messages ORDER BY sort_key",
        )
        .all(),
    ).toHaveLength(2);
    db.$client.prepare(oldInsert).run("rollback-owner", thread.id, "[]", "c");
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
