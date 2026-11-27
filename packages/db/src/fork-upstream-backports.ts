// werserk fork: fork migrations that backport an upstream migration before a
// sync brings it. Until the sync, the fork migration does the work. After it,
// upstream's migration owns the change, and these steps keep a database that
// already ran the backport from running it twice. See "Database migrations" in
// FORK.md.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DbConnection } from "./connection.js";

interface UpstreamBackport {
  /** Fork migration tag in drizzle/fork/meta/_journal.json. */
  forkTag: string;
  /** Upstream migration tag it backports, in drizzle/meta/_journal.json. */
  upstreamTag: string;
}

// get-bb/bb #7872: the plugin re-ask time gets its own column.
const recheckAtBackport: UpstreamBackport = {
  forkTag: "0007_queued_message_recheck_at",
  upstreamTag: "0162_queued_message_recheck_at",
};

export const forkBackportsOfUpstream: readonly UpstreamBackport[] = [
  recheckAtBackport,
];

function journalWhen(folder: string, tag: string): number | undefined {
  const path = join(folder, "meta", "_journal.json");
  if (!existsSync(path)) return undefined;
  const journal = JSON.parse(readFileSync(path, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  return journal.entries.find((entry) => entry.tag === tag)?.when;
}

function tableExists(db: DbConnection, table: string): boolean {
  return (
    db.$client
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function columnExists(
  db: DbConnection,
  table: string,
  column: string,
): boolean {
  return db.$client
    .prepare<[], { name: string }>(`PRAGMA table_info("${table}")`)
    .all()
    .some((row) => row.name === column);
}

function upstreamApplied(db: DbConnection, when: number): boolean {
  return (
    tableExists(db, "__drizzle_migrations") &&
    db.$client
      .prepare("SELECT 1 FROM __drizzle_migrations WHERE created_at = ?")
      .get(when) !== undefined
  );
}

/**
 * The createdAt of each fork migration whose upstream migration this database
 * has already applied. The fork runner records these without running them: on
 * a database created or upgraded after the sync, upstream already made the
 * change.
 */
export function forkMigrationsCoveredUpstream(
  db: DbConnection,
  migrationsFolder: string,
): Set<number> {
  const covered = new Set<number>();
  for (const backport of forkBackportsOfUpstream) {
    const upstreamWhen = journalWhen(migrationsFolder, backport.upstreamTag);
    const forkWhen = journalWhen(
      join(migrationsFolder, "fork"),
      backport.forkTag,
    );
    if (upstreamWhen === undefined || forkWhen === undefined) continue;
    if (upstreamApplied(db, upstreamWhen)) covered.add(forkWhen);
  }
  return covered;
}

const RECHECK_STAGE = "__bb_fork_stage_queued_message_recheck_at";

/**
 * Run before upstream's migrator. A database that ran fork 0007 already has
 * `recheck_at`, its index, and rows in the new meaning: on a plugin-held row,
 * `send_at` is the sender's time. Upstream 0162 would add the column again
 * (and fail) and move those sender times into `recheck_at`. So copy the
 * values out, drop the column and index, and let 0162 run on a table without
 * them. {@link restoreStagedForkRecheckAt} puts the values back.
 *
 * A no-op before the sync (no 0162 in the journal), after 0162 has applied,
 * and on a database without the column. If an earlier run staged and stopped,
 * the stage is kept as it is.
 */
export function stageForkRecheckAtForUpstream(
  db: DbConnection,
  migrationsFolder: string,
): void {
  if (tableExists(db, RECHECK_STAGE)) return;
  const upstreamWhen = journalWhen(
    migrationsFolder,
    recheckAtBackport.upstreamTag,
  );
  if (upstreamWhen === undefined || upstreamApplied(db, upstreamWhen)) return;
  if (!tableExists(db, "queued_thread_messages")) return;
  if (!columnExists(db, "queued_thread_messages", "recheck_at")) return;
  const sqlite = db.$client;
  sqlite.transaction(() => {
    sqlite.exec(`
      CREATE TABLE "${RECHECK_STAGE}" (
        id text PRIMARY KEY NOT NULL,
        recheck_at integer,
        send_at integer,
        state text NOT NULL
      );
      INSERT INTO "${RECHECK_STAGE}" (id, recheck_at, send_at, state)
        SELECT id, recheck_at, send_at, state FROM queued_thread_messages
        WHERE recheck_at IS NOT NULL
          OR (wait_holder IS NOT NULL AND send_at IS NOT NULL);
      DROP INDEX IF EXISTS queued_thread_messages_recheck_idx;
      ALTER TABLE queued_thread_messages DROP COLUMN recheck_at;
    `);
  })();
}

/**
 * Run after upstream's migrator, also when it threw. Puts the staged values
 * back by row id and drops the stage. If upstream's migrator did not add
 * `recheck_at` (it failed, or this build has no 0162), the fork's column and
 * index come back first, so the database is as it was before staging.
 */
export function restoreStagedForkRecheckAt(db: DbConnection): void {
  if (!tableExists(db, RECHECK_STAGE)) return;
  const sqlite = db.$client;
  sqlite.transaction(() => {
    if (!columnExists(db, "queued_thread_messages", "recheck_at")) {
      // The same DDL as fork 0007 and upstream 0162.
      sqlite.exec(`
        ALTER TABLE queued_thread_messages ADD recheck_at integer;
        CREATE INDEX queued_thread_messages_recheck_idx ON queued_thread_messages (state, recheck_at, id) WHERE "queued_thread_messages"."recheck_at" IS NOT NULL;
      `);
    }
    sqlite.exec(`
      UPDATE queued_thread_messages
        SET recheck_at = stage.recheck_at,
            send_at = stage.send_at,
            state = stage.state
        FROM "${RECHECK_STAGE}" AS stage
        WHERE queued_thread_messages.id = stage.id;
      DROP TABLE "${RECHECK_STAGE}";
    `);
  })();
}
