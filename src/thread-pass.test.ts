import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { AuditLog } from "./audit-log.js";
import { QUOTA_MIGRATIONS } from "./store.js";
import {
  ARCHIVE_UNDO_GRACE_MS,
  PASS_KEY_FILE,
  PassKey,
  ThreadPasses,
  type PassThread,
} from "./thread-pass.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "thread-pass-"));
  const host = createFakePluginHost({ pluginId: "passes", dataDir });
  const db = new Database(path.join(dataDir, "policy.db"));
  host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
  cleanups.push(async () => {
    db.close();
    await host.harness.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const secrets = path.join(dataDir, "secrets");
  const state = {
    time: 1_000_000_000,
    roles: new Map<string, string | undefined>([
      ["host-w", "worker"],
      ["host-v", "worker"],
      ["host-t", "trusted"],
    ]),
    threads: new Map<string, PassThread | Error>(),
    hosts: new Map<string, boolean | Error>(),
  };
  const audit = new AuditLog(db, () => state.time);
  const broken = vi.fn();
  const make = () =>
    new ThreadPasses({
      db,
      key: new PassKey(secrets, broken),
      now: () => state.time,
      audit,
      mayHold: (hostId) => state.roles.get(hostId) === "worker",
      mayPresent: (hostId) => state.roles.get(hostId) !== undefined,
      getThread: async (threadId) => {
        const thread = state.threads.get(threadId);
        if (thread instanceof Error) throw thread;
        // server.ts maps a 404 to null.
        return thread ?? null;
      },
      hostExists: async (hostId) => {
        const exists = state.hosts.get(hostId) ?? true;
        if (exists instanceof Error) throw exists;
        return exists;
      },
    });
  const live = (threadId: string, hostId = "host-w") =>
    state.threads.set(threadId, { hostId, archivedAt: null, deletedAt: null });
  const reasons = () =>
    audit
      .list()
      .entries.reverse()
      .map((entry) => `${entry.reason}:${entry.threadId}:${entry.detail ?? "-"}`);
  return { db, secrets, state, audit, broken, passes: make(), make, live, reasons };
}

it("issues a pass bound to its thread and refuses forged, tampered and malformed passes", async () => {
  const { passes, live } = await setup();
  live("thread-1");
  live("thread-2");
  const one = await passes.issue("thread-1", "host-w");
  const two = await passes.issue("thread-2", "host-w");
  expect(one).toMatch(/^pt1\.thread-1\.[A-Za-z0-9_-]{43}$/u);
  expect(await passes.issue("thread-1", "host-w")).toBe(one);
  expect(await passes.verify(one as string)).toEqual({
    kind: "thread",
    threadId: "thread-1",
    hostId: "host-w",
  });
  const mac = (pass: string | null) => (pass as string).split(".")[2] as string;
  const flipped = `${mac(one).slice(0, -1)}${mac(one).endsWith("A") ? "B" : "A"}`;
  for (const forged of [
    `pt1.thread-2.${mac(one)}`,
    `pt1.thread-1.${mac(two)}`,
    `pt1.thread-1.${flipped}`,
    `pc1.thread-1.${mac(one)}`,
    `pt2.thread-1.${mac(one)}`,
    `pt1.thread-1.${mac(one)}.x`,
    `pt1.thread-1.${mac(one).slice(1)}`,
    `pt1.thread-1.${mac(one)}A`,
    `pt1.thread/1.${mac(one)}`,
    `pt1..${mac(one)}`,
  ])
    await expect(passes.verify(forged)).resolves.toBeNull();
  // Only hosts that may hold passes get them.
  live("thread-t", "host-t");
  expect(await passes.issue("thread-t", "host-t")).toBeNull();
  expect(await passes.catalogPass("host-t")).toBeNull();
  const catalog = await passes.catalogPass("host-w");
  expect(catalog).toMatch(/^pc1\.host-w\.[A-Za-z0-9_-]{43}$/u);
  expect(await passes.verify(catalog as string)).toEqual({
    kind: "catalog",
    hostId: "host-w",
  });
  await expect(
    passes.verify(`pc1.host-v.${mac(catalog)}`),
  ).resolves.toBeNull();
});

it("moves a pass with its thread to another machine", async () => {
  const { passes, live } = await setup();
  live("thread-1");
  const onW = await passes.issue("thread-1", "host-w");
  const onV = await passes.issue("thread-1", "host-v");
  expect(onV).not.toBe(onW);
  expect(await passes.verify(onW as string)).toBeNull();
  expect(await passes.verify(onV as string)).toEqual({
    kind: "thread",
    threadId: "thread-1",
    hostId: "host-v",
  });
});

it("keeps an archived thread's pass for the undo grace and restores it on a timely unarchive", async () => {
  const { passes, state, live, reasons } = await setup();
  live("thread-1");
  const pass = (await passes.issue("thread-1", "host-w")) as string;
  await passes.archived("thread-1", state.time);
  state.time += ARCHIVE_UNDO_GRACE_MS - 1;
  expect(await passes.verify(pass)).not.toBeNull();
  expect(passes.list()).toMatchObject([{ state: "archived-grace" }]);
  state.time += 1;
  expect(await passes.verify(pass)).toBeNull();
  expect(passes.list()).toEqual([]);
  // Undo within the grace: the same pass works again.
  passes.unarchived("thread-1");
  const again = (await passes.issue("thread-1", "host-w")) as string;
  await passes.archived("thread-1", state.time);
  state.time += 10_000;
  passes.unarchived("thread-1");
  expect(await passes.verify(again)).not.toBeNull();
  expect(await passes.issue("thread-1", "host-w")).toBe(again);
  // Undo after the grace: the old pass stays dead, the next send gets a new one.
  await passes.archived("thread-1", state.time);
  state.time += ARCHIVE_UNDO_GRACE_MS;
  passes.unarchived("thread-1");
  expect(await passes.verify(again)).toBeNull();
  const fresh = (await passes.issue("thread-1", "host-w")) as string;
  expect(fresh).not.toBe(again);
  expect(await passes.verify(fresh)).not.toBeNull();
  expect(reasons()).toEqual([
    "pass-issued:thread-1:-",
    "pass-revoked:thread-1:archived",
    "pass-issued:thread-1:-",
    "pass-revoked:thread-1:archived",
    "pass-issued:thread-1:restored",
    "pass-revoked:thread-1:archived",
    "pass-issued:thread-1:-",
  ]);
});

it("closes the race of an archive that lands before the first pass is issued", async () => {
  const { passes, state } = await setup();
  state.threads.set("thread-1", {
    hostId: "host-w",
    archivedAt: state.time,
    deletedAt: null,
  });
  await passes.archived("thread-1", state.time);
  const pass = await passes.issue("thread-1", "host-w");
  state.time += ARCHIVE_UNDO_GRACE_MS;
  expect(pass === null || (await passes.verify(pass)) === null).toBe(true);
  expect(passes.list()).toEqual([]);
  // A thread of a machine without passes gets no row.
  state.threads.set("thread-t", {
    hostId: "host-t",
    archivedAt: state.time,
    deletedAt: null,
  });
  await passes.archived("thread-t", state.time);
  expect(passes.list()).toEqual([]);
});

it("revokes a deleted or manually revoked thread's pass at once and never revives it", async () => {
  const { passes, live, reasons } = await setup();
  live("thread-1");
  const first = (await passes.issue("thread-1", "host-w")) as string;
  expect(passes.revokeThread("thread-1", "deleted")).toBe(true);
  expect(await passes.verify(first)).toBeNull();
  const second = (await passes.issue("thread-1", "host-w")) as string;
  expect(second).not.toBe(first);
  expect(await passes.verify(first)).toBeNull();
  expect(passes.revokeThread("thread-1", "manual")).toBe(true);
  expect(passes.revokeThread("thread-1", "manual")).toBe(false);
  expect(await passes.verify(second)).toBeNull();
  expect(reasons()).toEqual([
    "pass-issued:thread-1:-",
    "pass-revoked:thread-1:deleted",
    "pass-issued:thread-1:-",
    "pass-revoked:thread-1:manual",
  ]);
  // Neither the list nor the audit ever holds a pass.
  expect(JSON.stringify(passes.list())).not.toMatch(/pt1\.|pc1\./u);
});

it("gives a missed unarchive a working pass at the next send", async () => {
  const { passes, state, live } = await setup();
  live("thread-1");
  const pass = (await passes.issue("thread-1", "host-w")) as string;
  await passes.archived("thread-1", state.time);
  // Within the grace: the same pass comes back.
  state.time += 10_000;
  expect(await passes.issue("thread-1", "host-w")).toBe(pass);
  expect(await passes.verify(pass)).not.toBeNull();
  // After the grace: a new pass.
  await passes.archived("thread-1", state.time);
  state.time += ARCHIVE_UNDO_GRACE_MS + 1;
  const fresh = (await passes.issue("thread-1", "host-w")) as string;
  expect(fresh).not.toBe(pass);
  expect(await passes.verify(fresh)).not.toBeNull();
  // Still archived in bb: no pass.
  await passes.archived("thread-1", state.time);
  state.threads.set("thread-1", {
    hostId: "host-w",
    archivedAt: state.time,
    deletedAt: null,
  });
  expect(await passes.issue("thread-1", "host-w")).toBeNull();
});

// Issuing is for workers only; accepting is for any machine with a role, so
// a later build that issues passes on every role can roll back to this one
// without failing a turn in flight.
it("accepts passes from any machine with a role and none from a role-less one", async () => {
  const { passes, state, live } = await setup();
  live("thread-1");
  live("thread-2");
  live("thread-v", "host-v");
  const one = (await passes.issue("thread-1", "host-w")) as string;
  await passes.issue("thread-2", "host-w");
  const other = (await passes.issue("thread-v", "host-v")) as string;
  const catalog = (await passes.catalogPass("host-w")) as string;
  state.roles.set("host-w", "trusted");
  expect(await passes.verify(one)).toEqual({
    kind: "thread",
    threadId: "thread-1",
    hostId: "host-w",
  });
  expect(await passes.verify(catalog)).toEqual({
    kind: "catalog",
    hostId: "host-w",
  });
  expect(await passes.issue("thread-1", "host-w")).toBeNull();
  state.roles.set("host-w", undefined);
  expect(await passes.verify(one)).toBeNull();
  expect(await passes.verify(catalog)).toBeNull();
  state.roles.set("host-w", "server");
  expect(passes.revokeHost("host-w", "role")).toBe(2);
  expect(await passes.verify(one)).toBeNull();
  expect(await passes.verify(other)).not.toBeNull();
});

it("reconciles rows of deleted, archived, missing and role-less threads and keeps rows on SDK errors", async () => {
  const { db, passes, state, live } = await setup();
  for (const id of ["live", "deleted", "soft-deleted", "archived", "flaky", "gone-host", "role"])
    live(id, id === "gone-host" ? "host-v" : id === "role" ? "host-x" : "host-w");
  state.roles.set("host-x", "worker");
  for (const id of ["live", "deleted", "soft-deleted", "archived", "flaky"])
    await passes.issue(id, "host-w");
  await passes.issue("gone-host", "host-v");
  await passes.issue("role", "host-x");
  state.threads.delete("deleted");
  state.threads.set("soft-deleted", {
    hostId: "host-w",
    archivedAt: null,
    deletedAt: state.time,
  });
  state.threads.set("archived", {
    hostId: "host-w",
    archivedAt: state.time - ARCHIVE_UNDO_GRACE_MS,
    deletedAt: null,
  });
  state.threads.set("flaky", new Error("bb is restarting"));
  state.hosts.set("host-v", false);
  state.roles.set("host-x", undefined);
  await passes.reconcile();
  expect(
    db.prepare("SELECT thread_id FROM pool_thread_pass ORDER BY thread_id").all(),
  ).toEqual([{ thread_id: "flaky" }, { thread_id: "live" }]);
  // A failing machine lookup keeps the rows too.
  state.hosts.set("host-w", new Error("bb is restarting"));
  state.threads.delete("live");
  await passes.reconcile();
  expect(passes.list().map((pass) => pass.threadId)).toEqual(["flaky", "live"]);
});

it("creates the key only at the first issue, never overwrites it, and keeps passes across a restart", async () => {
  const { secrets, live, make } = await setup();
  live("thread-1");
  const passes = make();
  await expect(
    passes.verify(`pt1.thread-1.${"A".repeat(43)}`),
  ).resolves.toBeNull();
  expect(await passes.catalogPass("host-t")).toBeNull();
  await expect(fs.access(secrets)).rejects.toThrow();
  const pass = (await passes.issue("thread-1", "host-w")) as string;
  const file = path.join(secrets, PASS_KEY_FILE);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  expect(await fs.readdir(secrets)).toEqual([PASS_KEY_FILE]);
  const bytes = await fs.readFile(file);
  const restarted = make();
  expect(await restarted.verify(pass)).not.toBeNull();
  expect(await restarted.issue("thread-1", "host-w")).toBe(pass);
  expect(await fs.readFile(file)).toEqual(bytes);
});

it("makes two loaders racing on a missing key agree on one key", async () => {
  const { secrets } = await setup();
  const one = new PassKey(secrets, () => {});
  const two = new PassKey(secrets, () => {});
  const [left, right] = await Promise.all([one.get(true), two.get(true)]);
  expect(left).not.toBeNull();
  expect(left?.equals(right as Buffer)).toBe(true);
  expect(await fs.readdir(secrets)).toEqual([PASS_KEY_FILE]);
});

it.each([
  ["corrupt", "{not json"],
  ["wrong shape", JSON.stringify({ version: 2, key: "A".repeat(43) })],
])(
  "fails closed on a %s key file and leaves it untouched",
  async (_name, content) => {
    const { secrets, live, make, broken } = await setup();
    live("thread-1");
    const issued = (await make().issue("thread-1", "host-w")) as string;
    const file = path.join(secrets, PASS_KEY_FILE);
    await fs.writeFile(file, content, { mode: 0o600 });
    const passes = make();
    expect(await passes.issue("thread-1", "host-w")).toBeNull();
    expect(await passes.catalogPass("host-w")).toBeNull();
    expect(await passes.verify(issued)).toBeNull();
    expect(broken).toHaveBeenCalledTimes(1);
    expect(String(broken.mock.calls[0]?.[0])).not.toContain(content);
    expect(await fs.readFile(file, "utf8")).toBe(content);
  },
);

it("fails closed when the key file cannot be read", async () => {
  const { secrets, live, make, broken } = await setup();
  live("thread-1");
  await fs.mkdir(path.join(secrets, PASS_KEY_FILE), { recursive: true });
  const passes = make();
  expect(await passes.issue("thread-1", "host-w")).toBeNull();
  expect(broken).toHaveBeenCalledTimes(1);
  expect((await fs.stat(path.join(secrets, PASS_KEY_FILE))).isDirectory()).toBe(
    true,
  );
});
