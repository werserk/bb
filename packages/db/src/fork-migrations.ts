// werserk fork: the fork's migrations live in `drizzle/fork/`, with their own
// journal and their own ledger table, so `drizzle/` and `__drizzle_migrations`
// stay exactly upstream's. See "Database migrations" in FORK.md.
import { readMigrationFiles } from "drizzle-orm/migrator";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbConnection } from "./connection.js";
import { forkMigrationsCoveredUpstream } from "./fork-upstream-backports.js";

export const forkMigrationsTable = "__bb_fork_migrations";

interface ForkMigration {
  tag: string;
  createdAt: number;
  hash: string;
}

interface LedgerRow {
  hash: string;
  createdAt: number;
}

function resolveForkMigrationsFolder(migrationsFolder: string): string {
  const folder = join(migrationsFolder, "fork");
  if (!existsSync(join(folder, "meta", "_journal.json"))) {
    throw new Error(
      `Missing fork database migrations. Expected meta/_journal.json under ${folder}`,
    );
  }
  return folder;
}

function readForkMigrations(migrationsFolder: string): ForkMigration[] {
  const folder = resolveForkMigrationsFolder(migrationsFolder);
  const journal = JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string; when: number }[] };
  const tagByWhen = new Map(journal.entries.map((e) => [e.when, e.tag]));
  return readMigrationFiles({ migrationsFolder: folder }).map((migration) => ({
    tag:
      tagByWhen.get(migration.folderMillis) ?? String(migration.folderMillis),
    createdAt: migration.folderMillis,
    hash: migration.hash,
  }));
}

function readLedger(db: DbConnection, table: string): LedgerRow[] {
  const exists = db.$client
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (exists === undefined) return [];
  return db.$client
    .prepare<[], LedgerRow>(
      `SELECT hash, created_at AS createdAt FROM "${table}"`,
    )
    .all();
}

/**
 * Builds before the fork ledger recorded fork migrations in
 * `__drizzle_migrations`. Move those rows (matched by timestamp, checked by
 * hash) into the fork ledger in one transaction. A hash mismatch throws before
 * anything moves. A no-op on a fresh database and after the first run.
 */
export function adoptLegacyForkMigrationRows(
  db: DbConnection,
  migrationsFolder: string,
): void {
  const upstreamRows = readLedger(db, "__drizzle_migrations");
  if (upstreamRows.length === 0) return;
  const legacy = readForkMigrations(migrationsFolder).filter((migration) => {
    const rows = upstreamRows.filter(
      (row) => Number(row.createdAt) === migration.createdAt,
    );
    const mismatch = rows.find((row) => row.hash !== migration.hash);
    if (mismatch !== undefined) {
      throw new Error(
        `Fork migration ${migration.tag} (when=${migration.createdAt}) is recorded in __drizzle_migrations with hash ${mismatch.hash}, but its file has hash ${migration.hash}. No ledger rows were moved.`,
      );
    }
    return rows.length > 0;
  });
  if (legacy.length === 0) return;

  const sqlite = db.$client;
  sqlite.transaction(() => {
    // The table shape Drizzle creates for a migrations ledger.
    sqlite.exec(
      `CREATE TABLE IF NOT EXISTS "${forkMigrationsTable}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
    );
    const forkHas = sqlite.prepare<[number]>(
      `SELECT 1 FROM "${forkMigrationsTable}" WHERE created_at = ?`,
    );
    const insert = sqlite.prepare<[string, number]>(
      `INSERT INTO "${forkMigrationsTable}" (hash, created_at) VALUES (?, ?)`,
    );
    const remove = sqlite.prepare<[number]>(
      "DELETE FROM __drizzle_migrations WHERE created_at = ?",
    );
    for (const migration of legacy) {
      if (forkHas.get(migration.createdAt) === undefined) {
        insert.run(migration.hash, migration.createdAt);
      }
      remove.run(migration.createdAt);
    }
  })();
}

/**
 * Drizzle's migrator, with one difference: a fork migration whose upstream
 * migration this database already applied is recorded without running (see
 * fork-upstream-backports.ts). Like Drizzle, it runs every migration newer
 * than the newest ledger row, in one transaction.
 */
function runForkMigrations(db: DbConnection, migrationsFolder: string): void {
  const covered = forkMigrationsCoveredUpstream(db, migrationsFolder);
  const migrations = readMigrationFiles({
    migrationsFolder: resolveForkMigrationsFolder(migrationsFolder),
  });
  const sqlite = db.$client;
  // The table shape Drizzle creates for a migrations ledger.
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS "${forkMigrationsTable}" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`,
  );
  const newest = sqlite
    .prepare<[], { createdAt: number }>(
      `SELECT created_at AS createdAt FROM "${forkMigrationsTable}" ORDER BY created_at DESC LIMIT 1`,
    )
    .get();
  const insert = sqlite.prepare<[string, number]>(
    `INSERT INTO "${forkMigrationsTable}" (hash, created_at) VALUES (?, ?)`,
  );
  sqlite.transaction(() => {
    for (const migration of migrations) {
      if (
        newest !== undefined &&
        Number(newest.createdAt) >= migration.folderMillis
      )
        continue;
      if (!covered.has(migration.folderMillis)) {
        for (const statement of migration.sql) sqlite.prepare(statement).run();
      }
      insert.run(migration.hash, migration.folderMillis);
    }
  })();
}

/**
 * Apply pending fork migrations, then require every fork migration in the
 * fork ledger with its file's hash. The runner skips a migration older than
 * the newest ledger row, so a fork migration merged out of timestamp order
 * fails here instead of being skipped silently.
 */
export function applyForkMigrations(
  db: DbConnection,
  migrationsFolder: string,
): void {
  runForkMigrations(db, migrationsFolder);
  const applied = readLedger(db, forkMigrationsTable);
  const problems = readForkMigrations(migrationsFolder)
    .filter(
      (migration) =>
        !applied.some(
          (row) =>
            Number(row.createdAt) === migration.createdAt &&
            row.hash === migration.hash,
        ),
    )
    .map((migration) => `${migration.tag} (when=${migration.createdAt})`);
  if (problems.length > 0) {
    throw new Error(
      `Fork migration history is incomplete after migration. Missing or mismatched in ${forkMigrationsTable}: ${problems.join("; ")}.`,
    );
  }
}
