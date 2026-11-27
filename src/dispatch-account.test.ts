import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { accountSchema } from "./contracts.js";
import { PARENT_TOKEN_ENV, PARENT_URL_ENV } from "./parent-pool.js";
import { QuotaStore } from "./store.js";
import { createAccountPoolPlugin } from "./server.js";

// The pool's message.dispatch hook: a new thread's composer hands the chosen
// account as its own submission, applied on the thread's inline first attempt.
// Ids and labels are synthetic.

const PLUGIN_ID = "account-pool-prewarm";
const START = 1_900_000_000_000;
const DAY = 86_400_000;

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

type Overrides = Parameters<typeof makeMessageDispatchHookContext>[0];

async function fixture() {
  const clock = { time: START };
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-pool-dispatch-"));
  const threads = new Map<string, Record<string, unknown>>();
  const thread = (id: string, overrides: Record<string, unknown> = {}) => {
    const value = {
      ...makeThreadResponse({ id }),
      host: { id: "host-one" },
      providerId: "claude-code",
      status: "pending",
      createdAt: START + 1,
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    };
    threads.set(id, value);
    return value;
  };
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const host = createFakePluginHost({
    pluginId: PLUGIN_ID,
    dataDir,
    sdk: {
      hosts: {
        list: async () => [
          { id: "host-one", name: "One" },
          { id: "host-two", name: "Two" },
        ],
        get: async () => ({ id: "host-one" }),
      },
      threads: {
        get: async (input: { threadId: string }) => {
          const found = threads.get(input.threadId);
          if (found === undefined) throw notFound;
          return found;
        },
        list: async () => [],
        events: { list: async () => [] },
        queuedMessages: { list: async () => [] },
      },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({ plugins: [{ id: PLUGIN_ID, enabled: true }] }),
      },
    },
  });
  await createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    fetch: async () => Response.json({}),
    upstreams: {
      anthropic: "https://unused.invalid",
      chatgptCodex: "https://unused.invalid",
      openai: "https://unused.invalid",
    },
    now: () => clock.time,
  })(host.bb);
  cleanups.push(async () => {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const { callRpc, runCli } = host.harness.behavior;
  await callRpc("hostRole.set", { hostId: "host-one", role: "trusted" });
  const add = async (label: string, provider: "claude" | "codex" = "claude") =>
    accountSchema.parse(
      await callRpc("account.add", {
        provider,
        source: { kind: "api-key", apiKey: `sk-${label}` },
        label,
        priority: 0,
      }),
    ).id;
  const alpha = await add("alpha");
  const beta = await add("beta");
  const hook = host.harness.inspection.registrations.hooks["message.dispatch"];
  if (hook === null) throw new Error("message.dispatch is not registered");
  const dispatch = (threadId: string, overrides: Overrides = {}) =>
    hook(
      makeMessageDispatchHookContext({
        host: { id: "host-one" },
        ...overrides,
        thread: { id: threadId, status: "pending", ...overrides.thread },
      }),
    );
  const own = (data: unknown) => ({
    experimental_submission: { pluginId: PLUGIN_ID, data: data as never },
  });
  const rpc = async (method: string, input: unknown) =>
    (await callRpc(`thread-account.v1.${method}`, input)) as Record<string, unknown>;
  const policyOf = async (threadId: string) => {
    const state = await rpc("get", { threadId });
    return { policy: state.policy, revision: state.revision };
  };
  const policyRows = async () =>
    z
      .object({
        entries: z.array(
          z.object({
            reason: z.string(),
            threadId: z.string().nullable(),
            detail: z.string().nullable(),
          }),
        ),
      })
      .parse(JSON.parse((await runCli(["audit", "--json"])).stdout))
      .entries.reverse()
      .filter((entry) => entry.reason === "policy")
      .map((entry) => `${entry.threadId}:${entry.detail}`);
  const quotas = new QuotaStore(host.bb.storage.database());
  const atLimit = (accountId: string) =>
    quotas.put({
      ...quotas.get(accountId),
      fiveHourUtilization: 1,
      fiveHourResetAt: START + 3_600_000,
      observedAt: clock.time,
    });
  return {
    clock,
    thread,
    callRpc,
    add,
    alpha,
    beta,
    dispatch,
    own,
    rpc,
    policyOf,
    policyRows,
    atLimit,
  };
}

const PROCEED = { action: "proceed" };
const AUTO = { policy: { mode: "auto" }, revision: 0 };

describe("message.dispatch: the new thread's chosen account", () => {
  it("applies a named policy from its own submission on a pending thread's start attempt, then proceeds", async () => {
    const f = await fixture();
    f.thread("thr_new");
    await expect(
      f.dispatch(
        "thr_new",
        f.own({ policy: { mode: "named", accountId: f.beta, onLimit: "stop" } }),
      ),
    ).resolves.toEqual(PROCEED);
    expect(await f.policyOf("thr_new")).toEqual({
      policy: {
        mode: "named",
        accountId: f.beta,
        accountLabel: "beta",
        onLimit: "stop",
      },
      revision: 1,
    });
    expect(await f.policyRows()).toEqual([`thr_new:named-stop@plugin-${PLUGIN_ID}`]);
  });

  it("does nothing and proceeds without its own submission or outside a pending thread's start attempt", async () => {
    const f = await fixture();
    f.thread("thr_new");
    const named = { policy: { mode: "named", accountId: f.beta } };
    const cases: Overrides[] = [
      {},
      { experimental_submission: null },
      { experimental_submission: { pluginId: "other-plugin", data: named } },
      {
        experimental_submission: {
          pluginId: "other-plugin",
          data: { anything: "else" },
        },
      },
      { ...f.own(named), thread: { status: "idle" } },
      { ...f.own(named), thread: { status: "active" } },
      { ...f.own(named), thread: { status: "error" } },
      { ...f.own(named), attempt: "join-turn" },
      { ...f.own(named), queuedMessages: [{ id: "queued_1" }] },
    ];
    for (const overrides of cases)
      await expect(f.dispatch("thr_new", overrides)).resolves.toEqual(PROCEED);
    expect(await f.policyOf("thr_new")).toEqual(AUTO);
    expect(await f.policyRows()).toEqual([]);
  });

  it("rejects invalid data under its own id", async () => {
    const f = await fixture();
    f.thread("thr_new");
    for (const data of [
      null,
      "named",
      {},
      { policy: { mode: "named" } },
      { policy: { mode: "named", accountId: "" } },
      { policy: { mode: "named", accountId: "a".repeat(129) } },
      { policy: { mode: "named", accountId: f.beta, onLimit: "ask" } },
      { policy: { mode: "named", accountId: f.beta, extra: true } },
      { policy: { mode: "auto" }, extra: true },
      { policy: { mode: "other" } },
    ]) {
      const decision = await f.dispatch("thr_new", f.own(data));
      expect(decision).toEqual({
        action: "reject",
        message: expect.stringContaining("invalid account choice"),
      });
    }
    expect(await f.policyOf("thr_new")).toEqual(AUTO);
  });

  it("rejects with the pool's own message when set refuses", async () => {
    const f = await fixture();
    const codex = await f.add("gamma", "codex");
    f.atLimit(f.alpha);
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["thr_limit", { mode: "named", accountId: f.alpha }, "at-limit"],
      ["thr_other", { mode: "named", accountId: codex }, "other-provider"],
      [
        "thr_unknown",
        { mode: "named", accountId: "00000000-0000-4000-8000-000000000000" },
        "unknown-account",
      ],
      ["thr_notpooled", { mode: "named", accountId: f.beta }, "not-pooled"],
    ];
    f.thread("thr_notpooled", { providerId: "other-provider" });
    for (const [threadId, policy, reason] of cases) {
      if (threadId !== "thr_notpooled") f.thread(threadId);
      const refused = await f.rpc("set", { threadId, policy });
      expect(refused).toMatchObject({ ok: false, reason });
      await expect(f.dispatch(threadId, f.own({ policy }))).resolves.toEqual({
        action: "reject",
        message: refused.message,
      });
      expect(await f.policyOf(threadId)).toEqual(AUTO);
    }
  });

  it("rejects on a machine with no pool role, or none known, and stores nothing", async () => {
    const f = await fixture();
    f.thread("thr_new", { host: { id: "host-two" } });
    const named = f.own({ policy: { mode: "named", accountId: f.beta } });
    for (const host of [{ id: "host-two" }, null]) {
      await expect(f.dispatch("thr_new", { ...named, host })).resolves.toEqual({
        action: "reject",
        message: expect.stringContaining("no Account Pooler role"),
      });
    }
    expect(await f.policyOf("thr_new")).toEqual(AUTO);
  });

  it("proceeds without a write for auto on a thread that is already auto", async () => {
    const f = await fixture();
    f.thread("thr_new");
    await expect(f.dispatch("thr_new", f.own({ policy: { mode: "auto" } }))).resolves.toEqual(
      PROCEED,
    );
    await expect(
      f.dispatch("thr_new", {
        ...f.own({ policy: { mode: "auto" } }),
        host: { id: "host-two" },
      }),
    ).resolves.toEqual(PROCEED);
    expect(await f.policyOf("thr_new")).toEqual(AUTO);
    expect(await f.policyRows()).toEqual([]);
  });

  it("replaces a policy stored earlier on the pending thread", async () => {
    const f = await fixture();
    f.thread("thr_new");
    await f.rpc("set", {
      threadId: "thr_new",
      policy: { mode: "named", accountId: f.alpha },
    });
    await expect(
      f.dispatch("thr_new", f.own({ policy: { mode: "named", accountId: f.beta } })),
    ).resolves.toEqual(PROCEED);
    expect(await f.policyOf("thr_new")).toMatchObject({
      policy: { mode: "named", accountId: f.beta, onLimit: "fallback-auto" },
      revision: 2,
    });
    // Same account, another rule at its limit: not equal, so it is written.
    await expect(
      f.dispatch("thr_new", f.own({ policy: { mode: "named", accountId: f.beta, onLimit: "stop" } })),
    ).resolves.toEqual(PROCEED);
    expect(await f.policyOf("thr_new")).toMatchObject({
      policy: { mode: "named", accountId: f.beta, onLimit: "stop" },
      revision: 3,
    });
    await expect(f.dispatch("thr_new", f.own({ policy: { mode: "auto" } }))).resolves.toEqual(
      PROCEED,
    );
    expect(await f.policyOf("thr_new")).toMatchObject({
      policy: { mode: "auto" },
      revision: 4,
    });
  });

  it("proceeds on a reattempt with the same submission without a write or a revision conflict", async () => {
    const f = await fixture();
    f.thread("thr_new");
    const choice = f.own({
      policy: { mode: "named", accountId: f.beta, onLimit: "fallback-auto" },
    });
    await expect(f.dispatch("thr_new", choice)).resolves.toEqual(PROCEED);
    const first = await f.policyOf("thr_new");
    await expect(f.dispatch("thr_new", choice)).resolves.toEqual(PROCEED);
    f.atLimit(f.beta);
    await expect(f.dispatch("thr_new", choice)).resolves.toEqual(PROCEED);
    expect(await f.policyOf("thr_new")).toEqual(first);
    expect(first.revision).toBe(1);
    expect(await f.policyRows()).toEqual([`thr_new:named-fallback-auto@plugin-${PLUGIN_ID}`]);
  });

  it("sets the policy on the inline pass of a create sent a day later, before the time wait", async () => {
    const f = await fixture();
    f.thread("thr_later");
    const sendAt = START + DAY;
    await expect(
      f.dispatch("thr_later", f.own({ policy: { mode: "named", accountId: f.beta } })),
    ).resolves.toEqual(PROCEED);
    const state = await f.rpc("get", { threadId: "thr_later" });
    expect(state).toMatchObject({
      policy: { mode: "named", accountId: f.beta },
      revision: 1,
      updatedAt: START,
    });
    f.clock.time = sendAt;
    await expect(
      f.dispatch("thr_later", {
        experimental_submission: null,
        queuedMessages: [{ id: "queued_1", sendAt }],
      }),
    ).resolves.toEqual(PROCEED);
    expect(await f.rpc("get", { threadId: "thr_later" })).toMatchObject({
      policy: { mode: "named", accountId: f.beta },
      revision: 1,
    });
  });
});
