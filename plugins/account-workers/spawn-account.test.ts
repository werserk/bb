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
  reset?: Handler;
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

function hostRpc(calls: string[], releaseScratch: unknown = { ok: true }) {
  return (call: ExperimentalFakeHostRpcCall) => {
    calls.push(call.method);
    switch (call.method) {
      case "resolveRoot":
        return { ok: true, root: "/work/repo", hostname: "ws", instructions: [] };
      case "prepareScratch":
        return { ok: true, path: SCRATCH };
      case "releaseScratch":
        return releaseScratch;
      default:
        throw new Error(`unexpected ${call.method}`);
    }
  };
}

async function load(pool: Pool | null, releaseScratch?: unknown) {
  const order: string[] = [];
  const hostCalls: string[] = [];
  const rpc: RpcArgs[] = [];
  const queued = new Map<string, string[]>([[THREAD, ["q1"]]]);
  const host = createFakePluginHost({ pluginId: "account-workers", experimental_callHostRpc: hostRpc(hostCalls, releaseScratch) });
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
    const method = args.method.replace("thread-account.v1.", "");
    const short = method === "set" && (args.input.policy as { mode: string }).mode === "auto" ? "reset" : method;
    order.push(short === "reset" && args.signal?.aborted ? "reset:aborted" : short);
    const value =
      short === "accounts"
        ? { threadId: args.input.threadId, provider: null, accounts: (pool?.accounts ?? ACCOUNTS).map((a) => ({ ...a, kind: "oauth", subscriptionType: null, usable: false, reason: "not-pooled", resetAt: null })) }
        : short === "set"
          ? (pool?.set ?? ((a: RpcArgs) => named(a.input)))(args)
          : short === "reset"
            ? (pool?.reset ?? (() => ({ ...getState(null), ok: true, changed: true, sessionRebuild: "none", message: null, revision: 2 })))(args)
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
  if (code === "account_refused") expect(t.order).not.toContain("reset");
  else expect(t.order.indexOf("reset")).toBeGreaterThan(-1);
  if (code !== "account_refused") expect(t.order.indexOf("reset")).toBeLessThan(t.order.indexOf("archive:live"));
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

  it.each([
    ["auto", { mode: "auto" }, "stored auto"],
    ["another account", { mode: "named", accountId: "acct-b", accountLabel: "Work B", onLimit: "fallback-auto" }, "stored named acct-b (fallback-auto)"],
    ["another onLimit", { mode: "named", accountId: "acct-a", accountLabel: "Work A", onLimit: "stop" }, "stored named acct-a (stop)"],
  ])("ok storing %s → account_not_applied, reset to auto, same abort", async (_name, policy, stored) => {
    const t = await load({ set: (a) => ({ ...named(a.input), policy }) });
    const result = await t.spawn(["--account", "Work A"]);
    await expectAborted(t, result, "account_not_applied");
    expect(errorOf(result.stdout).message).toContain(stored);
  });

  it.each([
    ["throws", () => { throw new Error("pool restarting"); }, "pool restarting"],
    ["refuses", () => ({ ok: false, reason: "not-writable", message: "archived" }), "not-writable: archived"],
  ])("a reset to auto that %s is reported after the original cause; the abort still finishes", async (_name, reset, text) => {
    const t = await load({ set: (a) => ({ ...named(a.input), policy: { mode: "auto" } }), reset: reset as Handler });
    const result = await t.spawn(["--account", "Work A"]);
    const { code, message } = errorOf(result.stdout);
    expect(code).toBe("account_not_applied");
    expect(message.indexOf("stored auto")).toBeLessThan(message.indexOf("resetting its pool policy to auto failed"));
    expect(message).toContain(text);
    expect(message).toContain(`Thread ${THREAD}: archived; nothing was sent; resetting`);
    expect(t.order).toContain("archive:live");
    expect(await t.dispatch()).toEqual({ action: "reject", message: RELEASED_MESSAGE });
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
    expect(t.order.indexOf("reset")).toBeGreaterThan(t.order.indexOf("set"));
    expect(t.order.indexOf("reset")).toBeLessThan(t.order.indexOf("archive:live"));
  });

  it("without --account the binding cannot be released between claim and ready: a hook check inside threads.spawn only waits", async () => {
    const t = await load(null);
    let inside: unknown = null;
    t.host.harness.sdk.stub("threads.spawn", async () => {
      const now = realNow();
      Date.now = () => now + READY_DEADLINE_MS + 1;
      inside = await t.dispatch();
      Date.now = realNow;
      return makeThreadResponse({ id: THREAD });
    });
    const result = await t.spawn([]);
    expect(inside).toMatchObject({ action: "wait" });
    expect(result.exitCode).toBe(0);
    expect(await t.dispatch()).toEqual({ action: "proceed" });
    expect(t.order).not.toContain("discover");
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
    expect(t.order).not.toContain("reset:aborted");
  });

  it("a queued message already gone (404) counts as removed", async () => {
    const t = await load({ set: () => ({ ok: false, reason: "unavailable", message: "disabled" }) });
    t.host.harness.sdk.stub("threads.queuedMessages.delete", async () => {
      throw Object.assign(new Error("HTTP 404: queued message not found"), { status: 404 });
    });
    const result = await t.spawn(["--account", "Work A"]);
    expect(errorOf(result.stdout).message).toContain(`Thread ${THREAD} was archived; nothing was sent.`);
  });

  it.each([
    ["listing the queue fails", "threads.queuedMessages.list", "removing its queued messages failed: Error: queue down"],
    ["deleting a row fails", "threads.queuedMessages.delete", "removing its queued messages failed: Error: queue down"],
  ])("%s: reported, and nothing claims the prompt was withdrawn", async (_name, path, text) => {
    const t = await load({ set: () => ({ ok: false, reason: "unavailable", message: "disabled" }) });
    t.host.harness.sdk.stub(path as "threads.queuedMessages.list", async () => {
      throw new Error("queue down");
    });
    const message = errorOf((await t.spawn(["--account", "Work A"])).stdout).message;
    expect(message).toContain(`Thread ${THREAD}: archived; ${text}.`);
    expect(message).not.toContain("nothing was sent");
  });

  it("a failing worker cleanup is reported with the retry hint", async () => {
    const t = await load({ set: () => ({ ok: false, reason: "unavailable", message: "disabled" }) }, { ok: false, error: "disk busy" });
    const message = errorOf((await t.spawn(["--account", "Work A"])).stdout).message;
    expect(message).toContain("the worker cleanup failed: disk busy; run unbind to retry");
  });

  it.each([
    ["sent by Send now", [], `Thread ${THREAD}: archived; no queued prompt was left to withdraw`],
    ["withdrawn, another turn running", ["q1"], `Thread ${THREAD}: archived; a turn is running`],
  ])("a turn already running (prompt %s) is named; the tail does not say nothing was sent", async (_name, rows, head) => {
    const t = await load({ set: () => ({ ok: false, reason: "unavailable", message: "disabled" }) });
    t.queued.set(THREAD, rows);
    t.host.harness.sdk.stub("threads.get", async (args: { threadId: string }) => makeThreadResponse({ id: args.threadId, status: "active" }));
    const message = errorOf((await t.spawn(["--account", "Work A"])).stdout).message;
    expect(message).toContain(head);
    expect(message).toContain("a turn is running (Send now), so the worker cleanup waits until it stops");
    expect(message).not.toContain("nothing was sent");
    expect(t.hostCalls).not.toContain("releaseScratch");
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
