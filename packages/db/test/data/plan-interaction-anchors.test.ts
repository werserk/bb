import { expect, it } from "vitest";
import { createMigratedConnection } from "../../src/testing.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { noopNotifier } from "../../src/notifier.js";
import { getPlanInteractionCreationRow } from "../../src/data/events.js";
import type { SlowDbQueryLogFields } from "../../src/connection.js";

function fixture() {
  const queries: SlowDbQueryLogFields[] = [];
  const db = createMigratedConnection({
    slowQueryThresholdMs: 0,
    slowQueryLogger: {
      info: (fields) => {
        queries.push(fields);
      },
    },
  });
  const host = upsertHost(db, noopNotifier, { name: "anchor-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "anchors",
    source: { type: "local_path", hostId: host.id, path: "/tmp/anchors" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const insert = db.$client.prepare(
    "INSERT INTO events (id,thread_id,scope_kind,turn_id,sequence,type,data,created_at) VALUES (?,?,?,?,?, 'system/interaction/lifecycle',?,1)",
  );
  const write = (
    seq: number,
    id: string,
    turn: string | null = "current",
    status = "pending",
    kind = "user_question",
  ) =>
    insert.run(
      `event-${seq}`,
      thread.id,
      turn === null ? "thread" : "turn",
      turn,
      seq,
      JSON.stringify({ interaction: { id, status, payload: { kind } } }),
    );
  const read = (id: string, turnId: string | null = "current", boundary = 0) =>
    getPlanInteractionCreationRow(db, thread.id, id, { turnId, boundary });
  return { db, thread, write, read, queries };
}
it("bounds lifecycle JSON work by the indexed turn and sequence, independently of 10000 historical interactions", () => {
  const f = fixture();
  try {
    f.db.$client.transaction(() => {
      for (let seq = 1; seq <= 10000; seq++)
        f.write(seq, `old-${seq}`, "historical");
    })();
    f.write(10001, "target");
    f.write(10002, "second");
    let evaluations = 0;
    f.db.$client.function("json_extract", (data: string, path: string) => {
      evaluations++;
      const value = JSON.parse(data).interaction;
      return path === "$.interaction.id"
        ? value.id
        : path === "$.interaction.status"
          ? value.status
          : value.payload.kind;
    });
    f.queries.length = 0;
    expect(f.read("target")?.sequence).toBe(10001);
    expect(f.read("second")?.sequence).toBe(10002);
    expect(evaluations).toBeLessThanOrEqual(12);
    const query = f.queries[0]!;
    const plan = f.db.$client
      .prepare<
        [
          string,
          string,
          string,
          number,
          number,
          number,
          string,
          string,
          string,
        ],
        { detail: string }
      >(`EXPLAIN QUERY PLAN ${query.sql}`)
      .all(
        f.thread.id,
        "current",
        "system/interaction/lifecycle",
        0,
        129,
        128,
        "target",
        "pending",
        "user_question",
      )
      .map((row) => row.detail)
      .join("\n");
    expect(plan).toContain("events_thread_turn_type_item_sequence_idx");
    expect(plan).toContain("MATERIALIZE plan_interaction_candidates");
    expect(plan).toMatch(
      /thread_id=\? AND turn_id=\? AND type=\? AND item_id=\? AND sequence>\?/,
    );
    expect(plan).not.toContain("TEMP B-TREE");
    console.log(
      `ANCHOR WORK historical=10000 lookups=2 json_evaluations=${evaluations}; ${plan}`,
    );
  } finally {
    f.db.$client.close();
  }
});
it("accepts exactly 128 candidates, refuses the overflow sentinel and excludes non-creation lifecycle facts", () => {
  const f = fixture();
  try {
    f.write(1, "target");
    for (let seq = 2; seq <= 128; seq++)
      f.write(seq, `old-${seq}`, "current", "resolved");
    expect(f.read("target")?.sequence).toBe(1);
    f.write(129, "extra");
    expect(f.read("target")).toBeNull();
    f.write(130, "resolving", "fresh", "resolving");
    f.write(131, "unsupported", "fresh", "pending", "plugin");
    f.write(132, "legacy-turnless", null);
    expect(f.read("resolving", "fresh")).toBeNull();
    expect(f.read("unsupported", "fresh")).toBeNull();
    expect(f.read("legacy-turnless", "fresh")).toBeNull();
    expect(f.read("legacy-turnless", null)).toBeNull();
  } finally {
    f.db.$client.close();
  }
});
it("fails closed for missing, duplicate, wrong-turn, turnless, cleared and oversized single-turn lifecycle anchors", () => {
  const f = fixture();
  try {
    f.write(1, "target");
    expect(f.read("target", "wrong")).toBeNull();
    expect(f.read("target", null)).toBeNull();
    expect(f.read("target", "current", 2)).toBeNull();
    expect(f.read("missing")).toBeNull();
    f.write(2, "target");
    expect(f.read("target")).toBeNull();
    for (let seq = 3; seq <= 10000; seq++) f.write(seq, `extra-${seq}`);
    let evaluations = 0;
    f.db.$client.function("json_extract", () => {
      evaluations++;
      return "target";
    });
    expect(f.read("target")).toBeNull();
    expect(evaluations).toBeLessThanOrEqual(387);
    console.log(
      `ANCHOR OVERFLOW same_turn=10000 json_evaluations=${evaluations} result=unbound`,
    );
  } finally {
    f.db.$client.close();
  }
});
