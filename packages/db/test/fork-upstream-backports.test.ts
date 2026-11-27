import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { forkMigrationsTable } from "../src/fork-migrations.js";
import { stageForkRecheckAtForUpstream } from "../src/fork-upstream-backports.js";
import {
  createConnection,
  createThread,
  migrate,
  noopNotifier,
  type DbConnection,
} from "../src/index.js";

// werserk fork: fork 0007 backports upstream 0162 (get-bb/bb #7872). These
// tests run a later sync's migration against today's databases: a copy of
// drizzle/ with upstream's 0162 file (test/fixtures, taken unchanged from
// upstream) added to the upstream journal.

const drizzleFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const upstream0162 = fileURLToPath(
  new URL("./fixtures/0162_queued_message_recheck_at.sql", import.meta.url),
);
const UPSTREAM_0162_WHEN = 1795210022396;
const UPSTREAM_0162_TAG = "0162_queued_message_recheck_at";
const FORK_0007_TAG = "0007_queued_message_recheck_at";

type Journal = {
  entries: {
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }[];
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    rmSync(folder, { recursive: true, force: true });
});

function copyDrizzle(): string {
  const folder = mkdtempSync(join(tmpdir(), "bb-fork-backport-"));
  folders.push(folder);
  cpSync(drizzleFolder, folder, { recursive: true });
  return folder;
}

function readJournal(folder: string): Journal {
  return JSON.parse(
    readFileSync(join(folder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
}

function writeJournal(folder: string, journal: Journal): void {
  writeFileSync(
    join(folder, "meta", "_journal.json"),
    JSON.stringify(journal, null, 2),
  );
}

/** drizzle/ as it looks after a sync that brings upstream 0162. */
function syncedFolder(): string {
  const folder = copyDrizzle();
  const journal = readJournal(folder);
  // After the real sync, drizzle/ already has it.
  if (journal.entries.some((entry) => entry.tag === UPSTREAM_0162_TAG)) {
    return folder;
  }
  cpSync(upstream0162, join(folder, `${UPSTREAM_0162_TAG}.sql`));
  journal.entries.push({
    idx: journal.entries.length,
    version: "6",
    when: UPSTREAM_0162_WHEN,
    tag: UPSTREAM_0162_TAG,
    breakpoints: true,
  });
  writeJournal(folder, journal);
  return folder;
}

/** drizzle/ as the build before this backport had it: no fork 0007, no upstream 0162. */
function preBackportFolder(): string {
  const folder = copyDrizzle();
  const upstream = readJournal(folder);
  if (upstream.entries.some((entry) => entry.tag === UPSTREAM_0162_TAG)) {
    unlinkSync(join(folder, `${UPSTREAM_0162_TAG}.sql`));
    upstream.entries = upstream.entries.filter(
      (entry) => entry.tag !== UPSTREAM_0162_TAG,
    );
    writeJournal(folder, upstream);
  }
  const fork = join(folder, "fork");
  unlinkSync(join(fork, `${FORK_0007_TAG}.sql`));
  const journal = readJournal(fork);
  journal.entries = journal.entries.filter(
    (entry) => entry.tag !== FORK_0007_TAG,
  );
  writeJournal(fork, journal);
  return folder;
}

function forkWhen(tag: string): number {
  const entry = readJournal(join(drizzleFolder, "fork")).entries.find(
    (e) => e.tag === tag,
  );
  if (entry === undefined) throw new Error(`Missing fork journal entry ${tag}`);
  return entry.when;
}

const limiter = JSON.stringify({
  kind: "plugin",
  pluginId: "limiter",
  reason: "full",
});
const time = JSON.stringify({ kind: "time" });

interface Row {
  id: string;
  state: string;
  sendAt: number | null;
  recheckAt?: number | null;
  waitingOn: string | null;
  waitHolder: string | null;
}

function insertRow(db: DbConnection, threadId: string, row: Row): void {
  const withRecheck = row.recheckAt !== undefined;
  db.$client
    .prepare(
      `INSERT INTO queued_thread_messages (
        id, thread_id, content, model, reasoning_level, permission_mode,
        service_tier, state, send_at, ${withRecheck ? "recheck_at," : ""}
        waiting_on, wait_holder, sort_key, created_at, updated_at
      ) VALUES (
        @id, @threadId, '[]', 'gpt-5', 'medium', 'full', 'default', @state,
        @sendAt, ${withRecheck ? "@recheckAt," : ""} @waitingOn, @waitHolder,
        @id, 1000, 1000
      )`,
    )
    .run({ threadId, ...row });
}

function queueRows(db: DbConnection) {
  return db.$client
    .prepare(
      "SELECT id, state, send_at AS sendAt, recheck_at AS recheckAt FROM queued_thread_messages ORDER BY id",
    )
    .all();
}

function columnCount(db: DbConnection, column: string): number {
  return db.$client
    .prepare<[], { name: string }>("PRAGMA table_info(queued_thread_messages)")
    .all()
    .filter((row) => row.name === column).length;
}

function hasIndex(db: DbConnection, name: string): boolean {
  return (
    db.$client
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) !== undefined
  );
}

function hasTable(db: DbConnection, name: string): boolean {
  return (
    db.$client
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

function ledgerHas(db: DbConnection, table: string, when: number): boolean {
  return (
    db.$client
      .prepare(`SELECT 1 FROM "${table}" WHERE created_at = ?`)
      .get(when) !== undefined
  );
}

function withThread(db: DbConnection): string {
  return createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "test-provider",
    status: "idle",
  }).id;
}

// Rows on a database that already ran fork 0007, in the new meaning.
const fixedRows: Row[] = [
  // plugin-held with the sender's time, and the plugin's re-ask time
  {
    id: "a-plugin-sender",
    state: "scheduled",
    sendAt: 9000,
    recheckAt: 3000,
    waitingOn: limiter,
    waitHolder: "plugin:limiter",
  },
  // plugin-held, no sender time
  {
    id: "b-plugin-recheck",
    state: "waiting",
    sendAt: null,
    recheckAt: 3000,
    waitingOn: limiter,
    waitHolder: "plugin:limiter",
  },
  // time only
  {
    id: "c-time",
    state: "scheduled",
    sendAt: 9000,
    recheckAt: null,
    waitingOn: time,
    waitHolder: null,
  },
];
const fixedExpected = [
  { id: "a-plugin-sender", state: "scheduled", sendAt: 9000, recheckAt: 3000 },
  { id: "b-plugin-recheck", state: "waiting", sendAt: null, recheckAt: 3000 },
  { id: "c-time", state: "scheduled", sendAt: 9000, recheckAt: null },
];

describe("fork 0007 backport of upstream 0162", () => {
  it("fork 0007 is today's migration and matches upstream 0162 byte for byte", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      expect(columnCount(db, "recheck_at")).toBe(1);
      expect(hasIndex(db, "queued_thread_messages_recheck_idx")).toBe(true);
      expect(ledgerHas(db, forkMigrationsTable, forkWhen(FORK_0007_TAG))).toBe(
        true,
      );
      expect(
        readFileSync(
          join(drizzleFolder, "fork", `${FORK_0007_TAG}.sql`),
          "utf8",
        ),
      ).toBe(readFileSync(upstream0162, "utf8"));
    } finally {
      db.$client.close();
    }
  });

  it("moves a plugin's re-ask time out of send_at on upgrade", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db, { migrationsFolder: preBackportFolder() });
      const threadId = withThread(db);
      const plugin = { waitingOn: limiter, waitHolder: "plugin:limiter" };
      insertRow(db, threadId, {
        id: "plugin-scheduled",
        state: "scheduled",
        sendAt: 9000,
        ...plugin,
      });
      insertRow(db, threadId, {
        id: "plugin-waiting",
        state: "waiting",
        sendAt: null,
        ...plugin,
      });
      insertRow(db, threadId, {
        id: "time",
        state: "scheduled",
        sendAt: 9000,
        waitingOn: time,
        waitHolder: null,
      });

      migrate(db);

      expect(queueRows(db)).toEqual([
        {
          id: "plugin-scheduled",
          state: "waiting",
          sendAt: null,
          recheckAt: 9000,
        },
        {
          id: "plugin-waiting",
          state: "waiting",
          sendAt: null,
          recheckAt: null,
        },
        { id: "time", state: "scheduled", sendAt: 9000, recheckAt: null },
      ]);
    } finally {
      db.$client.close();
    }
  });

  it("a sync that brings 0162 neither fails nor re-runs it on a database that ran 0007", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const threadId = withThread(db);
      for (const row of fixedRows) insertRow(db, threadId, row);

      const synced = syncedFolder();
      migrate(db, { migrationsFolder: synced });

      expect(queueRows(db)).toEqual(fixedExpected);
      expect(columnCount(db, "recheck_at")).toBe(1);
      expect(hasIndex(db, "queued_thread_messages_recheck_idx")).toBe(true);
      expect(hasTable(db, "__bb_fork_stage_queued_message_recheck_at")).toBe(
        false,
      );
      expect(ledgerHas(db, "__drizzle_migrations", UPSTREAM_0162_WHEN)).toBe(
        true,
      );

      migrate(db, { migrationsFolder: synced });
      expect(queueRows(db)).toEqual(fixedExpected);
    } finally {
      db.$client.close();
    }
  });

  it("after the sync, a fresh database gets 0162 from upstream and records fork 0007 without running it", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db, { migrationsFolder: syncedFolder() });
      expect(columnCount(db, "recheck_at")).toBe(1);
      expect(ledgerHas(db, "__drizzle_migrations", UPSTREAM_0162_WHEN)).toBe(
        true,
      );
      expect(ledgerHas(db, forkMigrationsTable, forkWhen(FORK_0007_TAG))).toBe(
        true,
      );
    } finally {
      db.$client.close();
    }
  });

  it("after the sync, a database that never ran 0007 gets upstream's data move", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db, { migrationsFolder: preBackportFolder() });
      const threadId = withThread(db);
      insertRow(db, threadId, {
        id: "plugin-scheduled",
        state: "scheduled",
        sendAt: 9000,
        waitingOn: limiter,
        waitHolder: "plugin:limiter",
      });

      migrate(db, { migrationsFolder: syncedFolder() });

      expect(queueRows(db)).toEqual([
        {
          id: "plugin-scheduled",
          state: "waiting",
          sendAt: null,
          recheckAt: 9000,
        },
      ]);
      expect(ledgerHas(db, forkMigrationsTable, forkWhen(FORK_0007_TAG))).toBe(
        true,
      );
    } finally {
      db.$client.close();
    }
  });

  it("a stage left by a stopped run is restored by the next run, with or without 0162", () => {
    for (const folder of [undefined, syncedFolder()]) {
      const db = createConnection(":memory:");
      try {
        migrate(db);
        const threadId = withThread(db);
        for (const row of fixedRows) insertRow(db, threadId, row);
        stageForkRecheckAtForUpstream(db, syncedFolder());
        expect(columnCount(db, "recheck_at")).toBe(0);

        migrate(db, folder === undefined ? {} : { migrationsFolder: folder });

        expect(queueRows(db)).toEqual(fixedExpected);
        expect(hasIndex(db, "queued_thread_messages_recheck_idx")).toBe(true);
        expect(hasTable(db, "__bb_fork_stage_queued_message_recheck_at")).toBe(
          false,
        );
      } finally {
        db.$client.close();
      }
    }
  });

  it("the build before this backport still starts on a database that ran 0007", () => {
    const db = createConnection(":memory:");
    try {
      migrate(db);
      const threadId = withThread(db);
      for (const row of fixedRows) insertRow(db, threadId, row);

      expect(() =>
        migrate(db, { migrationsFolder: preBackportFolder() }),
      ).not.toThrow();
      // The old build ignores recheck_at and leaves every value as it is.
      expect(queueRows(db)).toEqual(fixedExpected);
    } finally {
      db.$client.close();
    }
  });
});
