import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { BindingStore, type Binding } from "./bindings.js";
import { Releaser, type ThreadState } from "./release.js";

let now: number;
let store: BindingStore;
let calls: { method: string; input: unknown; hostId: string }[];
let hostAnswer: () => unknown;
let state: ThreadState["kind"];
let timers: { run: () => void; ms: number; cancelled: boolean }[];
let releaser: Releaser;

beforeEach(() => {
  now = 1_000;
  store = new BindingStore(new Database(":memory:"), () => now);
  calls = [];
  hostAnswer = () => ({ ok: true });
  state = "quiet";
  timers = [];
  releaser = new Releaser({
    store,
    host: {
      call: (async (method: string, input: unknown, options: { hostId: string }) => {
        calls.push({ method, input, hostId: options.hostId });
        return hostAnswer();
      }) as never,
    },
    threadState: async () => ({ kind: state }),
    now: () => now,
    log: () => undefined,
    setTimer: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return { cancel: () => void (timer.cancelled = true) };
    },
  });
});

function bound(id = "aw_0123456789abcdef", threadId = "t1"): Binding {
  store.create({ id, workerHostId: "worker", scratchPath: `/s/${id}`, workspaceHostId: "ws", workspaceHostName: "ws", root: "/r", instructions: [], profile: "codex" });
  return store.claimById(id, threadId)!;
}

describe("release", () => {
  it("tombstones first: the live lookup drops the binding before anything runs on the worker", () => {
    const b = bound();
    releaser.retire(b, now + 30_000, "archive");
    expect(store.byThread("t1")).toBeNull();
    expect(store.recordByThread("t1")?.releasedAt).toBe(now);
    expect(calls).toEqual([]);
    expect(timers.at(-1)?.ms).toBe(30_000);
  });

  it("does not touch the worker before the due time", async () => {
    const b = bound();
    releaser.retire(b, now + 30_000, "archive");
    expect(await releaser.release(b)).toEqual({ kind: "not-due" });
    await releaser.sweep();
    expect(calls).toEqual([]);
  });

  it("release on an active thread does not touch the scratch", async () => {
    const b = bound();
    releaser.retire(b, now, "unbind");
    state = "live";
    expect(await releaser.release(b)).toEqual({ kind: "live" });
    expect(calls).toEqual([]);
    expect(store.byId(b.id)?.cleanedAt).toBeNull();
    state = "quiet";
    await releaser.sweep();
    expect(calls).toHaveLength(1);
  });

  it("asks the worker to release with the stored scratch path, then records it once", async () => {
    const b = bound();
    releaser.retire(b, now, "unbind");
    now += 5;
    expect(await releaser.release(b)).toEqual({ kind: "cleaned" });
    expect(calls).toEqual([{ method: "releaseScratch", input: { bindingId: b.id, profile: "codex", scratchPath: "/s/aw_0123456789abcdef" }, hostId: "worker" }]);
    expect(store.byId(b.id)?.cleanedAt).toBe(now);
    expect(await releaser.release(b)).toEqual({ kind: "cleaned" });
    expect(calls).toHaveLength(1);
  });

  it("a sweep with nothing pending does not block later sweeps", async () => {
    await releaser.sweep();
    const b = bound();
    releaser.retire(b, now, "unbind");
    await releaser.sweep();
    expect(calls.map((c) => c.method)).toEqual(["releaseScratch"]);
    expect(store.byId(b.id)?.cleanedAt).toBe(now);
  });

  it("the due timer runs the sweep", async () => {
    const b = bound();
    releaser.retire(b, now + 30_000, "archive");
    now += 30_000;
    timers.at(-1)!.run();
    await releaser.sweep();
    expect(store.byId(b.id)?.cleanedAt).toBe(now);
  });

  it("an unarchive before the release undoes an archive tombstone only", async () => {
    const a = bound("aw_000000000000000a", "ta");
    releaser.retire(a, now + 30_000, "archive");
    expect(releaser.restore(a)).toBe(true);
    expect(store.byThread("ta")?.id).toBe(a.id);
    expect(timers.at(-1)?.cancelled).toBe(true);

    const u = bound("aw_000000000000000b", "tb");
    hostAnswer = () => ({ ok: false, error: "busy" });
    releaser.retire(u, now, "unbind");
    await releaser.release(u);
    expect(releaser.restore(u)).toBe(false);

    const d = bound("aw_000000000000000c", "tc");
    releaser.retire(d, now + 30_000, "archive");
    releaser.retire(d, now + 30_000, "delete");
    expect(releaser.restore(d)).toBe(false);
    expect(store.byId(d.id)?.releaseReason).toBe("delete");
  });

  it("a failed release keeps the row with the error; the sweep leaves it for an explicit retry", async () => {
    const b = bound();
    hostAnswer = () => ({ ok: false, error: "profile codex release failed: locked" });
    releaser.retire(b, now, "unbind");
    expect(await releaser.release(b)).toEqual({ kind: "failed", error: "profile codex release failed: locked" });
    expect(store.byId(b.id)?.releaseError).toBe("profile codex release failed: locked");
    await releaser.sweep();
    expect(calls).toHaveLength(1);
    hostAnswer = () => ({ ok: true });
    expect(await releaser.release(b)).toEqual({ kind: "cleaned" });
    expect(store.byId(b.id)?.releaseError).toBeNull();
  });

  it("a transport failure is recorded the same way", async () => {
    const b = bound();
    hostAnswer = () => {
      throw new Error("host offline");
    };
    releaser.retire(b, now, "unbind");
    expect(await releaser.release(b)).toEqual({ kind: "failed", error: "host offline" });
  });

  it("an unclaimed binding (spawn failed) releases without a thread check", async () => {
    store.create({ id: "aw_00000000000000ff", workerHostId: "worker", scratchPath: "/s/x", workspaceHostId: "ws", workspaceHostName: "ws", root: "/r", instructions: [], profile: "claude", ready: false });
    const b = store.byId("aw_00000000000000ff")!;
    state = "live";
    releaser.retire(b, now, "spawn-failed");
    expect(await releaser.release(b)).toEqual({ kind: "cleaned" });
  });
});
