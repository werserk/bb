import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { HostRoles, migrateHostRoles } from "./host-roles.js";
import { HubTokenStore, QUOTA_MIGRATIONS } from "./store.js";

// The migrations of the opt-out build (0c7ca42), before machine roles.
const BASE_MIGRATIONS = QUOTA_MIGRATIONS.slice(0, 9);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function store() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "host-roles-"));
  const host = createFakePluginHost({ pluginId: "roles", dataDir });
  const db = new Database(path.join(dataDir, "policy.db"));
  cleanups.push(async () => {
    db.close();
    await host.harness.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const migrate = (statements: string[]) => host.bb.storage.migrate(db, statements);
  return { db, migrate, dataDir };
}

const column = (db: Database.Database, sql: string) =>
  (db.prepare(sql).all() as Array<Record<string, unknown>>).map((row) =>
    Object.values(row).join(":"),
  );
const roles = (db: Database.Database) =>
  column(db, "SELECT host_id, role FROM pool_host_role ORDER BY host_id");
const exclusions = (db: Database.Database) =>
  column(db, "SELECT host_id FROM pool_host_exclusion ORDER BY host_id");

it("upgrades the opt-out store: included hosts become trusted, excluded hosts get nothing", async () => {
  const { db, migrate } = await store();
  migrate(BASE_MIGRATIONS);
  db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?), (?)").run(
    "host-b",
    "host-gone",
  );
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), [
    "host-a",
    "host-b",
    "host-c",
  ]);
  expect(roles(db)).toEqual(["host-a:trusted", "host-c:trusted"]);
  expect(exclusions(db)).toEqual(["host-b", "host-gone"]);
  expect(
    db.prepare("SELECT count(*) AS count FROM _bb_migrations").get(),
  ).toEqual({ count: QUOTA_MIGRATIONS.length });
});

it("gives no role to anyone on a fresh store", async () => {
  const { db, migrate } = await store();
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a", "host-b"]);
  expect(roles(db)).toEqual([]);
  expect(exclusions(db)).toEqual(["host-a", "host-b"]);
});

it("seeds once: a later start never grants a role again", async () => {
  const { db, migrate } = await store();
  migrate(BASE_MIGRATIONS);
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a"]);
  db.prepare("DELETE FROM pool_host_role").run();
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a", "host-new"]);
  expect(roles(db)).toEqual([]);
  expect(exclusions(db)).toEqual(["host-a", "host-new"]);
});

it("lets an exclusion made by the previous build during a rollback beat a role", async () => {
  const { db, migrate } = await store();
  migrate(BASE_MIGRATIONS);
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a", "host-b"]);
  // The previous build runs again: its `machine exclude host-a` writes this row.
  migrate(BASE_MIGRATIONS);
  db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
    "host-a",
  );
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a", "host-b"]);
  expect(roles(db)).toEqual(["host-b:trusted"]);
  expect(exclusions(db)).toEqual(["host-a"]);
});

it("keeps the store readable by the previous build and its exclusions fail closed", async () => {
  const { db, migrate } = await store();
  migrate(BASE_MIGRATIONS);
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a", "host-b"]);
  const service = new HostRoles(
    db,
    async () => [
      { id: "host-a", name: "A" },
      { id: "host-b", name: "B" },
      { id: "host-new", name: "New" },
    ],
    async () => {},
  );
  await service.set({ hostId: "host-b", role: "none" });
  // Rollback: the previous build's migrator ignores the extra row and its only
  // input is pool_host_exclusion (`SELECT host_id ... WHERE host_id = ?`).
  expect(() => migrate(BASE_MIGRATIONS)).not.toThrow();
  const oldBuildRoutes = (hostId: string) =>
    db
      .prepare("SELECT host_id FROM pool_host_exclusion WHERE host_id = ?")
      .get(hostId) === undefined;
  expect(["host-a", "host-b", "host-new"].map(oldBuildRoutes)).toEqual([
    true,
    false,
    false,
  ]);
  expect(() =>
    migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), ["host-a"]),
  ).not.toThrow();
  expect(roles(db)).toEqual(["host-a:trusted"]);
});

it("sets, lists and removes roles; only removal revokes, and the projection follows", async () => {
  const { db, migrate } = await store();
  migrateHostRoles(db, () => migrate(QUOTA_MIGRATIONS), []);
  let hosts = [
    { id: "host-a", name: "A" },
    { id: "host-b", name: "B" },
  ];
  const revoke = vi.fn(async () => {});
  const changed = vi.fn();
  const service = new HostRoles(db, async () => hosts, revoke, changed);
  expect(await service.set({ hostId: "host-a", role: "trusted" })).toEqual({
    hostId: "host-a",
    hostName: "A",
    enrolled: true,
    role: "trusted",
  });
  expect(exclusions(db)).toEqual(["host-b"]);
  await service.set({ hostId: "host-a", role: "server" });
  await service.set({ hostId: "host-a", role: "worker" });
  expect(revoke).not.toHaveBeenCalled();
  expect(service.roleOf("host-a")).toBe("worker");
  await expect(
    service.set({ hostId: "host-missing", role: "trusted" }),
  ).rejects.toThrow("not enrolled");
  await expect(
    service.set({ hostId: "bad/id", role: "trusted" }),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error not a role
    service.set({ hostId: "host-a", role: "admin" }),
  ).rejects.toThrow();
  // A removed machine keeps its role until someone removes it.
  hosts = hosts.slice(1);
  expect(await service.list()).toEqual([
    { hostId: "host-a", hostName: null, enrolled: false, role: "worker" },
    { hostId: "host-b", hostName: "B", enrolled: true, role: null },
  ]);
  await service.set({ hostId: "host-a", role: "none" });
  expect(revoke).toHaveBeenCalledExactlyOnceWith("host-a");
  expect(service.hasRole("host-a")).toBe(false);
  expect(await service.list()).toEqual([
    { hostId: "host-b", hostName: "B", enrolled: true, role: null },
  ]);
  expect(changed).toHaveBeenCalledTimes(4);
});

it("denies mint, rotation, current and grace credentials without a role", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roleless-token-"));
  cleanups.push(() => fs.rm(dir, { recursive: true }));
  let permitted = false;
  const tokens = new HubTokenStore(
    dir,
    () => 100,
    () => permitted,
  );
  await expect(tokens.forHost("one")).rejects.toThrow("no Account Pooler role");
  expect(await tokens.list()).toEqual([]);
  expect(await fs.readdir(dir)).toEqual([]);
  permitted = true;
  const previous = await tokens.forHost("one");
  await tokens.rotate("one");
  const current = await tokens.forHost("one");
  permitted = false;
  await expect(tokens.rotate("one")).rejects.toThrow("no Account Pooler role");
  expect(await tokens.authenticate(previous)).toBeNull();
  expect(await tokens.authenticate(current)).toBeNull();
});

it("revokes a token file and prunes tokens of role-less or unenrolled hosts", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "revoke-token-"));
  cleanups.push(() => fs.rm(dir, { recursive: true }));
  const permitted = new Set(["one", "two", "three"]);
  const tokens = new HubTokenStore(
    dir,
    () => 100,
    (id) => permitted.has(id),
  );
  const one = await tokens.forHost("one");
  await tokens.forHost("two");
  await tokens.forHost("three");
  await tokens.revoke("one");
  expect(await tokens.authenticate(one)).toBeNull();
  permitted.delete("two");
  await tokens.prune(["two", "three"]);
  expect((await fs.readdir(dir)).sort()).toEqual(["hub-token-three.json"]);
  permitted.add("one");
  expect(await tokens.forHost("one")).not.toBe(one);
});

it("drops a token whose role vanished during an already-started credential write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "roleless-race-"));
  cleanups.push(() => fs.rm(dir, { recursive: true }));
  let permitted = true;
  const tokens = new HubTokenStore(
    dir,
    () => 100,
    () => permitted,
  );
  await tokens.initialize();
  const entered = deferred();
  const release = deferred();
  const original = fs.writeFile.bind(fs);
  const spy = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
    entered.resolve();
    await release.promise;
    return original(...args);
  });
  try {
    const pending = tokens.forHost("one");
    const rejected = expect(pending).rejects.toThrow("no Account Pooler role");
    await entered.promise;
    permitted = false;
    release.resolve();
    await rejected;
    expect(await tokens.list()).toEqual([]);
    expect(await fs.readdir(dir)).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
