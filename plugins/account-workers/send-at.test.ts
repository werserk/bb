import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { BindingStore, type Binding, type ReleaseReason } from "./bindings.js";
import { decideDispatch, safeDecide, WAIT_RECHECK_MS } from "./dispatch.js";

const ME = "account-workers";
const T0 = 1_000_000;
const DAY = 86_400_000;

const time = z.number().int().nonnegative().nullable().optional();
const reason = z.string().min(1).max(200);

const oldCoreWait = z.object({ action: z.literal("wait"), reason, sendAt: time });
const newCoreWait = z
  .object({ action: z.literal("wait"), reason, recheckAt: time, sendAt: time })
  .refine((d) => d.recheckAt === undefined || d.sendAt === undefined);

const cores = {
  "SDK 0.6.132 core (no #7872)": (decision: unknown) => oldCoreWait.parse(decision).sendAt ?? null,
  "SDK >= 0.6.174 core (#7872)": (decision: unknown) => {
    const parsed = newCoreWait.parse(decision);
    return parsed.recheckAt ?? parsed.sendAt ?? null;
  },
};

type Status = "pending" | "idle" | "starting" | "active" | "stopping" | "error";

const ctx = (status: Status = "pending") =>
  makeMessageDispatchHookContext({
    thread: { id: "t1", originPluginId: ME, createdAt: T0, status },
    requestedExecution: { providerId: "claude-code", model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
  });

function store(db = new Database(":memory:"), now = () => T0) {
  return new BindingStore(db, now);
}

function create(s: BindingStore, patch: Partial<Pick<Binding, "ready" | "sendAt">> = {}): Binding {
  const created = s.create({
    id: "aw_0123456789abcdef",
    workerHostId: "w",
    scratchPath: "/s",
    workspaceHostId: "ws",
    workspaceHostName: "ws",
    root: "/r",
    instructions: [],
    profile: "claude",
    ...patch,
  });
  s.claimById(created.id, "t1");
  return s.byId(created.id)!;
}

describe("--send-at hold", () => {
  it("a ready binding still waits until the requested time: readiness and the schedule are two gates", () => {
    const record = create(store(), { sendAt: T0 + DAY });
    expect(record.ready).toBe(true);
    const verdict = decideDispatch(ME, ctx(), record, T0 + 5);
    expect(verdict.decision).toMatchObject({ action: "wait", sendAt: T0 + DAY });
    expect(verdict.decision).not.toHaveProperty("recheckAt");
    expect((verdict.decision as { reason: string }).reason).toContain("--send-at");
  });

  it("an unready binding waits for readiness first, then for the time, then proceeds", () => {
    const s = store();
    const record = create(s, { ready: false, sendAt: T0 + DAY });
    expect(decideDispatch(ME, ctx(), record, T0 + 5).decision).toMatchObject({ action: "wait", sendAt: T0 + 5 + WAIT_RECHECK_MS });
    s.markReadyIfLive(record.id);
    const ready = s.byId(record.id)!;
    expect(decideDispatch(ME, ctx(), ready, T0 + 5).decision).toMatchObject({ action: "wait", sendAt: T0 + DAY });
    expect(decideDispatch(ME, ctx(), ready, T0 + DAY).decision).toEqual({ action: "proceed" });
  });

  it.each<Status>(["idle", "starting", "active", "stopping", "error"])("a thread that has started (%s) proceeds before the time: --send-at schedules only the first message", (status) => {
    expect(decideDispatch(ME, ctx(status), create(store(), { sendAt: T0 + DAY }), T0).decision).toEqual({ action: "proceed" });
  });

  it("the same binding holds a pending thread and lets it through once the thread has started", () => {
    const record = create(store(), { sendAt: T0 + DAY });
    expect(decideDispatch(ME, ctx("pending"), record, T0).decision).toMatchObject({ action: "wait", sendAt: T0 + DAY });
    expect(decideDispatch(ME, ctx("active"), record, T0).decision).toEqual({ action: "proceed" });
  });

  it.each([
    ["a missing time", null],
    ["a past-due time", T0 - 1],
    ["a time that is due now", T0],
  ])("%s proceeds once ready, never waits forever", (_name, sendAt) => {
    expect(decideDispatch(ME, ctx(), create(store(), { sendAt }), T0).decision).toEqual({ action: "proceed" });
  });

  describe.each(Object.entries(cores))("on a %s", (_core, waitTime) => {
    it("every wait the hook returns keeps its time", () => {
      const s = store();
      const scheduled = decideDispatch(ME, ctx(), create(s, { sendAt: T0 + DAY }), T0).decision;
      expect(waitTime(scheduled)).toBe(T0 + DAY);
      expect(waitTime(decideDispatch(ME, ctx(), null, T0).decision)).toBe(T0 + WAIT_RECHECK_MS);
      const failed = safeDecide(ME, ctx(), () => {
        throw new Error("locked");
      }, T0, () => undefined).decision;
      expect(waitTime(failed)).toBe(T0 + WAIT_RECHECK_MS);
    });
  });

  it("model of the 0.6.132 queue: rechecks and due sweeps before T re-ask and wait; the sweep at T dispatches", () => {
    const s = store();
    const record = create(s, { ready: false, sendAt: T0 + DAY });
    const parse = cores["SDK 0.6.132 core (no #7872)"];
    const row = { sendAt: null as number | null, dispatchedAt: null as number | null };
    const attempt = (now: number) => {
      const decision = decideDispatch(ME, ctx(), s.byId(record.id)!, now).decision;
      if (decision.action === "proceed") row.dispatchedAt = now;
      else row.sendAt = parse(decision);
    };
    const sweep = (now: number) => {
      if (row.dispatchedAt === null && row.sendAt !== null && row.sendAt <= now) attempt(now);
    };
    attempt(T0);
    expect(row.sendAt).toBe(T0 + WAIT_RECHECK_MS);
    s.markReadyIfLive(record.id);
    attempt(T0 + 10);
    expect(row.sendAt).toBe(T0 + DAY);
    for (const now of [T0 + WAIT_RECHECK_MS, T0 + 60_000, T0 + DAY / 2, T0 + DAY - 1]) {
      sweep(now);
      attempt(now);
    }
    expect(row).toEqual({ sendAt: T0 + DAY, dispatchedAt: null });
    sweep(T0 + DAY);
    expect(row.dispatchedAt).toBe(T0 + DAY);
  });

  it("control: the SDK 0.6.174 name alone is lost on a 0.6.132 core, which is why the hook does not use it", () => {
    expect(cores["SDK 0.6.132 core (no #7872)"]({ action: "wait", reason: "r", recheckAt: T0 + DAY })).toBeNull();
  });
});

describe("binding send_at", () => {
  it("is stored at create, and an old database gains the column as null", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE bindings (id TEXT PRIMARY KEY, thread_id TEXT UNIQUE, worker_host_id TEXT NOT NULL, scratch_path TEXT NOT NULL, workspace_host_id TEXT NOT NULL, workspace_host_name TEXT NOT NULL, root TEXT NOT NULL, instructions TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO bindings VALUES ('aw_old', 't0', 'h', '/s/aw_old', 'h2', 'ws', '/r', '[]', 1, 1)").run();
    const s = store(db);
    expect(s.byId("aw_old")?.sendAt).toBeNull();
    expect(create(s, { sendAt: T0 + DAY }).sendAt).toBe(T0 + DAY);
    expect(create(store()).sendAt).toBeNull();
  });

  it.each<ReleaseReason>(["unbind", "delete", "spawn-failed", "abandoned", "account-refused"])("a %s release clears it at once", (why) => {
    const s = store();
    const record = create(s, { sendAt: T0 + DAY });
    s.tombstone(record.id, T0, why);
    expect(s.byId(record.id)?.sendAt).toBeNull();
  });

  it("an archive keeps it through the undo window, so an unarchive restores the hold, and the final release clears it", () => {
    const s = store();
    const record = create(s, { sendAt: T0 + DAY });
    s.tombstone(record.id, T0 + 30_000, "archive");
    expect(s.byId(record.id)?.sendAt).toBe(T0 + DAY);
    expect(s.untombstone(record.id)).toBe(true);
    expect(decideDispatch(ME, ctx(), s.byId(record.id)!, T0 + 1).decision).toMatchObject({ action: "wait", sendAt: T0 + DAY });
    s.tombstone(record.id, T0, "archive");
    s.markCleaned(record.id);
    expect(s.byId(record.id)?.sendAt).toBeNull();
  });

  it("a delete after an archive clears it", () => {
    const s = store();
    const record = create(s, { sendAt: T0 + DAY });
    s.tombstone(record.id, T0 + 30_000, "archive");
    s.tombstone(record.id, T0, "delete");
    expect(s.byId(record.id)?.sendAt).toBeNull();
  });
});
