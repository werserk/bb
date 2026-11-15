import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { createMigratedConnection } from "@bb/db/testing";
import {
  createThread,
  createProject,
  upsertHost,
  noopNotifier,
  insertEvents,
  listPendingInteractionsByThread,
} from "@bb/db";
import { turnScope } from "@bb/domain";
import { readThreadPlan } from "../src/services/threads/thread-plans.js";

const db = createMigratedConnection();
try {
  const host = upsertHost(db, noopNotifier, { name: "benchmark" });
  const { project } = createProject(db, noopNotifier, {
    name: "plans",
    source: { type: "local_path", hostId: host.id, path: "/synthetic/plans" },
  });
  const threads = db.transaction(() =>
    Array.from({ length: 1400 }, (_, i) => {
      const thread = createThread(db, noopNotifier, {
        projectId: project.id,
        providerId: "benchmark",
      });
      insertEvents(
        db,
        noopNotifier,
        Array.from({ length: i % 10 === 0 ? 0 : 12 }, (_, j) => ({
          threadId: thread.id,
          sequence: j + 1,
          type: "item/completed",
          scope: turnScope("benchmark-turn"),
          itemId: `plan-${j}`,
          itemKind: "planSteps",
          parentToolCallId: null,
          data: JSON.stringify({
            providerThreadId: "benchmark",
            item: {
              id: `plan-${j}`,
              type: "planSteps",
              status: "completed",
              planId: `p${j}`,
              steps: Array.from({ length: 8 }, (_, k) => ({
                id: `s${k}`,
                step: "Synthetic work",
                status: "completed",
                note: "x".repeat(32),
              })),
            },
          }),
        })),
      );
      return thread;
    }),
  );
  const pendingInteractions = {
    listPendingThreadInteractions(threadId) {
      const rows = listPendingInteractionsByThread(db, {
        threadId,
        statuses: ["pending", "resolving"],
      });
      if (rows.length)
        throw new Error("Fixture must have no pending interactions");
      return [];
    },
  };
  const deps = { db, pendingInteractions };
  const samples = [];
  let checksum = 0;
  for (let pass = 0; pass < 35; pass++) {
    const load1 = Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);
    if (load1 >= 16) throw new Error(`Load guard: ${load1} >= 16`);
    const started = performance.now();
    for (const thread of threads) {
      const view = readThreadPlan(deps, thread);
      checksum += view.revision + view.previousPlans.length;
    }
    const elapsed = performance.now() - started;
    if (pass >= 5) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      threads: threads.length,
      plans: 15120,
      warmup: 5,
      samples: samples.length,
      p50Ms: samples[14],
      p95Ms: samples[28],
      minMs: samples[0],
      maxMs: samples.at(-1),
      checksum,
      timesMs: samples,
    }),
  );
} finally {
  db.$client.close();
}
