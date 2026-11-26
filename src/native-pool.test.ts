import Database from "better-sqlite3";
import { afterEach, expect, it, vi } from "vitest";
import {
  NativePool,
  NativePoolStore,
  type NativeClients,
} from "./native-pool.js";
import { QUOTA_MIGRATIONS } from "./store.js";
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  for (const migration of QUOTA_MIGRATIONS) db.exec(migration);
  const store = new NativePoolStore(db);
  store.enroll({
    id: "a",
    hostId: "host-a",
    generation: "g1",
    label: "Account A",
    workspace: "/runtime",
    sshTarget: "owner@machine:/work",
  });
  db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
    "host-a",
  );
  store.configure("a", true, true);
  const clients: NativeClients = {
    observe: vi.fn(async () => ({
      generation: "g1",
      epoch: "boot1",
      lock: "free" as const,
      threadId: null,
    })),
    spawn: vi.fn(async () => ({ threadId: "thread-a" })),
    send: vi.fn(async () => ({ kind: "queued" as const, queueId: "queue-a" })),
    recheck: vi.fn(async () => {}),
    findCreated: vi.fn(async () => []),
    releaseIdle: vi.fn(async () => "released" as const),
    stop: vi.fn(async () => {}),
    cancelQueue: vi.fn(async () => {}),
  };
  const pool = new NativePool(store, clients, {
    enabled: true,
    qualified: true,
  });
  return { db, store, clients, pool };
}
it("reserves before spawn and queues a competitor without another spawn", async () => {
  const { pool, store, clients } = fixture();
  clients.spawn = vi.fn(async () => {
    expect(store.status().slots[0].phase).toBe("reserved");
    const second = await pool.submit({
      submissionKey: "two",
      projectId: "p",
      input: "second",
    });
    expect(second.phase).toBe("waiting");
    return { threadId: "thread-a" };
  });
  const first = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "first",
  });
  expect(first.queueId).toBe("queue-a");
  expect(first.input).toBeNull();
  expect(clients.spawn).toHaveBeenCalledTimes(1);
  expect(clients.send).toHaveBeenCalledTimes(1);
  expect(
    await pool.submit({ submissionKey: "one", projectId: "p", input: "first" }),
  ).toEqual(first);
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("holds lost send acknowledgements across restart without resend", async () => {
  const { pool, store, clients } = fixture();
  clients.send = vi.fn(async () => {
    throw new Error("ack lost");
  });
  const first = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "keep me",
  });
  expect(first.phase).toBe("unknown");
  expect(first.input).toBe("keep me");
  const restarted = new NativePool(store, clients, {
    enabled: true,
    qualified: true,
  });
  await restarted.reconcile();
  expect(clients.send).toHaveBeenCalledTimes(1);
  expect(restarted.dispatch("thread-a", "host-a").allow).toBe(false);
  expect(store.status().slots[0].phase).toBe("unknown");
});
it("recovers exact create attribution and never repeats spawn", async () => {
  const { pool, store, clients } = fixture();
  clients.spawn = vi.fn(async () => {
    throw new Error("ack lost");
  });
  const first = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "keep me",
  });
  clients.findCreated = vi.fn(async () => [
    { threadId: "recovered", cellId: "a", generation: "g1" },
  ]);
  await new NativePool(store, clients, {
    enabled: true,
    qualified: true,
  }).reconcile();
  expect(store.intent(first.id).queueId).toBe("queue-a");
  expect(clients.spawn).toHaveBeenCalledTimes(1);
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("holds absent or duplicate create matches without guessing", async () => {
  const { pool, store, clients } = fixture();
  clients.spawn = vi.fn(async () => {
    throw new Error("lost");
  });
  const first = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "keep",
  });
  await pool.reconcile();
  expect(store.intent(first.id).phase).toBe("unknown");
  clients.findCreated = vi.fn(async () => [
    { threadId: "t1", cellId: "a", generation: "g1" },
    { threadId: "t2", cellId: "a", generation: "g1" },
  ]);
  await pool.reconcile();
  expect(clients.send).not.toHaveBeenCalled();
  expect(clients.spawn).toHaveBeenCalledTimes(1);
});
it("commits exact queue custody before waking, and restart cannot send twice", async () => {
  const { pool, store, clients } = fixture();
  clients.send = vi.fn(async () => {
    expect(pool.dispatch("thread-a", "host-a").allow).toBe(false);
    return { kind: "queued" as const, queueId: "exact-q" };
  });
  clients.recheck = vi.fn(async () => {
    expect(store.status().intents[0].queueId).toBe("exact-q");
    throw new Error("wake lost");
  });
  const first = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "x",
  });
  await pool.reconcile();
  expect(store.intent(first.id).input).toBeNull();
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("does not resend after queue receipt but failed local commit", async () => {
  const { pool, store, clients, db } = fixture();
  db.exec(
    "CREATE TRIGGER break_commit BEFORE UPDATE OF queueId ON native_intent BEGIN SELECT RAISE(ABORT,'crash'); END",
  );
  const first = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "x",
  });
  db.exec("DROP TRIGGER break_commit");
  await pool.reconcile();
  expect(store.intent(first.id).queueId).toBeNull();
  expect(store.intent(first.id).input).toBe("x");
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("busy idle-release preserves resident and never calls Stop", async () => {
  const { pool, clients, store } = fixture();
  const i = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "x",
  });
  clients.releaseIdle = vi.fn(async () => "busy" as const);
  expect(await pool.release("a")).toBe("busy");
  expect(store.status().slots[0].phase).toBe("reserved");
  expect(clients.stop).not.toHaveBeenCalled();
  expect(store.intent(i.id).queueId).toBe("queue-a");
});
it("release requires a free worker observation and preserves immutable affinity", async () => {
  const { pool, store, clients } = fixture();
  const i = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "x",
  });
  expect(await pool.release("a")).toBe("released");
  expect(store.status().slots[0].phase).toBe("free");
  await pool.reconcile();
  expect(store.status().slots[0].phase).toBe("free");
  expect(store.status().bindings[0].cellId).toBe("a");
  expect(store.intent(i.id).phase).toBe("released");
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("Stop cancels only exact owned queue and cannot free capacity from ok alone", async () => {
  const { pool, store, clients } = fixture();
  const i = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "x",
  });
  await pool.stop(i.id);
  await pool.reconcile();
  expect(clients.cancelQueue).toHaveBeenCalledWith("thread-a", "queue-a");
  expect(clients.stop).toHaveBeenCalledTimes(1);
  expect(store.status().slots[0].phase).toBe("unknown");
  expect(pool.dispatch("thread-a", "host-a").allow).toBe(false);
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("defaults disabled and unqualified without side effects", async () => {
  const { store, clients } = fixture();
  const pool = new NativePool(store, clients);
  const i = await pool.submit({
    submissionKey: "one",
    projectId: "p",
    input: "x",
  });
  expect(i.phase).toBe("waiting");
  expect(clients.observe).not.toHaveBeenCalled();
  expect(pool.dispatch("anything", "host-a").allow).toBe(false);
});
it("UI RPC and CLI repeat the same intent and dispatch path", async () => {
  const { pool, clients } = fixture();
  const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
  const { registerNativeSurface, createNativeCommands } =
    await import("./native-surface.js");
  const host = createFakePluginHost({ pluginId: "native-lab" });
  registerNativeSurface(host.bb, pool);
  const { defineCli } = await import("@get-bb/plugin-sdk");
  host.bb.cli.register(
    defineCli({
      name: "pool",
      summary: "Pool",
      commands: createNativeCommands(pool),
    }),
  );
  const first = await host.harness.behavior.callRpc("native.submit", {
    submissionKey: "same",
    projectId: "p",
    input: "task",
  });
  const cli = await host.harness.behavior.runCli([
    "native",
    "submit",
    "same",
    "p",
    "task",
  ]);
  expect(JSON.parse(cli.stdout!)).toEqual(first);
  expect(clients.spawn).toHaveBeenCalledTimes(1);
  expect(clients.send).toHaveBeenCalledTimes(1);
  await host.harness.dispose();
});
it("Stop during create persists cancellation and suppresses initial transfer", async () => {
  const { pool, store, clients } = fixture();
  let finish!: (x: { threadId: string }) => void;
  clients.spawn = vi.fn(
    () =>
      new Promise<{ threadId: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = pool.submit({
    submissionKey: "stop-create",
    projectId: "p",
    input: "never send",
  });
  await vi.waitFor(() => expect(clients.spawn).toHaveBeenCalled());
  const id = store.status().intents[0].id;
  await pool.stop(id);
  expect(store.intent(id).phase).toBe("cancelling");
  finish({ threadId: "late-thread" });
  await pending;
  expect(clients.send).not.toHaveBeenCalled();
  expect(clients.stop).toHaveBeenCalledWith("late-thread");
  expect(store.status().slots[0].phase).toBe("unknown");
});
it("Stop during send cancels exact eventual queue receipt and never wakes it", async () => {
  const { pool, store, clients } = fixture();
  let finish!: (x: { kind: "queued"; queueId: string }) => void;
  clients.send = vi.fn(
    () =>
      new Promise<{ kind: "queued"; queueId: string }>((resolve) => {
        finish = resolve;
      }),
  );
  const pending = pool.submit({
    submissionKey: "stop-send",
    projectId: "p",
    input: "held",
  });
  await vi.waitFor(() => expect(clients.send).toHaveBeenCalled());
  await pool.stop(store.status().intents[0].id);
  finish({ kind: "queued", queueId: "late-queue" });
  await pending;
  expect(clients.cancelQueue).toHaveBeenCalledWith("thread-a", "late-queue");
  expect(clients.recheck).not.toHaveBeenCalled();
});
it("wakes waiting submissions after release and resumes only the original binding", async () => {
  const { pool, store, clients } = fixture();
  let n = 0;
  clients.spawn = vi.fn(async () => ({ threadId: `thread-${++n}` }));
  const first = await pool.submit({
    submissionKey: "first",
    projectId: "p",
    input: "a",
  });
  const second = store.create({
    submissionKey: "second",
    projectId: "p",
    input: "b",
  });
  await pool.pump();
  expect(store.intent(second.id).queueId).toBe("queue-a");
  expect(store.intent(first.id).phase).toBe("released");
  expect(await pool.resume(first.threadId!, "host-a")).toBe(true);
  expect(store.status().slots[0].threadId).toBe(first.threadId);
  expect(
    store.status().bindings.find((b) => b.threadId === first.threadId)?.cellId,
  ).toBe("a");
});
it("holds unexpected sent response, generation mismatch and worker loss without replay", async () => {
  const { pool, store, clients } = fixture();
  clients.send = vi.fn(async () => ({ kind: "sent" as const }));
  const i = await pool.submit({
    submissionKey: "sent",
    projectId: "p",
    input: "preserve",
  });
  expect(i.phase).toBe("unknown");
  expect(i.input).toBe("preserve");
  clients.observe = vi.fn(async () => ({
    generation: "g2",
    epoch: "boot2",
    lock: "free" as const,
    threadId: null,
  }));
  await pool.reconcile();
  expect(pool.dispatch("thread-a", "host-a").allow).toBe(false);
  pool.workerLost("host-a");
  expect(store.status().slots[0].phase).toBe("unknown");
  expect(clients.send).toHaveBeenCalledTimes(1);
});
it("SQLite forbids rewriting bindings or account generation", async () => {
  const { pool, store, db } = fixture();
  await pool.submit({ submissionKey: "one", projectId: "p", input: "x" });
  expect(() =>
    db.prepare("UPDATE native_binding SET cellId='other'").run(),
  ).toThrow("immutable");
  expect(() =>
    db.prepare("UPDATE native_cell SET generation='new'").run(),
  ).toThrow("immutable");
  expect(store.status().bindings[0].generation).toBe("g1");
});
it("durable queue receipt survives closing and reopening SQLite with no second send", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "native-restart-"));
  const original = fixture();
  try {
    await original.pool.submit({
      submissionKey: "saved",
      projectId: "p",
      input: "payload",
    });
    await original.db.backup(path.join(dir, "state.db"));
    const reopened = new Database(path.join(dir, "state.db"));
    databases.push(reopened);
    const store = new NativePoolStore(reopened);
    const restarted = new NativePool(store, original.clients, {
      enabled: true,
      qualified: true,
    });
    expect(restarted.dispatch("thread-a", "host-a").allow).toBe(false);
    await restarted.reconcile();
    expect(store.status().intents[0].queueId).toBe("queue-a");
    expect(store.status().intents[0].input).toBeNull();
    expect(original.clients.send).toHaveBeenCalledTimes(1);
    expect(restarted.dispatch("thread-a", "host-a").allow).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("operator enrollment stays disabled, qualification persists and central exclusion is mandatory", async () => {
  const { pool, store, clients, db } = fixture();
  clients.enrolledHost = async () => true;
  const cell = {
    id: "b",
    hostId: "host-b",
    generation: "g1",
    label: "B",
    workspace: "/runtime-b",
    sshTarget: "owner@b:/ssh",
  };
  await expect(pool.enroll(cell)).rejects.toThrow("Exclude host");
  db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
    "host-b",
  );
  await pool.enroll(cell);
  expect(store.status().cells.find((c) => c.id === "b")?.enabled).toBe(false);
  expect(() => pool.configure({ enabled: true, qualified: true })).toThrow(
    "operator assertion",
  );
  pool.configure({
    enabled: true,
    qualified: true,
    qualification: "installed-worker-verified",
  });
  expect(new NativePool(store, clients).status().enabled).toBe(true);
  db.prepare("DELETE FROM pool_host_exclusion").run();
  expect(
    (
      await pool.submit({
        submissionKey: "excluded-lost",
        projectId: "p",
        input: "x",
      })
    ).phase,
  ).toBe("waiting");
  expect(clients.spawn).not.toHaveBeenCalled();
});

it.each(["disabled", "unqualified", "included"])(
  "an %s free cell cannot hide an eligible idle resident",
  async (kind) => {
    const { pool, store, clients, db } = fixture();
    let n = 0;
    clients.spawn = vi.fn(async () => ({ threadId: `t${++n}` }));
    await pool.submit({
      submissionKey: "first",
      projectId: "p",
      input: "first",
    });
    store.enroll({
      id: "b",
      hostId: "host-b",
      generation: "g1",
      label: "B",
      workspace: "/b",
      sshTarget: "b:/ssh",
    });
    if (kind !== "included")
      db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
        "host-b",
      );
    store.configure("b", kind !== "disabled", kind !== "unqualified");
    const second = await pool.submit({
      submissionKey: "second",
      projectId: "p",
      input: "second",
    });
    expect(second.phase).toBe("queued");
    expect(second.cellId).toBe("a");
    expect(clients.releaseIdle).toHaveBeenCalledWith("t1");
    expect(clients.spawn).toHaveBeenCalledTimes(2);
    expect(store.status().slots.find((s) => s.cellId === "b")?.phase).toBe(
      "free",
    );
  },
);

it("actual plugin idle handler wakes a busy sticky follow-up through the registered dispatch hook", async () => {
  const { clients } = fixture();
  let next = 0;
  let busy = false;
  let pendingThread: string | null = null;
  let deliveries = 0;
  const {
    createFakePluginHost,
    makeMessageDispatchHookContext,
    makeHostResponse,
    makeThreadResponse,
  } = await import("@get-bb/plugin-sdk/testing");
  const { createAccountPoolPlugin } = await import("./server.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(tmpdir(), "native-idle-event-"));
  const host = createFakePluginHost({
    pluginId: "native-idle",
    dataDir: dir,
    sdk: { hosts: { list: async () => [makeHostResponse({ id: "host-a" })] } },
  });
  const dispatch = (threadId: string) =>
    host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: makeThreadResponse({ id: threadId }),
        host: makeHostResponse({ id: "host-a" }),
      }),
    );
  clients.spawn = vi.fn(async () => ({ threadId: `t${++next}` }));
  clients.releaseIdle = vi.fn(async () =>
    busy ? ("busy" as const) : ("released" as const),
  );
  clients.send = vi.fn(async (threadId) => {
    expect((await dispatch(threadId)).action).toBe("wait");
    return { kind: "queued" as const, queueId: `q-${threadId}` };
  });
  clients.recheck = vi.fn(async () => {
    if (pendingThread && (await dispatch(pendingThread)).action === "proceed") {
      deliveries++;
      pendingThread = null;
    }
  });
  try {
    await createAccountPoolPlugin({
      nativeClients: clients,
      nativePolicy: { enabled: true, qualified: true },
      env: {},
    })(host.bb);
    const db = host.bb.storage.database();
    const store = new NativePoolStore(db);
    store.enroll({
      id: "a",
      hostId: "host-a",
      generation: "g1",
      label: "A",
      workspace: "/a",
      sshTarget: "a:/ssh",
    });
    db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
      "host-a",
    );
    store.configure("a", true, true);
    const first = (await host.harness.behavior.callRpc("native.submit", {
      submissionKey: "one",
      projectId: "p",
      input: "one",
    })) as { threadId: string };
    const second = (await host.harness.behavior.callRpc("native.submit", {
      submissionKey: "two",
      projectId: "p",
      input: "two",
    })) as { threadId: string };
    busy = true;
    pendingThread = first.threadId;
    expect((await dispatch(first.threadId)).action).toBe("wait");
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: second.threadId }),
      lastAssistantText: "done",
    });
    expect(deliveries).toBe(0);
    expect(pendingThread).toBe(first.threadId);
    busy = false;
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: second.threadId }),
      lastAssistantText: "done",
    });
    expect(deliveries).toBe(1);
    expect(pendingThread).toBeNull();
    expect(store.status().slots[0].threadId).toBe(first.threadId);
    expect(
      store.status().bindings.find((b) => b.threadId === first.threadId),
    ).toMatchObject({ cellId: "a", generation: "g1" });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: second.threadId }),
      lastAssistantText: "done",
    });
    expect(deliveries).toBe(1);
    expect(clients.send).toHaveBeenCalledTimes(2);
    expect(clients.stop).not.toHaveBeenCalled();
  } finally {
    await host.harness.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([undefined, "a", "b"])(
  "honors eligible free cells and explicit constraint %s",
  async (requestedCell) => {
    const { pool, store, clients, db } = fixture();
    let n = 0;
    clients.spawn = vi.fn(async () => ({ threadId: `t${++n}` }));
    await pool.submit({
      submissionKey: "first",
      projectId: "p",
      input: "first",
    });
    store.enroll({
      id: "b",
      hostId: "host-b",
      generation: "g1",
      label: "B",
      workspace: "/b",
      sshTarget: "b:/ssh",
    });
    db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
      "host-b",
    );
    store.configure("b", true, true);
    const second = await pool.submit({
      submissionKey: "second",
      projectId: "p",
      input: "second",
      cellId: requestedCell,
    });
    expect(second.phase).toBe("queued");
    expect(second.cellId).toBe(requestedCell === "a" ? "a" : "b");
    expect(clients.releaseIdle).toHaveBeenCalledTimes(
      requestedCell === "a" ? 1 : 0,
    );
  },
);

it.each([404, 500, "transport"])(
  "explicit Stop still interrupts after owned queue cleanup rejects with %s",
  async (failure) => {
    const { pool, store, clients } = fixture();
    const i = await pool.submit({
      submissionKey: "stop-rejected-cleanup",
      projectId: "p",
      input: "x",
    });
    clients.cancelQueue = vi.fn(async () => {
      throw Object.assign(new Error("cleanup unavailable"), {
        status: failure,
      });
    });
    const stopped = await pool.stop(i.id);
    expect(clients.cancelQueue).toHaveBeenCalledExactlyOnceWith(
      "thread-a",
      "queue-a",
    );
    expect(clients.stop).toHaveBeenCalledExactlyOnceWith("thread-a");
    expect(stopped.phase).toBe("cancelling");
    expect(stopped.detail).toContain("Queue cleanup unconfirmed");
    expect(store.status().slots[0].phase).toBe("unknown");
    expect(clients.send).toHaveBeenCalledTimes(1);
  },
);

it("Stop interrupted during exact create recovery carries through to the late binding", async () => {
  const { pool, store, clients } = fixture();
  clients.spawn = vi.fn(async () => {
    throw new Error("spawn acknowledgement lost");
  });
  const i = await pool.submit({
    submissionKey: "stop-recovery",
    projectId: "p",
    input: "never send",
  });
  let finish!: (
    matches: Array<{ threadId: string; cellId: string; generation: string }>,
  ) => void;
  clients.findCreated = vi.fn(
    () =>
      new Promise<
        Array<{ threadId: string; cellId: string; generation: string }>
      >((resolve) => {
        finish = resolve;
      }),
  );
  const recovery = pool.reconcile();
  await vi.waitFor(() => expect(clients.findCreated).toHaveBeenCalledTimes(1));
  await pool.stop(i.id);
  expect(store.intent(i.id).phase).toBe("cancelling");
  finish([{ threadId: "recovered-thread", cellId: "a", generation: "g1" }]);
  await recovery;
  expect(clients.stop).toHaveBeenCalledExactlyOnceWith("recovered-thread");
  expect(clients.send).not.toHaveBeenCalled();
  expect(clients.cancelQueue).not.toHaveBeenCalled();
  expect(store.intent(i.id).phase).toBe("cancelling");
  expect(store.status().slots[0].phase).toBe("unknown");
});

it("a delayed cleanup cannot delay issuing explicit Stop, and failed Stop remains unconfirmed", async () => {
  const { pool, store, clients } = fixture();
  const i = await pool.submit({
    submissionKey: "stop-slow-cleanup",
    projectId: "p",
    input: "x",
  });
  let finish!: () => void;
  clients.cancelQueue = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  clients.stop = vi.fn(async () => {
    throw new Error("stop transport lost");
  });
  const stopping = pool.stop(i.id);
  await vi.waitFor(() =>
    expect(clients.stop).toHaveBeenCalledExactlyOnceWith("thread-a"),
  );
  expect(store.intent(i.id).phase).toBe("cancelling");
  expect(store.status().slots[0].phase).toBe("unknown");
  finish();
  const result = await stopping;
  expect(result.detail).toContain("Thread Stop outcome unconfirmed");
  expect(result.detail).toContain("Owned queue cleanup acknowledged");
  expect(clients.cancelQueue).toHaveBeenCalledExactlyOnceWith(
    "thread-a",
    "queue-a",
  );
});
