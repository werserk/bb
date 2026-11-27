import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountSchema } from "./contracts.js";
import { PARENT_TOKEN_ENV, PARENT_URL_ENV } from "./parent-pool.js";
import {
  ProjectPriority,
  orderForProject,
  projectHeaderValue,
  readProjectId,
} from "./project-priority.js";
import { PoolAffinityStore } from "./store.js";
import { createAccountPoolPlugin } from "./server.js";

const SESSION_ONE = "11111111-1111-4111-8111-111111111111";
const SESSION_TWO = "22222222-2222-4222-8222-222222222222";
const SESSION_THREE = "33333333-3333-4333-8333-333333333333";
const PROJECT = "proj_alpha1";
const OTHER_PROJECT = "proj_beta2";
const IDLE_MS = 66 * 60 * 1_000;

interface Seen {
  key: string | undefined;
  project: string | undefined;
  headers: IncomingMessage["headers"];
}

interface Pool {
  host: ReturnType<typeof createFakePluginHost>;
  token: string;
  ids: Record<"a" | "b" | "c", string>;
  seen: Seen[];
  clock: { now: number };
  respond: Map<string, (response: ServerResponse) => void>;
  send: (
    session: string,
    project?: string | null,
  ) => Promise<{ status: number; key: string | undefined }>;
}

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startPool(): Promise<Pool> {
  const seen: Seen[] = [];
  const respond = new Map<string, (response: ServerResponse) => void>();
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const key = request.headers["x-api-key"]?.toString();
      seen.push({
        key,
        project: request.headers["x-bb-project"]?.toString(),
        headers: request.headers,
      });
      const custom = key === undefined ? undefined : respond.get(key);
      if (custom !== undefined) return custom(response);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake upstream did not bind a TCP port.");
  }
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "bb-pool-project-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: {
      hosts: { list: async () => [{ id: "host-one", name: "One" }] },
      threads: { events: { list: async () => [] } },
      system: { providerStates: async () => ({ providers: [] }) },
      plugins: {
        list: async () => ({
          plugins: [{ id: "account-pool", enabled: true }],
        }),
      },
    },
  });
  const clock = { now: Date.now() };
  await createAccountPoolPlugin({
    usageUrl: "data:application/json,{}",
    upstreams: {
      anthropic: `http://127.0.0.1:${address.port}`,
      chatgptCodex: `http://127.0.0.1:${address.port}`,
      openai: `http://127.0.0.1:${address.port}`,
    },
    now: () => clock.now,
  })(host.bb);
  await host.harness.behavior.callRpc("hostRole.set", {
    hostId: "host-one",
    role: "trusted",
  });
  const ids = {} as Pool["ids"];
  for (const [name, priority] of [
    ["a", 1],
    ["b", 2],
    ["c", 3],
  ] as const) {
    ids[name] = accountSchema.parse(
      await host.harness.behavior.callRpc("account.add", {
        provider: "claude",
        source: { kind: "api-key", apiKey: `sk-${name}` },
        label: name,
        priority,
      }),
    ).id;
  }
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
    const status = await host.harness.behavior.runCli(["status", "--json"]);
    expect(JSON.parse(status.stdout).accepting).toBe(true);
  });
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    { threadId: "thread-one", projectId: PROJECT, hostId: "host-one" },
  );
  const token = entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  if (typeof token?.value !== "string") throw new Error("No hub token.");
  return {
    host,
    token: token.value,
    ids,
    seen,
    clock,
    respond,
    send: async (session, project = null) => {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: {
            authorization: `Bearer ${token.value}`,
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            ...(project === null ? {} : { "x-bb-project": project }),
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            messages: [{ role: "user", content: "hi" }],
            metadata: { user_id: `user_x_account__session_${session}` },
          }),
        },
      );
      await response.text();
      return { status: response.status, key: seen.at(-1)?.key };
    },
  };
}

async function setOrder(
  pool: Pool,
  names: Array<keyof Pool["ids"]>,
  projectId = PROJECT,
): Promise<void> {
  await pool.host.harness.behavior.callRpc("projectPriority.set", {
    projectId,
    accountIds: names.map((name) => pool.ids[name]),
  });
}

describe("project priority helpers", () => {
  it("orders listed accounts first and the rest in the given order, ignoring unknown ids", () => {
    const accounts = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(
      orderForProject(accounts, ["c", "gone", "a"]).map(({ id }) => id),
    ).toEqual(["c", "a", "b", "d"]);
    expect(orderForProject(accounts, []).map(({ id }) => id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("reads only well-formed project headers", () => {
    expect(readProjectId(new Headers({ "x-bb-project": " proj_ab12 " }))).toBe(
      "proj_ab12",
    );
    expect(readProjectId(new Headers())).toBeNull();
    expect(readProjectId(new Headers({ "x-bb-project": "project-one" }))).toBe(
      null,
    );
    expect(
      readProjectId(new Headers({ "x-bb-project": "proj_AB" })),
    ).toBeNull();
  });

  it("builds the custom header value, keeping host headers and replacing a stale project line", () => {
    expect(projectHeaderValue("proj_ab12", undefined)).toBe(
      "x-bb-project: proj_ab12",
    );
    expect(
      projectHeaderValue("proj_ab12", "x-team: t1\nX-BB-Project: proj_old"),
    ).toBe("x-team: t1\nx-bb-project: proj_ab12");
    expect(projectHeaderValue(null, "x-team: t1")).toBeNull();
    expect(projectHeaderValue("proj_ab12\nx-evil: 1", undefined)).toBeNull();
  });

  it("reloads persisted orders and drops malformed entries", async () => {
    const store = new Map<string, unknown>([
      ["project-priority:proj_ok1", ["44444444-4444-4444-8444-444444444444"]],
      ["project-priority:proj_bad", ["not-a-uuid"]],
      ["project-priority:wrong id", ["44444444-4444-4444-8444-444444444444"]],
    ]);
    const kv = {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      delete: async (key: string) => void store.delete(key),
      list: async (prefix: string) =>
        [...store.keys()].filter((key) => key.startsWith(prefix)),
    };
    const priority = new ProjectPriority(kv as never, async () => []);
    await priority.load();
    expect(priority.list()).toEqual([
      {
        projectId: "proj_ok1",
        accountIds: ["44444444-4444-4444-8444-444444444444"],
      },
    ]);
    expect(priority.get("proj_missing")).toBeNull();
  });
});

describe("project priority routing", () => {
  it("sends a cold session of a configured project to its first account", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c", "b"]);
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      status: 200,
      key: "sk-c",
    });
    expect(pool.seen.at(-1)?.project).toBeUndefined();
  });

  it("keeps a live pin over the project order and re-evaluates after the pin expires", async () => {
    const pool = await startPool();
    await expect(pool.send(SESSION_ONE)).resolves.toMatchObject({
      key: "sk-a",
    });
    await setOrder(pool, ["c", "b"]);
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      key: "sk-a",
    });
    pool.clock.now += IDLE_MS;
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      key: "sk-c",
    });
  });

  it("falls to the next account in the project order when the first is at the switch threshold", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c", "b"]);
    pool.respond.set("sk-c", (response) => {
      response.writeHead(200, {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-5h-utilization": "0.99",
        "anthropic-ratelimit-unified-5h-reset": "4102444800",
        "anthropic-ratelimit-unified-5h-status": "allowed",
      });
      response.end("{}");
    });
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      key: "sk-c",
    });
    await expect(pool.send(SESSION_TWO, PROJECT)).resolves.toMatchObject({
      key: "sk-b",
    });
  });

  it("fails over within one request along the project order when the first account is rejected", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c", "b"]);
    pool.respond.set("sk-c", (response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "bad key" },
        }),
      );
    });
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      status: 200,
      key: "sk-b",
    });
    expect(pool.seen.map((entry) => entry.key)).toEqual(["sk-c", "sk-b"]);
  });

  it("skips a disabled first account and keeps reaching every other account", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c"]);
    await pool.host.harness.behavior.callRpc("account.disable", {
      id: pool.ids.c,
    });
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      key: "sk-a",
    });
  });

  it("behaves as before without a header, for an unknown project and for a project without an order", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c", "b"]);
    await expect(pool.send(SESSION_ONE)).resolves.toMatchObject({
      key: "sk-a",
    });
    await expect(pool.send(SESSION_TWO, "proj_unknown")).resolves.toMatchObject(
      {
        key: "sk-a",
      },
    );
    await expect(
      pool.send(SESSION_THREE, "not a project"),
    ).resolves.toMatchObject({ key: "sk-a" });
  });

  it("does not move the global cursor or other projects' routing", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c", "b"]);
    await setOrder(pool, ["b", "c"], OTHER_PROJECT);
    await pool.send(SESSION_ONE, PROJECT);
    await pool.send(SESSION_TWO, OTHER_PROJECT);
    expect(pool.seen.map((entry) => entry.key)).toEqual(["sk-c", "sk-b"]);
    expect(
      new PoolAffinityStore(pool.host.bb.storage.database())
        .loadActiveAccounts()
        .get("claude"),
    ).toBeUndefined();
    await expect(pool.send(SESSION_THREE)).resolves.toMatchObject({
      key: "sk-a",
    });
  });

  it("ignores an account that was removed after the order was set", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c", "b"]);
    await pool.host.harness.behavior.callRpc("account.remove", {
      id: pool.ids.c,
    });
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      key: "sk-b",
    });
  });

  it("never forwards the project header or the hub token upstream", async () => {
    const pool = await startPool();
    await setOrder(pool, ["c"]);
    await pool.send(SESSION_ONE, PROJECT);
    const headers = pool.seen.at(-1)?.headers ?? {};
    expect(Object.keys(headers)).not.toContain("x-bb-project");
    expect(JSON.stringify(headers)).not.toContain(pool.token);
  });
});

describe("project priority configuration", () => {
  it("validates input and round-trips through RPC and CLI", async () => {
    const pool = await startPool();
    const { callRpc, runCli } = pool.host.harness.behavior;
    await expect(
      callRpc("projectPriority.set", {
        projectId: PROJECT,
        accountIds: ["99999999-9999-4999-8999-999999999999"],
      }),
    ).rejects.toThrow(/Unknown Claude account id/u);
    await expect(
      callRpc("projectPriority.set", {
        projectId: PROJECT,
        accountIds: [pool.ids.a, pool.ids.a],
      }),
    ).rejects.toThrow();
    await expect(
      callRpc("projectPriority.set", {
        projectId: "project-one",
        accountIds: [pool.ids.a],
      }),
    ).rejects.toThrow();

    const set = await runCli([
      "project-priority",
      "set",
      PROJECT,
      pool.ids.b,
      pool.ids.a,
      "--json",
    ]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout)).toEqual({
      ok: true,
      projectId: PROJECT,
      accountIds: [pool.ids.b, pool.ids.a],
    });
    const listed = await runCli(["project-priority", "list", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual({
      projects: [{ projectId: PROJECT, accountIds: [pool.ids.b, pool.ids.a] }],
    });
    await expect(pool.send(SESSION_ONE, PROJECT)).resolves.toMatchObject({
      key: "sk-b",
    });
    const cleared = await runCli([
      "project-priority",
      "clear",
      PROJECT,
      "--json",
    ]);
    expect(JSON.parse(cleared.stdout)).toEqual({
      ok: true,
      projectId: PROJECT,
      cleared: true,
    });
    expect(await callRpc("projectPriority.list", null)).toEqual([]);
    await expect(pool.send(SESSION_TWO, PROJECT)).resolves.toMatchObject({
      key: "sk-a",
    });
  });

  it("contributes the project header only for well-formed project ids and never for Codex", async () => {
    const pool = await startPool();
    const header = async (projectId: string | null) =>
      (
        await pool.host.harness.behavior.resolveProviderEnv("claude-code", {
          threadId: "thread-one",
          projectId,
          hostId: "host-one",
        })
      ).find((entry) => entry.name === "ANTHROPIC_CUSTOM_HEADERS")?.value;
    await expect(header(PROJECT)).resolves.toBe(`x-bb-project: ${PROJECT}`);
    await expect(header(null)).resolves.toBeUndefined();
    await expect(header("project-one")).resolves.toBeUndefined();
    const codex = await pool.host.harness.behavior.resolveProviderEnv("codex", {
      threadId: "thread-codex",
      projectId: PROJECT,
      hostId: "host-one",
    });
    expect(codex.map((entry) => entry.name)).not.toContain(
      "ANTHROPIC_CUSTOM_HEADERS",
    );
  });
});
