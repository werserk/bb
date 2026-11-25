import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createConnection, migrate } from "../src/index.js";
import {
  setupPlacement,
  acceptPrepared,
  observation,
} from "./helpers/placement.js";
import { readPlacementOperation } from "../src/data/placement-operations.js";
import {
  observePlacementWorkers,
  readPlacementWorker,
} from "../src/data/placement-workers.js";

async function race(
  path: string,
  mode: string,
  ids: string[],
  workers?: string[],
) {
  const children = ids.map((id, index) =>
    fork(
      new URL("./helpers/placement-process.ts", import.meta.url),
      [path, mode, id, ...(workers ? [workers[index]!] : [])],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        env: { ...process.env, NODE_OPTIONS: "" },
      },
    ),
  );
  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve, reject) => {
            child.once("message", () => resolve());
            child.once("error", reject);
            child.once("exit", (code) => {
              if (code) reject(new Error(`child exit ${code}`));
            });
          }),
      ),
    );
    const results = children.map(
      (child) =>
        new Promise<unknown>((resolve, reject) => {
          child.once("message", resolve);
          child.once("error", reject);
          child.once("exit", (code) => {
            if (code) reject(new Error(`child exit ${code}`));
          });
        }),
    );
    for (const child of children) child.send("go");
    return await Promise.all(results);
  } finally {
    for (const child of children) child.kill();
  }
}
it("two processes accept once and atomically reserve only the oldest compatible operation, surviving reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "placement-process-")),
    path = join(dir, "bb.db");
  let db = createConnection(path);
  try {
    migrate(db);
    setupPlacement(db);
    const accepted = await race(path, "accept", ["", ""]);
    expect(accepted[0]).toEqual(accepted[1]);
    const first = acceptPrepared(db, "first"),
      second = acceptPrepared(db, "second");
    const reserved = await race(path, "reserve", [second.id, first.id]);
    expect(reserved).toEqual([
      expect.objectContaining({ kind: "wait" }),
      expect.objectContaining({ kind: "reserved", fence: 1 }),
    ]);
    db.$client.close();
    db = createConnection(path);
    expect(readPlacementWorker(db, "workers", "worker")).toMatchObject({
      ownerOperationId: first.id,
      fence: 1,
      slotState: "reserved",
    });
    expect(readPlacementOperation(db, first.id)).toMatchObject({
      phase: "reserved",
    });
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("serializes alias reservations in separate processes on the same physical host and inode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alias-race-")),
    path = join(dir, "race.db");
  const db = createConnection(path);
  try {
    migrate(db);
    setupPlacement(db);
    const sibling = observation({
      workerId: "sibling",
      generation: "generation-two",
    });
    sibling.custody.lock = { device: "01", inode: "002" };
    sibling.custody.workerId = sibling.workerId;
    sibling.custody.generation = sibling.generation;
    sibling.routes[0]!.agent.generation = sibling.generation;
    expect(
      observePlacementWorkers(db, {
        ownerPluginId: "workers",
        providerId: "claude",
        expectedOwnerRevision: 2,
        workers: [observation({ revision: 2 }), sibling],
      }).kind,
    ).toBe("observed");
    const names = ["worker", "sibling"];
    const ids = names.map((name) => acceptPrepared(db, name, {}, {}, name).id);
    const results = await race(path, "reserve", ids, names);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "reserved" }),
        expect.objectContaining({ kind: "wait" }),
      ]),
    );
    expect(
      db.$client
        .prepare(
          "select count(*) from placement_worker where physical_lock is not null",
        )
        .pluck()
        .get(),
    ).toBe(1);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("serializes native mode disable and new acceptance across competing processes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mode-race-")),
    file = join(dir, "race.db");
  const db = createConnection(file);
  try {
    migrate(db);
    setupPlacement(db);
    const [disable, accept] = await race(file, "mode-race", [
      "disable",
      "accept",
    ]);
    expect(disable).toMatchObject({
      kind: "updated",
      owner: { mode: "disabled", revision: 3 },
    });
    const count = db.$client
      .prepare("select count(*) from placement_operation")
      .pluck()
      .get();
    expect([0, 1]).toContain(count);
    expect(accept).toMatchObject({
      kind: count === 1 ? "accepted" : "refused",
    });
    const replays = await race(file, "accept", ["", ""]);
    expect(replays).toEqual([accept, accept]);
    expect(
      db.$client
        .prepare("select coalesce(max(accepted_seq),0) from placement_counter")
        .pluck()
        .get(),
    ).toBe(count);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
