import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { createConnection, migrate } from "../src/index.js";

it("upgrades actual pre0153 Codex/Claude rows without reclassifying, rewriting or losing fork columns", () => {
  const dir = mkdtempSync(join(tmpdir(), "placement-upgrade-"));
  const fixture = readFileSync(
    new URL("./fixtures/placement-pre0153.sqlite.gz", import.meta.url),
  );
  const provenance = JSON.parse(
    readFileSync(
      new URL("./fixtures/placement-pre0153.json", import.meta.url),
      "utf8",
    ),
  );
  expect(createHash("sha256").update(fixture).digest("hex")).toBe(
    provenance.sha256,
  );
  const path = join(dir, "bb.db");
  writeFileSync(path, gunzipSync(fixture));
  const db = createConnection(path);
  try {
    const tables = [
      "hosts",
      "projects",
      "environments",
      "threads",
      "queued_thread_messages",
      "conversation_questions",
    ];
    const before = tables.map((table) => ({
      table,
      columns: db.$client
        .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name),
      rows: db.$client.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
    }));
    expect(
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'placement_%'")
        .all(),
    ).toEqual([]);
    migrate(db);
    for (const original of before)
      expect(
        db.$client
          .prepare(
            `SELECT ${original.columns.map((c) => `"${c}"`).join(",")} FROM ${original.table} ORDER BY rowid`,
          )
          .all(),
      ).toEqual(original.rows);
    for (const table of [
      "owner",
      "counter",
      "operation",
      "worker",
      "workspace",
      "binding",
      "retry_consent",
    ])
      expect(
        db.$client.prepare(`SELECT * FROM placement_${table}`).all(),
      ).toEqual([]);
    expect(
      db.$client
        .prepare(
          "SELECT placement_operation_id,placement_fence FROM queued_thread_messages",
        )
        .all(),
    ).toEqual([
      { placement_operation_id: null, placement_fence: null },
      { placement_operation_id: null, placement_fence: null },
    ]);
    expect(
      db.$client
        .prepare("SELECT owner_placement_operation_id FROM environments")
        .all(),
    ).toEqual([{ owner_placement_operation_id: null }]);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
    migrate(db);
    expect(db.$client.pragma("foreign_key_check")).toEqual([]);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
