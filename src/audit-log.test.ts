import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import {
  AUDIT_RETENTION_MS,
  AuditLog,
  createAuditCommands,
  parseSince,
} from "./audit-log.js";
import { QUOTA_MIGRATIONS } from "./store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup(maxRows?: number) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "audit-log-"));
  const host = createFakePluginHost({ pluginId: "audit", dataDir });
  const db = new Database(path.join(dataDir, "policy.db"));
  host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
  cleanups.push(async () => {
    db.close();
    await host.harness.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const clock = { time: 10 * AUDIT_RETENTION_MS };
  const raw = new AuditLog(db, () => clock.time, AUDIT_RETENTION_MS, maxRows);
  // Most tests read entries only; the skipped count has its own test.
  const log = {
    append: raw.append.bind(raw),
    prune: raw.prune.bind(raw),
    list: (query?: Parameters<AuditLog["list"]>[0]) => raw.list(query).entries,
  };
  return { db, raw, log, clock };
}

it("appends validated rows and lists them newest first with filters", async () => {
  const { log, clock } = await setup();
  log.append({ reason: "role-change", hostId: "host-a", detail: "none->worker" });
  clock.time += 1;
  log.append({
    reason: "select",
    provider: "claude",
    threadId: "thread-1",
    hostId: "host-a",
    accountId: "account-1",
  });
  clock.time += 1;
  log.append({
    reason: "failover",
    provider: "codex",
    threadId: "thread-2",
    hostId: "host-b",
    accountId: "account-2",
    detail: "rate-limit",
  });
  expect(log.list().map((entry) => entry.reason)).toEqual([
    "failover",
    "select",
    "role-change",
  ]);
  expect(log.list({ threadId: "thread-1" })).toEqual([
    {
      id: 2,
      ts: clock.time - 1,
      reason: "select",
      provider: "claude",
      threadId: "thread-1",
      hostId: "host-a",
      accountId: "account-1",
      detail: null,
    },
  ]);
  expect(log.list({ hostId: "host-a", reason: "role-change" })).toHaveLength(1);
  expect(log.list({ accountId: "account-2" })).toHaveLength(1);
  expect(log.list({ since: clock.time - 1 })).toHaveLength(2);
  expect(log.list({ limit: 1 }).map((entry) => entry.id)).toEqual([3]);
  // Free text never gets in: only the fixed reason and detail vocabulary.
  expect(() =>
    // @ts-expect-error not a reason
    log.append({ reason: "prompt" }),
  ).toThrow();
  expect(() =>
    log.append({ reason: "limit", detail: "user wrote: secret plan" }),
  ).toThrow();
  expect(() => log.append({ reason: "select", threadId: "a b" })).toThrow();
  expect(log.list()).toHaveLength(3);
});

it("prunes by age and by count", async () => {
  const { db, log, clock } = await setup(3);
  const count = () =>
    (db.prepare("SELECT count(*) AS n FROM pool_audit").get() as { n: number })
      .n;
  log.append({ reason: "select", accountId: "old" });
  clock.time += AUDIT_RETENTION_MS;
  for (let index = 0; index < 5; index++)
    log.append({ reason: "select", accountId: `new-${index}` });
  expect(count()).toBe(6);
  log.prune();
  expect(log.list().map((entry) => entry.accountId)).toEqual([
    "new-4",
    "new-3",
    "new-2",
  ]);
  log.prune();
  expect(count()).toBe(3);
});

it("keeps rows under both bounds", async () => {
  const { log, clock } = await setup(10);
  log.append({ reason: "select", accountId: "kept" });
  clock.time += AUDIT_RETENTION_MS - 1;
  log.prune();
  expect(log.list()).toHaveLength(1);
});

// After a rollback from a later build, its rows (new reasons and details) are
// shown as they are; this build only refuses to write them.
it("reads rows with reasons and details this build does not know", async () => {
  const { db, raw, log, clock } = await setup();
  db.prepare(
    "INSERT INTO pool_audit(ts, reason, provider, thread_id, host_id, account_id, detail) VALUES (?, 'switch', 'gemini', 'thread-1', 'host-a', 'account-1', 'policy:cheapest')",
  ).run(clock.time);
  log.append({ reason: "select", accountId: "account-1" });
  expect(log.list()).toEqual([
    expect.objectContaining({ reason: "select" }),
    {
      id: 1,
      ts: clock.time,
      reason: "switch",
      provider: "gemini",
      threadId: "thread-1",
      hostId: "host-a",
      accountId: "account-1",
      detail: "policy:cheapest",
    },
  ]);
  expect(log.list({ reason: "switch" })).toHaveLength(1);
  const { audit } = createAuditCommands(raw, () => clock.time);
  const run = (options: Record<string, unknown>) =>
    audit.run({ options, positionals: {} } as never, {} as never) as Promise<{
      stdout: string;
    }>;
  expect((await run({})).stdout).toContain("\tswitch\tgemini\t");
  expect(JSON.parse((await run({ json: true, reason: "switch" })).stdout).entries).toHaveLength(1);
});

// The later build's own words for a rollback (L12): a new reason, and a known
// reason with a new detail. Rows that break the id or time invariants, or hold
// control characters, are skipped and counted, never fatal.
it("returns later builds' reasons and details as they are and skips broken rows", async () => {
  const { db, raw, clock } = await setup();
  const insert = db.prepare(
    "INSERT INTO pool_audit(id, ts, reason, provider, thread_id, host_id, account_id, detail) VALUES (?, ?, ?, 'claude', 'thread-1', 'host-a', 'account-1', ?)",
  );
  insert.run(1, clock.time, "switch", "policy");
  insert.run(2, clock.time, "limit", "named-stop");
  insert.run(3, "yesterday", "select", null);
  insert.run(4, clock.time, "select", "line\nbreak");
  insert.run(5, clock.time, "x".repeat(300), null);
  expect(raw.list()).toEqual({
    entries: [
      expect.objectContaining({ id: 2, reason: "limit", detail: "named-stop" }),
      expect.objectContaining({ id: 1, reason: "switch", detail: "policy" }),
    ],
    skipped: 3,
  });
  expect(raw.list({ reason: "switch" }).entries).toHaveLength(1);
  const { audit } = createAuditCommands(raw, () => clock.time);
  const run = (options: Record<string, unknown>) =>
    audit.run({ options, positionals: {} } as never, {} as never) as Promise<{
      stdout: string;
      stderr?: string;
    }>;
  const text = await run({});
  expect(text.stdout).toContain("\tlimit\tclaude\tthread-1\thost-a\taccount-1\tnamed-stop\n");
  expect(text.stdout).toContain("\tswitch\tclaude\tthread-1\thost-a\taccount-1\tpolicy\n");
  expect(text.stdout.split("\n")).toHaveLength(3);
  expect(text.stderr).toBe("3 audit row(s) could not be read and were skipped.\n");
  expect(JSON.parse((await run({ json: true })).stdout)).toEqual({
    entries: [
      expect.objectContaining({ reason: "limit", detail: "named-stop" }),
      expect.objectContaining({ reason: "switch", detail: "policy" }),
    ],
    skipped: 3,
  });
});

it("reads relative and absolute --since values", () => {
  const now = Date.parse("2026-11-27T12:00:00.000Z");
  expect(parseSince("30m", now)).toBe(now - 30 * 60 * 1_000);
  expect(parseSince("24h", now)).toBe(now - 24 * 60 * 60 * 1_000);
  expect(parseSince("7d", now)).toBe(now - 7 * 24 * 60 * 60 * 1_000);
  expect(parseSince("2026-11-01T00:00:00.000Z", now)).toBe(
    Date.parse("2026-11-01T00:00:00.000Z"),
  );
  expect(() => parseSince("yesterday", now)).toThrow("--since");
});

it("prints the audit as tab-separated rows or JSON and rejects bad filters", async () => {
  const { raw, log, clock } = await setup();
  const { audit } = createAuditCommands(raw, () => clock.time);
  const run = (options: Record<string, unknown>) =>
    audit.run({ options, positionals: {} } as never, {} as never) as Promise<{
      stdout: string;
    }>;
  expect((await run({})).stdout).toBe("No audit entries.\n");
  log.append({
    reason: "pass-issued",
    threadId: "thread-1",
    hostId: "host-a",
  });
  expect((await run({})).stdout).toBe(
    `${new Date(clock.time).toISOString()}\tpass-issued\t-\tthread-1\thost-a\t-\t-\n`,
  );
  expect(JSON.parse((await run({ json: true, thread: "thread-1" })).stdout)).toEqual({
    entries: [expect.objectContaining({ reason: "pass-issued" })],
    skipped: 0,
  });
  await expect(run({ reason: "Not A Reason" })).rejects.toThrow(
    "Invalid audit filter",
  );
  await expect(run({ limit: "0" })).rejects.toThrow("Invalid audit filter");
});

it("finds a thread's latest row of one reason with one indexed lookup (block P3)", async () => {
  const { raw, db, clock } = await setup();
  expect(raw.latestEvent("thread-1", "named-limit")).toBeNull();
  const limit = (threadId: string, detail: string) => {
    clock.time += 1;
    raw.append({ reason: "named-limit", provider: "claude", threadId, hostId: "host-a", accountId: "account-1", detail });
  };
  limit("thread-1", "unavailable-fallback-auto");
  limit("thread-1", "limit-fallback-auto");
  limit("thread-2", "limit-stop");
  clock.time += 1;
  raw.append({ reason: "select", provider: "claude", threadId: "thread-1", hostId: "host-a", accountId: "account-2" });
  expect(raw.latestEvent("thread-1", "named-limit")).toMatchObject({
    threadId: "thread-1",
    detail: "limit-fallback-auto",
  });
  // The same timestamp as "limit-fallback-auto": the later row wins.
  clock.time -= 3;
  limit("thread-1", "deleted-stop");
  expect(raw.latestEvent("thread-1", "named-limit")?.detail).toBe("deleted-stop");
  const plan = db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM pool_audit WHERE thread_id = ? AND reason = ? ORDER BY ts DESC, id DESC LIMIT 1",
    )
    .all("thread-1", "named-limit")
    .map((row) => String((row as { detail: unknown }).detail));
  expect(plan.join("\n")).toContain("USING INDEX pool_audit_thread");
});
