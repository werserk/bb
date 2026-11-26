import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it, vi } from "vitest";
import { HostExclusions } from "./host-exclusion.js";
import { HubTokenStore, QUOTA_MIGRATIONS } from "./store.js";

it("persists explicit exclusions across reload and retains unenrolled exclusions", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "exclusion-"));
  let hosts = [
    { id: "host-one", name: "One" },
    { id: "host-two", name: "Two" },
  ];
  const host = createFakePluginHost({ pluginId: "exclusion", dataDir });
  const db = new Database(path.join(dataDir, "policy.db"));
  host.bb.storage.migrate(db, QUOTA_MIGRATIONS.slice(0, 7));
  db.prepare("INSERT INTO account_quota(account_id) VALUES (?)").run(
    "existing-account",
  );
  host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
  expect(db.prepare("SELECT account_id FROM account_quota").all()).toEqual([
    { account_id: "existing-account" },
  ]);
  const policy = new HostExclusions(db, async () => hosts);
  expect((await policy.list()).map((x) => x.excluded)).toEqual([false, false]);
  await policy.set({ hostId: "host-one", excluded: true });
  await policy.set({ hostId: "host-one", excluded: true });
  expect(new HostExclusions(db, async () => hosts).isExcluded("host-one")).toBe(
    true,
  );
  expect(
    db.prepare("SELECT count(*) AS count FROM pool_host_exclusion").get(),
  ).toEqual({ count: 1 });
  await expect(
    policy.set({ hostId: "bad/id", excluded: true }),
  ).rejects.toThrow();
  db.close();
  await host.harness.dispose();
  const reopened = createFakePluginHost({ pluginId: "exclusion", dataDir });
  const reopenedDb = new Database(path.join(dataDir, "policy.db"));
  const restored = new HostExclusions(reopenedDb, async () => hosts);
  expect(restored.isExcluded("host-one")).toBe(true);
  hosts = hosts.slice(1);
  expect(await restored.list()).toContainEqual({
    hostId: "host-one",
    hostName: null,
    enrolled: false,
    excluded: true,
  });
  await expect(
    restored.set({ hostId: "missing", excluded: true }),
  ).rejects.toThrow("not enrolled");
  await restored.set({ hostId: "host-one", excluded: false });
  expect(restored.isExcluded("host-one")).toBe(false);
  reopenedDb.close();
  await reopened.harness.dispose();
  await fs.rm(dataDir, { recursive: true });
});

it("denies mint, rotation, current and grace credentials without recording denied use", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "excluded-token-"));
  let excluded = true;
  const tokens = new HubTokenStore(
    dir,
    () => 100,
    () => excluded,
  );
  await expect(tokens.forHost("one")).rejects.toThrow("excluded");
  expect(await tokens.list()).toEqual([]);
  excluded = false;
  const previous = await tokens.forHost("one");
  await tokens.rotate("one");
  const current = await tokens.forHost("one");
  excluded = true;
  await expect(tokens.rotate("one")).rejects.toThrow("excluded");
  expect(await tokens.authenticate(previous)).toBeNull();
  expect(await tokens.authenticate(current)).toBeNull();
  expect((await tokens.list())[0]?.lastUsedAt).toBeNull();
  excluded = false;
  expect(await tokens.authenticate(previous)).toBe("one");
  expect(await tokens.authenticate(current)).toBe("one");
  await fs.rm(dir, { recursive: true });
});

it("rechecks exclusion after an already-started credential write", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "excluded-race-"));
  let excluded = false;
  const tokens = new HubTokenStore(
    dir,
    () => 100,
    () => excluded,
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
    const rejected = expect(pending).rejects.toThrow("excluded");
    await entered.promise;
    excluded = true;
    release.resolve();
    await rejected;
    expect((await tokens.list())[0]?.lastUsedAt).toBeNull();
  } finally {
    spy.mockRestore();
    await fs.rm(dir, { recursive: true });
  }
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
