import { createFakePluginHost, makeHostResponse, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server.js";
import { RELEASED_MESSAGE, READY_DEADLINE_MS } from "./dispatch.js";

const WORKER = "host-worker";
const WORKSPACE = "host-workspace";
const SCRATCH = "/state/bb-account-workers/scratch/aw_x";
const POOL = "fake-pool";
const THREAD = "thread-new";
const V1 = ["thread-account.v1.set", "thread-account.v1.get", "thread-account.v1.accounts"];

type Account = { accountId: string; accountLabel: string; provider: string };
const ACCOUNTS: Account[] = [
  { accountId: "acct-a", accountLabel: "Work A", provider: "claude" },
  { accountId: "acct-b", accountLabel: "Work B", provider: "claude" },
  { accountId: "acct-c", accountLabel: "Work C", provider: "codex" },
];

type RpcArgs = { pluginId: string; method: string; input: Record<string, unknown>; outputSchema: { parse(v: unknown): unknown }; signal?: AbortSignal };
type Handler = (args: RpcArgs) => unknown;

interface Pool {
  publishers?: Array<{ pluginId: string; methods: string[] }>;
  accounts?: Account[];
  set?: Handler;
  get?: Handler;
  discoverThrows?: boolean;
}

function named(input: Record<string, unknown>, revision = 1) {
  const policy = input.policy as { accountId: string; onLimit: string };
  const label = ACCOUNTS.find((a) => a.accountId === policy.accountId)?.accountLabel ?? null;
  return {
    ok: true,
    changed: true,
    sessionRebuild: "none",
    message: null,
    threadId: input.threadId,
    provider: "claude",
    policy: { mode: "named", accountId: policy.accountId, accountLabel: label, onLimit: policy.onLimit },
    revision,
    updatedAt: 1,
    grandfathered: false,
    route: "none",
    serving: null,
    lastLimit: null,
    switchContinuity: "continues",
    note: null,
    futureField: "ignored",
  };
}

const getState = (serving: { accountId: string; accountLabel: string } | null, policy: Record<string, unknown> = { mode: "auto" }) => ({
  threadId: THREAD,
  provider: "claude",
  policy,
  revision: 1,
  updatedAt: 1,
  grandfathered: false,
  route: "pass",
  serving: serving === null ? null : { ...serving, provider: "claude", since: 1 },
  lastLimit: null,
  switchContinuity: "continues",
  note: null,
});

let realNow = Date.now;
afterEach(() => {
  Date.now = realNow;
  vi.restoreAllMocks();
});

function hostRpc(calls: string[]) {
  return (call: ExperimentalFakeHostRpcCall) => {
    calls.push(call.method);
    switch (call.method) {
      case "resolveRoot":
        return { ok: true, root: "/work/repo", hostname: "ws", instructions: [] };
      case "prepareScratch":
        return { ok: true, path: SCRATCH };
      case "releaseScratch":
        return { ok: true };
      default:
        throw new Error(`unexpected ${call.method}`);
    }
  };
}

async function load(pool: Pool | null) {
  const order: string[] = [];
  const hostCalls: string[] = [];
  const rpc: RpcArgs[] = [];
  const queued = new Map<string, string[]>([[THREAD, ["q1"]]]);
  const host = createFakePluginHost({ pluginId: "account-workers", experimental_callHostRpc: hostRpc(hostCalls) });
  await plugin(host.bb);
  const sdk = host.harness.sdk;
  sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: WORKER, name: "worker", status: "connected" }),
    makeHostResponse({ id: WORKSPACE, name: "workspace", status: "connected" }),
  ]);
  sdk.stub("projects.machineEnvironment", async () => ({ builtInGit: { status: "disabled" as const, statusMessage: "" }, variables: [], inheritedVariables: [] }));
  sdk.stub("threads.get", async (args: { threadId: string }) => makeThreadResponse({ id: args.threadId, status: "idle" }));
  sdk.stub("threads.stop", async () => ({}) as never);
  sdk.stub("threads.spawn", async () => {
    order.push("spawn");
    return makeThreadResponse({ id: THREAD });
  });
  sdk.stub("threads.archive", async (args: { threadId: string; signal?: AbortSignal }) => {
    order.push(`archive:${args.signal?.aborted ? "aborted" : "live"}`);
    return {} as never;
  });
  sdk.stub("threads.queuedMessages.list", async (args: { threadId: string }) =>
    (queued.get(args.threadId) ?? []).map((id) => ({ id })),
  );
  sdk.stub("threads.queuedMessages.delete", async (args: { threadId: string; queuedMessageId: string }) => {
    order.push(`delete:${args.queuedMessageId}`);
    queued.set(args.threadId, (queued.get(args.threadId) ?? []).filter((id) => id !== args.queuedMessageId));
    return {} as never;
  });
  sdk.stub("plugins.experimental_discoverRpc", async () => {
    order.push("discover");
    if (pool === null) return [];
    if (pool.discoverThrows) throw new Error("server down");
    return (pool.publishers ?? [{ pluginId: POOL, methods: V1 }]).flatMap((p) =>
      p.methods.map((method) => ({ pluginId: p.pluginId, displayName: "Pool", method, registrationDescription: null, methodDescription: null, inputSchema: {}, outputSchema: {} })),
    );
  });
  sdk.stub("plugins.callRpc", async (args: RpcArgs) => {
    rpc.push(args);
    const short = args.method.replace("thread-account.v1.", "");
    order.push(short);
    const value =
      short === "accounts"
        ? { threadId: args.input.threadId, provider: null, accounts: (pool?.accounts ?? ACCOUNTS).map((a) => ({ ...a, kind: "oauth", subscriptionType: null, usable: false, reason: "not-pooled", resetAt: null })) }
        : short === "set"
          ? (pool?.set ?? ((a: RpcArgs) => named(a.input)))(args)
          : (pool?.get ?? (() => getState(null)))(args);
    return args.outputSchema.parse(await value);
  });
  const dispatch = () =>
    host.harness.inspection.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: { id: THREAD, originPluginId: "account-workers", createdAt: Date.now() },
        requestedExecution: { providerId: "claude-code", model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
      }),
    );
  const spawn = (extra: string[], ctx: Record<string, unknown> = {}) =>
    host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1", "--json", ...extra],
      ctx,
    );
  return { host, order, hostCalls, rpc, queued, dispatch, spawn };
}

const errorOf = (stdout: string) => (JSON.parse(stdout) as { ok: false; error: { code: string; message: string } }).error;

async function expectAborted(t: Awaited<ReturnType<typeof load>>, result: { exitCode: number; stdout: string }, code: string) {
  expect(result.exitCode).toBe(1);
  expect(errorOf(result.stdout).code).toBe(code);
  expect(errorOf(result.stdout).message).toContain(`Thread ${THREAD} was archived; nothing was sent.`);
  expect(t.queued.get(THREAD)).toEqual([]);
  expect(t.order).toContain("archive:live");
  expect(t.hostCalls).toContain("releaseScratch");
  expect(await t.dispatch()).toEqual({ action: "reject", message: RELEASED_MESSAGE });
  const list = await t.host.harness.behavior.runCli(["list", "--all"]);
  expect(list.stdout).toContain("RELEASED (account-refused)");
  await t.host.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: THREAD }) });
  expect(await t.dispatch()).toEqual({ action: "reject", message: RELEASED_MESSAGE });
}

describe("spawn --account", () => {
  it("without --account calls no pool and keeps today's spawn", async () => {
    const t = await load(null);
    const result = await t.spawn([]);
    expect(result.exitCode).toBe(0);
    expect(t.order).toEqual(["spawn"]);
    expect(t.rpc).toEqual([]);
    expect(JSON.parse(result.stdout).account).toBeNull();
  });

  it("--account auto is the default: no pool call", async () => {
    const t = await load(null);
    expect((await t.spawn(["--account", "auto"])).exitCode).toBe(0);
    expect(t.order).toEqual(["spawn"]);
  });

  it("stores the named policy after the thread exists and before the first turn is let through", async () => {
    const decisions: unknown[] = [];
    const t = await load({
      set: async (args) => {
        decisions.push(await t.dispatch());
        return named(args.input);
      },
    });
    const result = await t.spawn(["--account", "Work B"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(t.order).toEqual(["discover", "accounts", "spawn", "set", "get"]);
    expect(decisions).toEqual([expect.objectContaining({ action: "wait" })]);
    expect(await t.dispatch()).toEqual({ action: "proceed" });
    expect(t.host.harness.inspection.recheckCount).toBe(1);
    const set = t.rpc.find((c) => c.method === "thread-account.v1.set")!;
    expect(set.pluginId).toBe(POOL);
    expect(set.input).toEqual({ threadId: THREAD, policy: { mode: "named", accountId: "acct-b", onLimit: "fallback-auto" } });
    expect(JSON.parse(result.stdout).account).toEqual({ accountId: "acct-b", accountLabel: "Work B", onLimit: "fallback-auto", revision: 1 });
    expect(JSON.parse(result.stdout)).not.toHaveProperty("warning");
  });

  it("passes --on-limit stop and prints the account in text", async () => {
    const t = await load({});
    const result = await t.host.harness.behavior.runCli([
      "spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1",
      "--account", "acct-a", "--on-limit", "stop",
    ]);
    expect(result.exitCode).toBe(0);
    expect(t.rpc.find((c) => c.method === "thread-account.v1.set")!.input.policy).toEqual({ mode: "named", accountId: "acct-a", onLimit: "stop" });
    expect(result.stdout).toContain("account Work A (acct-a), on limit stop");
  });

  it("resolves before spawn with the calling thread, or a probe id", async () => {
    const t = await load({});
    await t.spawn(["--account", "Work A"], { threadId: "thr-caller" });
    expect(t.rpc[0]!.input).toEqual({ threadId: "thr-caller" });
    const u = await load({});
    await u.spawn(["--account", "Work A"]);
    expect(u.rpc[0]!.input).toEqual({ threadId: "aw_account_probe" });
  });

  it("an id wins over an equal label; a label shared by two accounts of the provider is ambiguous before anything is created", async () => {
    const accounts = [
      { accountId: "acct-a", accountLabel: "acct-b", provider: "claude" },
      { accountId: "acct-b", accountLabel: "Work B", provider: "claude" },
      { accountId: "acct-d", accountLabel: "Twin", provider: "claude" },
      { accountId: "acct-e", accountLabel: "Twin", provider: "claude" },
    ];
    const t = await load({ accounts });
    expect((await t.spawn(["--account", "acct-b"])).exitCode).toBe(0);
    expect(t.rpc.find((c) => c.method === "thread-account.v1.set")!.input.policy).toMatchObject({ accountId: "acct-b" });
    const u = await load({ accounts });
    const result = await u.spawn(["--account", "Twin"]);
    expect(errorOf(result.stdout).code).toBe("account_ambiguous");
    expect(errorOf(result.stdout).message).toContain("acct-d, acct-e");
    expect(u.order).not.toContain("spawn");
    expect(u.hostCalls).toEqual([]);
  });

  it("narrows to the spawn's provider: a label on a Claude and a Codex account is not ambiguous; a Codex-only label is unknown for Claude", async () => {
    const accounts = [
      { accountId: "acct-a", accountLabel: "Same", provider: "claude" },
      { accountId: "acct-c", accountLabel: "Same", provider: "codex" },
      { accountId: "acct-x", accountLabel: "Codex only", provider: "codex" },
    ];
    const t = await load({ accounts });
    expect((await t.spawn(["--account", "Same"])).exitCode).toBe(0);
    expect(t.rpc.find((c) => c.method === "thread-account.v1.set")!.input.policy).toMatchObject({ accountId: "acct-a" });
    const u = await load({ accounts });
    const result = await u.spawn(["--account", "Codex only"]);
    expect(errorOf(result.stdout).code).toBe("account_unknown");
    expect(errorOf(result.stdout).message).toContain("another provider");
    expect(u.order).not.toContain("spawn");
  });

  it("an unknown account stops before any host call or thread", async () => {
    const t = await load({});
    const result = await t.spawn(["--account", "Nope"]);
    expect(errorOf(result.stdout).code).toBe("account_unknown");
    expect(t.hostCalls).toEqual([]);
    expect(t.order).toEqual(["discover", "accounts"]);
  });

  it.each([
    ["no plugin publishes the contract", { publishers: [] }, "account_pool_missing"],
    ["the pool is older: only get", { publishers: [{ pluginId: POOL, methods: ["thread-account.v1.get"] }] }, "account_pool_missing"],
    ["methods split across plugins", { publishers: [{ pluginId: POOL, methods: ["thread-account.v1.set", "thread-account.v1.get"] }, { pluginId: "other", methods: ["thread-account.v1.accounts"] }] }, "account_pool_missing"],
    ["two pools", { publishers: [{ pluginId: POOL, methods: V1 }, { pluginId: "other", methods: V1 }] }, "account_pool_ambiguous"],
    ["discovery fails", { discoverThrows: true }, "account_pool_unreachable"],
  ])("%s: refused before scratch or spawn", async (_name, pool, code) => {
    const t = await load(pool as Pool);
    const result = await t.spawn(["--account", "Work A"]);
    expect(errorOf(result.stdout).code).toBe(code);
    expect(t.hostCalls).toEqual([]);
    expect(t.order).not.toContain("spawn");
  });

  it("a provider the pool does not route is refused before any call", async () => {
    const t = await load({});
    const result = await t.spawn(["--account", "Work A", "--provider", "acp-opencode"]);
    expect(errorOf(result.stdout).code).toBe("account_not_pooled");
    expect(t.order).toEqual([]);
    expect(t.hostCalls).toEqual([]);
  });

  it.each([
    [["--on-limit", "stop"], "on_limit_without_account"],
    [["--account", "auto", "--on-limit", "stop"], "on_limit_without_account"],
    [["--account", "Work A", "--on-limit", "ask"], "bad_on_limit"],
  ])("usage %j → %s", async (extra, code) => {
    const t = await load({});
    const result = await t.spawn(extra);
    expect(errorOf(result.stdout).code).toBe(code);
    expect(t.order).toEqual([]);
  });

  it.each([
    ["unknown-account", undefined],
    ["other-provider", undefined],
    ["unavailable", undefined],
    ["at-limit", 1_900_000_000_000],
    ["not-pooled", undefined],
    ["some-future-reason", undefined],
  ])("set refusal %s aborts the spawn: queue emptied, thread archived, scratch released, never auto", async (reason, resetAt) => {
    const t = await load({
      set: () => ({ ok: false, reason, message: `pool says ${reason}`, ...(resetAt === undefined ? {} : { resetAt }) }),
    });
    const result = await t.spawn(["--account", "Work A"]);
    await expectAborted(t, result, "account_refused");
    expect(errorOf(result.stdout).message).toContain(`${reason}: pool says ${reason}`);
    if (resetAt !== undefined) expect(errorOf(result.stdout).message).toContain(new Date(resetAt).toISOString());
    expect(t.order).toContain("delete:q1");
    expect(t.order.indexOf("delete:q1")).toBeLessThan(t.order.indexOf("archive:live"));
  });

  it.each([
    ["set throws", () => { throw new Error("socket hang up"); }],
    ["set returns a malformed body", () => ({ ok: true, revision: "x" })],
  ])("%s → account_pool_error, same abort", async (_name, set) => {
    const t = await load({ set: set as Handler });
    const result = await t.spawn(["--account", "Work A"]);
    await expectAborted(t, result, "account_pool_error");
    expect(errorOf(result.stdout).message).toContain("state is unknown");
  });

  it("ok with another stored policy → account_not_applied", async () => {
    const t = await load({ set: (a) => ({ ...named(a.input), policy: { mode: "auto" } }) });
    await expectAborted(t, await t.spawn(["--account", "Work A"]), "account_not_applied");
  });

  it("the binding released while set is pending (ready deadline) → spawn_abandoned, no success", async () => {
    const t = await load({
      set: async (args) => {
        const now = realNow();
        Date.now = () => now + READY_DEADLINE_MS + 1;
        await t.dispatch();
        return named(args.input);
      },
    });
    const result = await t.spawn(["--account", "Work A"]);
    expect(result.exitCode).toBe(1);
    expect(errorOf(result.stdout).code).toBe("spawn_abandoned");
    expect(t.host.harness.inspection.recheckCount).toBe(1);
    expect(t.queued.get(THREAD)).toEqual([]);
  });

  it("a cancelled CLI still cleans up: abort-path calls do not get ctx.signal", async () => {
    const controller = new AbortController();
    const t = await load({
      set: () => {
        controller.abort();
        throw new Error("aborted");
      },
    });
    const result = await t.spawn(["--account", "Work A"], { signal: controller.signal });
    await expectAborted(t, result, "account_pool_error");
  });

  it("archive failing during the abort is reported with the cause; the binding stays released", async () => {
    const t = await load({ set: () => ({ ok: false, reason: "unavailable", message: "disabled" }) });
    t.host.harness.sdk.stub("threads.archive", async () => {
      throw new Error("archive refused");
    });
    const result = await t.spawn(["--account", "Work A"]);
    expect(errorOf(result.stdout).code).toBe("account_refused");
    expect(errorOf(result.stdout).message).toContain("disabled");
    expect(errorOf(result.stdout).message).toContain("archiving it failed");
    expect(await t.dispatch()).toEqual({ action: "reject", message: RELEASED_MESSAGE });
  });

  it("warns when another account already served the thread (Send now in the window)", async () => {
    const t = await load({ get: () => getState({ accountId: "acct-a", accountLabel: "Work A" }) });
    const result = await t.spawn(["--account", "Work B"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).warning).toBe("the first request ran on Work A (acct-a) before the policy was set");
    const same = await load({ get: () => getState({ accountId: "acct-b", accountLabel: "Work B" }) });
    expect(JSON.parse((await same.spawn(["--account", "Work B"])).stdout)).not.toHaveProperty("warning");
  });

  it("a failing get after set keeps the spawn and says serving is not confirmed", async () => {
    const t = await load({ get: () => { throw new Error("timeout"); } });
    const result = await t.spawn(["--account", "Work B"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).warning).toContain("serving account not confirmed");
    expect(await t.dispatch()).toEqual({ action: "proceed" });
  });
});

describe("list shows the thread's account", () => {
  it("shows policy and serving account from get", async () => {
    const t = await load({ get: () => getState({ accountId: "acct-a", accountLabel: "Work A" }, { mode: "named", accountId: "acct-a", accountLabel: "Work A", onLimit: "stop" }) });
    await t.spawn(["--account", "Work A"]);
    const text = await t.host.harness.behavior.runCli(["list"]);
    expect(text.stdout).toContain("account Work A, policy Work A (stop)");
    const json = JSON.parse((await t.host.harness.behavior.runCli(["list", "--json"])).stdout) as Array<{ account: { policy: unknown; serving: unknown } | null }>;
    expect(json[0]!.account).toMatchObject({ policy: { mode: "named", accountId: "acct-a" }, serving: { accountId: "acct-a" } });
  });

  it("without a pool the cell is empty and no RPC is made", async () => {
    const t = await load(null);
    await t.spawn([]);
    const text = await t.host.harness.behavior.runCli(["list"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).not.toContain("account");
    expect(t.rpc).toEqual([]);
    const json = JSON.parse((await t.host.harness.behavior.runCli(["list", "--json"])).stdout) as Array<{ account: unknown }>;
    expect(json[0]!.account).toBeNull();
  });

  it("a get error leaves that row empty and the list intact", async () => {
    const t = await load({
      get: (args) => {
        if (args.input.threadId === THREAD) throw new Error("boom");
        return getState(null);
      },
    });
    await t.spawn([]);
    t.host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "thread-two" }));
    t.host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    expect((await t.spawn([])).exitCode).toBe(0);
    const lines = (await t.host.harness.behavior.runCli(["list"])).stdout.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.startsWith(THREAD))).not.toContain("account");
    expect(lines.find((l) => l.startsWith("thread-two"))).toContain("account —, policy auto");
  });
});
