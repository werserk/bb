import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";
import { forkMigrationsTable } from "../src/fork-migrations.js";
import { createConnection, migrate, type DbConnection } from "../src/index.js";

// werserk fork: fork migrations live in drizzle/fork/ with their own ledger.
// Builds before that recorded them in __drizzle_migrations; migrate() moves
// those rows. These tests build that legacy state forward, the way the
// owner's database reached it.

const mainFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const forkFolder = fileURLToPath(new URL("../drizzle/fork", import.meta.url));
const mainMigrations = readMigrationFiles({ migrationsFolder: mainFolder });
const forkMigrations = readMigrationFiles({ migrationsFolder: forkFolder });
const mainJournal = JSON.parse(
  readFileSync(`${mainFolder}/meta/_journal.json`, "utf8"),
) as { entries: { tag: string; when: number }[] };
const forkJournal = JSON.parse(
  readFileSync(`${forkFolder}/meta/_journal.json`, "utf8"),
) as { entries: { tag: string; when: number }[] };

// The ledger identity of the fork migrations already applied in production;
// newer fork migrations are appended to the journal after these.
const productionForkMigrations = [
  ["0000_petite_karen_page", 1794014431811],
  ["0001_lumpy_hammerhead", 1794352508595],
  ["0002_clean_mockingbird", 1794352736272],
  ["0003_lively_madrox", 1794353752629],
  ["0004_panoramic_hedge_knight", 1794456846322],
  ["0005_glorious_mentor", 1794458242846],
] as const;

const upstreamAfterForkBase = [
  "0148_queued_message_delivery_mode",
  "0149_coalesced_system_notices",
  "0150_thread_status_changed_at",
  "0151_hand_diff_viewed_files_to_git_plugin",
  "0152_small_storage_cleanups",
];

function mainWhen(tag: string): number {
  const entry = mainJournal.entries.find((candidate) => candidate.tag === tag);
  if (entry === undefined) throw new Error(`Missing journal entry ${tag}`);
  return entry.when;
}

const forkBaseWhen = mainWhen("0147_git_and_pr_status_plugin_show_settings");
const forkWhens = forkMigrations.map((migration) => migration.folderMillis);

const viewedMarks = [
  ["env_1", "uncommitted", "a.ts", "rev-a", 10],
  ["env_1", "commit:abcdef1", "b.ts", "rev-b", 30],
  ["env_2", "all:main", "c.ts", "rev-c", 20],
] as const;
const serviceTurn = JSON.stringify({ version: 1, visibility: "hidden" });

function columnNames(db: DbConnection, table: string): string[] {
  return db.$client
    .prepare<[], { name: string }>(`PRAGMA table_info("${table}")`)
    .all()
    .map((column) => column.name);
}

function seed(db: DbConnection): void {
  const sqlite = db.$client;
  sqlite.exec(`
    INSERT INTO hosts (id, name, type, created_at, updated_at) VALUES ('host_1', 'fixture', 'local', 1, 1);
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj_1', 'fixture', 1, 1);
    INSERT INTO environments (id, project_id, host_id, created_at, updated_at) VALUES
      ('env_1', 'proj_1', 'host_1', 1, 1), ('env_2', 'proj_1', 'host_1', 1, 1);
    INSERT INTO threads (id, project_id, provider_id, latest_attention_at, created_at, updated_at) VALUES
      ('thr_1', 'proj_1', 'codex', 5, 1, 1000), ('thr_2', 'proj_1', 'codex', 5, 1, 2000);
    INSERT INTO queued_thread_messages (id, thread_id, content, model, reasoning_level, permission_mode, service_tier, state, sort_key, created_at, updated_at)
      VALUES ('qm_1', 'thr_1', '[]', 'fixture', 'low', 'full', 'default', 'queued', 'a', 1, 1);
  `);
  const insertMark = sqlite.prepare(
    "INSERT INTO diff_viewed_files (environment_id, target_key, path, revision, updated_at) VALUES (?, ?, ?, ?, ?)",
  );
  for (const mark of viewedMarks) insertMark.run(...mark);

  const queueColumns = columnNames(db, "queued_thread_messages");
  if (queueColumns.includes("service_turn")) {
    sqlite
      .prepare("UPDATE queued_thread_messages SET service_turn = ?")
      .run(serviceTurn);
  }
  if (queueColumns.includes("question_id")) {
    sqlite.exec(
      "UPDATE queued_thread_messages SET question_id = 'cq_1', question_revision = 2",
    );
  }
  if (columnNames(db, "conversation_questions").length > 0) {
    sqlite.exec(
      "INSERT INTO conversation_questions (id, thread_id, publication, material_manifest, created_at, updated_at) VALUES ('cq_1', 'thr_1', '{}', '[]', 1, 1)",
    );
  }
  if (columnNames(db, "conversation_questions").includes("dispatched_at")) {
    sqlite.exec("UPDATE conversation_questions SET dispatched_at = 7");
  }
}

/** Upstream 0000-0147, then the first `forkCount` fork migrations, all in
 * __drizzle_migrations: the shape the pre-fork-ledger builds left behind. */
function legacyDatabase(forkCount: number): DbConnection {
  const db = createConnection(":memory:");
  const sqlite = db.$client;
  sqlite.exec(`
    CREATE TABLE "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric);
    CREATE TEMP TABLE bb_migration_queued_message_groups (id TEXT PRIMARY KEY, group_with_next INTEGER NOT NULL);
    CREATE TEMP TABLE bb_migration_local_host (id TEXT PRIMARY KEY);
    CREATE TEMP TABLE bb_migration_existing_installation (existing INTEGER NOT NULL);
    INSERT INTO bb_migration_existing_installation VALUES (0);
  `);
  const record = sqlite.prepare(
    'INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)',
  );
  const applied = [
    ...mainMigrations.filter((m) => m.folderMillis <= forkBaseWhen),
    ...forkMigrations.slice(0, forkCount),
  ];
  sqlite.pragma("foreign_keys = OFF");
  for (const migration of applied) {
    for (const statement of migration.sql) sqlite.exec(statement);
    record.run(migration.hash, migration.folderMillis);
  }
  sqlite.pragma("foreign_keys = ON");
  seed(db);
  return db;
}

function ledgerWhens(db: DbConnection, table: string): number[] {
  const exists = db.$client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) return [];
  return db.$client
    .prepare<[], { createdAt: number }>(
      `SELECT created_at AS createdAt FROM "${table}" ORDER BY created_at`,
    )
    .all()
    .map((row) => Number(row.createdAt));
}

function ledgers(db: DbConnection) {
  const read = (table: string) =>
    ledgerWhens(db, table).length === 0
      ? []
      : db.$client
          .prepare(
            `SELECT hash, created_at FROM "${table}" ORDER BY created_at`,
          )
          .all();
  return {
    main: read("__drizzle_migrations"),
    fork: read(forkMigrationsTable),
  };
}

/** Order-insensitive schema description: object names, and per table the
 * set of columns and the set of indexes with their columns. */
function describeSchema(db: DbConnection) {
  const sqlite = db.$client;
  const objects = sqlite
    .prepare<[], { type: string; name: string }>(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') ORDER BY type, name",
    )
    .all();
  const tables: Record<string, { columns: string[]; indexes: string[] }> = {};
  for (const { name } of objects.filter((object) => object.type === "table")) {
    const columns = sqlite
      .prepare<[], { cid: number }>(`PRAGMA table_info("${name}")`)
      .all()
      .map(({ cid: _cid, ...column }) => JSON.stringify(column))
      .sort();
    const indexes = sqlite
      .prepare<[], { seq: number; name: string }>(
        `PRAGMA index_list("${name}")`,
      )
      .all()
      .map(({ seq: _seq, ...index }) =>
        JSON.stringify({
          ...index,
          columns: sqlite
            .prepare<[], { name: string | null }>(
              `PRAGMA index_info("${index.name}")`,
            )
            .all()
            .map((column) => column.name),
        }),
      )
      .sort();
    tables[name] = { columns, indexes };
  }
  return {
    objects: objects.map((object) => `${object.type}:${object.name}`),
    tables,
  };
}

function freshSchema() {
  const db = createConnection(":memory:");
  try {
    migrate(db);
    return describeSchema(db);
  } finally {
    db.$client.close();
  }
}

function seededData(db: DbConnection) {
  const sqlite = db.$client;
  return {
    threads: sqlite
      .prepare(
        "SELECT id, status_changed_at AS statusChangedAt, updated_at AS updatedAt FROM threads ORDER BY id",
      )
      .all(),
    queue: sqlite
      .prepare(
        "SELECT id, delivery_mode AS deliveryMode, service_turn AS serviceTurn, question_id AS questionId, question_revision AS questionRevision FROM queued_thread_messages",
      )
      .all(),
    questions: sqlite
      .prepare(
        "SELECT id, dispatched_at AS dispatchedAt FROM conversation_questions",
      )
      .all(),
    handoff: sqlite
      .prepare<[], { value: string; updatedAt: number }>(
        "SELECT value, updated_at AS updatedAt FROM plugin_kv WHERE plugin_id = 'bb--git' AND key = 'viewedMarksFromCore'",
      )
      .all(),
  };
}

function expectedHandoff() {
  return viewedMarks
    .map(([environmentId, targetKey, path, revision, updatedAt]) => ({
      environmentId,
      targetKey,
      path,
      revision,
      updatedAt,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function expectMigratedLedgers(db: DbConnection): void {
  expect(ledgerWhens(db, forkMigrationsTable)).toEqual(forkWhens);
  const mainWhens = ledgerWhens(db, "__drizzle_migrations");
  expect(mainWhens.filter((when) => forkWhens.includes(when))).toEqual([]);
  expect(mainWhens).toEqual(
    mainMigrations.map((migration) => migration.folderMillis),
  );
  for (const tag of upstreamAfterForkBase) {
    expect(mainWhens).toContain(mainWhen(tag));
  }
}

describe("fork migration ledger", () => {
  it("keeps the production ledger identity of the fork migrations", () => {
    const produced = productionForkMigrations.length;
    expect(
      forkJournal.entries
        .slice(0, produced)
        .map((entry) => [entry.tag, entry.when]),
    ).toEqual(productionForkMigrations);
    expect(forkWhens.slice(0, produced)).toEqual(
      productionForkMigrations.map(([, when]) => when),
    );
    const lastProduced = productionForkMigrations[produced - 1]![1];
    for (const when of forkWhens.slice(produced)) {
      expect(when).toBeGreaterThan(lastProduced);
    }
  });

  it("adopts legacy rows from the production shape and migrates its data", () => {
    const db = legacyDatabase(productionForkMigrations.length);
    try {
      migrate(db);
      expectMigratedLedgers(db);

      const data = seededData(db);
      expect(data.threads).toEqual([
        { id: "thr_1", statusChangedAt: 1000, updatedAt: 1000 },
        { id: "thr_2", statusChangedAt: 2000, updatedAt: 2000 },
      ]);
      expect(data.queue).toEqual([
        {
          id: "qm_1",
          deliveryMode: "steer",
          serviceTurn,
          questionId: "cq_1",
          questionRevision: 2,
        },
      ]);
      expect(data.questions).toEqual([{ id: "cq_1", dispatchedAt: 7 }]);
      expect(data.handoff).toHaveLength(1);
      const handoff = data.handoff[0];
      expect(handoff?.updatedAt).toBe(30);
      expect(
        (JSON.parse(handoff?.value ?? "[]") as { path: string }[]).sort(
          (a, b) => a.path.localeCompare(b.path),
        ),
      ).toEqual(expectedHandoff());
      expect(columnNames(db, "diff_viewed_files")).toEqual([]);

      const schema = describeSchema(db);
      expect(schema).toEqual(freshSchema());

      const before = { ledgers: ledgers(db), data };
      migrate(db);
      expect({ ledgers: ledgers(db), data: seededData(db) }).toEqual(before);
      expect(describeSchema(db)).toEqual(schema);
    } finally {
      db.$client.close();
    }
  });

  it("applies the remaining fork migrations after adopting the first two", () => {
    const db = legacyDatabase(2);
    try {
      migrate(db);
      expectMigratedLedgers(db);
      expect(seededData(db).queue).toEqual([
        {
          id: "qm_1",
          deliveryMode: "steer",
          serviceTurn,
          questionId: null,
          questionRevision: null,
        },
      ]);
      expect(seededData(db).questions).toEqual([
        { id: "cq_1", dispatchedAt: null },
      ]);
      expect(describeSchema(db)).toEqual(freshSchema());
    } finally {
      db.$client.close();
    }
  });

  it("records a fresh database in both ledgers and changes nothing on rerun", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      expectMigratedLedgers(db);
      const before = { ledgers: ledgers(db), schema: describeSchema(db) };
      migrate(db);
      expect({ ledgers: ledgers(db), schema: describeSchema(db) }).toEqual(
        before,
      );
    } finally {
      db.$client.close();
    }
  });

  it("refuses a legacy row whose hash differs and moves nothing", () => {
    const db = legacyDatabase(productionForkMigrations.length);
    try {
      db.$client
        .prepare(
          "UPDATE __drizzle_migrations SET hash = 'stale' WHERE created_at = ?",
        )
        .run(forkWhens[3]);
      const before = { ledgers: ledgers(db), schema: describeSchema(db) };

      expect(() => migrate(db)).toThrow(
        /Fork migration 0003_lively_madrox .*hash stale.*No ledger rows were moved/,
      );
      expect({ ledgers: ledgers(db), schema: describeSchema(db) }).toEqual(
        before,
      );
      expect(ledgerWhens(db, forkMigrationsTable)).toEqual([]);
    } finally {
      db.$client.close();
    }
  });

  it("refuses a fork migration that Drizzle skipped by timestamp", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      db.$client
        .prepare(`DELETE FROM "${forkMigrationsTable}" WHERE created_at = ?`)
        .run(forkWhens[2]);

      expect(() => migrate(db)).toThrow(
        /Fork migration history is incomplete.*0002_clean_mockingbird/,
      );
    } finally {
      db.$client.close();
    }
  });
});
