import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import Database from "better-sqlite3";
import { z } from "zod";
import type { PluginKvStorage } from "@get-bb/plugin-sdk";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import type { Account } from "./contracts.js";
import { AccountStore, QUOTA_MIGRATIONS, QuotaStore } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function delayedAccountReads(kv: PluginKvStorage): PluginKvStorage {
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const value = await kv.get<T>(key);
      if (key === "accounts:v1") {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return value;
    },
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    list: (prefix) => kv.list(prefix),
  };
}

describe("AccountStore", () => {
  it("loads account metadata written before account UUIDs were stored", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    const store = new AccountStore(
      host.bb.storage.kv,
      path.join(dataDir, "secrets"),
    );
    await host.bb.storage.kv.set("accounts:v1", [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "claude",
        kind: "oauth",
        label: "existing",
        email: null,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: 100,
        createdAt: 1,
      },
    ]);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(await store.list()).toEqual([
      expect.objectContaining({ accountUuid: null }),
    ]);
  });

  it("preserves both accounts added concurrently", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-store-"));
    const host = createFakePluginHost({ pluginId: "account-pool", dataDir });
    const secretsDir = path.join(dataDir, "secrets");
    const store = new AccountStore(
      delayedAccountReads(host.bb.storage.kv),
      secretsDir,
    );
    await store.initialize();
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const account = (
      label: string,
    ): Omit<Account, "id" | "createdAt" | "lastUsedAt" | "lastUsedHostId"> => ({
      provider: "claude",
      kind: "api-key",
      label,
      email: null,
      accountUuid: null,
      subscriptionType: null,
      rateLimitTier: null,
      enabled: true,
      priority: 100,
    });

    const [first, second] = await Promise.all([
      store.add(account("first"), { kind: "api-key", apiKey: "sk-first" }),
      store.add(account("second"), { kind: "api-key", apiKey: "sk-second" }),
    ]);

    expect((await store.list()).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
  });
});

describe("QuotaStore", () => {
  it("migrates an existing quota table to family observations", () => {
    const database = new Database(":memory:");
    const initial = QUOTA_MIGRATIONS[0];
    const familyMigration = QUOTA_MIGRATIONS[1];
    const windowMigration = QUOTA_MIGRATIONS[2];
    if (
      initial === undefined ||
      familyMigration === undefined ||
      windowMigration === undefined
    ) {
      throw new Error("Expected quota migrations.");
    }
    database.exec(initial);
    database
      .prepare(
        `INSERT INTO account_quota (
          account_id, seven_day_utilization, bucket_exhaustion_json
        ) VALUES (?, ?, ?)`,
      )
      .run(
        "11111111-1111-4111-8111-111111111111",
        0.5,
        '{"7d_oi":4102452000000}',
      );
    database.exec(familyMigration);
    database.exec(windowMigration);
    for (const migration of QUOTA_MIGRATIONS.slice(3)) database.exec(migration);
    const quotas = new QuotaStore(database);

    const migrated = quotas.get("11111111-1111-4111-8111-111111111111");
    expect(migrated.sevenDayUtilization).toBe(0.5);
    expect(migrated.limitWindows).toEqual([]);
    expect(migrated.extraUsage).toBeNull();
    expect(migrated.familyWeekly).toEqual({
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    });
    quotas.put({
      ...migrated,
      familyWeekly: {
        ...migrated.familyWeekly,
        fable: {
          utilization: 1,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: 10,
          source: "usage",
        },
      },
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").familyWeekly.fable,
    ).toMatchObject({ utilization: 1, source: "usage" });
    quotas.put({
      ...migrated,
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          resetAt: 4_102_452_000_000,
          status: "allowed",
          observedAt: 10,
          source: "usage",
        },
      ],
    });
    expect(
      quotas.get("11111111-1111-4111-8111-111111111111").limitWindows,
    ).toEqual([
      {
        slot: "primary",
        windowMinutes: 10_080,
        utilization: 0.48,
        resetAt: 4_102_452_000_000,
        status: "allowed",
        observedAt: 10,
        source: "usage",
      },
    ]);
    database.close();
  });
});

describe("access observation custody", () => {
  it.each([403, 400] as const)(
    "survives database reopen and stale quota writes for HTTP %s",
    async (status) => {
      const dataDir = await mkdtemp(path.join(tmpdir(), "pool-observation-"));
      const filename = path.join(dataDir, "quota.sqlite");
      let database = new Database(filename);
      cleanups.push(async () => {
        database.close();
        await fs.rm(dataDir, { recursive: true, force: true });
      });
      for (const migration of QUOTA_MIGRATIONS) database.exec(migration);
      const id = "11111111-1111-4111-8111-111111111111";
      let store = new QuotaStore(database);
      const stale = store.get(id);
      const block = {
        status,
        type: "permission_error",
        message: "Access denied",
        observedAt: 1234,
      };
      store.setAccessBlocked(id, block);
      store.put({ ...stale, fiveHourUtilization: 0 });
      database.close();
      database = new Database(filename);
      store = new QuotaStore(database);
      expect(store.get(id)).toMatchObject({
        accessBlocked: block,
        fiveHourUtilization: 0,
      });
      store.setAccessBlocked(id, null);
      store.put({ ...stale, accessBlocked: block });
      expect(store.get(id).accessBlocked).toBeNull();
    },
  );
});

describe("access observation rollback compatibility", () => {
  it("keeps legacy strict quota rows unchanged for Claude and Codex and cleans observations on removal", () => {
    const database = new Database(":memory:");
    try {
      const migration = QUOTA_MIGRATIONS.at(-1);
      if (migration === undefined)
        throw new Error("Missing access observation migration.");
      for (const legacyMigration of QUOTA_MIGRATIONS.slice(0, -1))
        database.exec(legacyMigration);
      const claudeId = "11111111-1111-4111-8111-111111111111";
      const codexId = "22222222-2222-4222-8222-222222222222";
      database
        .prepare(
          "INSERT INTO account_quota (account_id, five_hour_utilization) VALUES (?, ?)",
        )
        .run(claudeId, 0.5);
      database
        .prepare(
          "INSERT INTO account_quota (account_id, five_hour_utilization) VALUES (?, ?)",
        )
        .run(codexId, 0.25);
      const rows = z
        .array(z.record(z.string(), z.unknown()))
        .parse(
          database
            .prepare("SELECT * FROM account_quota ORDER BY account_id")
            .all(),
        );
      const legacyStrictRowSchema = z
        .object(
          Object.fromEntries(
            Object.keys(rows[0]!).map((key) => [key, z.unknown()]),
          ),
        )
        .strict();
      database.exec(migration);
      const store = new QuotaStore(database);
      store.setAccessBlocked(claudeId, {
        status: 403,
        type: "permission_error",
        message: "Denied",
        observedAt: 1234,
      });
      const migratedRows = database
        .prepare("SELECT * FROM account_quota ORDER BY account_id")
        .all();
      expect(z.array(legacyStrictRowSchema).parse(migratedRows)).toEqual(rows);
      expect(store.get(codexId)).toMatchObject({
        accessBlocked: null,
        fiveHourUtilization: 0.25,
      });
      expect(store.get(claudeId).accessBlocked).toMatchObject({ status: 403 });
      store.remove(claudeId);
      expect(
        database.prepare("SELECT * FROM account_access_block").all(),
      ).toEqual([]);
      expect(store.get(claudeId).accessBlocked).toBeNull();
      expect(store.get(codexId).fiveHourUtilization).toBe(0.25);
    } finally {
      database.close();
    }
  });
});

describe("migration continuity", () => {
  // sha256 of each statement as the SDK records it in _bb_migrations, pinned from the
  // build that still shipped native cells. A changed or reordered entry makes the SDK
  // refuse every existing store, so these never change; new migrations are appended.
  const RECORDED_MIGRATION_HASHES = [
    "3720ef4afed7c7d9fae068a2d9dd37a18f33ab8bf90725f5ddd275540fef62b7",
    "9a9a5485f162d2fa3de976f6b8f3fa2d21aaa64f6bc2e9a721b6535cad281737",
    "eb21a6258795537792182089b403a6319dc3e92ff06f7d0e5de7e767a3eb3e68",
    "262c2203c745c0c06c15650cfc67a440afa62f164b8c62c1b366d3c70984f9ad",
    "e89a01e3cd050b493dccff99945e88446ef05509fe22d8d1f780a3f3844385aa",
    "7d22a08fed7eab826a721f15cfb6b6a74f5a038b1e3edddea8ab17058688ebc3",
    "702ba51e1687868c9f86aff2ab0d58c8ec0f61c183890e15a6b379b18ede012d",
    "da87bb5d61407af0225faf226753e60367f27f109eacb39799cc10984831ba61",
    // The retired native-cell tables.
    "8a894f03e76693a36576cd11c3fdf19959510d5ec3f7fadc996c35b37e09399f",
  ];
  const sha256 = (statement: string) =>
    createHash("sha256").update(statement).digest("hex");

  it("keeps every recorded migration byte-identical at its index", () => {
    expect(
      QUOTA_MIGRATIONS.slice(0, RECORDED_MIGRATION_HASHES.length).map(sha256),
    ).toEqual(RECORDED_MIGRATION_HASHES);
    // Machine roles (block P1), appended after the native-cell build.
    expect(QUOTA_MIGRATIONS.slice(RECORDED_MIGRATION_HASHES.length).map(sha256)).toEqual([
      "ad290dc1b51d2f7206a14ecaf43e22d3c8339ffd7bf62367dca9b063e97bd0d0",
    ]);
  });

  it("reopens a store recorded by the native-cell build and keeps its rows", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "pool-continuity-"));
    const host = createFakePluginHost({ pluginId: "continuity", dataDir });
    const filename = path.join(dataDir, "policy.db");
    let database = new Database(filename);
    cleanups.push(async () => {
      database.close();
      await host.harness.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    // Write _bb_migrations exactly as the previous build left it.
    database.exec(
      "CREATE TABLE _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)",
    );
    const record = database.prepare(
      "INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (?, 1, ?)",
    );
    QUOTA_MIGRATIONS.slice(0, RECORDED_MIGRATION_HASHES.length).forEach(
      (statement, index) => {
        database.exec(statement);
        record.run(index, RECORDED_MIGRATION_HASHES[index]);
      },
    );
    database
      .prepare(
        "INSERT INTO native_cell (id, hostId, generation, label, workspace, sshTarget, enabled, qualified) VALUES ('cell-one', 'host-one', 'g1', 'Cell', '/workspace', 'cell.invalid', 0, 0)",
      )
      .run();
    database.close();
    database = new Database(filename);
    expect(() =>
      host.bb.storage.migrate(database, QUOTA_MIGRATIONS),
    ).not.toThrow();
    expect(
      database.prepare("SELECT id, hostId FROM native_cell").all(),
    ).toEqual([{ id: "cell-one", hostId: "host-one" }]);
    expect(
      database.prepare("SELECT count(*) AS count FROM _bb_migrations").get(),
    ).toEqual({ count: QUOTA_MIGRATIONS.length });
  });
});
