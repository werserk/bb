import { fork } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createConnection, migrate } from "../src/index.js";
import { setupPlacement, acceptPrepared } from "./helpers/placement.js";
import { readPlacementOperation } from "../src/data/placement-operations.js";
import { readPlacementWorker } from "../src/data/placement-workers.js";

async function race(path: string, mode: string, ids: string[]) {
  const children = ids.map((id) =>
    fork(
      new URL("./helpers/placement-process.ts", import.meta.url),
      [path, mode, id],
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
