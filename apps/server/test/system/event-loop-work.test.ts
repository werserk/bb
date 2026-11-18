import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import type { DbConnection, SlowDbQueryLogFields } from "@bb/db";
import { initDb } from "../../src/db.js";
import {
  currentEventLoopWorkLabel,
  resetEventLoopWorkForTests,
  runEventLoopWork,
  runEventLoopWorkSync,
  takeEventLoopWorkWindowSnapshot,
} from "../../src/services/system/event-loop-work.js";

describe("currentEventLoopWorkLabel", () => {
  beforeEach(() => resetEventLoopWorkForTests());

  it("returns the lineage of nested sync work", () => {
    const labels = runEventLoopWorkSync("GET /api/threads", () => [
      currentEventLoopWorkLabel(),
      runEventLoopWorkSync("timeline build", () => {
        expect(
          takeEventLoopWorkWindowSnapshot().inFlightWorkAtObservation,
        ).toBe("GET /api/threads > timeline build");
        return currentEventLoopWorkLabel();
      }),
    ]);

    expect(labels).toEqual([
      "GET /api/threads",
      "GET /api/threads > timeline build",
    ]);
  });

  it("keeps the lineage of async work across an await", async () => {
    const label = await runEventLoopWork(
      "plugin:wprojects rpc projectState",
      async () => {
        await delay(1);
        return runEventLoopWorkSync("kv list", () =>
          currentEventLoopWorkLabel(),
        );
      },
    );

    expect(label).toBe("plugin:wprojects rpc projectState > kv list");
  });

  it("Label survives after the frame ended", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<string | null>;
    await runEventLoopWork("plugin:wprojects rpc projectState", () => {
      detached = released.then(() => currentEventLoopWorkLabel());
    });

    expect(
      takeEventLoopWorkWindowSnapshot().inFlightWorkAtObservation,
    ).toBeNull();
    release();

    await expect(detached).resolves.toBe("plugin:wprojects rpc projectState");
  });

  it("Bounded lineage", () => {
    const nest = (depth: number): string | null =>
      depth === 0
        ? currentEventLoopWorkLabel()
        : runEventLoopWorkSync(`frame ${depth}`, () => nest(depth - 1));
    const label = runEventLoopWorkSync("root", () => nest(20));
    expect(label).toBe(
      "root > … > frame 6 > frame 5 > frame 4 > frame 3 > frame 2 > frame 1",
    );
  });

  it("returns null outside any frame", () => {
    expect(currentEventLoopWorkLabel()).toBeNull();
  });
});

describe("slow DB lines name their caller", () => {
  let db: DbConnection;
  let lines: SlowDbQueryLogFields[];

  beforeEach(() => {
    resetEventLoopWorkForTests();
    lines = [];
    const ignore = () => undefined;
    db = initDb(":memory:", {
      slowQueryThresholdMs: 0,
      logger: {
        info: (fields: SlowDbQueryLogFields) => lines.push(fields),
        warn: ignore,
        error: ignore,
      } as unknown as NonNullable<Parameters<typeof initDb>[1]>["logger"],
    });
    lines.length = 0;
  });

  afterEach(() => db.$client.close());

  function selectOne(): void {
    db.$client.prepare("SELECT 1").get();
  }

  it("Slow transaction in a plugin RPC", async () => {
    await runEventLoopWork("plugin:wprojects rpc projectState", async () => {
      await delay(1);
      db.transaction(() => selectOne(), { behavior: "deferred" });
    });

    const transaction = lines.find((line) => line.operation === "transaction");
    expect(transaction?.sql).toBe("TRANSACTION DEFERRED");
    expect(transaction?.workLabel).toMatch(/^plugin:wprojects /u);
  });

  it("Concurrent work", async () => {
    let finishSweep!: () => void;
    const sweep = runEventLoopWork(
      "sweep thread-pruning",
      () =>
        new Promise<void>((resolve) => {
          finishSweep = resolve;
        }),
    );

    await runEventLoopWork("GET /api/threads", () => selectOne());
    finishSweep();
    await sweep;

    expect(lines.map((line) => line.workLabel)).toEqual(["GET /api/threads"]);
  });

  it("Label survives after the frame ended", async () => {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let detached!: Promise<void>;
    await runEventLoopWork("plugin:wprojects rpc projectState", () => {
      detached = released.then(() => selectOne());
    });
    release();
    await detached;

    expect(lines.map((line) => line.workLabel)).toEqual([
      "plugin:wprojects rpc projectState",
    ]);
  });

  it("No active work", () => {
    selectOne();

    expect(lines.map((line) => line.workLabel)).toEqual([null]);
  });
});
