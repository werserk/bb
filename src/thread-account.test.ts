import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { accountSchema, statusReportSchema } from "./contracts.js";
import { PARENT_TOKEN_ENV, PARENT_URL_ENV } from "./parent-pool.js";
import { QUOTA_MIGRATIONS, QuotaStore } from "./store.js";
import { createAccountPoolPlugin } from "./server.js";
import { retryAvailabilityMethod } from "./retry-contract.js";
import { callerDetail, ThreadPolicyStore } from "./thread-policy.js";
import { AuditLog } from "./audit-log.js";

// Block P3: thread account policy and the thread-account.v1 contract, end to
// end through the plugin (env hook, hub, RPC, CLI). Labels and ids are
// synthetic.

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

const START = 1_900_000_000_000;
const MESSAGE = JSON.stringify({
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: "hi" }],
});

type Reply = { status: number; headers?: Record<string, string>; body?: string };

async function fixture(
  args: { beforeStart?: (dir: string) => Promise<void> } = {},
) {
  const clock = { time: START };
  // Which API key the upstream saw, in order, and what it answers per key.
  const seen: string[] = [];
  const replies = new Map<string, Reply>();
  const server = http.createServer((request, response) => {
    const key = String(
      request.headers["x-api-key"] ??
        String(request.headers.authorization ?? "").replace(/^Bearer /u, ""),
    );
    seen.push(key);
    request.resume();
    request.on("end", () => {
      const reply = replies.get(key) ?? { status: 200 };
      response.writeHead(reply.status, {
        "content-type": "application/json",
        ...reply.headers,
      });
      response.end(reply.body ?? "{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const url = `http://127.0.0.1:${address.port}`;
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-pool-p3-"));
  // Threads bb knows: created before the first start are grandfathered.
  const threads = new Map<string, Record<string, unknown>>();
  const thread = (
    id: string,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => {
    const value = {
      ...makeThreadResponse({ id }),
      host: { id: "host-one" },
      providerId: "claude-code",
      status: "idle",
      createdAt: START + 1,
      archivedAt: null,
      deletedAt: null,
      ...overrides,
    };
    threads.set(id, value);
    return value;
  };
  const clearContext = vi.fn(async (_input: unknown) => ({ ok: true as const }));
  const model = { current: "claude-haiku-4-5-20251001" };
  const notFound = Object.assign(new Error("not found"), { status: 404 });
  const host = createFakePluginHost({
    pluginId: "account-pool-prewarm",
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
        list: async (input: { threadIds: string[] }) =>
          input.threadIds.flatMap((id) => {
            const found = threads.get(id);
            return found === undefined || found.deletedAt !== null ? [] : [found];
          }),
        clearContext,
        events: {
          list: async () => [
            {
              data: {
                requestId: "creq_aaaaaaaaaa",
                execution: { model: model.current },
              },
            },
          ],
        },
      },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool-prewarm", enabled: true }],
        }),
      },
    },
  });
  await args.beforeStart?.(dataDir);
  await createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    upstreams: { anthropic: url, chatgptCodex: url },
    now: () => clock.time,
  })(host.bb);
  const { callRpc, resolveProviderEnv, fetchHttp, runCli } = host.harness.behavior;
  for (const hostId of ["host-one", "host-two"])
    await callRpc("hostRole.set", { hostId, role: "trusted" });
  const add = async (
    label: string,
    priority: number,
    provider: "claude" | "codex" = "claude",
  ) =>
    accountSchema.parse(
      await callRpc("account.add", {
        provider,
        source: { kind: "api-key", apiKey: `sk-${label}` },
        label,
        priority,
      }),
    ).id;
  const alpha = await add("alpha", 0);
  const beta = await add("beta", 10);
  const service = host.harness.behavior.runService("hub");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await vi.waitFor(async () => {
    const result = await runCli(["status", "--json"]);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(true);
  });
  const env = async (
    threadId: string | null,
    provider: "claude-code" | "codex" = "claude-code",
    hostId = "host-one",
  ) =>
    Object.fromEntries(
      (await resolveProviderEnv(provider, { threadId, projectId: null, hostId })).map(
        (entry) => [entry.name, entry.value],
      ),
    );
  const token = async (threadId: string) =>
    String((await env(threadId)).ANTHROPIC_AUTH_TOKEN);
  const send = async (credential: string, body = MESSAGE) => {
    const response = await fetchHttp("POST", "/v1/messages", {
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body,
    });
    await response.text();
    return response;
  };
  const rpc = async (method: string, input: unknown, pluginId?: string) =>
    callRpc(
      `thread-account.v1.${method}`,
      input,
      pluginId === undefined
        ? undefined
        : { experimental_caller: { kind: "plugin", pluginId } },
    ) as Promise<Record<string, unknown>>;
  const audit = async () =>
    z
      .object({
        entries: z.array(
          z.object({
            reason: z.string(),
            threadId: z.string().nullable(),
            accountId: z.string().nullable(),
            detail: z.string().nullable(),
          }),
        ),
      })
      .parse(JSON.parse((await runCli(["audit", "--json"])).stdout))
      .entries.reverse()
      .filter((entry) =>
        ["select", "failover", "switch", "policy", "named-limit", "limit"].includes(
          entry.reason,
        ),
      )
      .map((entry) => `${entry.reason}:${entry.threadId ?? "-"}:${entry.detail ?? "-"}`);
  const quotas = new QuotaStore(host.bb.storage.database());
  const setUsage = (accountId: string, utilization: number) =>
    quotas.put({
      ...quotas.get(accountId),
      fiveHourUtilization: utilization,
      fiveHourResetAt: START + 3_600_000,
      observedAt: clock.time,
    });
  return {
    host,
    clock,
    seen,
    replies,
    thread,
    threads,
    clearContext,
    model,
    env,
    token,
    send,
    rpc,
    audit,
    add,
    alpha,
    beta,
    setUsage,
    runCli,
    callRpc,
    dataDir,
  };
}

describe("passes on every role and grandfathering (R1, R3)", () => {
  it("keeps the machine token, byte for byte, for a thread created before the first start", async () => {
    const f = await fixture();
    f.thread("thread-old", { createdAt: START - 1 });
    f.thread("thread-new");
    const old = await f.env("thread-old");
    const fresh = await f.env("thread-new");
    expect(old.ANTHROPIC_AUTH_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(old[PARENT_TOKEN_ENV]).toBe(old.ANTHROPIC_AUTH_TOKEN);
    // A new thread on a trusted machine gets its own pass; nested servers keep
    // the machine token.
    expect(fresh.ANTHROPIC_AUTH_TOKEN).toMatch(/^pt1\.thread-new\.[A-Za-z0-9_-]{43}$/u);
    expect(fresh[PARENT_TOKEN_ENV]).toBe(old.ANTHROPIC_AUTH_TOKEN);
    expect({ ...fresh, ANTHROPIC_AUTH_TOKEN: old.ANTHROPIC_AUTH_TOKEN }).toEqual(old);
    // A thread bb cannot describe keeps the P2 behaviour too.
    expect(await f.token("thread-unknown")).toBe(old.ANTHROPIC_AUTH_TOKEN);
    expect(await f.send(String(fresh.ANTHROPIC_AUTH_TOKEN))).toHaveProperty("status", 200);
    expect(await f.audit()).toEqual(["select:thread-new:-"]);
  });

  it("moves a grandfathered thread to its own pass once a policy is set, and says the session rebuilds", async () => {
    const f = await fixture();
    f.thread("thread-old", { createdAt: START - 1 });
    const machine = await f.token("thread-old");
    expect(await f.rpc("get", { threadId: "thread-old" })).toMatchObject({
      grandfathered: true,
      policy: { mode: "auto" },
      revision: 0,
    });
    // `auto` on a grandfathered thread stores nothing and rebuilds nothing.
    expect(
      await f.rpc("set", { threadId: "thread-old", policy: { mode: "auto" } }),
    ).toMatchObject({ ok: true, changed: false, sessionRebuild: "none" });
    expect(await f.token("thread-old")).toBe(machine);
    const set = await f.rpc("set", {
      threadId: "thread-old",
      policy: { mode: "named", accountId: f.beta },
    });
    expect(set).toMatchObject({
      ok: true,
      changed: true,
      sessionRebuild: "next-turn",
      grandfathered: false,
      revision: 1,
    });
    const pass = await f.token("thread-old");
    expect(pass).toMatch(/^pt1\.thread-old\./u);
    expect((await f.send(pass)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-beta");
  });

  it("falls back to the machine token when no pass can be issued, and logs it once (R2)", async () => {
    const f = await fixture({
      beforeStart: async (dir) => {
        const secrets = path.join(dir, "plugins", "account-pool-prewarm", "secrets", "accounts");
        await fs.mkdir(secrets, { recursive: true });
        await fs.writeFile(path.join(secrets, "pass-key.json"), "not json", { mode: 0o600 });
      },
    });
    f.thread("thread-new");
    f.thread("thread-two");
    const machine = String((await f.env(null)).ANTHROPIC_AUTH_TOKEN);
    expect(await f.token("thread-new")).toBe(machine);
    expect(await f.token("thread-two")).toBe(machine);
    expect(
      f.host.harness.inspection.logEntries.filter((entry) =>
        String(entry.message).includes("could not issue a thread pass"),
      ),
    ).toHaveLength(1);
  });

  it("gives an archived new thread nothing", async () => {
    const f = await fixture();
    f.thread("thread-new");
    await f.token("thread-new");
    f.thread("thread-new", { archivedAt: START - 60_000 });
    await f.host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-new", archivedAt: START - 60_000 }),
    });
    expect((await f.env("thread-new")).ANTHROPIC_AUTH_TOKEN).toBe("");
  });
});

describe("named policy routing", () => {
  it("pins a thread to its named account over the pool order and an inherited binding, with a switch row", async () => {
    const f = await fixture();
    f.thread("thread-a");
    f.thread("thread-b");
    const a = await f.token("thread-a");
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-alpha");
    expect(
      await f.rpc("set", {
        threadId: "thread-a",
        policy: { mode: "named", accountId: f.beta, onLimit: "stop" },
      }),
    ).toMatchObject({ ok: true, changed: true, sessionRebuild: "none" });
    // The pass is unchanged: no env change, no session rebuild.
    expect(await f.token("thread-a")).toBe(a);
    expect((await f.send(a)).status).toBe(200);
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.slice(-2)).toEqual(["sk-beta", "sk-beta"]);
    expect((await f.send(await f.token("thread-b"))).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-alpha");
    expect(await f.audit()).toEqual([
      "select:thread-a:-",
      "policy:thread-a:named-stop@client",
      "switch:thread-a:-",
      "select:thread-b:-",
    ]);
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({
      policy: { mode: "named", accountId: f.beta, accountLabel: "beta", onLimit: "stop" },
      serving: { accountId: f.beta, accountLabel: "beta", provider: "claude" },
      switchContinuity: "continues",
      lastLimit: null,
    });
  });

  it("keeps a named account above the switch threshold and falls back only at the real limit (D1)", async () => {
    const f = await fixture();
    f.thread("thread-a");
    await f.rpc("set", { threadId: "thread-a", policy: { mode: "named", accountId: f.beta } });
    const a = await f.token("thread-a");
    f.setUsage(f.beta, 0.99);
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-beta");
    f.setUsage(f.beta, 1);
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-alpha");
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({
      policy: { mode: "auto" },
      revision: 2,
      lastLimit: { accountId: f.beta, cause: "limit", action: "fell-back" },
    });
    expect((await f.audit()).slice(-3)).toEqual([
      "named-limit:thread-a:limit-fallback-auto",
      "policy:thread-a:auto@limit",
      "select:thread-a:-",
    ]);
    // Now auto: the named account coming back does not move the thread.
    f.setUsage(f.beta, 0);
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-alpha");
  });

  it("serves a disabled named account's requests via auto without changing the policy (D2)", async () => {
    const f = await fixture();
    f.thread("thread-a");
    await f.rpc("set", { threadId: "thread-a", policy: { mode: "named", accountId: f.beta } });
    const a = await f.token("thread-a");
    await f.callRpc("account.disable", { id: f.beta });
    expect((await f.send(a)).status).toBe(200);
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.slice(-2)).toEqual(["sk-alpha", "sk-alpha"]);
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({
      policy: { mode: "named", accountId: f.beta },
      revision: 1,
    });
    // One deduplicated row for the stretch.
    expect(
      (await f.audit()).filter((row) => row.startsWith("named-limit")),
    ).toEqual(["named-limit:thread-a:unavailable-fallback-auto"]);
    await f.callRpc("account.enable", { id: f.beta });
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-beta");
  });

  it("falls back on an upstream quota rejection and returns a transient failure as is", async () => {
    const f = await fixture();
    f.thread("thread-a");
    await f.rpc("set", { threadId: "thread-a", policy: { mode: "named", accountId: f.beta } });
    const a = await f.token("thread-a");
    f.replies.set("sk-beta", { status: 529, body: '{"type":"error","error":{"type":"overloaded_error"}}' });
    const before = f.seen.length;
    expect((await f.send(a)).status).not.toBe(200);
    expect(f.seen.slice(before).every((key) => key === "sk-beta")).toBe(true);
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({
      policy: { mode: "named" },
    });
    f.replies.set("sk-beta", {
      status: 429,
      headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "1",
        "anthropic-ratelimit-unified-5h-reset": String(Math.floor(START / 1_000) + 3_600),
      },
    });
    expect((await f.send(a)).status).toBe(200);
    expect(f.seen.at(-1)).toBe("sk-alpha");
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({
      policy: { mode: "auto" },
    });
  });

  it("stops a thread pinned with `stop` at the limit, with retry-after and its own retry availability", async () => {
    const f = await fixture();
    f.thread("thread-a");
    await f.rpc("set", {
      threadId: "thread-a",
      policy: { mode: "named", accountId: f.beta, onLimit: "stop" },
    });
    const a = await f.token("thread-a");
    f.setUsage(f.beta, 1);
    const before = f.seen.length;
    const response = await f.send(a);
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(f.seen.length).toBe(before);
    await f.send(a);
    expect(
      (await f.audit()).filter((row) => row.startsWith("named-limit")),
    ).toEqual(["named-limit:thread-a:limit-stop"]);
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({
      policy: { mode: "named", onLimit: "stop" },
      lastLimit: { cause: "limit", action: "stopped" },
    });
    // alpha is free, but this thread waits for beta.
    expect(
      await f.callRpc(retryAvailabilityMethod, {
        threadId: "thread-a",
        requestId: "creq_aaaaaaaaaa",
      }),
    ).toMatchObject({ kind: "blocked", retryAt: START + 3_600_000 });
    f.thread("thread-b");
    await f.token("thread-b");
    expect(
      await f.callRpc(retryAvailabilityMethod, {
        threadId: "thread-b",
        requestId: "creq_aaaaaaaaaa",
      }),
    ).toEqual({ kind: "ready" });
  });
});

describe("thread-account.v1 set refusals (S9)", () => {
  it("refuses with reason codes in order and changes nothing", async () => {
    const f = await fixture();
    const codexId = await f.add("delta", 0, "codex");
    f.thread("thread-a");
    f.thread("thread-archived", { archivedAt: START });
    f.thread("thread-pi", { providerId: "pi" });
    const named = (threadId: string, accountId: string, extra = {}) =>
      f.rpc("set", { threadId, policy: { mode: "named", accountId }, ...extra });
    expect(await named("thread-missing", f.beta)).toMatchObject({ ok: false, reason: "unknown-thread" });
    expect(await named("thread-archived", f.beta)).toMatchObject({ ok: false, reason: "not-writable" });
    expect(await named("thread-pi", f.beta)).toMatchObject({ ok: false, reason: "not-pooled" });
    expect(await named("thread-a", "acct-missing")).toMatchObject({ ok: false, reason: "unknown-account" });
    expect(await named("thread-a", codexId)).toMatchObject({ ok: false, reason: "other-provider" });
    await f.callRpc("account.disable", { id: f.beta });
    expect(await named("thread-a", f.beta)).toMatchObject({ ok: false, reason: "unavailable" });
    await f.callRpc("account.enable", { id: f.beta });
    f.setUsage(f.beta, 1);
    expect(await named("thread-a", f.beta)).toMatchObject({
      ok: false,
      reason: "at-limit",
      resetAt: START + 3_600_000,
    });
    f.setUsage(f.beta, 0.99);
    expect(await named("thread-a", f.beta, { expectedRevision: 3 })).toMatchObject({
      ok: false,
      reason: "revision-conflict",
    });
    expect(await named("thread-a", f.beta, { newSession: true })).toMatchObject({
      ok: false,
      reason: "new-session-not-codex",
    });
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({ revision: 0 });
    expect((await f.audit()).filter((row) => row.startsWith("policy"))).toEqual([]);
    // A stale writer loses the compare-and-set.
    expect(await named("thread-a", f.beta, { expectedRevision: 0 })).toMatchObject({ ok: true, revision: 1 });
    expect(await named("thread-a", f.alpha, { expectedRevision: 0 })).toMatchObject({
      ok: false,
      reason: "revision-conflict",
    });
  });

  it("starts a new Codex session only after the policy is stored, and reverts when bb refuses", async () => {
    const f = await fixture();
    const first = await f.add("delta", 0, "codex");
    const second = await f.add("epsilon", 10, "codex");
    f.thread("thread-codex", { providerId: "codex" });
    const set = (accountId: string) =>
      f.rpc("set", {
        threadId: "thread-codex",
        policy: { mode: "named", accountId },
        newSession: true,
      });
    // Serving nothing yet: the first pin is not a switch either way.
    f.threads.get("thread-codex")!.status = "active";
    expect(await set(second)).toMatchObject({ ok: false, reason: "not-idle" });
    f.threads.get("thread-codex")!.status = "idle";
    let seenPolicy: unknown = null;
    f.clearContext.mockImplementationOnce(async () => {
      seenPolicy = (await f.rpc("get", { threadId: "thread-codex" })).policy;
      return { ok: true };
    });
    expect(await set(second)).toMatchObject({
      ok: true,
      sessionRebuild: "new-session",
      switchContinuity: "new-session",
    });
    expect(seenPolicy).toMatchObject({ mode: "named", accountId: second });
    expect(f.clearContext).toHaveBeenCalledWith({ threadId: "thread-codex" });
    f.clearContext.mockRejectedValueOnce(new Error("busy"));
    expect(await set(first)).toMatchObject({ ok: false, reason: "not-idle" });
    expect(await f.rpc("get", { threadId: "thread-codex" })).toMatchObject({
      policy: { mode: "named", accountId: second },
      revision: 3,
    });
    expect((await f.audit()).filter((row) => row.startsWith("policy"))).toEqual([
      "policy:thread-codex:named-fallback-auto@client+new-session",
      "policy:thread-codex:named-fallback-auto@client+new-session",
      "policy:thread-codex:named-fallback-auto@revert",
    ]);
    expect(await f.rpc("get", { threadId: "thread-codex" })).toMatchObject({
      switchContinuity: "may-restart",
      note: expect.stringContaining("new Codex session"),
    });
  });
});

describe("contract callers, events, accounts, CLI and status", () => {
  it("records a sanitized plugin caller", async () => {
    const f = await fixture();
    f.thread("thread-a");
    await f.rpc(
      "set",
      { threadId: "thread-a", policy: { mode: "named", accountId: f.beta } },
      "Some Plugin!! v2",
    );
    expect((await f.audit()).at(-1)).toBe(
      "policy:thread-a:named-fallback-auto@plugin-some-plugin-v2",
    );
    expect(callerDetail({ kind: "plugin", pluginId: "!!!" })).toBe("plugin-unknown");
    expect(callerDetail({ kind: "plugin", pluginId: "a".repeat(80) })).toBe(
      `plugin-${"a".repeat(48)}`,
    );
  });

  it("lists accounts in priority order with usability, and pages events", async () => {
    const f = await fixture();
    await f.add("delta", 5, "codex");
    f.thread("thread-a");
    f.setUsage(f.beta, 1);
    const listed = await f.rpc("accounts", { threadId: "thread-a" });
    expect(
      (listed.accounts as Array<Record<string, unknown>>).map((account) => [
        account.accountLabel,
        account.usable,
        account.reason,
      ]),
    ).toEqual([
      ["alpha", true, null],
      ["delta", false, "other-provider"],
      ["beta", false, "at-limit"],
    ]);
    f.setUsage(f.beta, 0);
    await f.rpc("set", { threadId: "thread-a", policy: { mode: "named", accountId: f.beta } });
    await f.rpc("set", { threadId: "thread-a", policy: { mode: "auto" } });
    const all = (await f.rpc("events", { threadId: "thread-a" })).events as Array<{ id: number }>;
    expect(all.map((event: Record<string, unknown>) => event.detail)).toEqual([
      "named-fallback-auto@client",
      "auto@client",
    ]);
    expect(
      ((await f.rpc("events", { threadId: "thread-a", afterId: all[0]!.id, limit: 1 })).events as unknown[]),
    ).toHaveLength(1);
  });

  it("drives the policy from the CLI by label and shows threads in status", async () => {
    const f = await fixture();
    f.thread("thread-a");
    const set = await f.runCli(["thread", "set", "thread-a", "beta", "--on-limit", "stop", "--json"]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toMatchObject({ ok: true, policy: { accountId: f.beta } });
    const refused = await f.runCli(["thread", "set", "thread-a", "nobody"]);
    expect(refused.exitCode).not.toBe(0);
    expect((await f.runCli(["thread", "show", "thread-a"])).stdout).toContain(
      "Policy: named beta (on limit: stop) (revision 1)",
    );
    expect((await f.send(await f.token("thread-a"))).status).toBe(200);
    expect((await f.runCli(["thread", "list"])).stdout).toContain("thread-a\tbeta (stop)\tbeta");
    expect((await f.runCli(["thread", "events", "thread-a"])).stdout).toContain("policy");
    expect((await f.runCli(["thread", "accounts", "thread-a"])).stdout).toContain("usable");
    const status = statusReportSchema.parse(
      JSON.parse((await f.runCli(["status", "--json"])).stdout),
    );
    expect(status.threads).toEqual({
      namedPolicies: 1,
      servingByAccount: [{ accountId: f.beta, accountLabel: "beta", threads: 1 }],
      machineTokenSelections: 0,
    });
    expect((await f.runCli(["status"])).stdout).toContain("Named policies: 1");
  });

  it("drops a deleted thread's policy and keeps an archived one", async () => {
    const f = await fixture();
    f.thread("thread-a");
    f.thread("thread-b");
    for (const threadId of ["thread-a", "thread-b"])
      await f.rpc("set", { threadId, policy: { mode: "named", accountId: f.beta } });
    await f.host.harness.behavior.emitThreadEvent("thread.deleted", {
      thread: makeThreadResponse({ id: "thread-a", deletedAt: START }),
    });
    f.thread("thread-b", { archivedAt: START });
    expect(await f.rpc("get", { threadId: "thread-a" })).toMatchObject({ revision: 0 });
    const status = statusReportSchema.parse(
      JSON.parse((await f.runCli(["status", "--json"])).stdout),
    );
    expect(status.threads?.namedPolicies).toBe(1);
  });
});

describe("policy store", () => {
  it("compare-and-sets, reconciles deleted threads and keeps the pass epoch", async () => {
    const db = new Database(":memory:");
    for (const statement of QUOTA_MIGRATIONS) db.exec(statement);
    const clock = { time: START };
    const audit = new AuditLog(db, () => clock.time);
    const store = new ThreadPolicyStore(db, () => clock.time, (id) => audit.latestServing(id));
    expect(store.passEpoch).toBe(START);
    const named = { mode: "named", provider: "claude", accountId: "acct-1", onLimit: "stop" } as const;
    expect(store.write("thread-a", named, 0)).toBe(1);
    expect(store.write("thread-a", { mode: "auto" }, 0)).toBeNull();
    expect(store.get("thread-a")).toMatchObject({ mode: "named", revision: 1 });
    expect(store.write("thread-a", { mode: "auto" }, 1)).toBe(2);
    store.write("thread-b", named, 0);
    store.write("thread-c", named, 0);
    clock.time += 1_000;
    // A restart keeps the first start time.
    expect(new ThreadPolicyStore(db, () => clock.time, () => null).passEpoch).toBe(START);
    const deleted: string[] = [];
    await store.reconcile(
      {
        listThreads: async () => new Map([["thread-b", { archivedAt: START, deletedAt: null }]]),
        getThread: async (threadId) => {
          if (threadId === "thread-c") throw new Error("bb is restarting");
          return null;
        },
      },
      (threadId) => deleted.push(threadId),
    );
    expect(deleted).toEqual(["thread-a"]);
    expect(store.threadIds()).toEqual(["thread-b", "thread-c"]);
  });

  it("keeps P2's migrations a byte-identical prefix, so a rollback opens the store", () => {
    // P2 runs migrations 0..11; P3 only appends index 12.
    expect(QUOTA_MIGRATIONS).toHaveLength(13);
    expect(QUOTA_MIGRATIONS[12]).toContain("CREATE TABLE pool_thread_policy");
  });
});
