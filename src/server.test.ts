import { accountStatus } from "./quota.js";
import {
  retryAvailabilityMethod,
  type RetryAvailability,
} from "./retry-contract.js";
import {
  usageMeasurementSchema,
  usageResourceListSchema,
  usageListMethod,
  usageFetchMethod,
} from "./usage-contract.js";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  createFakePluginHost,
  makeHostResponse,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountSchema,
  accountSecretSchema,
  accountSummarySchema,
  accountPoolConfigSchema,
  DEFAULT_ACCOUNT_POOL_CONFIG,
  accountPoolConfigSetInputSchema,
  codexLoginPollSchema,
  codexLoginStartSchema,
  routedThreadStatusListSchema,
  statusReportSchema,
  statusSchema,
  type AccountSummary,
} from "./contracts.js";
import { z } from "zod";
import {
  AVAILABILITY_PATH,
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
} from "./parent-pool.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
} from "./store.js";
import {
  createAccountPoolPlugin,
  helloResponse,
  type AccountPoolPluginOptions,
} from "./server.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The pool adds OAuth accounts only through its own logins. Most tests need a
// ready OAuth account rather than a login, so they seed the record the login
// path stores, through the plugin's own AccountStore and secret directory.
interface ClaudeLoginSeed {
  accessToken: string;
  refreshToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  email: string | null;
  accountUuid: string | null;
}

interface CodexLoginSeed {
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string;
  email: string | null;
  expiresAt: number | null;
}

type TestPluginOptions = AccountPoolPluginOptions & {
  seedClaude?: () => Promise<ClaudeLoginSeed>;
  seedCodex?: () => Promise<CodexLoginSeed>;
};

const loginSeeds = new WeakMap<
  BbPluginApi,
  Pick<TestPluginOptions, "seedClaude" | "seedCodex">
>();

function testPlugin(options: TestPluginOptions = {}) {
  const { seedClaude, seedCodex, ...pluginOptions } = options;
  const plugin = createAccountPoolPlugin(pluginOptions);
  return async (bb: BbPluginApi): Promise<void> => {
    loginSeeds.set(bb, { seedClaude, seedCodex });
    await plugin(bb);
  };
}

// Test-only: the Anthropic and ChatGPT upstreams at one fake server. OpenAI API
// keys keep the fixed api.openai.com upstream, as the old stored config did.
function upstreamsAt(url: string) {
  return { anthropic: url, chatgptCodex: url };
}

async function addOAuthAccount(
  host: { bb: BbPluginApi; harness: { behavior: { callRpc: (method: string, input: unknown) => Promise<unknown> } } },
  input: { provider: "claude" | "codex"; label: string | null; priority: number },
) {
  const seeds = loginSeeds.get(host.bb);
  const store = new AccountStore(
    host.bb.storage.kv,
    path.join(
      host.bb.server.experimental_dataDir,
      "plugins",
      host.bb.pluginId,
      "secrets",
      "accounts",
    ),
  );
  let account;
  if (input.provider === "claude") {
    if (seeds?.seedClaude === undefined) throw new Error("No Claude login seed.");
    const login = await seeds.seedClaude();
    account = await store.add(
      {
        provider: "claude",
        kind: "oauth",
        label: input.label ?? login.email ?? "Claude Code account",
        email: login.email,
        accountUuid: login.accountUuid,
        subscriptionType: login.subscriptionType,
        rateLimitTier: login.rateLimitTier,
        enabled: true,
        priority: input.priority,
      },
      {
        kind: "oauth",
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        expiresAt: login.expiresAt,
      },
    );
  } else {
    if (seeds?.seedCodex === undefined) throw new Error("No Codex login seed.");
    const login = await seeds.seedCodex();
    account = await store.add(
      {
        provider: "codex",
        kind: "oauth",
        label: input.label ?? login.email ?? "Codex account",
        email: login.email,
        accountUuid: null,
        codexAccountId: login.accountId,
        subscriptionType: null,
        rateLimitTier: null,
        enabled: true,
        priority: input.priority,
      },
      {
        kind: "oauth",
        accessToken: login.accessToken,
        refreshToken: login.refreshToken,
        expiresAt: login.expiresAt,
        ...(login.idToken === null ? {} : { idToken: login.idToken }),
      },
    );
  }
  // A finished login refreshes the new account's usage; do the same.
  await host.harness.behavior.callRpc("account.refreshUsage", {
    accountId: account.id,
  });
  return account;
}

type UpstreamHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => void | Promise<void>;

interface Upstream {
  url: string;
  close: () => Promise<void>;
}

interface Fixture {
  dataDir: string;
  host: ReturnType<typeof createFakePluginHost>;
  service: ReturnType<
    ReturnType<typeof createFakePluginHost>["harness"]["behavior"]["runService"]
  >;
  key: string;
  account: AccountSummary;
}

const cleanups: Array<() => Promise<void>> = [];

function sdkStubs() {
  return {
    hosts: {
      list: async () => [
        {
          id: "host-one",
          name: "One",
        },
        {
          id: "host-two",
          name: "Two",
        },
      ],
    },
    threads: {
      get: async () => ({ host: { id: "host-one" } }),
      events: {
        list: async () => [
          {
            data: {
              requestId: "creq_aaaaaaaaaa",
              execution: { model: "claude-opus-4-1" },
            },
          },
        ],
      },
    },
    system: {
      providerStates: async () => ({ providers: [] }),
    },
    plugins: {
      list: async () => ({
        plugins: [{ id: "account-pool", enabled: true }],
      }),
    },
  };
}

// A fresh store gives no machine a role; the fixture hosts get one explicitly.
async function grantRoles(
  host: ReturnType<typeof createFakePluginHost>,
  hostIds: readonly string[] = ["host-one", "host-two"],
  role: "server" | "worker" | "trusted" = "trusted",
): Promise<void> {
  for (const hostId of hostIds)
    await host.harness.behavior.callRpc("hostRole.set", { hostId, role });
}

async function resolveToken(
  host: ReturnType<typeof createFakePluginHost>,
  hostId = "host-one",
  threadId = "thread-one",
): Promise<string> {
  const entries = await host.harness.behavior.resolveProviderEnv(
    "claude-code",
    { threadId, projectId: "project-one", hostId },
  );
  const token = entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  if (token === undefined || typeof token.value !== "string") {
    throw new Error("Account Pool token was not resolved.");
  }
  return token.value;
}

async function resolveCodexToken(
  host: ReturnType<typeof createFakePluginHost>,
  hostId = "host-one",
): Promise<{ token: string; baseUrl: string }> {
  const entries = await host.harness.behavior.resolveProviderEnv("codex", {
    threadId: "thread-codex",
    projectId: "project-one",
    hostId,
  });
  const token = entries.find((entry) => entry.name === "CODEX_POOL_AUTH_TOKEN");
  const baseUrl = entries.find(
    (entry) => entry.name === "CODEX_OPENAI_BASE_URL",
  );
  if (token === undefined || typeof token.value !== "string") {
    throw new Error("Codex Account Pool token was not resolved.");
  }
  if (baseUrl === undefined || typeof baseUrl.value !== "object") {
    throw new Error("Codex Account Pool base URL was not resolved.");
  }
  return { token: token.value, baseUrl: baseUrl.value.serverPath };
}

beforeEach(() => {
  vi.stubEnv(PARENT_URL_ENV, undefined);
  vi.stubEnv(PARENT_TOKEN_ENV, undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const server = http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      response.statusCode = 500;
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fake upstream did not bind a TCP port.");
  }
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function readRequestBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function claudeLoginSeed(
  overrides: Partial<ClaudeLoginSeed> = {},
): ClaudeLoginSeed {
  return {
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAt: Date.now() + 60 * 60 * 1_000,
    subscriptionType: "max",
    rateLimitTier: "max_5x",
    email: "pool@example.com",
    accountUuid: "11111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function testJwt(payload: object): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

async function createFixture(args: {
  // null keeps the fixed provider upstreams.
  upstreamUrl: string | null;
  storedConfig?: Record<string, unknown>;
  options?: TestPluginOptions;
  provider?: "claude" | "codex";
  source?: "api-key" | "oauth";
  apiKey?: string;
  priority?: number;
  beforePlugin?: (host: Fixture["host"]) => void;
  // false: start with the store's own roles (none on a fresh store) and no key.
  roles?: boolean;
}): Promise<Fixture> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: sdkStubs(),
  });
  if (args.storedConfig !== undefined) {
    await host.bb.storage.kv.set("config", args.storedConfig);
  }
  const plugin = testPlugin({
    usageUrl: "data:application/json,{}",
    ...(args.upstreamUrl === null
      ? {}
      : { upstreams: upstreamsAt(args.upstreamUrl) }),
    ...args.options,
  });
  args.beforePlugin?.(host);
  await plugin(host.bb);
  if (args.roles !== false) await grantRoles(host);
  const provider = args.provider ?? "claude";
  const priority = args.priority ?? 100;
  const accountMetadata =
    args.source === "oauth"
      ? await addOAuthAccount(host, { provider, label: null, priority })
      : accountSchema.parse(
          await host.harness.behavior.callRpc("account.add", {
            provider,
            source: { kind: "api-key", apiKey: args.apiKey ?? "sk-account" },
            label: null,
            priority,
          }),
        );
  const service = host.harness.behavior.runService("hub");
  await vi.waitFor(async () => {
    const result = await host.harness.behavior.runCli(["status", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(statusReportSchema.parse(JSON.parse(result.stdout)).accepting).toBe(
      true,
    );
  });
  const statusResult = await host.harness.behavior.runCli(["status", "--json"]);
  const status = statusReportSchema.parse(JSON.parse(statusResult.stdout));
  const account = status.accounts.find(
    (candidate) => candidate.id === accountMetadata.id,
  );
  if (account === undefined) throw new Error("Added account was not listed.");
  cleanups.push(async () => {
    service.controller.abort();
    await service.done;
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const key =
    args.roles === false
      ? ""
      : args.provider === "codex"
        ? (await resolveCodexToken(host)).token
        : await resolveToken(host);
  return { dataDir, host, service, key, account };
}

async function createOAuthRequestFixture(
  provider: "claude" | "codex",
  upstreamFetch: typeof fetch,
  now: () => number,
  extra: TestPluginOptions = {},
): Promise<Fixture> {
  return createFixture({
    upstreamUrl: "https://upstream.example",
    provider,
    source: "oauth",
    options: {
      ...extra,
      fetch: (input, init) =>
        String(input) === EMPTY_USAGE_URL
          ? Promise.resolve(Response.json({}))
          : upstreamFetch(input, init),
      now,
      refreshUrl: "https://upstream.example/oauth/token",
      codexRefreshUrl: "https://upstream.example/oauth/token",
      codexUsageUrl: EMPTY_USAGE_URL,
      seedClaude: async () =>
        claudeLoginSeed({
          accessToken: "oauth-old",
          expiresAt: now() + 60 * 60 * 1_000,
        }),
      seedCodex: async () => ({
        accessToken: "oauth-old",
        refreshToken: "oauth-refresh",
        idToken: null,
        accountId: "chatgpt-account",
        email: "codex@example.com",
        expiresAt: now() + 60 * 60 * 1_000,
      }),
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((release) => {
    resolve = release;
  });
  return { promise, resolve };
}

function authHeaders(key: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
}

async function addApiAccount(
  fixture: Fixture,
  apiKey: string,
  priority = 100,
): Promise<AccountSummary> {
  const added = accountSchema.parse(
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey },
      label: apiKey,
      priority,
    }),
  );
  const list = z
    .array(accountSummarySchema)
    .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
  const found = list.find((account) => account.id === added.id);
  if (found === undefined) throw new Error("Added account was not listed.");
  return found;
}

async function movePoolToOtherAccount(
  fixture: Fixture,
  provider: "claude" | "codex",
  disabledId = fixture.account.id,
): Promise<void> {
  await fixture.host.harness.behavior.callRpc("account.disable", {
    id: disabledId,
  });
  try {
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      provider === "claude" ? "/v1/messages" : "/v1/responses",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(response.status).toBe(200);
    await response.text();
  } finally {
    await fixture.host.harness.behavior.callRpc("account.enable", {
      id: disabledId,
    });
  }
}

const EMPTY_USAGE_URL = "data:application/json,{}";
const CODEX_USAGE_STUB_URL = "https://usage.example/wham/usage";

describe("Account Pool config schema", () => {
  it("fills defaults and rejects removed upstream keys and bad thresholds", () => {
    expect(accountPoolConfigSchema.parse({})).toEqual({
      switchThreshold: 0.98,
      parentMode: "proxy",
    });
    for (const key of ["anthropicUpstreamBaseUrl", "codexUpstreamBaseUrl"]) {
      expect(
        accountPoolConfigSetInputSchema.safeParse({
          [key]: "https://example.invalid",
        }).success,
      ).toBe(false);
      expect(
        accountPoolConfigSchema.safeParse({ [key]: "https://example.invalid" })
          .success,
      ).toBe(false);
    }
    expect(
      accountPoolConfigSetInputSchema.safeParse({ switchThreshold: 0 }).success,
    ).toBe(false);
    expect(
      accountPoolConfigSetInputSchema.safeParse({ switchThreshold: 1.01 })
        .success,
    ).toBe(false);
  });
});

describe("Account Pool plugin", () => {
  it("drops removed settings from a stored config, logs it once, and keeps the rest across reloads", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-config-upgrade-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const expected = accountPoolConfigSchema.parse({
      switchThreshold: 0.75,
      parentMode: "isolate",
    });
    await host.bb.storage.kv.set("config", {
      ...expected,
      anthropicUpstreamBaseUrl: "https://evil.example",
      codexUpstreamBaseUrl: "https://evil.example/codex",
      cacheMissDebug: true,
      cacheMissMinTokens: 20_000,
    });
    const plugin = testPlugin();
    await plugin(host.bb);
    await grantRoles(host);
    expect(await host.bb.storage.kv.get("config")).toEqual(expected);
    expect(await host.harness.behavior.callRpc("config.get", null)).toEqual(
      expected,
    );
    await host.harness.lifecycle.reload(plugin);
    expect(await host.harness.behavior.callRpc("config.get", null)).toEqual(
      expected,
    );
    const removedNotices = host.harness.inspection.logEntries.filter((entry) =>
      entry.message.startsWith("Ignored removed config keys"),
    );
    expect(removedNotices).toEqual([
      {
        level: "warn",
        message:
          "Ignored removed config keys: anthropicUpstreamBaseUrl, codexUpstreamBaseUrl, cacheMissDebug, cacheMissMinTokens. Provider upstreams are fixed in code. A non-default upstream was stored for anthropicUpstreamBaseUrl, codexUpstreamBaseUrl (value not logged).",
      },
    ]);
    expect(
      host.harness.inspection.logEntries.some((entry) =>
        entry.message.includes("evil.example"),
      ),
    ).toBe(false);
  });

  it("does not flag stored upstreams that equal the former defaults", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-config-defaults-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await host.bb.storage.kv.set("config", {
      ...DEFAULT_ACCOUNT_POOL_CONFIG,
      anthropicUpstreamBaseUrl: "https://api.anthropic.com",
      codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    });
    await testPlugin()(host.bb);
    await grantRoles(host);
    expect(
      host.harness.inspection.logEntries.filter((entry) =>
        entry.message.startsWith("Ignored removed config keys"),
      ),
    ).toEqual([
      {
        level: "warn",
        message:
          "Ignored removed config keys: anthropicUpstreamBaseUrl, codexUpstreamBaseUrl. Provider upstreams are fixed in code.",
      },
    ]);
  });

  it("reads and updates one full config record through RPC and CLI", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-config-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin()(host.bb);
    await grantRoles(host);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    expect(
      accountPoolConfigSchema.parse(
        await host.harness.behavior.callRpc("config.get", null),
      ),
    ).toEqual(accountPoolConfigSchema.parse({}));
    const cliGet = await host.harness.behavior.runCli(["config"]);
    expect(cliGet.exitCode).toBe(0);
    expect(cliGet.stdout).toBe("switchThreshold: 0.98\nparentMode: proxy\n");

    const cliSet = await host.harness.behavior.runCli([
      "config",
      "set",
      "switchThreshold",
      "0.75",
    ]);
    expect(cliSet.exitCode).toBe(0);
    expect(cliSet.stdout).toContain("switchThreshold: 0.75");
    const updated = accountPoolConfigSchema.parse(
      await host.harness.behavior.callRpc("config.set", {
        parentMode: "isolate",
      }),
    );
    expect(updated).toEqual({ switchThreshold: 0.75, parentMode: "isolate" });
    expect(
      accountPoolConfigSchema.parse(await host.bb.storage.kv.get("config")),
    ).toEqual(updated);
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "config-changed",
      payload: {},
    });
  });

  it.each(["anthropicUpstreamBaseUrl", "codexUpstreamBaseUrl"])(
    "refuses to set the removed %s key through RPC and CLI",
    async (key) => {
      const dataDir = await mkdtemp(
        path.join(tmpdir(), "bb-account-pool-config-refuse-"),
      );
      const host = createFakePluginHost({
        pluginId: "account-pool",
        dataDir,
        sdk: sdkStubs(),
      });
      await testPlugin()(host.bb);
      await grantRoles(host);
      cleanups.push(async () => {
        await host.harness.lifecycle.dispose();
        await fs.rm(dataDir, { recursive: true, force: true });
      });
      const before = await host.harness.behavior.callRpc("config.get", null);
      await expect(
        host.harness.behavior.callRpc("config.set", {
          [key]: "https://example.invalid",
        }),
      ).rejects.toThrow();
      const cli = await host.harness.behavior.runCli([
        "config",
        "set",
        key,
        "https://example.invalid",
      ]);
      expect(cli.exitCode).not.toBe(0);
      expect(cli.stderr).toContain(
        `${key} was removed: provider upstreams are fixed in code.`,
      );
      expect(await host.harness.behavior.callRpc("config.get", null)).toEqual(
        before,
      );
      expect(JSON.stringify(await host.bb.storage.kv.get("config") ?? {})).not.toContain(
        "example.invalid",
      );
    },
  );

  it.each(["claude", "codex"] as const)(
    "refuses to import a %s login through RPC",
    async (provider) => {
      const dataDir = await mkdtemp(
        path.join(tmpdir(), "bb-account-pool-no-import-"),
      );
      const host = createFakePluginHost({
        pluginId: "account-pool",
        dataDir,
        sdk: sdkStubs(),
      });
      await testPlugin()(host.bb);
      await grantRoles(host);
      cleanups.push(async () => {
        await host.harness.lifecycle.dispose();
        await fs.rm(dataDir, { recursive: true, force: true });
      });
      await expect(
        host.harness.behavior.callRpc("account.add", {
          provider,
          source: { kind: "import" },
          label: null,
          priority: 100,
        }),
      ).rejects.toThrow();
      expect(
        await host.harness.behavior.callRpc("account.list", null),
      ).toEqual([]);
    },
  );

  it.each([
    {
      name: "a Claude OAuth account",
      provider: "claude" as const,
      source: "oauth" as const,
      path: "/v1/messages",
      expected: "https://api.anthropic.com/v1/messages",
    },
    {
      name: "an Anthropic API key",
      provider: "claude" as const,
      source: "api-key" as const,
      path: "/v1/messages",
      expected: "https://api.anthropic.com/v1/messages",
    },
    {
      name: "a ChatGPT Codex account",
      provider: "codex" as const,
      source: "oauth" as const,
      path: "/v1/responses",
      expected: "https://chatgpt.com/backend-api/codex/responses",
    },
    {
      name: "an OpenAI API key",
      provider: "codex" as const,
      source: "api-key" as const,
      path: "/v1/responses",
      expected: "https://api.openai.com/v1/responses",
    },
  ])(
    "sends $name to the fixed upstream whatever the stored config says",
    async ({ provider, source, path: requestPath, expected }) => {
      const fetched: string[] = [];
      const fixture = await createFixture({
        upstreamUrl: null,
        storedConfig: {
          anthropicUpstreamBaseUrl: "https://evil.example",
          codexUpstreamBaseUrl: "https://evil.example/codex",
        },
        provider,
        source,
        options: {
          fetch: async (input) => {
            fetched.push(String(input instanceof Request ? input.url : input));
            return Response.json({});
          },
          codexUsageUrl: EMPTY_USAGE_URL,
          seedClaude: async () => claudeLoginSeed(),
          seedCodex: async () => ({
            accessToken: "codex-access",
            refreshToken: "codex-refresh",
            idToken: null,
            accountId: "chatgpt-account-1",
            email: "codex@example.com",
            expiresAt: Date.now() + 60 * 60 * 1_000,
          }),
        },
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        requestPath,
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await response.text();
      expect(fetched).toContain(expected);
      expect(fetched.join("\n")).not.toContain("evil.example");
    },
  );

  it("sends every request, refresh, usage poll and ping only to provider hosts", async () => {
    const PROVIDER_HOSTS = new Set([
      "api.anthropic.com",
      "platform.claude.com",
      "chatgpt.com",
      "auth.openai.com",
      "api.openai.com",
    ]);
    const fetched: URL[] = [];
    const codexToken = testJwt({ exp: Math.floor(Date.now() / 1_000) + 3600 });
    const fixture = await createFixture({
      upstreamUrl: null,
      provider: "claude",
      source: "oauth",
      options: {
        usageUrl: undefined,
        fetch: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          fetched.push(url);
          if (url.pathname.endsWith("/oauth/token"))
            return Response.json({
              access_token: url.host === "auth.openai.com" ? codexToken : "claude-new",
              refresh_token: "refresh-new",
              expires_in: 3600,
            });
          const authorization = new Headers(init?.headers).get("authorization");
          if (authorization === "Bearer claude-old" || authorization === "Bearer codex-old")
            return Response.json({ error: { message: "expired" } }, { status: 401 });
          return Response.json({});
        },
        seedClaude: async () => claudeLoginSeed({ accessToken: "claude-old" }),
        seedCodex: async () => ({
          accessToken: "codex-old",
          refreshToken: "codex-refresh",
          idToken: null,
          accountId: "chatgpt-account-1",
          email: "codex@example.com",
          expiresAt: Date.now() + 60 * 60 * 1_000,
        }),
      },
    });
    const codex = await addOAuthAccount(fixture.host, {
      provider: "codex",
      label: null,
      priority: 100,
    });
    const claudeKey = await addApiAccount(fixture, "sk-claude-key", 200);
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "api-key", apiKey: "sk-openai-key" },
      label: null,
      priority: 200,
    });
    for (const [route, key] of [
      ["/v1/messages", fixture.key],
      ["/v1/responses", (await resolveCodexToken(fixture.host)).token],
    ] as const) {
      const response = await fixture.host.harness.behavior.fetchHttp("POST", route, {
        headers: authHeaders(key),
        body: "{}",
      });
      await response.text();
    }
    for (const id of [fixture.account.id, claudeKey.id])
      await fixture.host.harness.behavior
        .callRpc("account.ping", { id, diagnostic: true })
        .catch(() => null);
    for (const id of [fixture.account.id, codex.id])
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", { accountId: id });
    const hosts = new Set(fetched.map((url) => url.host));
    expect([...hosts].filter((host) => !PROVIDER_HOSTS.has(host))).toEqual([]);
    const seen = fetched.map((url) => `${url.host}${url.pathname}`);
    expect(seen).toEqual(
      expect.arrayContaining([
        "api.anthropic.com/v1/messages",
        "platform.claude.com/v1/oauth/token",
        "api.anthropic.com/api/oauth/usage",
        "chatgpt.com/backend-api/codex/responses",
        "auth.openai.com/oauth/token",
        "chatgpt.com/backend-api/wham/usage",
      ]),
    );
  });

  it.each([
    {
      path: "images/generations",
      request: { prompt: "A fox astronaut", images: [] },
      result: { data: [{ b64_json: "generated-image" }] },
    },
    {
      path: "images/edits",
      request: { prompt: "A fox astronaut", images: [] },
      result: { data: [{ b64_json: "generated-image" }] },
    },
    {
      path: "alpha/search",
      request: {
        id: "search-1",
        model: "gpt-5.5",
        commands: { search_query: [{ q: "bb account pooler" }] },
      },
      result: { encrypted_output: "encrypted-search-output" },
    },
  ])(
    "routes native Codex $path with pool authentication",
    async ({ path, request, result }) => {
      const requests: Request[] = [];
      const fixture = await createOAuthRequestFixture(
        "codex",
        async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(result);
        },
        Date.now,
      );
      const route = `/v1/${path}`;
      const body = JSON.stringify(request);
      const denied = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        { body },
      );
      expect(denied.status).toBe(401);
      expect(requests).toHaveLength(0);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        {
          headers: {
            "content-type": "application/json",
            "x-bb-account-pool-token": fixture.key,
            authorization: "Bearer local-token",
          },
          body,
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(result);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe(`https://upstream.example/${path}`);
      expect(requests[0]?.headers.get("authorization")).toBe(
        "Bearer oauth-old",
      );
      expect(requests[0]?.headers.get("chatgpt-account-id")).toBe(
        "chatgpt-account",
      );
      expect(requests[0]?.headers.has("x-bb-account-pool-token")).toBe(false);
      expect(await requests[0]?.text()).toBe(body);
    },
  );

  it("refreshes and routes Codex HTTP sessions by provider", async () => {
    const seen: Array<{
      path: string;
      authorization: string | undefined;
      accountId: string | undefined;
      body: string;
    }> = [];
    const modelRequests: string[] = [];
    let responseNumber = 0;
    let planType: unknown = "pro";
    const futureToken = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1_000) + 3_600 })).toString("base64url")}.signature`;
    const upstream = await startUpstream(async (request, response) => {
      const body = (await readRequestBody(request)).toString("utf8");
      if (request.url === "/oauth") {
        const parsed = z
          .object({
            client_id: z.literal("app_EMoamEEZ73f0CkXaXp7hrann"),
            grant_type: z.literal("refresh_token"),
            refresh_token: z.string(),
          })
          .parse(JSON.parse(body));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: futureToken,
            refresh_token: `next-${parsed.refresh_token}`,
            id_token: "next-id-token",
          }),
        );
        return;
      }
      if (request.url === "/usage") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            plan_type: planType,
            rate_limit: {
              allowed: true,
              limit_reached: false,
              primary_window: {
                used_percent: 48,
                limit_window_seconds: 604_800,
                reset_after_seconds: 180_092,
                reset_at: 4_102_452_000,
              },
              secondary_window: null,
            },
          }),
        );
        return;
      }
      if (request.url === "/models") {
        modelRequests.push(
          request.headers["chatgpt-account-id"]?.toString() ?? "",
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"data":[]}');
        return;
      }
      responseNumber += 1;
      seen.push({
        path: request.url ?? "",
        authorization: request.headers.authorization,
        accountId: z
          .string()
          .optional()
          .parse(request.headers["chatgpt-account-id"]),
        body,
      });
      if (responseNumber === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "x-codex-primary-used-percent": "25",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-after-seconds": "3600",
          "x-codex-secondary-used-percent": "40",
          "x-codex-secondary-window-minutes": "10080",
          "x-codex-secondary-reset-after-seconds": "86400",
        });
        response.end('{"id":"http-response"}');
        return;
      }
      if (responseNumber === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "x-codex-secondary-used-percent": "100",
        });
        response.end('{"error":{"message":"quota exhausted"}}');
        return;
      }
      const id = `response-${responseNumber}`;
      response.writeHead(200, {
        "content-type": "text/event-stream",
      });
      response.end(
        `event: response.created\ndata: ${JSON.stringify({
          type: "response.created",
          response: { id },
        })}\n\nevent: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id,
            output: [{ type: "message", id: `message-${responseNumber}` }],
          },
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    cleanups.push(upstream.close);
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-codex-"),
    );
    let imported = 0;
    const seedCodex =
      async (): Promise<CodexLoginSeed> => {
        imported += 1;
        return {
          accessToken: "expired-token",
          refreshToken: `refresh-${imported}`,
          idToken: "id-token",
          accountId: `chatgpt-account-${imported}`,
          email: `codex-${imported}@example.com`,
          expiresAt: Date.now() - 1,
        };
      };
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin({
      upstreams: upstreamsAt(upstream.url),
      codexRefreshUrl: `${upstream.url}/oauth`,
      codexUsageUrl: `${upstream.url}/usage`,
      seedCodex,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    await grantRoles(host);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "claude-key" },
      label: "Claude first",
      priority: 0,
    });
    const importByCli = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--import",
    ]);
    expect(importByCli.exitCode).toBe(1);
    expect(importByCli.stderr).toContain("unknown option '--import'");
    await addOAuthAccount(host, {
      provider: "codex",
      label: null,
      priority: 100,
    });
    await addOAuthAccount(host, {
      provider: "codex",
      label: null,
      priority: 100,
    });
    const accountTable = await host.harness.behavior.runCli([
      "account",
      "list",
    ]);
    expect(accountTable.stdout).toContain("Provider");
    expect(accountTable.stdout).toContain("codex");
    expect(accountTable.stdout).toContain("7d=48% 2100-01-01T02:00:00.000Z");
    expect(accountTable.stdout).not.toContain("5h=");
    const codexAccount = statusSchema
      .parse(await host.harness.behavior.callRpc("status.get", null))
      .accounts.find((account) => account.provider === "codex")!;
    expect(codexAccount.subscriptionType).toBe("pro");
    for (const [reportedPlan, expectedPlan] of [
      ["pro", "pro"],
      ["plus", "plus"],
      [undefined, "plus"],
      [null, "plus"],
      [123, "plus"],
      ["", "plus"],
    ]) {
      planType = reportedPlan;
      expect(
        await host.harness.behavior.callRpc("provider-usage.v1.getResource", {
          resourceId: codexAccount.id,
          refresh: true,
        }),
      ).toMatchObject({
        usage: {
          status: "ok",
          plan: { id: expectedPlan, multiplier: null },
          planLabel: expectedPlan === "pro" ? "Pro" : "Plus",
          windows: [expect.objectContaining({ usedPercent: 48 })],
        },
      });
    }

    const routed = await resolveCodexToken(host);
    expect(routed.baseUrl).toBe("/api/v1/plugins/account-pool-prewarm/http/v1");
    await expect(
      host.harness.behavior.resolveProviderEnvHealth("codex", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by the Account Pooler hub.",
    });
    const httpResponse = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          authorization: "Bearer local-codex-token",
          "x-bb-account-pool-token": routed.token,
          "content-type": "application/json",
          "openai-beta": "responses=experimental",
        },
        body: JSON.stringify({ model: "gpt-5", input: [], stream: true }),
      },
    );
    expect(httpResponse.status).toBe(200);
    expect(await httpResponse.json()).toEqual({ id: "http-response" });
    const modelsResponse = await host.harness.behavior.fetchHttp(
      "GET",
      "/v1/models",
      {
        headers: { "x-bb-account-pool-token": routed.token },
      },
    );
    expect(await modelsResponse.json()).toEqual({ data: [] });
    expect(modelRequests).toHaveLength(1);
    expect(modelRequests[0]).toMatch(/^chatgpt-account-[12]$/u);
    expect(seen[0]).toMatchObject({
      path: "/responses",
      authorization: `Bearer ${futureToken}`,
      accountId: "chatgpt-account-1",
    });
    const postResponses = (input: unknown[]) =>
      host.harness.behavior.fetchHttp("POST", "/v1/responses", {
        headers: {
          authorization: "Bearer local-codex-token",
          "x-bb-account-pool-token": routed.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input, stream: true }),
      });
    const first = await postResponses([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
    ]);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('"type":"response.completed"');
    const second = await postResponses([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
      { type: "message", id: "message-3" },
      { type: "message", id: "delta-two" },
    ]);
    expect(second.status).toBe(200);
    await second.text();
    expect(seen[1]?.accountId).not.toBe(seen[2]?.accountId);
    expect(seen[2]?.accountId).toBe(seen[3]?.accountId);
    expect(JSON.parse(seen[3]?.body ?? "{}").input).toEqual([
      { type: "message", id: "prefix" },
      { type: "message", id: "delta-one" },
      { type: "message", id: "message-3" },
      { type: "message", id: "delta-two" },
    ]);
    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    const firstCodex = status.accounts.find(
      (account) => account.codexAccountId === "chatgpt-account-1",
    );
    expect(seen[1]?.accountId).toBe("chatgpt-account-1");
    expect(firstCodex).toMatchObject({
      provider: "codex",
      status: "exhausted",
      fiveHourUtilization: null,
      sevenDayUtilization: null,
      familyWeekly: { other: null },
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 300,
          utilization: 0.25,
          status: null,
          source: "header",
        },
        {
          slot: "secondary",
          windowMinutes: 10_080,
          utilization: 1,
          status: "rejected",
          source: "header",
        },
      ],
    });
    expect(
      status.accounts.find(
        (account) => account.codexAccountId === seen[2]?.accountId,
      ),
    ).toMatchObject({
      provider: "codex",
      status: "ready",
      limitWindows: [
        {
          slot: "primary",
          windowMinutes: 10_080,
          utilization: 0.48,
          status: "allowed",
          source: "usage",
        },
      ],
    });
    const secondCodex = status.accounts.find(
      (account) =>
        account.provider === "codex" && account.id !== firstCodex?.id,
    );
    if (secondCodex === undefined) throw new Error("Missing second account.");
    await host.harness.behavior.callRpc("account.disable", {
      id: secondCodex.id,
    });
    const blocked = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: { "x-bb-account-pool-token": routed.token },
        body: JSON.stringify({ model: "gpt-5", input: [], stream: true }),
      },
    );
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(80_000);
    const secret = accountSecretSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            dataDir,
            "plugins",
            "account-pool",
            "secrets",
            "accounts",
            `account-${firstCodex?.id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    expect(secret).toMatchObject({
      accessToken: futureToken,
      refreshToken: "next-refresh-1",
      idToken: "next-id-token",
    });
  });

  it("cancels a Codex upstream read when the HTTP client aborts", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-codex-cancel-"),
    );
    let upstreamReadCanceled = false;
    const upstreamFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (String(input) === CODEX_USAGE_STUB_URL) return Response.json({});
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        throw new Error("Expected the upstream request to carry a signal.");
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"streaming"}}\n\n',
            ),
          );
          signal.addEventListener(
            "abort",
            () => {
              upstreamReadCanceled = true;
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin({
      upstreams: { chatgptCodex: "https://example.com" },
      fetch: upstreamFetch,
      codexUsageUrl: CODEX_USAGE_STUB_URL,
      seedCodex: async () => ({
        accessToken: "access",
        refreshToken: "refresh",
        idToken: null,
        accountId: "account",
        email: null,
        expiresAt: null,
      }),
    })(host.bb);
    await grantRoles(host);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    await addOAuthAccount(host, {
      provider: "codex",
      label: null,
      priority: 100,
    });
    const { token } = await resolveCodexToken(host);
    const client = new AbortController();
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/responses",
      {
        headers: {
          "x-bb-account-pool-token": token,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "gpt-5", input: [], stream: true }),
        signal: client.signal,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("response.created");
    client.abort(new Error("interrupted"));
    await reader.cancel().catch(() => undefined);
    await vi.waitFor(async () => {
      expect(upstreamReadCanceled).toBe(true);
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).inFlight,
      ).toBe(0);
    });
  });

  it("prunes token files for unenrolled hosts on startup and status", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-prune-"));
    const secretDir = path.join(
      dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
    );
    const seededTokens = new HubTokenStore(secretDir, Date.now, () => true);
    await seededTokens.initialize();
    await seededTokens.forHost("host-gone");
    const goneTokenFile = path.join(secretDir, "hub-token-host-gone.json");
    await expect(fs.access(goneTokenFile)).resolves.toBeUndefined();
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin()(host.bb);
    await grantRoles(host);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    await expect(fs.access(goneTokenFile)).rejects.toThrow();
    await grantRoles(host);
    await host.harness.behavior.callRpc("account.add", {
      provider: "claude",
      source: { kind: "api-key", apiKey: "sk-account" },
      label: null,
      priority: 100,
    });
    await resolveToken(host, "host-two", "thread-two");
    const hostTwoTokenFile = path.join(secretDir, "hub-token-host-two.json");
    await expect(fs.access(hostTwoTokenFile)).resolves.toBeUndefined();
    host.harness.sdk.stub("hosts.list", async () => [
      { id: "host-one", name: "One" },
    ]);
    const status = statusSchema.parse(
      await host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.hosts).toEqual([]);
    await expect(fs.access(hostTwoTokenFile)).rejects.toThrow();
  });

  it("uses a single-process token cache and throttles last-use file writes", async () => {
    let now = 1_000;
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-tokens-"));
    cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
    const tokens = new HubTokenStore(dataDir, () => now, () => true);
    await tokens.initialize();
    const token = await tokens.forHost("host-one");
    const tokenFile = path.join(dataDir, "hub-token-host-one.json");
    await fs.writeFile(
      tokenFile,
      `${JSON.stringify({
        hostId: "host-one",
        value: "A".repeat(43),
        mintedAt: now,
        lastUsedAt: null,
        previous: [],
      })}\n`,
    );
    const writeFile = vi.spyOn(fs, "writeFile");
    try {
      expect(await tokens.authenticate(token)).toBe("host-one");
      now += 30_000;
      expect(await tokens.authenticate(token)).toBe("host-one");
      expect(await tokens.authenticate("A".repeat(43))).toBeNull();
      expect(writeFile).toHaveBeenCalledTimes(1);
      now += 30_000;
      expect(await tokens.authenticate(token)).toBe("host-one");
      expect(writeFile).toHaveBeenCalledTimes(2);
    } finally {
      writeFile.mockRestore();
    }
  });

  it("forwards the next request after adding the first account through the CLI", async () => {
    let forwarded = 0;
    const upstream = await startUpstream(async (request, response) => {
      forwarded += 1;
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"forwarded":true}');
    });
    cleanups.push(upstream.close);
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-empty-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin({ upstreams: { anthropic: upstream.url } })(host.bb);
    await grantRoles(host);
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const statusResult = await host.harness.behavior.runCli([
      "status",
      "--json",
    ]);
    const status = statusReportSchema.parse(JSON.parse(statusResult.stdout));
    expect(status.accepting).toBe(true);
    expect(status.hosts).toEqual([]);
    expect(
      await host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-empty",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).toEqual([]);
    await expect(
      host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    expect(host.harness.inspection.needsConfigurationMessages).toEqual([
      "Add and enable a Claude or Codex account with `bb pool account add`.",
    ]);
    const hello = helloResponse();
    expect(hello.status).toBe(200);
    const added = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--api-key",
      "sk-cli-secret",
      "--label",
      "CLI account",
      "--priority",
      "7",
    ]);
    expect(added.exitCode).toBe(0);
    expect(added.stdout).not.toContain("sk-cli-secret");
    expect(added.stdout).not.toContain("reload");
    const key = await resolveToken(host, "host-one", "thread-empty");
    const forwardedResponse = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(key), body: "{}" },
    );
    expect(forwardedResponse.status).toBe(200);
    expect(await forwardedResponse.text()).toBe('{"forwarded":true}');
    expect(forwarded).toBe(1);
  });

  it("exposes every account CLI operation", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const help = await fixture.host.harness.behavior.runCli([
      "account",
      "add",
      "--help",
    ]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--login");
    expect(help.stdout).toContain("account login-complete");
    expect(help.stdout).toContain("--api-key-stdin");
    expect(help.stdout).toContain("Unsafe: exposes the key");
    const loginCompleteHelp = await fixture.host.harness.behavior.runCli([
      "account",
      "login-complete",
      "--help",
    ]);
    expect(loginCompleteHelp.exitCode).toBe(0);
    expect(loginCompleteHelp.stdout).toContain("--code-stdin");
    const topLevelHelp = await fixture.host.harness.behavior.runCli(["--help"]);
    expect(topLevelHelp.exitCode).toBe(0);
    expect(topLevelHelp.stdout).toContain("bb pool account refresh");
    expect(topLevelHelp.stdout).toContain("bb pool account login-poll");
    const refreshHelp = await fixture.host.harness.behavior.runCli([
      "account",
      "refresh",
      "--help",
    ]);
    expect(refreshHelp.exitCode).toBe(0);
    expect(refreshHelp.stdout).toContain("bb pool account refresh <id>");
    const list = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
      "--json",
    ]);
    const listed = z
      .object({ accounts: z.array(accountSummarySchema) })
      .strict()
      .parse(JSON.parse(list.stdout));
    const account = listed.accounts[0];
    if (account === undefined) throw new Error("CLI account was not listed.");
    expect(account).toMatchObject({ label: "Claude API key", priority: 100 });
    expect(
      await fixture.host.harness.behavior.runCli([
        "account",
        "refresh",
        account.id,
      ]),
    ).toMatchObject({ exitCode: 0 });
    const refreshedAsJson = await fixture.host.harness.behavior.runCli([
      "account",
      "refresh",
      account.id,
      "--json",
    ]);
    expect(refreshedAsJson.exitCode).toBe(0);
    expect(JSON.parse(refreshedAsJson.stdout)).toMatchObject({
      ok: true,
      account: { id: account.id },
    });
    const configAsJson = await fixture.host.harness.behavior.runCli([
      "config",
      "--json",
    ]);
    expect(configAsJson.exitCode).toBe(0);
    expect(JSON.parse(configAsJson.stdout)).toMatchObject({
      ok: true,
      config: { switchThreshold: expect.any(Number) },
    });
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "disable",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0]?.status,
    ).toBe("ready");
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "enable",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    const publicStatus = statusReportSchema.parse(
      JSON.parse(
        (await fixture.host.harness.behavior.runCli(["status", "--json"]))
          .stdout,
      ),
    );
    expect(publicStatus.accepting).toBe(true);
    expect(publicStatus.hosts).toEqual([
      expect.objectContaining({ hostId: "host-one", hostName: "One" }),
    ]);
    expect(publicStatus).not.toHaveProperty("hubKey");
    expect(JSON.stringify(publicStatus)).not.toContain(fixture.key);
    const counted = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages/count_tokens",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(counted.status).toBe(200);
    expect(await counted.text()).toBe("{}");
    expect(
      (
        await fixture.host.harness.behavior.runCli([
          "account",
          "remove",
          account.id,
        ])
      ).exitCode,
    ).toBe(0);
    expect(
      await fixture.host.harness.behavior.callRpc("account.list", null),
    ).toEqual([]);
  });

  describe("Claude access observations", () => {
    it("leaves Codex verification-shaped HTTP400 responses unchanged", async () => {
      const payload = {
        error: {
          type: "invalid_request_error",
          message: "Identity verification is required to continue.",
        },
      };
      const fixture = await createOAuthRequestFixture(
        "codex",
        async () => Response.json(payload, { status: 400 }),
        () => 1800000000000,
      );
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(payload);
      expect(
        new QuotaStore(fixture.host.bb.storage.database()).get(
          fixture.account.id,
        ).accessBlocked,
      ).toBeNull();
    });

    describe.each(["ordinary", "diagnostic"] as const)(
      "verification errors through %s",
      (path) => {
        it.each([
          {
            type: "invalid_request_error",
            message: "Identity verification is required to continue.",
            blocked: true,
          },
          {
            type: "permission_error",
            message: "Identity verification is required to continue.",
            blocked: false,
          },
          {
            type: "invalid_request_error",
            message: "Another request error",
            blocked: false,
          },
          {
            type: "invalid_request_error",
            message: "Identity\tverification is required to continue.",
            blocked: false,
          },
        ])(
          "classifies exact provider error $type / $message",
          async ({ type, message, blocked }) => {
            let status = 400;
            const raw = JSON.stringify({ error: { type, message } });
            const upstream = await startUpstream((_request, response) => {
              response.writeHead(status, {
                "content-type": "application/json",
                "x-test-detail": "preserved",
              });
              response.end(status === 400 ? raw : "{}");
            });
            const fixture = await createFixture({ upstreamUrl: upstream.url });
            const id = fixture.account.id;
            if (path === "diagnostic")
              await fixture.host.harness.behavior.callRpc("account.disable", {
                id,
              });
            if (path === "diagnostic") {
              const result = await fixture.host.harness.behavior.callRpc(
                "account.ping",
                { id, diagnostic: true },
              );
              expect(result).toMatchObject({ status: 400, ok: false });
            } else {
              const response = await fixture.host.harness.behavior.fetchHttp(
                "POST",
                "/v1/messages",
                { headers: authHeaders(fixture.key), body: "{}" },
              );
              expect(response.status).toBe(400);
              const body = await response.text();
              if (!blocked) {
                expect(body).toBe(raw);
                expect(response.headers.get("x-test-detail")).toBe("preserved");
              }
            }
            const quotas = new QuotaStore(fixture.host.bb.storage.database());
            const block = quotas.get(id).accessBlocked;
            expect(block).toEqual(
              blocked
                ? { status: 400, type, message, observedAt: expect.any(Number) }
                : null,
            );
            const list = async () =>
              usageResourceListSchema.parse(
                await fixture.host.harness.behavior.callRpc(
                  usageListMethod,
                  {},
                ),
              );
            expect((await list()).resources.some((a) => a.id === id)).toBe(
              path === "ordinary",
            );
            if (!blocked) return;
            const account = (
              (await fixture.host.harness.behavior.callRpc(
                "account.list",
                null,
              )) as AccountSummary[]
            ).find((a) => a.id === id);
            expect(account?.status).toBe("verification-required");
            if (path === "diagnostic") {
              await expect(fixture.host.harness.behavior.callRpc(usageFetchMethod, {
                resourceId: id, refresh: false,
              })).rejects.toThrow("no longer exists");
            } else {
              expect(await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
                resourceId: id, refresh: false,
              })).toMatchObject({usage:{status:"error",message:"Requires verification (400)"}});
            }
            status = 200;
            await fixture.host.harness.behavior.callRpc("account.disable", {
              id,
            });
            expect(
              await fixture.host.harness.behavior.callRpc("account.ping", {
                id,
                diagnostic: true,
              }),
            ).toMatchObject({ ok: true });
            expect(quotas.get(id).accessBlocked).toBeNull();
            expect((await list()).resources.some((a) => a.id === id)).toBe(false);
            expect(
              (
                (await fixture.host.harness.behavior.callRpc(
                  "account.list",
                  null,
                )) as AccountSummary[]
              ).find((a) => a.id === id)?.enabled,
            ).toBe(false);
          },
        );
      },
    );

    it("fails over after confirmed verification while preserving generic 400 streaming bodies", async () => {
      const calls: string[] = [];
      const raw = JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: "Identity verification is required to continue.",
        },
      });
      const upstream = await startUpstream((request, response) => {
        const key = String(request.headers["x-api-key"]);
        calls.push(key);
        response.writeHead(key === "sk-account" ? 400 : 200);
        response.end(key === "sk-account" ? raw : "success");
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      await addApiAccount(fixture, "sk-second", 101);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("success");
      expect(calls).toEqual(["sk-account", "sk-second"]);
      expect(
        new QuotaStore(fixture.host.bb.storage.database()).get(
          fixture.account.id,
        ).accessBlocked?.status,
      ).toBe(400);
    });

    it.each(["malformed", "oversized", "slow"])(
      "passes through %s 400 bodies intact without access classification",
      async (mode) => {
        const raw =
          mode === "malformed"
            ? "<html>bad request</html>"
            : JSON.stringify({
                error: {
                  type: "invalid_request_error",
                  message: "x".repeat(2048),
                },
              });
        const upstream = await startUpstream(async (_request, response) => {
          response.writeHead(400, { "content-type": "application/json" });
          response.write(raw.slice(0, 8));
          if (mode === "slow")
            await new Promise((resolve) => setTimeout(resolve, 400));
          response.end(raw.slice(8));
        });
        const fixture = await createFixture({ upstreamUrl: upstream.url });
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toBe(raw);
        expect(
          new QuotaStore(fixture.host.bb.storage.database()).get(
            fixture.account.id,
          ).accessBlocked,
        ).toBeNull();
      },
    );

    it("retains a block across a successful OAuth usage reset and refreshed credentials", async () => {
      let now = 1800000000000;
      let usageCalls = 0;
      let refreshCalls = 0;
      let inferenceCalls = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://synthetic.example",
        source: "oauth",
        options: {
          now: () => now,
          usageUrl: "https://synthetic.example/usage",
          refreshUrl: "https://synthetic.example/oauth/token",
          seedClaude: async () =>
            claudeLoginSeed({ expiresAt: now - 1 }),
          fetch: async (input) => {
            const url = String(input);
            if (url.endsWith("/oauth/token")) {
              refreshCalls++;
              return Response.json({
                access_token: "synthetic-refreshed",
                expires_in: 3600,
              });
            }
            if (url.endsWith("/usage")) {
              usageCalls++;
              return Response.json({
                five_hour: {
                  utilization: usageCalls === 1 ? 100 : 0,
                  resets_at: new Date(now + 3600000).toISOString(),
                },
              });
            }
            inferenceCalls++;
            return Response.json(
              { error: { type: "permission_error", message: "Access denied" } },
              { status: 403 },
            );
          },
        },
      });
      const id = fixture.account.id;
      await fixture.host.harness.behavior.callRpc("account.ping", {
        id,
        diagnostic: true,
      });
      const quotas = new QuotaStore(fixture.host.bb.storage.database());
      const block = quotas.get(id).accessBlocked;
      expect(block).toMatchObject({ status: 403 });
      expect(refreshCalls).toBe(1);
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: id,
      });
      const previousUsageCalls = usageCalls;
      now += 60000;
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: id,
      });
      expect(usageCalls).toBeGreaterThan(previousUsageCalls);
      expect(quotas.get(id)).toMatchObject({
        accessBlocked: block,
        fiveHourUtilization: 0,
        observedAt: now,
      });
      expect(inferenceCalls).toBe(1);
    });

    it.each([403, 429])(
      "persists only HTTP %s access failures and removes stale compact resources",
      async (status) => {
        let calls = 0;
        const upstream = await startUpstream((_request, response) => {
          calls++;
          response.writeHead(status);
          response.end(
            JSON.stringify({
              error: {
                type: "permission_error",
                message: "blocked sk-account Bearer private-token",
              },
            }),
          );
        });
        const fixture = await createFixture({ upstreamUrl: upstream.url });
        const id = fixture.account.id;
        const list = async () =>
          usageResourceListSchema.parse(
            await fixture.host.harness.behavior.callRpc(usageListMethod, {}),
          );
        expect((await list()).resources.map((a) => a.id)).toContain(id);
        await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
          resourceId: id,
          refresh: false,
        });
        await fixture.host.harness.behavior.callRpc("account.ping", { id });
        const quotas = new QuotaStore(fixture.host.bb.storage.database());
        if (status === 429) {
          expect(quotas.get(id).accessBlocked).toBeNull();
          expect((await list()).resources.map((a) => a.id)).toContain(id);
          return;
        }
        const block = quotas.get(id).accessBlocked;
        expect(block).toMatchObject({
          status: 403,
          type: "permission_error",
          message: "blocked [REDACTED] Bearer [REDACTED]",
          observedAt: expect.any(Number),
        });
        await fixture.host.harness.behavior.callRpc("account.disable", { id });
        await fixture.host.harness.behavior.callRpc("account.enable", { id });
        await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
          accountId: id,
        });
        quotas.put({ ...quotas.get(id), accessBlocked: null });
        expect(quotas.get(id).accessBlocked).toEqual(block);
        fixture.service.controller.abort();
        await fixture.service.done;
        const restarted = fixture.host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          restarted.controller.abort();
          await restarted.done;
        });
        await vi.waitFor(async () =>
          expect(
            statusSchema.parse(
              await fixture.host.harness.behavior.callRpc("status.get", null),
            ).accepting,
          ).toBe(true),
        );
        expect(
          new QuotaStore(fixture.host.bb.storage.database()).get(id)
            .accessBlocked,
        ).toEqual(block);
        expect((await list()).resources.map(a=>a.id)).toContain(id);
        expect(await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
          resourceId: id, refresh: false,
        })).toMatchObject({usage:{status:"error",message:"Access blocked (403)"}});
        await fixture.host.harness.behavior.callRpc("account.disable", {id});
        expect((await list()).resources).toEqual([]);
        await expect(fixture.host.harness.behavior.callRpc(usageFetchMethod, {
          resourceId: id, refresh: false,
        })).rejects.toThrow("no longer exists");
        await fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        });
        expect(calls).toBe(1);
      },
    );

    it.each([403, 429, 200])(
      "diagnoses a disabled exhausted target exactly once with HTTP %s without routing changes",
      async (status) => {
        const calls: string[] = [];
        const upstream = await startUpstream((request, response) => {
          calls.push(String(request.headers["x-api-key"]));
          response.writeHead(status);
          response.end("<html>private raw body</html>");
        });
        const fixture = await createFixture({ upstreamUrl: upstream.url });
        await addApiAccount(fixture, "sk-other", 0);
        const id = fixture.account.id;
        await fixture.host.harness.behavior.callRpc("account.disable", { id });
        const quotas = new QuotaStore(fixture.host.bb.storage.database());
        quotas.put({
          ...quotas.get(id),
          fiveHourUtilization: 1,
          fiveHourResetAt: Date.now() + 3600000,
          accessBlocked: null,
        });
        quotas.setAccessBlocked(id, {
          status: 403,
          type: null,
          message: null,
          observedAt: 1,
        });
        const affinity = new PoolAffinityStore(
          fixture.host.bb.storage.database(),
        );
        const before = {
          active: affinity.loadActiveAccounts(),
          bindings: affinity.loadBindings(0, 4096),
        };
        const result = await fixture.host.harness.behavior.runCli([
          "ping",
          id,
          "--diagnostic",
          "--json",
        ]);
        expect(JSON.parse(result.stdout)).toMatchObject({
          accountId: id,
          status,
          ok: status === 200,
        });
        expect(result.stdout).not.toContain("private raw body");
        expect(calls).toEqual(["sk-account"]);
        expect(
          (
            (await fixture.host.harness.behavior.callRpc(
              "account.list",
              null,
            )) as AccountSummary[]
          ).find((a) => a.id === id)?.enabled,
        ).toBe(false);
        expect({
          active: affinity.loadActiveAccounts(),
          bindings: affinity.loadBindings(0, 4096),
        }).toEqual(before);
        expect(quotas.get(id).accessBlocked).toEqual(
          status === 200
            ? null
            : {
                status: 403,
                type: null,
                message: null,
                observedAt: status === 403 ? expect.any(Number) : 1,
              },
        );
        const listed = usageResourceListSchema.parse(
          await fixture.host.harness.behavior.callRpc(usageListMethod, {}),
        );
        expect(listed.resources.some((a) => a.id === id)).toBe(false);
      },
    );

    it("accepts a typed diagnostic RPC flag and rejects non-boolean input", async () => {
      let calls = 0;
      const upstream = await startUpstream((_request, response) => {
        calls++;
        response.end("{}");
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      const id = fixture.account.id;
      await fixture.host.harness.behavior.callRpc("account.disable", { id });
      await expect(
        fixture.host.harness.behavior.callRpc("account.ping", {
          id,
          diagnostic: "true",
        }),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(
        await fixture.host.harness.behavior.callRpc("account.ping", {
          id,
          diagnostic: true,
        }),
      ).toMatchObject({ ok: true });
      expect(calls).toBe(1);
    });
  });

  describe("targeted account ping", () => {
    it("pings only the specified account via CLI and RPC without moving routing state", async () => {
      const calls: { key: string | undefined; body: unknown }[] = [];
      const upstream = await startUpstream(async (request, response) => {
        calls.push({
          key: request.headers["x-api-key"] as string | undefined,
          body: JSON.parse((await readRequestBody(request)).toString()),
        });
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            content: [{ type: "text", text: "secret upstream content" }],
          }),
        );
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      const second = accountSchema.parse(
        await fixture.host.harness.behavior.callRpc("account.add", {
          provider: "claude",
          source: { kind: "api-key", apiKey: "sk-second" },
          label: "C2",
          priority: 100,
        }),
      );
      const ordinary = async () => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: JSON.stringify({
              model: "claude-haiku-4-5-20251001",
              messages: [{ role: "user", content: "hi" }],
              metadata: { user_id: "session-test" },
            }),
          },
        );
        expect(response.status).toBe(200);
        await response.text();
      };
      await ordinary();
      const affinity = new PoolAffinityStore(
        fixture.host.bb.storage.database(),
      );
      const before = {
        active: affinity.loadActiveAccounts(),
        bindings: affinity.loadBindings(0, 4096),
      };
      const otherBefore = new QuotaStore(
        fixture.host.bb.storage.database(),
      ).get(fixture.account.id);
      const cli = await fixture.host.harness.behavior.runCli([
        "ping",
        second.id,
        "--json",
      ]);
      expect(cli.exitCode).toBe(0);
      expect(JSON.parse(cli.stdout)).toEqual({
        accountId: second.id,
        model: "claude-haiku-4-5-20251001",
        status: 200,
        ok: true,
      });
      expect(cli.stdout).not.toContain("secret upstream content");
      expect(calls[1]).toEqual({
        key: "sk-second",
        body: {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          stream: false,
          messages: [{ role: "user", content: "Hi" }],
        },
      });
      expect(
        await fixture.host.harness.behavior.callRpc("account.ping", {
          id: second.id,
        }),
      ).toEqual({
        accountId: second.id,
        model: "claude-haiku-4-5-20251001",
        status: 200,
        ok: true,
      });
      expect({
        active: affinity.loadActiveAccounts(),
        bindings: affinity.loadBindings(0, 4096),
      }).toEqual(before);
      expect(
        new QuotaStore(fixture.host.bb.storage.database()).get(
          fixture.account.id,
        ),
      ).toEqual(otherBefore);
      await ordinary();
      expect(calls.map((c) => c.key)).toEqual([
        "sk-account",
        "sk-second",
        "sk-second",
        "sk-account",
      ]);
    });

    it("returns only sanitized structured upstream errors in JSON", async () => {
      const upstream = await startUpstream((_request, response) => {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "rate_limit_error",
              message: "Unavailable sk-account",
            },
            credential: "sk-account",
          }),
        );
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      const ping = await fixture.host.harness.behavior.runCli([
        "ping",
        fixture.account.id,
        "--json",
      ]);
      expect(ping.exitCode).toBe(1);
      expect(JSON.parse(ping.stdout)).toMatchObject({
        status: 429,
        ok: false,
        error: { type: "rate_limit_error", message: "Unavailable [REDACTED]" },
      });
      expect(ping.stdout).not.toContain("sk-account");
      expect(ping.stdout).not.toContain("credential");
    });

    it.each([
      "not JSON",
      JSON.stringify({ error: { message: "incomplete" } }),
      JSON.stringify({
        error: { type: "api_error", message: "x".repeat(2048) },
      }),
    ])("omits unreadable or oversized error bodies: %s", async (body) => {
      const upstream = await startUpstream((_request, response) => {
        response.writeHead(500);
        response.end(body);
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      const ping = await fixture.host.harness.behavior.runCli([
        "ping",
        fixture.account.id,
        "--json",
      ]);
      expect(ping.exitCode).toBe(1);
      expect(JSON.parse(ping.stdout)).not.toHaveProperty("error");
    });

    it("redacts OAuth credentials and bearer values in both error fields", async () => {
      const upstream = await startUpstream((_request, response) => {
        response.writeHead(403);
        response.end(
          JSON.stringify({
            error: {
              type: "oauth-test-access",
              message: "oauth-test-refresh Bearer unrelated-value sk-other-key",
            },
          }),
        );
      });
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        source: "oauth",
        options: {
          seedClaude: async () =>
            claudeLoginSeed({
              accessToken: "oauth-test-access",
              refreshToken: "oauth-test-refresh",
            }),
        },
      });
      const ping = await fixture.host.harness.behavior.runCli([
        "ping",
        fixture.account.id,
        "--json",
      ]);
      expect(JSON.parse(ping.stdout).error).toEqual({
        type: "[REDACTED]",
        message: "[REDACTED] Bearer [REDACTED] [REDACTED]",
      });
    });

    it("bounds complete structured errors without damaging ordinary words", async () => {
      const message = "risk-based task-force " + "x".repeat(600);
      const upstream = await startUpstream((_request, response) => {
        response.writeHead(400);
        response.end(
          JSON.stringify({ error: { type: "invalid_request_error", message } }),
        );
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      const ping = await fixture.host.harness.behavior.runCli([
        "ping",
        fixture.account.id,
        "--json",
      ]);
      expect(JSON.parse(ping.stdout).error).toEqual({
        type: "invalid_request_error",
        message: message.slice(0, 512),
      });
    });

    it.each([401])(
      "keeps ordinary routing available after a ping HTTP %s rejection",
      async (rejection) => {
        let calls = 0;
        const upstream = await startUpstream((_request, response) => {
          response.writeHead(calls++ === 0 ? rejection : 200);
          response.end("{}");
        });
        const fixture = await createFixture({ upstreamUrl: upstream.url });
        const ping = await fixture.host.harness.behavior.runCli([
          "ping",
          fixture.account.id,
          "--json",
        ]);
        expect(ping.exitCode).toBe(1);
        expect(
          new QuotaStore(fixture.host.bb.storage.database()).get(
            fixture.account.id,
          ).error,
        ).toBeNull();
        const ordinary = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        expect(ordinary.status).toBe(200);
        await ordinary.text();
        expect(calls).toBe(2);
      },
    );

    it("uses the target OAuth credential and beta header", async () => {
      let imported = 0;
      const calls: {
        authorization: string | undefined;
        beta: string | string[] | undefined;
      }[] = [];
      const upstream = await startUpstream((request, response) => {
        calls.push({
          authorization: request.headers.authorization,
          beta: request.headers["anthropic-beta"],
        });
        response.end("{}");
      });
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        source: "oauth",
        options: {
          seedClaude: async () =>
            claudeLoginSeed({
              accessToken: `oauth-${++imported}`,
              accountUuid:
                imported === 1
                  ? "11111111-1111-4111-8111-111111111111"
                  : "22222222-2222-4222-8222-222222222222",
            }),
        },
      });
      const second = accountSchema.parse(
        await addOAuthAccount(fixture.host, {
          provider: "claude",
          label: "C2",
          priority: 100,
        }),
      );
      const result = await fixture.host.harness.behavior.runCli([
        "ping",
        second.id,
        "--json",
      ]);
      expect(result.exitCode).toBe(0);
      expect(calls).toEqual([
        { authorization: "Bearer oauth-2", beta: "oauth-2025-04-20" },
      ]);
    });

    it.each([429, 500, 503])(
      "does not fail over or repeat an HTTP %s ping",
      async (status) => {
        let calls = 0;
        const upstream = await startUpstream((_request, response) => {
          calls++;
          response.writeHead(status);
          response.end("upstream detail");
        });
        const fixture = await createFixture({ upstreamUrl: upstream.url });
        await fixture.host.harness.behavior.callRpc("account.add", {
          provider: "claude",
          source: { kind: "api-key", apiKey: "sk-fallback" },
          label: "C2",
          priority: 100,
        });
        const result = await fixture.host.harness.behavior.runCli([
          "ping",
          fixture.account.id,
          "--json",
        ]);
        expect(result.exitCode).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, status });
        expect(result.stdout).not.toContain("upstream detail");
        expect(calls).toBe(1);
        expect(
          statusSchema.parse(
            await fixture.host.harness.behavior.callRpc("status.get", null),
          ).inFlight,
        ).toBe(0);
      },
    );

    it.each([
      "disabled",
      "unknown",
      "codex",
      "quota",
      "hold",
      "error",
      "family",
    ])("rejects %s targets without inference", async (state) => {
      let calls = 0;
      const upstream = await startUpstream((_request, response) => {
        calls++;
        response.end("{}");
      });
      const fixture = await createFixture({ upstreamUrl: upstream.url });
      let id = fixture.account.id;
      if (state === "disabled")
        await fixture.host.harness.behavior.callRpc("account.disable", { id });
      if (state === "unknown") id = "11111111-1111-4111-8111-111111111111";
      if (state === "codex") {
        const accounts = await fixture.host.bb.storage.kv.get("accounts:v1");
        await fixture.host.bb.storage.kv.set(
          "accounts:v1",
          z
            .array(accountSchema)
            .parse(accounts)
            .map((a) => ({ ...a, provider: "codex" })),
        );
      }
      const quotas = new QuotaStore(fixture.host.bb.storage.database());
      const quota = quotas.get(id);
      if (state === "quota")
        quotas.put({
          ...quota,
          fiveHourUtilization: 1,
          fiveHourResetAt: Date.now() + 3600000,
        });
      if (state === "hold")
        quotas.put({ ...quota, heldUntil: Date.now() + 3600000 });
      if (state === "error")
        quotas.put({ ...quota, error: "credential unavailable" });
      if (state === "family")
        quotas.put({
          ...quota,
          familyWeekly: {
            ...quota.familyWeekly,
            haiku: {
              utilization: 1,
              resetAt: Date.now() + 3600000,
              status: "rejected",
              source: "header",
              observedAt: Date.now(),
            },
          },
        });
      const result = await fixture.host.harness.behavior.runCli([
        "ping",
        id,
        "--json",
      ]);
      expect(result.exitCode).toBe(1);
      expect(calls).toBe(0);
    });
  });

  it("refuses unusable pool invocations instead of guessing", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-account-pool-cli-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin()(host.bb);
    await grantRoles(host);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const run = (argv: string[], ctx?: { threadId: string }) =>
      host.harness.behavior.runCli(argv, ctx);

    const strayArgument = await run(["status", "everything"]);
    expect(strayArgument.exitCode).toBe(1);
    expect(strayArgument.stderr).toContain("unexpected argument 'everything'");

    const allMissing = await run(["account", "login-complete"]);
    expect(allMissing.exitCode).toBe(1);
    expect(allMissing.stderr).toContain(
      "missing required options: --session, --code",
    );

    const stdinFlag = await run([
      "account",
      "login-complete",
      "--session",
      "11111111-1111-4111-8111-111111111111",
      "--code-stdin",
    ]);
    expect(stdinFlag.exitCode).toBe(1);
    expect(stdinFlag.stderr).toContain(
      "--code-stdin is read by the bb CLI, which rewrites it to --code <value>",
    );

    const badProvider = await run([
      "account",
      "add",
      "--provider",
      "gemini",
      "--login",
    ]);
    expect(badProvider.exitCode).toBe(1);
    expect(badProvider.stderr).toContain(
      "invalid value 'gemini' for --provider. Expected one of: claude, codex",
    );

    const conflicting = await run([
      "account",
      "add",
      "--provider",
      "claude",
      "--api-key",
      "sk-conflict",
      "--login",
    ]);
    expect(conflicting.exitCode).toBe(1);
    expect(conflicting.stderr).toContain(
      "--login and --api-key cannot be combined",
    );

    for (const flag of ["--import", "--import-local", "--local"]) {
      const imported = await run(["account", "add", "--provider", "claude", flag]);
      expect(imported.exitCode).toBe(1);
      expect(imported.stderr).toContain(`unknown option '${flag}'`);
    }
    const addHelp = await run(["account", "add", "--help"]);
    expect(addHelp.stdout).not.toMatch(/--import|--local|import credentials/u);

    const jsonEnvelope = await run([
      "account",
      "add",
      "--provider",
      "claude",
      "--json",
    ]);
    expect(jsonEnvelope.exitCode).toBe(1);
    expect(JSON.parse(jsonEnvelope.stdout)).toEqual({
      ok: false,
      error: {
        code: "missing_required",
        message:
          "missing required options: one of --login, --api-key",
        hint: expect.stringContaining("bb pool account add"),
      },
    });
    expect(jsonEnvelope.stderr).toContain(
      "missing required options: one of --login, --api-key",
    );

    const bypassWithoutThread = await run(["bypass"], {
      threadId: "thread-seven",
    });
    expect(bypassWithoutThread.exitCode).toBe(1);
    expect(bypassWithoutThread.stderr).toContain(
      "This thread is thread-seven; re-run with bb pool bypass thread-seven",
    );
  });

  it("exposes manual Claude login over RPC and the two-step CLI", async () => {
    const tokenBodies: object[] = [];
    const oauth = await startUpstream(async (request, response) => {
      if (request.url === "/token") {
        tokenBodies.push(
          JSON.parse((await readRequestBody(request)).toString()),
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            access_token: "login-access",
            refresh_token: "login-refresh",
            expires_in: 3600,
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        expect(request.headers.authorization).toBe("Bearer login-access");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            account: {
              uuid: "22222222-2222-4222-8222-222222222222",
              email: "login@example.com",
              display_name: "Logged-in Claude",
              has_claude_pro: true,
              rate_limit_tier: "default_claude_pro",
            },
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    cleanups.push(oauth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-login-rpc-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin({
      oauthAuthorizeUrl: `${oauth.url}/authorize`,
      oauthTokenUrl: `${oauth.url}/token`,
      oauthProfileUrl: `${oauth.url}/profile`,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    await grantRoles(host);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    const started = z
      .object({ sessionId: z.string().uuid(), authorizeUrl: z.string().url() })
      .strict()
      .parse(await host.harness.behavior.callRpc("login.start", null));
    const state = new URL(started.authorizeUrl).searchParams.get("state");
    if (state === null) throw new Error("Login start did not return state.");
    const account = accountSchema.parse(
      await host.harness.behavior.callRpc("login.complete", {
        sessionId: started.sessionId,
        pasted: `login-code#${state}`,
      }),
    );
    expect(account).toMatchObject({
      label: "Logged-in Claude",
      email: "login@example.com",
      subscriptionType: "pro",
      rateLimitTier: "default_claude_pro",
      kind: "oauth",
      enabled: true,
    });
    expect(tokenBodies).toHaveLength(1);
    expect(tokenBodies[0]).toMatchObject({
      code: "login-code",
      state,
      grant_type: "authorization_code",
      redirect_uri: "https://console.anthropic.com/oauth/code/callback",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
    const secret = accountSecretSchema.parse(
      JSON.parse(
        await fs.readFile(
          path.join(
            dataDir,
            "plugins",
            "account-pool",
            "secrets",
            "accounts",
            `account-${account.id}.json`,
          ),
          "utf8",
        ),
      ),
    );
    expect(secret).toMatchObject({
      kind: "oauth",
      accessToken: "login-access",
      refreshToken: "login-refresh",
    });
    expect(host.harness.inspection.realtimeSignals).toContainEqual({
      channel: "accounts-changed",
      payload: {},
    });

    const cliStarted = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "claude",
      "--login",
    ]);
    expect(cliStarted.exitCode).toBe(0);
    expect(cliStarted.stdout).toContain("Open this URL to sign in to Claude:");
    expect(cliStarted.stdout).toContain("account login-complete");
    expect(cliStarted.stdout).toContain("--code-stdin");
    const sessionId = cliStarted.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    const authorizeUrl = cliStarted.stdout.match(
      /Open this URL to sign in to Claude:\n([^\n]+)/u,
    )?.[1];
    if (sessionId === undefined || authorizeUrl === undefined) {
      throw new Error("CLI login start did not return its session and URL.");
    }
    const cliState = new URL(authorizeUrl).searchParams.get("state");
    if (cliState === null) throw new Error("CLI login start omitted state.");
    const cliCompleted = await host.harness.behavior.runCli([
      "account",
      "login-complete",
      "--session",
      sessionId,
      "--code",
      `cli-code#${cliState}`,
    ]);
    expect(cliCompleted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Added Logged-in Claude"),
    });
    expect(tokenBodies).toHaveLength(2);
    expect(tokenBodies[1]).toMatchObject({ code: "cli-code", state: cliState });
  });

  it("exposes Codex device login over RPC and the two-step CLI", async () => {
    let holdTokenPoll = false;
    let markTokenPollStarted: () => void = () => {};
    const tokenPollStarted = new Promise<void>((resolve) => {
      markTokenPollStarted = resolve;
    });
    let releaseTokenPoll: () => void = () => {};
    const tokenPollRelease = new Promise<void>((resolve) => {
      releaseTokenPoll = resolve;
    });
    const auth = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/accounts/deviceauth/usercode") {
        response.end(
          JSON.stringify({
            device_auth_id: "device-secret",
            user_code: "ABCD-1234",
            interval: "1",
            expires_in: 600,
          }),
        );
        return;
      }
      if (request.url === "/api/accounts/deviceauth/token") {
        if (holdTokenPoll) {
          markTokenPollStarted();
          await tokenPollRelease;
        }
        response.end(
          JSON.stringify({
            authorization_code: "authorization-secret",
            code_challenge: "challenge-secret",
            code_verifier: "verifier-secret",
          }),
        );
        return;
      }
      if (request.url === "/oauth/token") {
        response.end(
          JSON.stringify({
            access_token: testJwt({ exp: 2_000_000_000 }),
            refresh_token: "refresh-secret",
            id_token: testJwt({
              email: "codex@example.com",
              "https://api.openai.com/auth": {
                chatgpt_account_id: "chatgpt-account-1",
              },
            }),
          }),
        );
        return;
      }
      response.statusCode = 404;
      response.end("{}");
    });
    cleanups.push(auth.close);
    const dataDir = await mkdtemp(path.join(tmpdir(), "bb-pool-codex-login-"));
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    await testPlugin({
      codexAuthBaseUrl: auth.url,
      codexUsageUrl: EMPTY_USAGE_URL,
      usageUrl: "data:application/json,{}",
    })(host.bb);
    await grantRoles(host);
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });

    const started = codexLoginStartSchema.parse(
      await host.harness.behavior.callRpc("codexLogin.start", null),
    );
    expect(started).toMatchObject({
      verificationUri: `${auth.url}/codex/device`,
      userCode: "ABCD-1234",
      intervalMs: 1_000,
    });
    expect(
      codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: started.sessionId,
        }),
      ),
    ).toEqual({ status: "pending" });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const completed = codexLoginPollSchema.parse(
      await host.harness.behavior.callRpc("codexLogin.poll", {
        sessionId: started.sessionId,
      }),
    );
    expect(completed).toMatchObject({
      status: "complete",
      account: {
        provider: "codex",
        codexAccountId: "chatgpt-account-1",
        email: "codex@example.com",
      },
    });

    const cliStarted = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--login",
    ]);
    expect(cliStarted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Open this URL to sign in to Codex:"),
    });
    expect(cliStarted.stdout).toContain("Enter this code: ABCD-1234");
    expect(cliStarted.stdout).toContain("account login-poll --session");
    const sessionId = cliStarted.stdout.match(/Session ID: ([0-9a-f-]+)/u)?.[1];
    if (sessionId === undefined) {
      throw new Error("Codex CLI login start omitted its session ID.");
    }
    const cliCompleted = await host.harness.behavior.runCli([
      "account",
      "login-poll",
      "--session",
      sessionId,
    ]);
    expect(cliCompleted).toMatchObject({
      exitCode: 0,
      stdout: expect.stringContaining("Added codex@example.com"),
    });
    const cancelledStart = await host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--login",
    ]);
    const cancelledSessionId = cancelledStart.stdout.match(
      /Session ID: ([0-9a-f-]+)/u,
    )?.[1];
    if (cancelledSessionId === undefined) {
      throw new Error("Codex CLI login start omitted its session ID.");
    }
    holdTokenPoll = true;
    const controller = new AbortController();
    const cancelledPoll = host.harness.behavior.runCli(
      ["account", "login-poll", "--session", cancelledSessionId],
      { signal: controller.signal },
    );
    await tokenPollStarted;
    controller.abort(new Error("cancelled by test"));
    expect(
      codexLoginPollSchema.parse(
        await host.harness.behavior.callRpc("codexLogin.poll", {
          sessionId: cancelledSessionId,
        }),
      ),
    ).toEqual({
      status: "error",
      message: "Login session was not found. Start again.",
    });
    releaseTokenPoll();
    expect(await cancelledPoll).toMatchObject({ exitCode: 1 });
    expect(host.harness.inspection.logEntries.join("\n")).not.toMatch(
      /device-secret|ABCD-1234|authorization-secret|verifier-secret|refresh-secret/u,
    );
  });

  it("resolves distinct secret machine tokens and honors per-thread bypass", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const first = await fixture.host.harness.behavior.resolveProviderEnv(
      "claude-code",
      {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      },
    );
    expect(first).toEqual([
      {
        name: "ANTHROPIC_BASE_URL",
        value: { serverPath: "/api/v1/plugins/account-pool-prewarm/http" },
        reason: "Routed through the Account Pooler hub",
      },
      {
        name: "ANTHROPIC_AUTH_TOKEN",
        value: fixture.key,
        reason: "Account Pooler hub token for this machine",
      },
      {
        name: "ENABLE_TOOL_SEARCH",
        value: "true",
        reason:
          "Claude Code turns tool search off behind a custom base URL; the hub forwards tool_reference blocks",
      },
      {
        name: "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
        value: "1",
        reason:
          "Claude Code limits Opus to a 200k context window behind a custom base URL; the hub forwards to Anthropic's API",
      },
      {
        name: "BB_ACCOUNT_POOL_PARENT_URL",
        value: { serverPath: "/api/v1/plugins/account-pool-prewarm/http" },
        reason: "Account Pooler hub for nested bb servers on this machine",
      },
      {
        name: "BB_ACCOUNT_POOL_PARENT_TOKEN",
        value: fixture.key,
        reason: "Account Pooler hub token for this machine",
      },
    ]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toEqual({
      label: "Proxied",
      statusMessage: "Credentials are provided by the Account Pooler hub.",
    });
    const secondToken = await resolveToken(
      fixture.host,
      "host-two",
      "thread-two",
    );
    expect(secondToken).not.toBe(fixture.key);
    expect(
      await fixture.host.harness.behavior.callRpc("bypass.set", {
        threadId: "thread-one",
        bypassed: true,
      }),
    ).toEqual({ threadId: "thread-one", bypassed: true });
    expect(
      await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-one",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).toEqual([]);
    const off = await fixture.host.harness.behavior.runCli([
      "bypass",
      "thread-one",
      "--off",
    ]);
    expect(off.exitCode).toBe(0);
    expect(await resolveToken(fixture.host)).toBe(fixture.key);
  });

  it("routes thread-less Codex model listing through the hub without recording a thread route", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "codex",
      source: "oauth",
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        seedCodex: async () => ({
          accessToken: "sk-codex",
          refreshToken: "refresh",
          idToken: null,
          accountId: "model-list-codex-account",
          email: null,
          expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        }),
        fetch: async () => Response.json({}),
      },
    });
    await fixture.host.bb.storage.kv.delete("retry-route:thread-codex");

    const entries = await fixture.host.harness.behavior.resolveProviderEnv(
      "codex",
      { threadId: null, projectId: null, hostId: "host-one" },
    );

    expect(entries.filter((entry) => entry.name.startsWith("CODEX_"))).toEqual([
      {
        name: "CODEX_OPENAI_BASE_URL",
        value: { serverPath: "/api/v1/plugins/account-pool-prewarm/http/v1" },
        reason: "Routed through the Account Pooler hub",
      },
      {
        name: "CODEX_POOL_AUTH_TOKEN",
        value: fixture.key,
        reason: "Account Pooler hub token for this machine",
      },
    ]);
    expect(await fixture.host.bb.storage.kv.list("retry-route:")).toEqual([]);
  });

  it("restores the 1-hour prompt cache only while a subscription account can serve Claude", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { seedClaude: async () => claudeLoginSeed() },
    });
    const cacheEntry = async () =>
      (
        await fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
          threadId: "thread-one",
          projectId: "project-one",
          hostId: "host-one",
        })
      ).find((entry) => entry.name === "ENABLE_PROMPT_CACHING_1H");
    await expect(cacheEntry()).resolves.toBeUndefined();
    const subscription = accountSchema.parse(
      await addOAuthAccount(fixture.host, {
        provider: "claude",
        label: null,
        priority: 100,
      }),
    );
    await expect(cacheEntry()).resolves.toEqual({
      name: "ENABLE_PROMPT_CACHING_1H",
      value: "1",
      reason:
        "Claude Code uses a 5-minute prompt cache behind a custom base URL; subscription accounts get the 1-hour cache Claude Code uses for a direct subscription login",
    });
    await fixture.host.harness.behavior.callRpc("account.disable", {
      id: subscription.id,
    });
    await expect(cacheEntry()).resolves.toBeUndefined();
  });

  it("withholds env and proxied health when an enabled account secret is missing", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const accountSecretFile = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      `account-${fixture.account.id}.json`,
    );
    await fs.rm(accountSecretFile);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-without-secret",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
  });

  it("rotates a machine token with a ten-minute grace window", async () => {
    let now = 1_000;
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => now },
    });
    const first = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(first.status).toBe(200);
    await first.text();
    now = 2_000;
    const rotate = await fixture.host.harness.behavior.runCli([
      "token",
      "rotate",
      "--machine",
      "One",
    ]);
    expect(rotate.exitCode).toBe(0);
    expect(rotate.stdout).not.toContain(fixture.key);
    const nextKey = await resolveToken(fixture.host);
    expect(nextKey).not.toBe(fixture.key);
    now += 9 * 60 * 1_000;
    const grace = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(grace.status).toBe(200);
    await grace.text();
    now = 2_000 + 10 * 60 * 1_000 + 1;
    const expired = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(expired.status).toBe(401);
    const current = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(nextKey), body: "{}" },
    );
    expect(current.status).toBe(200);
    await current.text();
    const tokenFile = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      "hub-token-host-one.json",
    );
    expect(await fs.readFile(tokenFile, "utf8")).not.toContain(fixture.key);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.hosts).toEqual([
      {
        hostId: "host-one",
        hostName: "One",
        mintedAt: 2_000,
        lastUsedAt: now,
      },
    ]);
    expect(JSON.stringify(status)).not.toContain(fixture.key);
    expect(JSON.stringify(status)).not.toContain(nextKey);
  });

  it("reports routed threads without local login and logs them on disable", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    await resolveToken(fixture.host, "host-two", "thread-two");
    fixture.host.harness.sdk.stub(
      "system.providerStates",
      async ({ hostId }) => ({
        providers: [
          {
            providerId: "claude-code",
            status: hostId === "host-one" ? "unauthenticated" : "ready",
            planLabel: null,
          },
        ],
      }),
    );
    const routedThreads = routedThreadStatusListSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.routedThreads", null),
    );
    expect(routedThreads).toEqual([
      {
        threadId: "thread-one",
        hostId: "host-one",
        hostName: "One",
        routedAt: expect.any(Number),
        localClaudeStatus: "unauthenticated",
      },
    ]);
    fixture.host.harness.sdk.stub("plugins.list", async () => ({
      plugins: [{ id: "account-pool", enabled: false }],
    }));
    await fixture.host.harness.lifecycle.dispose();
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message:
        "Account Pooler disabled with 1 recently routed thread on machines without a local Claude login. Run bb pool status before disabling to inspect them.",
    });
  });

  it("does not fail disposal when disable inspection rejects", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    fixture.host.harness.sdk.stub("plugins.list", async () => {
      throw new Error("plugin list unavailable");
    });
    await expect(fixture.host.harness.lifecycle.dispose()).resolves.toBe(
      undefined,
    );
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "debug",
      message:
        "Account Pooler disable inspection skipped: plugin list unavailable",
    });
  });

  it("bounds disable inspection when provider states hang", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { disposeTimeoutMs: 10 },
    });
    fixture.host.harness.sdk.stub("plugins.list", async () => ({
      plugins: [{ id: "account-pool", enabled: false }],
    }));
    fixture.host.harness.sdk.stub(
      "system.providerStates",
      () => new Promise(() => {}),
    );
    await expect(fixture.host.harness.lifecycle.dispose()).resolves.toBe(
      undefined,
    );
    expect(fixture.host.harness.inspection.logEntries).toContainEqual({
      level: "debug",
      message: "Account Pooler disable inspection timed out.",
    });
  });

  it("keeps proxied routed hosts visible in status", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    fixture.host.harness.sdk.stub("system.providerStates", async () => ({
      providers: [
        {
          providerId: "claude-code",
          status: "ready",
          planLabel: "Proxied",
        },
      ],
    }));
    const routedThreads = routedThreadStatusListSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.routedThreads", null),
    );
    expect(routedThreads).toEqual([
      {
        threadId: "thread-one",
        hostId: "host-one",
        hostName: "One",
        routedAt: expect.any(Number),
        localClaudeStatus: "proxied",
      },
    ]);
  });

  it("requires a machine token and forwards a streaming SSE response byte for byte", async () => {
    const seen: {
      url: string;
      authorization: string | undefined;
      clientApiKey: string | undefined;
      beta: string | undefined;
      version: string | undefined;
      userAgent: string | undefined;
      app: string | undefined;
      stainlessRetry: string | undefined;
      cookie: string | undefined;
      gateMachineId: string | undefined;
      forwarded: string | undefined;
      cfRay: string | undefined;
      body: Buffer;
    }[] = [];
    const first = Buffer.from('event: message_start\ndata: {"one":1}\n\n');
    const second = Buffer.from('event: message_stop\ndata: {"two":2}\n\n');
    const upstream = await startUpstream(async (request, response) => {
      seen.push({
        url: request.url ?? "",
        authorization: request.headers.authorization,
        clientApiKey: request.headers["x-api-key"]?.toString(),
        beta: request.headers["anthropic-beta"]?.toString(),
        version: request.headers["anthropic-version"]?.toString(),
        userAgent: request.headers["user-agent"]?.toString(),
        app: request.headers["x-app"]?.toString(),
        stainlessRetry: request.headers["x-stainless-retry-count"]?.toString(),
        cookie: request.headers.cookie,
        gateMachineId: request.headers["x-bb-gate-machine-id"]?.toString(),
        forwarded: request.headers.forwarded,
        cfRay: request.headers["cf-ray"]?.toString(),
        body: await readRequestBody(request),
      });
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "anthropic-ratelimit-unified-5h-utilization": "0.25",
        "anthropic-ratelimit-unified-5h-reset": "4102444800",
        "anthropic-ratelimit-unified-5h-status": "allowed",
        "anthropic-ratelimit-unified-7d-utilization": "0.5",
        "anthropic-ratelimit-unified-7d-reset": "4102448400",
        "anthropic-ratelimit-unified-7d-status": "allowed",
        "anthropic-ratelimit-unified-representative-claim": "claim-a",
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
      });
      response.write(first);
      setTimeout(() => response.end(second), 60);
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: { seedClaude: async () => claudeLoginSeed() },
    });
    const unauthorized = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: { "content-type": "application/json" }, body: "{}" },
    );
    expect(unauthorized.status).toBe(401);
    expect(seen).toHaveLength(0);
    const body = Buffer.from('{"model":"claude-fable-5","stream":true}');
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages?beta=true",
      {
        headers: {
          ...authHeaders(fixture.key),
          "x-api-key": "client-key-must-not-forward",
          "anthropic-beta": "feature-a,feature-b",
          "user-agent": "claude-code-test",
          "x-app": "cli",
          "x-stainless-retry-count": "2",
          cookie: "bb_session=browser-secret",
          "x-bb-gate-machine-id": "machine-stable-id",
          forwarded: "for=192.0.2.1",
          "cf-ray": "edge-request-id",
          "accept-encoding": "gzip",
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected an SSE response body.");
    const firstRead = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("First SSE chunk was buffered.")),
          30,
        ),
      ),
    ]);
    expect(firstRead.done).toBe(false);
    expect(Buffer.from(firstRead.value ?? []).equals(first)).toBe(true);
    const remaining: Buffer[] = [];
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      remaining.push(Buffer.from(chunk.value));
    }
    expect(
      Buffer.concat([Buffer.from(firstRead.value ?? []), ...remaining]),
    ).toEqual(Buffer.concat([first, second]));
    expect(seen).toEqual([
      {
        url: "/v1/messages?beta=true",
        authorization: "Bearer oauth-access",
        clientApiKey: undefined,
        beta: "feature-a,feature-b",
        version: "2023-06-01",
        userAgent: "claude-code-test",
        app: "cli",
        stainlessRetry: "2",
        cookie: undefined,
        gateMachineId: undefined,
        forwarded: undefined,
        cfRay: undefined,
        body,
      },
    ]);
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]).toMatchObject({
      fiveHourUtilization: 0.25,
      sevenDayUtilization: 0.5,
      fiveHourStatus: "allowed",
      sevenDayStatus: "allowed",
      representativeClaim: "claim-a",
      familyWeekly: {
        fable: {
          utilization: null,
          resetAt: 4_102_452_000_000,
          status: "rejected",
          observedAt: expect.any(Number),
          source: "header",
        },
      },
    });
    expect(fixture.host.harness.inspection.registrations.httpRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "HEAD",
          path: "/api/hello",
          auth: "none",
        }),
      ]),
    );
  });

  it("errors a failed non-SSE stream without appending an SSE frame", async () => {
    const partial = Buffer.from('{"partial":');
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.write(partial);
      setTimeout(() => response.destroy(new Error("upstream failed")), 30);
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(Buffer.from(first.value ?? [])).toEqual(partial);
    await expect(reader.read()).rejects.toThrow();
  });

  it("applies config threshold changes live and rotates quota rejections", async () => {
    const keys: string[] = [];
    let requestNumber = 0;
    const upstream = await startUpstream((request, response) => {
      requestNumber += 1;
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      if (requestNumber === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-utilization": "0.75",
          "anthropic-ratelimit-unified-5h-reset": "4102444800",
          "anthropic-ratelimit-unified-5h-status": "allowed",
        });
        response.end('{"first":true}');
        return;
      }
      if (requestNumber === 2) {
        response.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "rejected",
          "anthropic-ratelimit-unified-5h-reset": "4102444800",
        });
        response.end('{"rejected":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"rotated":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");
    await addApiAccount(fixture, "sk-three");
    const first = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(first.status).toBe(200);
    await first.text();
    expect(
      accountPoolConfigSchema.parse(
        await fixture.host.harness.behavior.callRpc("config.set", {
          switchThreshold: 0.7,
        }),
      ).switchThreshold,
    ).toBe(0.7);
    const rotated = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(rotated.status).toBe(200);
    expect(await rotated.text()).toBe('{"rotated":true}');
    expect(keys).toEqual(["sk-one", "sk-two", "sk-three"]);
  });

  it("routes around a Fable-spent account while retaining it for Opus", async () => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      await readRequestBody(request);
      if (keys.length === 1) {
        response.writeHead(200, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-utilization": "0.99",
          "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
          "anthropic-ratelimit-unified-7d_oi-status": "allowed",
        });
      } else {
        response.writeHead(200, { "content-type": "application/json" });
      }
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");

    for (const model of [
      "claude-fable-5",
      "claude-fable-5",
      "claude-opus-4-1",
    ]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({ model }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(keys).toEqual(["sk-one", "sk-two", "sk-one"]);
  });

  it("rotates a family-only 429 without exhausting other families", async () => {
    const keys: string[] = [];
    const upstream = await startUpstream(async (request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      await readRequestBody(request);
      if (keys.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "anthropic-ratelimit-unified-5h-status": "allowed",
          "anthropic-ratelimit-unified-7d-status": "allowed",
          "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
          "anthropic-ratelimit-unified-7d_oi-status": "rejected",
        });
        response.end('{"rejected":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");

    const fable = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-fable-5" }),
      },
    );
    expect(fable.status).toBe(200);
    await fable.text();
    const opus = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-opus-4-1" }),
      },
    );
    expect(opus.status).toBe(200);
    await opus.text();

    expect(keys).toEqual(["sk-one", "sk-two", "sk-one"]);
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]).toMatchObject({
      status: "ready",
      familyWeekly: {
        fable: { status: "rejected", source: "header" },
      },
    });
  });

  it("rotates when a same-account retry reveals a family limit", async () => {
    const keys: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-one",
      options: {
        fetch: async (_input, init) => {
          keys.push(new Headers(init?.headers).get("x-api-key") ?? "");
          if (keys.length === 1) {
            return Response.json(
              { minute: true },
              { status: 429, headers: { "retry-after": "0" } },
            );
          }
          if (keys.length === 2) {
            return Response.json(
              { family: true },
              {
                status: 429,
                headers: {
                  "anthropic-ratelimit-unified-5h-status": "allowed",
                  "anthropic-ratelimit-unified-7d-status": "allowed",
                  "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
                  "anthropic-ratelimit-unified-7d_oi-status": "rejected",
                },
              },
            );
          }
          return Response.json({ rotated: true });
        },
      },
    });
    await addApiAccount(fixture, "sk-two");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: JSON.stringify({ model: "claude-fable-5" }),
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ rotated: true });
    expect(keys).toEqual(["sk-one", "sk-one", "sk-two"]);
  });

  it("refreshes usage on import and routes from its family observations", async () => {
    const authorizations: Array<string | undefined> = [];
    const usageCalls = new Map<string, number>();
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/usage") {
        const authorization = request.headers.authorization;
        usageCalls.set(
          authorization ?? "",
          (usageCalls.get(authorization ?? "") ?? 0) + 1,
        );
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            five_hour: { utilization: 10, resets_at: "4102444800" },
            seven_day: { utilization: 20, resets_at: "4102448400" },
            limits: [
              {
                kind: "weekly_scoped",
                group: "weekly",
                percent: authorization === "Bearer oauth-a" ? 100 : 0,
                resets_at: "4102452000",
                scope: { model: { display_name: "Fable" } },
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/profile") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            account: { uuid: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const imports = [
      claudeLoginSeed({
        accessToken: "oauth-a",
        accountUuid: null,
      }),
      claudeLoginSeed({
        accessToken: "oauth-b",
        accountUuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ];
    let importIndex = 0;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: {
        usageUrl: `${upstream.url}/usage`,
        oauthProfileUrl: `${upstream.url}/profile`,
        seedClaude: async () => {
          const imported = imports[importIndex];
          importIndex += 1;
          if (imported === undefined) throw new Error("No import fixture.");
          return imported;
        },
      },
    });
    const second = accountSchema.parse(
      await addOAuthAccount(fixture.host, {
        provider: "claude",
        label: "second",
        priority: 100,
      }),
    );
    expect(usageCalls).toEqual(
      new Map([
        ["Bearer oauth-a", 1],
        ["Bearer oauth-b", 1],
      ]),
    );
    await fixture.host.harness.behavior.callRpc("account.disable", {
      id: second.id,
    });
    await fixture.host.harness.behavior.callRpc("account.enable", {
      id: second.id,
    });
    expect(usageCalls.get("Bearer oauth-a")).toBe(1);
    expect(usageCalls.get("Bearer oauth-b")).toBe(2);
    const listed = await fixture.host.harness.behavior.runCli([
      "account",
      "list",
    ]);
    expect(listed.stdout).toContain("Fable");
    expect(listed.stdout).toContain("100% rejected");
    expect(listed.stdout).toContain("0% allowed");
    const accounts = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(accounts[0]?.accountUuid).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );

    for (const model of ["claude-fable-5", "claude-opus-4-1"]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({ model }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }

    expect(authorizations).toEqual(["Bearer oauth-b", "Bearer oauth-b"]);
  });

  it("rewrites both known metadata account UUID formats", async () => {
    const bodies: Buffer[] = [];
    const upstream = await startUpstream(async (request, response) => {
      bodies.push(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const accountUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const oldUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: {
        seedClaude: async () => claudeLoginSeed({ accountUuid }),
      },
    });
    const inputs = [
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            device_id: "device",
            account_uuid: oldUuid,
          }),
        },
      }),
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: `user_hash_account_${oldUuid}_session_cccccccc-cccc-4ccc-8ccc-cccccccccccc`,
        },
      }),
    ];
    for (const body of inputs) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.toString().includes(accountUuid))).toBe(
      true,
    );
    expect(bodies.every((body) => !body.toString().includes(oldUuid))).toBe(
      true,
    );
  });

  it("preserves request bytes when an account UUID rewrite cannot apply", async () => {
    const bodies: Buffer[] = [];
    const upstream = await startUpstream(async (request, response) => {
      bodies.push(await readRequestBody(request));
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const inputs = [
      JSON.stringify({
        model: "claude-fable-5",
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          }),
        },
      }),
      '{ "model": "claude-fable-5", "messages": [] }',
      "not-json-at-all",
    ];
    for (const body of inputs) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
    }
    expect(bodies.map((body) => body.toString())).toEqual(inputs);
  });

  it("paces a per-minute 429 on the same account without rotating", async () => {
    const keys: string[] = [];
    const times: number[] = [];
    const upstream = await startUpstream((request, response) => {
      keys.push(request.headers["x-api-key"]?.toString() ?? "");
      times.push(Date.now());
      if (keys.length === 1) {
        response.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0.04",
        });
        response.end('{"minute":true}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"retried":true}');
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      apiKey: "sk-one",
    });
    await addApiAccount(fixture, "sk-two");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"retried":true}');
    expect(keys).toEqual(["sk-one", "sk-one"]);
    expect((times[1] ?? 0) - (times[0] ?? 0)).toBeGreaterThanOrEqual(30);
  });

  it.each([401, 403, 408, 500, 502, 503, 504, 529, "disconnect"])(
    "tries another account after a pre-stream %s failure",
    async (failure) => {
      const attempts: Array<string | undefined> = [];
      const upstream = await startUpstream(async (request, response) => {
        await readRequestBody(request);
        const key = request.headers["x-api-key"];
        attempts.push(typeof key === "string" ? key : undefined);
        if (key === "sk-first") {
          if (typeof failure === "string") {
            request.socket.destroy();
            return;
          }
          response.writeHead(failure, { "content-type": "application/json" });
          response.end('{"error":{"message":"first account failed"}}');
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"result":"second"}');
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        apiKey: "sk-first",
        priority: 0,
      });
      await addApiAccount(fixture, "sk-second", 100);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload).toEqual({ result: "second" });
      expect(attempts).toEqual(["sk-first", "sk-second"]);
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(
        accounts.find((account) => account.id === fixture.account.id)?.error,
      ).toEqual(failure === 401 ? expect.any(String) : null);
    },
  );

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider rejected-token recovery", ({ provider, route }) => {
    it.each([
      {
        name: "401",
        statuses: [401, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "429 then 401",
        statuses: [429, 401, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "same-token refresh",
        statuses: [401, 200],
        refreshStatus: 200,
        sameToken: true,
      },
      {
        name: "401 then 429",
        statuses: [401, 429, 200],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "401 after both retry budgets",
        statuses: [401, 429, 401],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "repeated 401",
        statuses: [401, 401],
        refreshStatus: 200,
        sameToken: false,
      },
      {
        name: "refresh outage",
        statuses: [401],
        refreshStatus: 503,
        sameToken: false,
      },
    ])(
      "bounds $name recovery and never reuses rejected fallback credentials",
      async ({ statuses, refreshStatus, sameToken }) => {
        let now = 1_800_000_000_000;
        let refreshCalls = 0;
        let oauthStatus = refreshStatus;
        const newToken = sameToken
          ? "oauth-old"
          : testJwt({ exp: now / 1_000 + 3600 });
        const authorizations: Array<string | null> = [];
        const fixture = await createOAuthRequestFixture(
          provider,
          async (input, init) => {
            if (String(input).endsWith("/oauth/token")) {
              refreshCalls += 1;
              return Response.json(
                oauthStatus === 200
                  ? { access_token: newToken, expires_in: 3600 }
                  : { error: "temporarily_unavailable" },
                { status: oauthStatus },
              );
            }
            authorizations.push(
              new Headers(init?.headers).get("authorization"),
            );
            return Response.json(
              { result: "upstream" },
              {
                status: statuses[authorizations.length - 1] ?? 200,
                headers: { "retry-after": "0" },
              },
            );
          },
          () => now,
        );
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          {
            headers: authHeaders(fixture.key),
            body: "{}",
          },
        );
        await response.text();
        expect(response.status).toBe(
          refreshStatus === 503 || statuses.at(-1) === 401
            ? 503
            : statuses.at(-1),
        );
        expect(refreshCalls).toBe(1);
        expect(authorizations).toEqual(
          statuses.map(
            (_status, index) =>
              `Bearer ${index > statuses.indexOf(401) && refreshStatus === 200 ? newToken : "oauth-old"}`,
          ),
        );
        if (refreshStatus === 503) {
          const held = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: authHeaders(fixture.key),
              body: "{}",
            },
          );
          await held.text();
          expect(held.status).toBe(503);
          expect(authorizations).toHaveLength(1);
          expect(refreshCalls).toBe(1);
          now += 1_000;
          oauthStatus = 200;
          const recovered = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: authHeaders(fixture.key),
              body: "{}",
            },
          );
          await recovered.text();
          expect(recovered.status).toBe(200);
          expect(refreshCalls).toBe(2);
          expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
        }
      },
    );

    it("joins an unchanged normal flight once and reuses replacement tokens after a late 401", async () => {
      const now = 1_800_000_000_000;
      const newToken = testJwt({ exp: now / 1_000 + 3600 });
      const oldResponses: Array<() => void> = [];
      const authorizations: Array<string | null> = [];
      let refreshCalls = 0;
      let releaseRefresh = () => {};
      const refreshReleased = new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      const fixture = await createOAuthRequestFixture(
        provider,
        async (input, init) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            await refreshReleased;
            return Response.json({ access_token: newToken, expires_in: 3600 });
          }
          const authorization = new Headers(init?.headers).get("authorization");
          authorizations.push(authorization);
          if (authorization === "Bearer oauth-old") {
            await new Promise<void>((resolve) => {
              oldResponses.push(resolve);
            });
            return Response.json(
              { error: { message: "expired access token" } },
              { status: 401 },
            );
          }
          return Response.json({ result: "refreshed" });
        },
        () => now,
      );
      const requests = [1, 2].map(() =>
        fixture.host.harness.behavior.fetchHttp("POST", route, {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      let releaseRead = () => {};
      const readReleased = new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      const originalRead = AccountStore.prototype.readSecret;
      const read = vi.spyOn(AccountStore.prototype, "readSecret");
      try {
        await vi.waitFor(() => expect(oldResponses).toHaveLength(2));
        read.mockImplementation(async function (this: AccountStore, id) {
          const secret = await originalRead.call(this, id);
          await readReleased;
          return secret;
        });
        read.mockClear();
        requests.push(
          fixture.host.harness.behavior.fetchHttp("POST", route, {
            headers: authHeaders(fixture.key),
            body: "{}",
          }),
        );
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        oldResponses[0]?.();
        oldResponses[1]?.();
        await new Promise<void>((resolve) => setImmediate(resolve));
        releaseRead();
        await vi.waitFor(() => {
          expect(oldResponses).toHaveLength(3);
          expect(refreshCalls).toBe(1);
        });
        releaseRefresh();
        const first = await Promise.all(requests.slice(0, 2));
        expect(first.map((response) => response.status)).toEqual([200, 200]);
        await Promise.all(first.map((response) => response.text()));
        oldResponses[2]?.();
        const late = await requests[2];
        expect(late?.status).toBe(200);
        await late?.text();
        expect(refreshCalls).toBe(1);
        expect(
          authorizations.filter((value) => value === `Bearer ${newToken}`),
        ).toHaveLength(3);
        const accounts = z
          .array(accountSummarySchema)
          .parse(
            await fixture.host.harness.behavior.callRpc("account.list", null),
          );
        expect(accounts[0]?.error).toBeNull();
      } finally {
        releaseRead();
        releaseRefresh();
        for (const release of oldResponses) release();
        await Promise.allSettled(
          requests.map(async (request) => {
            const response = await request;
            await response.text();
          }),
        );
        read.mockRestore();
      }
    });
  });

  it.each(["terminal", "same-token cooldown"])(
    "keeps late 401 recovery bounded after a %s refresh",
    async (outcome) => {
      const oldResponse = deferred();
      const refreshed = deferred();
      let now = 1_800_000_000_000;
      let attempts = 0;
      let refreshCalls = 0;
      const fixture = await createOAuthRequestFixture(
        "claude",
        async (input) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            if (refreshCalls === 1)
              return Response.json(
                {
                  error:
                    outcome === "terminal"
                      ? "invalid_grant"
                      : "temporarily_unavailable",
                },
                { status: outcome === "terminal" ? 400 : 503 },
              );
            await refreshed.promise;
            return Response.json({
              access_token: "oauth-old",
              expires_in: 3600,
            });
          }
          attempts += 1;
          const attempt = attempts;
          if (attempt === 1) await oldResponse.promise;
          return Response.json({}, { status: attempt <= 2 ? 401 : 200 });
        },
        () => now,
      );
      const send = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        });
      const requests = [send()];
      try {
        await vi.waitFor(() => expect(attempts).toBe(1));
        const rejected = await send();
        expect(rejected.status).toBe(outcome === "terminal" ? 401 : 503);
        await rejected.text();
        if (outcome === "same-token cooldown") {
          now += 1_000;
          requests.push(send());
          await vi.waitFor(() => expect(refreshCalls).toBe(2));
        }
        oldResponse.resolve();
        await new Promise<void>((resolve) => setImmediate(resolve));
        refreshed.resolve();
        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.text()));
        expect(responses.map((response) => response.status)).toEqual(
          outcome === "terminal" ? [401] : [200, 200],
        );
        expect(refreshCalls).toBe(outcome === "terminal" ? 1 : 2);
        expect(attempts).toBe(outcome === "terminal" ? 2 : 4);
      } finally {
        oldResponse.resolve();
        refreshed.resolve();
        await Promise.allSettled(
          requests.map(async (request) => (await request).text()),
        );
      }
    },
  );

  it.each([false, true])(
    "separates rejection checks from credential flights when the reporting request is canceled: %s",
    async (cancelReporter) => {
      let attempts = 0;
      const fixture = await createOAuthRequestFixture(
        "claude",
        async (input) => {
          if (String(input).endsWith("/oauth/token"))
            return Response.json({
              access_token: "oauth-new",
              expires_in: 3600,
            });
          attempts += 1;
          return Response.json({}, { status: attempts <= 2 ? 401 : 200 });
        },
        () => 1_800_000_000_000,
      );
      const gate = deferred();
      const checking = deferred();
      const originalRead = AccountStore.prototype.readSecret;
      let reads = 0;
      const read = vi
        .spyOn(AccountStore.prototype, "readSecret")
        .mockImplementation(async function (this: AccountStore, id) {
          const secret = await originalRead.call(this, id);
          reads += 1;
          if (reads === 3) {
            checking.resolve();
            await gate.promise;
          }
          return secret;
        });
      const recordUsed = vi.spyOn(AccountStore.prototype, "recordUsed");
      const controller = new AbortController();
      const requests = [
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
          signal: controller.signal,
        }),
      ];
      try {
        await checking.promise;
        requests.push(
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: "{}",
          }),
        );
        await vi.waitFor(() => expect(recordUsed).toHaveBeenCalledTimes(2));
        await Promise.all(
          recordUsed.mock.results.map((result) => result.value),
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (cancelReporter) controller.abort();
        gate.resolve();
        const responses = await Promise.all(requests);
        await Promise.all(responses.map((response) => response.text()));
        expect(responses.map((response) => response.status)).toEqual(
          cancelReporter ? [499, 200] : [503, 503],
        );
        expect(attempts).toBe(cancelReporter ? 3 : 2);
      } finally {
        gate.resolve();
        await Promise.allSettled(
          requests.map(async (request) => (await request).text()),
        );
        read.mockRestore();
        recordUsed.mockRestore();
      }
    },
  );

  it("cancels one forced-refresh waiter without canceling shared recovery", async () => {
    const gate = deferred();
    let refreshCalls = 0;
    const authorizations: Array<string | null> = [];
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          await gate.promise;
          return Response.json({ access_token: "oauth-new", expires_in: 3600 });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        authorizations.push(authorization);
        return Response.json(
          {},
          { status: authorization === "Bearer oauth-old" ? 401 : 200 },
        );
      },
      () => 1_800_000_000_000,
    );
    const controller = new AbortController();
    const requests = [controller.signal, undefined].map((signal) =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
        signal,
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(authorizations).toHaveLength(2);
        expect(refreshCalls).toBe(1);
      });
      controller.abort();
      const canceled = await requests[0];
      expect(canceled?.status).toBe(499);
      await canceled?.text();
      gate.resolve();
      const recovered = await requests[1];
      expect(recovered?.status).toBe(200);
      await recovered?.text();
      expect(refreshCalls).toBe(1);
      expect(authorizations).toEqual([
        "Bearer oauth-old",
        "Bearer oauth-old",
        "Bearer oauth-new",
      ]);
    } finally {
      gate.resolve();
      await Promise.allSettled(
        requests.map(async (request) => (await request).text()),
      );
    }
  });

  it("does not let a late second 401 poison a newer credential", async () => {
    const gate = deferred();
    let refreshCalls = 0;
    let newAttempts = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return Response.json({
            access_token: `oauth-new-${refreshCalls}`,
            expires_in: 3600,
          });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === "Bearer oauth-new-2") return Response.json({});
        if (authorization === "Bearer oauth-new-1") {
          newAttempts += 1;
          if (newAttempts === 1) await gate.promise;
        }
        return Response.json({ error: "rejected token" }, { status: 401 });
      },
      () => 1_800_000_000_000,
    );
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      });
    const first = send();
    try {
      await vi.waitFor(() => expect(newAttempts).toBe(1));
      const second = await send();
      expect(second.status).toBe(200);
      await second.text();
      gate.resolve();
      const late = await first;
      expect(late.status).toBe(503);
      await late.text();
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(accounts[0]?.error).toBeNull();
      const next = await send();
      expect(next.status).toBe(200);
      await next.text();
      expect(refreshCalls).toBe(2);
    } finally {
      gate.resolve();
      const response = await first;
      if (!response.bodyUsed) await response.text();
    }
  });

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider upstream credential rejection", ({ provider, route }) => {
    it.each([401, 403])(
      "holds a freshly refreshed token rejected with HTTP %s without marking an account error",
      async (status) => {
        let now = 1_800_000_000_000;
        let outage = true;
        let refreshCalls = 0;
        const authorizations: Array<string | null> = [];
        const fixture = await createOAuthRequestFixture(
          provider,
          async (input, init) => {
            if (String(input).endsWith("/oauth/token")) {
              refreshCalls += 1;
              return Response.json({
                access_token: `oauth-new-${refreshCalls}`,
                expires_in: 3600,
              });
            }
            authorizations.push(
              new Headers(init?.headers).get("authorization"),
            );
            if (!outage) return Response.json({ result: "recovered" });
            return Response.json(
              {
                error: {
                  message:
                    "Incorrect API key provided: sk-svcac***fvMA. You can find your API key at https://platform.openai.com/account/api-keys.",
                  type: "invalid_request_error",
                  code: "invalid_api_key",
                },
              },
              { status },
            );
          },
          () => now,
        );
        const send = async () => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            { headers: authHeaders(fixture.key), body: "{}" },
          );
          return { status: response.status, body: await response.text() };
        };
        const accountState = async () =>
          z
            .array(accountSummarySchema)
            .parse(
              await fixture.host.harness.behavior.callRpc("account.list", null),
            )[0];

        const rejected = await send();
        if (provider === "claude" && status === 403) {
          expect(rejected.status).toBe(403);
          expect((await accountState())?.accessBlocked).toMatchObject({
            status: 403,
          });
          expect(refreshCalls).toBe(0);
          expect(authorizations).toHaveLength(1);
          return;
        }
        expect(rejected.status).toBe(503);
        expect(rejected.body).toContain("invalid_api_key");
        expect(authorizations).toEqual([
          "Bearer oauth-old",
          "Bearer oauth-new-1",
        ]);
        expect(refreshCalls).toBe(1);
        expect(await accountState()).toMatchObject({ error: null });

        now += 30_000;
        const held = await send();
        expect(held.status).toBe(503);
        expect(authorizations).toHaveLength(2);
        expect(refreshCalls).toBe(1);

        now += 31_000;
        outage = false;
        const recovered = await send();
        expect(recovered.status).toBe(200);
        expect(authorizations.at(-1)).toBe("Bearer oauth-new-1");
        expect(refreshCalls).toBe(1);
        expect(await accountState()).toMatchObject({ error: null });
      },
    );

    it("clears a stored credential error through a manual refresh", async () => {
      let refreshStatus = 400;
      let refreshCalls = 0;
      const fixture = await createOAuthRequestFixture(
        provider,
        async (input, init) => {
          if (String(input).endsWith("/oauth/token")) {
            refreshCalls += 1;
            return refreshStatus === 200
              ? Response.json({ access_token: "oauth-new", expires_in: 3600 })
              : Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json(
            {},
            {
              status:
                new Headers(init?.headers).get("authorization") ===
                "Bearer oauth-old"
                  ? 401
                  : 200,
            },
          );
        },
        () => 1_800_000_000_000,
      );
      const send = async () => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        await response.text();
        return response.status;
      };
      const refresh = async () =>
        z
          .object({ account: accountSummarySchema.nullable() })
          .parse(
            await fixture.host.harness.behavior.callRpc(
              "account.refreshUsage",
              { accountId: fixture.account.id },
            ),
          ).account;

      expect(await send()).toBe(401);
      expect(await send()).toBe(429);
      expect(refreshCalls).toBe(1);

      const stillRejected = await refresh();
      expect(refreshCalls).toBe(2);
      expect(stillRejected?.error).toBe(
        "OAuth refresh failed with HTTP 400. invalid_grant.",
      );
      expect(fixture.host.harness.inspection.logEntries).toContainEqual({
        level: "warn",
        message: expect.stringContaining(
          `Account Pooler ${provider} account ${fixture.account.id} OAuth refresh failed`,
        ),
      });

      refreshStatus = 200;
      const recovered = await refresh();
      expect(refreshCalls).toBe(3);
      expect(recovered?.error).toBeNull();
      expect(fixture.host.harness.inspection.logEntries).toContainEqual({
        level: "info",
        message: expect.stringContaining(
          `Account Pooler ${provider} account ${fixture.account.id} OAuth refresh succeeded`,
        ),
      });
      expect(await send()).toBe(200);
      const refreshLogs = fixture.host.harness.inspection.logEntries.filter(
        (entry) =>
          entry.message.includes(`account ${fixture.account.id} OAuth refresh`),
      );
      expect(refreshLogs).toHaveLength(3);
      const logText = JSON.stringify(refreshLogs);
      for (const token of ["oauth-old", "oauth-new", "oauth-refresh"])
        expect(logText).not.toContain(token);
    });
  });

  it("honors a newer token's rejected cooldown when an older 401 arrives late", async () => {
    const gate = deferred();
    let now = 1_800_000_000_000;
    let refreshCalls = 0;
    let attempts = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return refreshCalls === 2
            ? Response.json({}, { status: 503 })
            : Response.json({
                access_token: `oauth-new-${refreshCalls}`,
                expires_in: 3600,
              });
        }
        attempts += 1;
        if (attempts === 1) await gate.promise;
        return Response.json(
          {},
          { status: attempts === 3 || attempts >= 5 ? 200 : 401 },
        );
      },
      () => now,
    );
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      });
    const first = send();
    try {
      await vi.waitFor(() => expect(attempts).toBe(1));
      const second = await send();
      expect(second.status).toBe(200);
      await second.text();
      const rejected = await send();
      expect(rejected.status).toBe(503);
      await rejected.text();
      gate.resolve();
      const late = await first;
      expect(late.status).toBe(503);
      await late.text();
      const held = await send();
      expect(held.status).toBe(503);
      await held.text();
      expect(attempts).toBe(4);
      now += 1_000;
      const recovered = await send();
      expect(recovered.status).toBe(200);
      await recovered.text();
      expect(refreshCalls).toBe(3);
    } finally {
      gate.resolve();
      const response = await first;
      if (!response.bodyUsed) await response.text();
    }
  });

  it.each(["never ends", "cancel rejects", "cancel hangs"])(
    "bounds failed response disposal when the body %s",
    async (behavior) => {
      const cancel = vi.fn(() =>
        behavior === "cancel hangs"
          ? new Promise<void>(() => {})
          : behavior === "cancel rejects"
            ? Promise.reject(new Error("cancel failed"))
            : Promise.resolve(),
      );
      let attempts = 0;
      const fixture: Fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        priority: 0,
        options: {
          fetch: async (_input, init) => {
            attempts += 1;
            if (attempts === 1)
              return new Response(
                new ReadableStream({
                  start(controller) {
                    if (behavior !== "never ends")
                      controller.enqueue(new Uint8Array(2048).fill(65));
                  },
                  cancel,
                }),
                { status: 503 },
              );
            const status = statusSchema.parse(
              await fixture.host.harness.behavior.callRpc("status.get", null),
            );
            expect(
              status.accounts.find(
                (account) => account.id === fixture.account.id,
              )?.inFlight,
            ).toBe(0);
            expect(init?.signal?.aborted).toBe(false);
            return Response.json({});
          },
        },
      });
      await addApiAccount(fixture, "sk-backup", 100);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
      expect(attempts).toBe(2);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("finishes a successful in-flight fetch during graceful hub shutdown", async () => {
    const gate = deferred();
    const started = deferred();
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          started.resolve();
          await gate.promise;
          return Response.json({});
        },
      },
    });
    const request = fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    await started.promise;
    fixture.service.controller.abort();
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(false);
    });
    gate.resolve();
    const response = await request;
    expect(response.status).toBe(200);
    await response.text();
    await fixture.service.done;
  });

  it("accepts requests after stopping and restarting the hub service", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: { fetch: async () => Response.json({}) },
    });
    fixture.service.controller.abort();
    await fixture.service.done;
    const restarted = fixture.host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      restarted.controller.abort();
      await restarted.done;
    });
    await vi.waitFor(async () => {
      const status = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(status.accepting).toBe(true);
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    await response.text();
  });

  it.each([true, false])(
    "uses only the initial account snapshot with a healthy fourth account: %s",
    async (healthyFourth) => {
      const attempts: Array<string | null> = [];
      const fixture: Fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-1",
        priority: 1,
        options: {
          fetch: async (_input, init) => {
            const key = new Headers(init?.headers).get("x-api-key");
            attempts.push(key);
            if (attempts.length === 1)
              await addApiAccount(fixture, "sk-late", -1);
            return Response.json(
              { result: key },
              {
                status:
                  key === "sk-late" || (healthyFourth && key === "sk-4")
                    ? 200
                    : 503,
              },
            );
          },
        },
      });
      for (const account of [2, 3, 4])
        await addApiAccount(fixture, `sk-${account}`, account);
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: "{}",
        },
      );
      await response.text();
      expect(response.status).toBe(healthyFourth ? 200 : 503);
      expect(attempts).toEqual(["sk-1", "sk-2", "sk-3", "sk-4"]);
    },
  );

  it("does not start another inference after cancellation during pacing", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          attempts += 1;
          return attempts === 1
            ? new Response(
                new ReadableStream({
                  cancel() {
                    controller.abort();
                  },
                }),
                { status: 429, headers: { "retry-after": "0" } },
              )
            : Response.json({});
        },
      },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
        signal: controller.signal,
      },
    );
    await response.text();
    expect(attempts).toBe(1);
  });

  it("never replays a committed SSE stream on another account", async () => {
    let failStream = () => {};
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => {
          attempts += 1;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode("data: started\n\n"),
                );
                failStream = () =>
                  controller.error(new Error("stream disconnected"));
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    });
    await addApiAccount(fixture, "sk-backup");
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Missing SSE stream.");
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "data: started\n\n",
    );
    failStream();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain(
      "event: error",
    );
    expect((await reader.read()).done).toBe(true);
    expect(attempts).toBe(1);
  });

  describe("session affinity", () => {
    const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const claudeBody = (id: string, model = "claude-fable-5") =>
      JSON.stringify({
        model,
        metadata: {
          user_id: JSON.stringify({
            account_uuid: "invalid-account-uuid",
            device_id: "device",
            parent_session_id: "parent",
            session_id: id,
          }),
        },
      });
    const openStream = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: started\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );

    async function affinityFixture(
      provider: "claude" | "codex",
      upstreamFetch: typeof fetch,
      now = () => 1_800_000_000_000,
    ): Promise<Fixture> {
      let imported = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider,
        apiKey: "sk-first",
        source: provider === "codex" ? "oauth" : "api-key",
        options: {
          now,
          codexUsageUrl: EMPTY_USAGE_URL,
          fetch: (input, init) =>
            String(input) === EMPTY_USAGE_URL
              ? Promise.resolve(Response.json({}))
              : upstreamFetch(input, init),
          seedCodex: async () => ({
            accessToken:
              ["sk-first", "sk-second", "sk-third"][imported++] ?? "sk-extra",
            refreshToken: "refresh",
            idToken: null,
            accountId: `codex-account-${imported}`,
            email: null,
            expiresAt: now() + 24 * 60 * 60 * 1_000,
          }),
        },
      });
      if (provider === "claude") await addApiAccount(fixture, "sk-second");
      else
        await addOAuthAccount(fixture.host, {
          provider,
          label: null,
          priority: 100,
        });
      return fixture;
    }

    it.each(["claude", "codex"] as const)(
      "keeps %s sessions and the pool cursor on the third account after two failures",
      async (provider) => {
        let outage = false;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return Response.json(
              {},
              { status: outage && key !== "sk-third" ? 503 : 200 },
            );
          },
        );
        if (provider === "claude") await addApiAccount(fixture, "sk-third");
        else
          await addOAuthAccount(fixture.host, {
            provider,
            label: null,
            priority: 100,
          });
        const send = async (id: string) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        };
        await send("warm");
        outage = true;
        await send("warm");
        await send("warm");
        await send("fresh");
        outage = false;
        await send("warm");
        await send("fresh-after-recovery");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-third",
          "sk-third",
          "sk-third",
          "sk-third",
          "sk-third",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "lets new %s conversations bypass long holds while preserving established pins",
      async (provider) => {
        let now = 1_800_000_000_000;
        let limited = false;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return limited && key === "sk-first"
              ? Response.json(
                  {},
                  { status: 429, headers: { "retry-after": "60" } },
                )
              : Response.json({});
          },
          () => now,
        );
        const send = async (id: string, status = 200) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(status);
          await response.text();
        };
        await send("warm");
        limited = true;
        await send("warm", 429);
        await send("fresh");
        await send("warm", 429);
        now += 60_000;
        limited = false;
        await send("warm");
        await send("fresh-after-recovery");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-first",
          "sk-second",
        ]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "fails over immediately when a new %s conversation receives a long rate limit",
      async (provider) => {
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            return key === "sk-first"
              ? Response.json(
                  {},
                  { status: 429, headers: { "retry-after": "60" } },
                )
              : Response.json({});
          },
        );
        for (const id of ["fresh", "another"]) {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        }
        expect(attempts).toEqual(["sk-first", "sk-second", "sk-second"]);
      },
    );

    it.each(["claude", "codex"] as const)(
      "restores the %s cursor and distinct session pins after a full plugin reload",
      async (provider) => {
        let outage = false;
        const attempts: string[] = [];
        const upstreamFetch: typeof fetch = async (input, init) => {
          if (String(input) === EMPTY_USAGE_URL) return Response.json({});
          const headers = new Headers(init?.headers);
          const key =
            headers.get("x-api-key") ??
            headers.get("authorization")?.slice(7) ??
            "";
          attempts.push(key);
          return Response.json(
            {},
            { status: outage && key === "sk-first" ? 503 : 200 },
          );
        };
        const fixture = await affinityFixture(provider, upstreamFetch);
        let host = fixture.host;
        const send = async (id: string) => {
          const response = await host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "session-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
          expect(response.status).toBe(200);
          await response.text();
        };
        await send("original");
        outage = true;
        await send("fallback");
        outage = false;
        host = await host.harness.lifecycle.reload(
          testPlugin({
            fetch: upstreamFetch,
            now: () => 1_800_000_000_000,
            usageUrl: EMPTY_USAGE_URL,
            codexUsageUrl: EMPTY_USAGE_URL,
          }),
        );
        const service = host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          service.controller.abort();
          await service.done;
          await host.harness.lifecycle.dispose();
        });
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await host.harness.behavior.callRpc("status.get", null),
          );
          expect(status.accepting).toBe(true);
        });
        await send("fresh-after-restart");
        await send("original");
        await send("fallback");
        await send("another-fresh");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-second",
          "sk-first",
          "sk-second",
          "sk-second",
        ]);
      },
    );

    it.each([
      { idleMinutes: 45, reload: false },
      { idleMinutes: 45, reload: true },
      { idleMinutes: 61, reload: false },
      { idleMinutes: 61, reload: true },
    ])(
      "retains Claude session affinity after $idleMinutes idle minutes with reload=$reload",
      async ({ idleMinutes, reload }) => {
        let now = 1_800_000_000_000;
        let outage = false;
        const attempts: Array<string | null> = [];
        const upstreamFetch: typeof fetch = async (_input, init) => {
          const key = new Headers(init?.headers).get("x-api-key");
          attempts.push(key);
          return Response.json(
            {},
            { status: outage && key === "sk-first" ? 503 : 200 },
          );
        };
        const fixture = await affinityFixture(
          "claude",
          upstreamFetch,
          () => now,
        );
        let host = fixture.host;
        const send = async (id: string) => {
          const response = await host.harness.behavior.fetchHttp(
            "POST",
            "/v1/messages",
            {
              headers: authHeaders(fixture.key),
              body: claudeBody(id),
            },
          );
          expect(response.status).toBe(200);
          await response.text();
          return attempts.at(-1);
        };
        expect(await send("original")).toBe("sk-first");
        outage = true;
        expect(await send("fallback")).toBe("sk-second");
        outage = false;
        now += idleMinutes * 60 * 1_000;
        if (reload) {
          host = await host.harness.lifecycle.reload(
            testPlugin({
              fetch: upstreamFetch,
              now: () => now,
              usageUrl: EMPTY_USAGE_URL,
            }),
          );
          const service = host.harness.behavior.runService("hub");
          cleanups.push(async () => {
            service.controller.abort();
            await service.done;
            await host.harness.lifecycle.dispose();
          });
          await vi.waitFor(async () => {
            const status = statusSchema.parse(
              await host.harness.behavior.callRpc("status.get", null),
            );
            expect(status.accepting).toBe(true);
          });
        }
        expect(await send("original")).toBe("sk-first");
        expect(await send("fresh")).toBe("sk-second");
      },
    );

    it.each(["claude", "codex"] as const)(
      "runs %s sequentially across conversations and keeps a recovered earlier account as backup",
      async (provider) => {
        let now = 1_800_000_000_000;
        let rejected: string | null = null;
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              "";
            attempts.push(key);
            if (key === rejected)
              return Response.json(
                {},
                {
                  status: 429,
                  headers:
                    provider === "claude"
                      ? {
                          "anthropic-ratelimit-unified-5h-status": "rejected",
                          "anthropic-ratelimit-unified-5h-reset": String(
                            now / 1000 + 60,
                          ),
                        }
                      : {
                          "x-codex-primary-over-limit": "true",
                          "x-codex-primary-reset-after-seconds": "60",
                        },
                },
              );
            return attempts.length === 1 ? openStream() : Response.json({});
          },
          () => now,
        );
        const send = (id: string) =>
          fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), "thread-id": id },
              body: provider === "claude" ? claudeBody(id) : "{}",
            },
          );
        const first = await send("original");
        try {
          await (await send("new-while-busy")).text();
          expect(attempts).toEqual(["sk-first", "sk-first"]);
          rejected = "sk-first";
          await (await send("failover")).text();
          now += 60_000;
          rejected = null;
          await (await send("new-after-recovery")).text();
          await (await send("original")).text();
          await (await send("another-new")).text();
          expect(attempts).toEqual([
            "sk-first",
            "sk-first",
            "sk-first",
            "sk-second",
            "sk-second",
            "sk-first",
            "sk-second",
          ]);
          rejected = "sk-second";
          await (await send("wrap")).text();
          expect(attempts.slice(-2)).toEqual(["sk-second", "sk-first"]);
        } finally {
          await first.body?.cancel();
        }
      },
    );

    it.each<{
      label: string;
      status: number;
      headers: Record<string, string>;
      expected: RetryAvailability;
    }>([
      { label: "ready", status: 200, headers: {}, expected: { kind: "ready" } },
      {
        label: "unknown reset",
        status: 429,
        headers: { "anthropic-ratelimit-unified-5h-status": "rejected" },
        expected: { kind: "unavailable", reason: "reset-unknown" },
      },
      {
        label: "authentication failure",
        status: 401,
        headers: {},
        expected: { kind: "unavailable", reason: "authentication" },
      },
      {
        label: "model-specific window",
        status: 429,
        headers: {
          "anthropic-ratelimit-unified-7d_opus-status": "rejected",
          "anthropic-ratelimit-unified-7d_opus-reset": "1800003600",
        },
        expected: { kind: "blocked", retryAt: 1_800_003_600_000 },
      },
    ])(
      "reports retry availability for $label",
      async ({ status, headers, expected }) => {
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          options: {
            now: () => 1_800_000_000_000,
            fetch: async () => Response.json({}, { status, headers }),
          },
        });
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: JSON.stringify({ model: "claude-opus-4-1", messages: [] }),
          },
        );
        await response.text();
        const input = { threadId: "thread-one", requestId: "creq_aaaaaaaaaa" };
        expect(
          await fixture.host.harness.behavior.callRpc(
            retryAvailabilityMethod,
            input,
          ),
        ).toEqual(expected);
        expect(
          await fixture.host.harness.behavior.callRpc(retryAvailabilityMethod, {
            ...input,
            requestId: "another-request",
          }),
        ).toEqual({ kind: "unavailable", reason: "source-unavailable" });
        await fixture.host.harness.behavior.callRpc("account.disable", {
          id: fixture.account.id,
        });
        expect(
          await fixture.host.harness.behavior.callRpc(
            retryAvailabilityMethod,
            input,
          ),
        ).toEqual({ kind: "unavailable", reason: "no-enabled-account" });
        expect(
          (
            await fixture.host.harness.behavior.fetchHttp(
              "GET",
              "/retry-availability?provider=claude&family=opus",
            )
          ).status,
        ).toBe(401);
        const remote = await fixture.host.harness.behavior.fetchHttp(
          "GET",
          "/retry-availability?provider=claude&family=opus",
          { headers: authHeaders(fixture.key) },
        );
        expect(await remote.json()).toEqual({
          kind: "unavailable",
          reason: "no-enabled-account",
        });
      },
    );

    it.each(["claude", "codex"] as const)(
      "reports the earliest usable %s account after all of its limits reset",
      async (provider) => {
        const now = Date.now();
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const first =
              (headers.get("x-api-key") ??
                headers.get("authorization")?.slice(7)) === "sk-first";
            return Response.json(
              {},
              {
                status: 429,
                headers:
                  provider === "claude"
                    ? {
                        "anthropic-ratelimit-unified-5h-status": "rejected",
                        "anthropic-ratelimit-unified-5h-reset": String(
                          (now + (first ? 60_000 : 120_000)) / 1000,
                        ),
                        "anthropic-ratelimit-unified-7d-status": "rejected",
                        "anthropic-ratelimit-unified-7d-reset": String(
                          (now + (first ? 180_000 : 240_000)) / 1000,
                        ),
                      }
                    : {
                        "x-codex-primary-used-percent": "100",
                        "x-codex-primary-window-minutes": "300",
                        "x-codex-primary-reset-after-seconds": first
                          ? "60"
                          : "120",
                        "x-codex-secondary-used-percent": "100",
                        "x-codex-secondary-window-minutes": "10080",
                        "x-codex-secondary-reset-after-seconds": first
                          ? "180"
                          : "240",
                      },
              },
            );
          },
          () => now,
        );
        const threadId = provider === "claude" ? "thread-one" : "thread-codex";
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          provider === "claude" ? "/v1/messages" : "/v1/responses",
          {
            headers: authHeaders(fixture.key),
            body:
              provider === "claude"
                ? claudeBody("pooled-retry")
                : JSON.stringify({ model: "gpt-5", input: [], stream: true }),
          },
        );
        expect(response.status).toBe(429);
        await response.text();
        const input = { threadId, requestId: "creq_aaaaaaaaaa" };
        expect(
          await fixture.host.harness.behavior.callRpc(
            retryAvailabilityMethod,
            input,
          ),
        ).toEqual({ kind: "blocked", retryAt: now + 180_000 });
        await fixture.host.harness.behavior.callRpc("bypass.set", {
          threadId,
          bypassed: true,
        });
        await fixture.host.harness.behavior.resolveProviderEnv(
          provider === "claude" ? "claude-code" : "codex",
          { threadId, projectId: "project-one", hostId: "host-one" },
        );
        expect(
          await fixture.host.harness.behavior.callRpc(
            retryAvailabilityMethod,
            input,
          ),
        ).toEqual({ kind: "not-routed" });
      },
    );

    it.each(["claude", "codex"] as const)(
      "handles %s quota exhaustion and reset with session affinity",
      async (provider) => {
        let now = 1_800_000_000_000;
        const exhausted = new Set<string>();
        const attempts: string[] = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const headers = new Headers(init?.headers);
            const key =
              headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7);
            if (key === undefined)
              throw new Error("Missing account credential.");
            attempts.push(key);
            if (!exhausted.has(key)) return Response.json({ account: key });
            const resetSeconds = key === "sk-first" ? 60 : 120;
            return Response.json(
              { error: { message: "Account usage exhausted." } },
              {
                status: 429,
                headers:
                  provider === "claude"
                    ? {
                        "anthropic-ratelimit-unified-5h-status": "rejected",
                        "anthropic-ratelimit-unified-5h-reset": String(
                          now / 1000 + resetSeconds,
                        ),
                      }
                    : {
                        "x-codex-primary-used-percent": "100",
                        "x-codex-primary-window-minutes": "300",
                        "x-codex-primary-reset-after-seconds":
                          String(resetSeconds),
                      },
              },
            );
          },
          () => now,
        );
        const send = () =>
          fixture.host.harness.behavior.fetchHttp(
            "POST",
            provider === "claude" ? "/v1/messages" : "/v1/responses",
            {
              headers: {
                ...authHeaders(fixture.key),
                "session-id": sessionId,
                "thread-id": "quota-thread",
              },
              body:
                provider === "claude"
                  ? claudeBody(sessionId)
                  : JSON.stringify({ model: "gpt-5", input: [], stream: true }),
            },
          );
        const expectAccount = async (account: string) => {
          const response = await send();
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ account });
        };

        await expectAccount("sk-first");
        exhausted.add("sk-first");
        await expectAccount("sk-second");
        await expectAccount("sk-second");
        now += 60_000;
        exhausted.delete("sk-first");
        await expectAccount("sk-second");
        expect(attempts).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-second",
          "sk-second",
        ]);

        exhausted.add("sk-first");
        exhausted.add("sk-second");
        const unavailable = await send();
        expect(unavailable.status).toBe(429);
        expect(unavailable.headers.get("retry-after")).toBe("60");
        await unavailable.text();
        expect(attempts.slice(5)).toEqual(["sk-second", "sk-first"]);
        const stillUnavailable = await send();
        expect(stillUnavailable.status).toBe(429);
        expect(stillUnavailable.headers.get("retry-after")).toBe("60");
        const unavailableBody = await stillUnavailable.json();
        expect(unavailableBody.error.message).toContain(
          "2027-01-15T08:02:00.000Z",
        );
        expect(unavailableBody.error.message).toContain("60 seconds");
        expect(attempts).toHaveLength(7);

        now += 60_000;
        exhausted.delete("sk-first");
        await expectAccount("sk-first");
        await expectAccount("sk-first");
        expect(attempts.slice(7)).toEqual(["sk-first", "sk-first"]);
        const status = statusSchema.parse(
          await fixture.host.harness.behavior.callRpc("status.get", null),
        );
        expect(status.accounts.map((account) => account.status)).toEqual([
          "ready",
          "exhausted",
        ]);
      },
    );

    describe("parent affinity", () => {
      type Wire =
        | "claude"
        | "codex-fork"
        | "codex-shared-session"
        | "codex-body"
        | "codex-parent-header"
        | "codex-parent-body"
        | "codex-spawn";
      function forkRequest(
        wire: Wire,
        own: string,
        parent: string | null,
      ): { headers: Record<string, string>; body: string } {
        if (wire === "claude")
          return {
            headers: {},
            body: JSON.stringify({
              model: "claude-fable-5",
              metadata: {
                user_id: JSON.stringify({
                  session_id: own,
                  parent_session_id: parent,
                  device_id: "device",
                  account_uuid: "invalid-account-uuid",
                  extra: "keep",
                }),
              },
              messages: [{ role: "user", content: "Identical cached prefix" }],
            }),
          };
        const session =
          (wire === "codex-shared-session" || wire === "codex-body") &&
          parent !== null
            ? parent
            : own;
        const turn = {
          session_id: session,
          thread_id: own,
          forked_from_thread_id:
            wire === "codex-fork" ||
            wire === "codex-shared-session" ||
            wire === "codex-body"
              ? parent
              : null,
          parent_thread_id: wire === "codex-spawn" ? parent : null,
          extra: "keep",
        };
        const bodyOnly = wire === "codex-body" || wire === "codex-parent-body";
        const headers: Record<string, string> = { "session-id": session };
        if (!bodyOnly) headers["thread-id"] = own;
        if (!bodyOnly) headers["x-codex-turn-metadata"] = JSON.stringify(turn);
        if (wire === "codex-parent-header" && parent !== null)
          headers["x-codex-parent-thread-id"] = parent;
        return {
          headers,
          body: JSON.stringify({
            model: "gpt-5",
            stream: true,
            prompt_cache_key: "shared-parent-cache",
            client_metadata: {
              session_id: session,
              thread_id: own,
              "x-codex-turn-metadata": JSON.stringify(turn),
              ...(wire === "codex-parent-body" && parent !== null
                ? { "x-codex-parent-thread-id": parent }
                : {}),
            },
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "Identical cached prefix" },
                ],
              },
              { type: "compaction", encrypted_content: "preserve" },
            ],
          }),
        };
      }

      it.each<Wire>(["claude", "codex-fork"])(
        "keeps a fork on its short-held parent account over %s",
        async (wire) => {
          const provider = wire === "claude" ? "claude" : "codex";
          const attempts: Array<string | null> = [];
          const parentRetry = deferred();
          const fixture = await affinityFixture(
            provider,
            async (_input, init) => {
              const headers = new Headers(init?.headers);
              attempts.push(
                headers.get("x-api-key") ??
                  headers.get("authorization")?.slice(7) ??
                  null,
              );
              if (attempts.length === 4) await parentRetry.promise;
              return attempts.length === 3
                ? Response.json(
                    {},
                    { status: 429, headers: { "retry-after": "0.25" } },
                  )
                : Response.json({});
            },
          );
          const send = (own: string, parent: string | null) => {
            const request = forkRequest(wire, own, parent);
            return fixture.host.harness.behavior.fetchHttp(
              "POST",
              provider === "claude" ? "/v1/messages" : "/v1/responses",
              {
                headers: { ...authHeaders(fixture.key), ...request.headers },
                body: request.body,
              },
            );
          };
          await (await send("parent", null)).text();
          await movePoolToOtherAccount(fixture, provider);
          const paced = send("parent", null);
          try {
            await vi.waitFor(
              async () => {
                const status = statusSchema.parse(
                  await fixture.host.harness.behavior.callRpc(
                    "status.get",
                    null,
                  ),
                );
                expect(
                  status.accounts.find(
                    (account) => account.id === fixture.account.id,
                  )?.status,
                ).toBe("held");
                expect(attempts).toHaveLength(4);
              },
              { interval: 5 },
            );
            const child = await send("child", "parent");
            expect(child.status).toBe(200);
            await child.text();
            parentRetry.resolve();
            await (await paced).text();
            await (await send("child", "parent")).text();
            expect(attempts).toEqual([
              "sk-first",
              "sk-second",
              "sk-first",
              "sk-first",
              "sk-first",
              "sk-first",
            ]);
          } finally {
            parentRetry.resolve();
            const response = await paced;
            if (!response.bodyUsed) await response.text();
          }
        },
      );

      it.each<Wire>([
        "claude",
        "codex-fork",
        "codex-shared-session",
        "codex-body",
        "codex-parent-header",
        "codex-parent-body",
        "codex-spawn",
      ])(
        "inherits the eligible %s parent once and keeps child failover independent",
        async (wire) => {
          const provider = wire === "claude" ? "claude" : "codex";
          const route =
            provider === "claude" ? "/v1/messages" : "/v1/responses";
          const seen: Array<{ key: string | null; body: string }> = [];
          let rejectNext = false;
          const fixture = await affinityFixture(
            provider,
            async (_input, init) => {
              const headers = new Headers(init?.headers);
              seen.push({
                key:
                  headers.get("x-api-key") ??
                  headers.get("authorization")?.slice(7) ??
                  null,
                body: new TextDecoder().decode(
                  init?.body instanceof ArrayBuffer
                    ? init.body
                    : new ArrayBuffer(0),
                ),
              });
              if (seen.length === 1) return openStream();
              if (rejectNext) {
                rejectNext = false;
                return Response.json({}, { status: 503 });
              }
              return Response.json({});
            },
          );
          const send = (own: string, parent: string | null) => {
            const request = forkRequest(wire, own, parent);
            return fixture.host.harness.behavior.fetchHttp("POST", route, {
              headers: { ...authHeaders(fixture.key), ...request.headers },
              body: request.body,
            });
          };
          const held = await send("parent-session", null);
          try {
            const child = await send("child-session", "parent-session");
            expect(child.status).toBe(200);
            await child.text();
            expect(seen[1]?.key).toBe("sk-first");
            expect(seen[1]?.body).toBe(
              forkRequest(wire, "child-session", "parent-session").body,
            );
            rejectNext = true;
            const failover = await send("child-session", "parent-session");
            expect(failover.status).toBe(200);
            await failover.text();
            const parent = await send("parent-session", null);
            await parent.text();
            const repeatedChild = await send("child-session", "parent-session");
            await repeatedChild.text();
            expect(seen.map(({ key }) => key)).toEqual([
              "sk-first",
              "sk-first",
              "sk-first",
              "sk-second",
              "sk-first",
              "sk-second",
            ]);
          } finally {
            await held.body?.cancel();
          }
        },
      );

      describe.each<"claude" | "codex">(["claude", "codex"])(
        "%s parent eligibility",
        (provider) => {
          const wire = provider === "claude" ? "claude" : "codex-fork";
          const route =
            provider === "claude" ? "/v1/messages" : "/v1/responses";
          it.each(["disabled", "expired", "missing", "other host"])(
            "uses ordinary selection when the parent is %s",
            async (reason) => {
              let now = 1_800_000_000_000;
              const attempts: Array<string | null> = [];
              const fixture = await affinityFixture(
                provider,
                async (_input, init) => {
                  const headers = new Headers(init?.headers);
                  attempts.push(
                    headers.get("x-api-key") ??
                      headers.get("authorization")?.slice(7) ??
                      null,
                  );
                  return attempts.length === 1
                    ? openStream()
                    : Response.json({});
                },
                () => now,
              );
              const parent = forkRequest(wire, "parent-session", null);
              const held = await fixture.host.harness.behavior.fetchHttp(
                "POST",
                route,
                {
                  headers: { ...authHeaders(fixture.key), ...parent.headers },
                  body: parent.body,
                },
              );
              try {
                await movePoolToOtherAccount(fixture, provider);
                attempts.splice(1);
                if (reason === "disabled")
                  await fixture.host.harness.behavior.callRpc(
                    "account.disable",
                    { id: fixture.account.id },
                  );
                if (reason === "expired") now += 66 * 60 * 1_000;
                const key =
                  reason === "other host"
                    ? provider === "claude"
                      ? await resolveToken(fixture.host, "host-two")
                      : (await resolveCodexToken(fixture.host, "host-two"))
                          .token
                    : fixture.key;
                const request = forkRequest(
                  wire,
                  "child-session",
                  reason === "missing" ? "missing-parent" : "parent-session",
                );
                const child = await fixture.host.harness.behavior.fetchHttp(
                  "POST",
                  route,
                  {
                    headers: { ...authHeaders(key), ...request.headers },
                    body: request.body,
                  },
                );
                expect(child.status).toBe(200);
                await child.text();
                expect(attempts).toEqual(["sk-first", "sk-second"]);
              } finally {
                await held.body?.cancel();
              }
            },
          );

          it("does not extend the parent lifetime when a child inherits its account", async () => {
            let now = 1_800_000_000_000;
            const attempts: Array<string | null> = [];
            const fixture = await affinityFixture(
              provider,
              async (_input, init) => {
                const headers = new Headers(init?.headers);
                attempts.push(
                  headers.get("x-api-key") ??
                    headers.get("authorization")?.slice(7) ??
                    null,
                );
                return attempts.length === 1 ? openStream() : Response.json({});
              },
              () => now,
            );
            const send = (own: string, parent: string | null) => {
              const request = forkRequest(wire, own, parent);
              return fixture.host.harness.behavior.fetchHttp("POST", route, {
                headers: { ...authHeaders(fixture.key), ...request.headers },
                body: request.body,
              });
            };
            const held = await send("parent-session", null);
            try {
              await movePoolToOtherAccount(fixture, provider);
              attempts.splice(1);
              now += 64 * 60 * 1_000;
              await (await send("child-session", "parent-session")).text();
              now += 2 * 60 * 1_000;
              await (await send("parent-session", null)).text();
              await (await send("child-session", "parent-session")).text();
              expect(attempts).toEqual([
                "sk-first",
                "sk-first",
                "sk-second",
                "sk-first",
              ]);
            } finally {
              await held.body?.cancel();
            }
          });
        },
      );

      it("does not inherit a parent binding from another provider", async () => {
        const attempts: Array<string | null> = [];
        const fixture = await affinityFixture("codex", async (_input, init) => {
          const headers = new Headers(init?.headers);
          attempts.push(
            headers.get("x-api-key") ??
              headers.get("authorization")?.slice(7) ??
              null,
          );
          return attempts.length <= 2 ? openStream() : Response.json({});
        });
        await addApiAccount(fixture, "sk-claude-parent");
        const claude = forkRequest("claude", "parent-session", null);
        const codex = forkRequest("codex-fork", "unrelated-session", null);
        const held = [
          await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/messages",
            { headers: authHeaders(fixture.key), body: claude.body },
          ),
          await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...codex.headers },
              body: codex.body,
            },
          ),
        ];
        try {
          await movePoolToOtherAccount(fixture, "codex");
          attempts.splice(2);
          const request = forkRequest(
            "codex-fork",
            "child-session",
            "parent-session",
          );
          const child = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            "/v1/responses",
            {
              headers: { ...authHeaders(fixture.key), ...request.headers },
              body: request.body,
            },
          );
          expect(child.status).toBe(200);
          await child.text();
          expect(attempts).toEqual([
            "sk-claude-parent",
            "sk-first",
            "sk-second",
          ]);
        } finally {
          for (const response of held) await response.body?.cancel();
        }
      });
    });

    it.each<{
      name: string;
      provider: "claude" | "codex";
      headers: Record<string, string>;
      body: string;
    }>([
      {
        name: "Claude JSON",
        provider: "claude",
        headers: {},
        body: claudeBody(sessionId),
      },
      {
        name: "Claude legacy",
        provider: "claude",
        headers: {},
        body: JSON.stringify({
          metadata: {
            user_id: `user_hash_account_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa_session_${sessionId}`,
          },
        }),
      },
      {
        name: "Codex native",
        provider: "codex",
        headers: { "session-id": sessionId, "thread-id": "native-thread" },
        body: "{}",
      },
      {
        name: "Codex legacy",
        provider: "codex",
        headers: { session_id: sessionId },
        body: "{}",
      },
      {
        name: "Codex cache",
        provider: "codex",
        headers: {},
        body: JSON.stringify({ prompt_cache_key: sessionId }),
      },
    ])(
      "keeps $name sessions sticky with host isolation and idle expiry",
      async ({ provider, headers, body }) => {
        let now = 1_800_000_000_000;
        const attempts: Array<string | null> = [];
        const fixture = await affinityFixture(
          provider,
          async (_input, init) => {
            const requestHeaders = new Headers(init?.headers);
            attempts.push(
              provider === "claude"
                ? requestHeaders.get("x-api-key")
                : requestHeaders.get("authorization"),
            );
            return attempts.length === 1 ? openStream() : Response.json({});
          },
          () => now,
        );
        const route = provider === "claude" ? "/v1/messages" : "/v1/responses";
        const keyFor = (key: string) =>
          provider === "claude" ? key : `Bearer ${key}`;
        const send = async (
          key: string,
          requestBody: string,
          sessionHeaders = headers,
        ) => {
          const response = await fixture.host.harness.behavior.fetchHttp(
            "POST",
            route,
            {
              headers: { ...authHeaders(key), ...sessionHeaders },
              body: requestBody,
            },
          );
          await response.text();
          expect(response.status).toBe(200);
          return attempts.at(-1);
        };
        const held = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          {
            headers: { ...authHeaders(fixture.key), ...headers },
            body,
          },
        );
        try {
          const otherHost =
            provider === "codex"
              ? (await resolveCodexToken(fixture.host, "host-two")).token
              : await resolveToken(fixture.host, "host-two");
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fixture.account.id,
          });
          expect(await send(otherHost, body)).toBe(keyFor("sk-second"));
          await fixture.host.harness.behavior.callRpc("account.enable", {
            id: fixture.account.id,
          });
          expect(await send(fixture.key, "{}", {})).toBe(keyFor("sk-second"));
          now += 64 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          now += 2 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-first"));
          now += 66 * 60 * 1_000;
          expect(await send(fixture.key, body)).toBe(keyFor("sk-second"));
        } finally {
          await held.body?.cancel();
        }
      },
    );

    it.each([
      "family quota",
      "auth error",
      "disabled account",
      "network error",
    ])(
      "preserves the correct binding after %s despite an older response completion",
      async (reason) => {
        const attempts: Array<string | null> = [];
        let finishOld = () => {};
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          apiKey: "sk-first",
          options: {
            fetch: async (_input, init) => {
              const key = new Headers(init?.headers).get("x-api-key");
              attempts.push(key);
              if (attempts.length === 1)
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(
                        new TextEncoder().encode("data: old\n\n"),
                      );
                      finishOld = () => {
                        controller.close();
                        finishOld = () => {};
                      };
                    },
                  }),
                  {
                    headers:
                      reason === "family quota"
                        ? {
                            "anthropic-ratelimit-unified-7d_fable-status":
                              "rejected",
                            "anthropic-ratelimit-unified-7d_fable-reset":
                              "4102444800",
                          }
                        : {},
                  },
                );
              if (
                reason === "network error" &&
                key === "sk-first" &&
                attempts.length === 2
              )
                throw new TypeError("network failed");
              return Response.json(
                {},
                {
                  status:
                    reason === "auth error" &&
                    key === "sk-first" &&
                    attempts.length === 2
                      ? 403
                      : 200,
                },
              );
            },
          },
        });
        await addApiAccount(fixture, "sk-second");
        const send = (model: string) =>
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: claudeBody(sessionId, model),
          });
        const held = await send(
          reason === "family quota" ? "claude-fable-5" : "claude-opus-4-1",
        );
        try {
          if (reason === "disabled account")
            await fixture.host.harness.behavior.callRpc("account.disable", {
              id: fixture.account.id,
            });
          const rebound = await send("claude-fable-5");
          expect(rebound.status).toBe(200);
          await rebound.text();
          if (reason !== "family quota")
            await fixture.host.harness.behavior.callRpc("account.enable", {
              id: fixture.account.id,
            });
          finishOld();
          await held.text();
          const afterCompletion = await send("claude-opus-4-1");
          await afterCompletion.text();
          expect(attempts).toEqual(
            reason === "auth error" || reason === "network error"
              ? ["sk-first", "sk-first", "sk-second", "sk-second"]
              : [
                  "sk-first",
                  "sk-second",
                  reason === "family quota" ? "sk-first" : "sk-second",
                ],
          );
        } finally {
          finishOld();
          if (!held.bodyUsed) await held.body?.cancel();
        }
      },
    );

    it("shares the first binding when simultaneous account listings resume under different load", async () => {
      const attempts: Array<string | null> = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        options: {
          fetch: async (_input, init) => {
            attempts.push(new Headers(init?.headers).get("x-api-key"));
            return attempts.length === 1 ? openStream() : Response.json({});
          },
        },
      });
      await addApiAccount(fixture, "sk-second");
      const gates = [deferred(), deferred()];
      const originalList = AccountStore.prototype.list;
      let listings = 0;
      const list = vi
        .spyOn(AccountStore.prototype, "list")
        .mockImplementation(async function (this: AccountStore) {
          const index = listings++;
          const accounts = await originalList.call(this);
          if (index < 2) await gates[index]?.promise;
          return accounts;
        });
      const requests = [1, 2].map(() =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        }),
      );
      try {
        await vi.waitFor(() => expect(listings).toBe(2));
        gates[0]?.resolve();
        await vi.waitFor(() => expect(attempts).toHaveLength(1));
        gates[1]?.resolve();
        const responses = await Promise.all(requests);
        await responses[1]?.text();
        await responses[0]?.body?.cancel();
        expect(attempts).toEqual(["sk-first", "sk-first"]);
      } finally {
        for (const gate of gates) gate.resolve();
        await Promise.allSettled(
          requests.map(async (request) => {
            const response = await request;
            if (!response.bodyUsed) await response.body?.cancel();
          }),
        );
        list.mockRestore();
      }
    });

    it("keeps native Codex HTTP compaction continuations on the same account", async () => {
      const seen: Array<{ headers: Headers; body: string }> = [];
      const compacted = {
        type: "compaction",
        encrypted_content: "encrypted-compaction-fixture",
      };
      const fixture = await affinityFixture("codex", async (_input, init) => {
        seen.push({
          headers: new Headers(init?.headers),
          body: new TextDecoder().decode(
            init?.body instanceof ArrayBuffer ? init.body : new ArrayBuffer(0),
          ),
        });
        if (seen.length === 1) return openStream();
        return new Response(
          `data: ${JSON.stringify({ type: "response.completed", response: { id: `response-${seen.length}`, output: [compacted] } })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const headers = {
        ...authHeaders(fixture.key),
        "session-id": sessionId,
        "thread-id": "native-thread",
      };
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        { headers, body: "{}" },
      );
      try {
        const fields = {
          model: "gpt-5",
          prompt_cache_key: "cache-key",
          client_metadata: {
            session_id: "body-session",
            thread_id: "body-thread",
            "x-codex-turn-metadata": "fixture",
          },
          include: ["reasoning.encrypted_content"],
          reasoning: { effort: "high" },
        };
        const input = [
          {
            type: "reasoning",
            encrypted_content: "encrypted-reasoning-fixture",
          },
          { type: "compaction_trigger" },
        ];
        const first = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          { headers, body: JSON.stringify({ ...fields, input }) },
        );
        expect(first.status).toBe(200);
        await first.text();
        const delta = { type: "message", role: "user", content: "next" };
        const second = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/responses",
          {
            headers,
            body: JSON.stringify({
              ...fields,
              input: [...input, compacted, delta],
            }),
          },
        );
        expect(second.status).toBe(200);
        await second.text();
        expect(JSON.parse(seen[1]?.body ?? "{}")).toMatchObject({
          ...fields,
          input,
        });
        expect(JSON.parse(seen[2]?.body ?? "{}")).toMatchObject({
          ...fields,
          input: [...input, compacted, delta],
        });
        expect(seen.map(({ headers }) => headers.get("session-id"))).toEqual([
          sessionId,
          sessionId,
          sessionId,
        ]);
        expect(seen.map(({ headers }) => headers.get("thread-id"))).toEqual([
          "native-thread",
          "native-thread",
          "native-thread",
        ]);
        expect(seen.map(({ headers }) => headers.get("authorization"))).toEqual(
          ["Bearer sk-first", "Bearer sk-first", "Bearer sk-first"],
        );
      } finally {
        await held.body?.cancel();
      }
    });

    it.each([false, true])(
      "preserves a newer session binding outside an older candidate snapshot with a fallback: %s",
      async (hasFallback) => {
        const gate = deferred();
        const attempts: Array<string | null> = [];
        const fixture = await createFixture({
          upstreamUrl: "https://upstream.example",
          apiKey: "sk-first",
          priority: 0,
          options: {
            fetch: async (_input, init) => {
              attempts.push(new Headers(init?.headers).get("x-api-key"));
              if (attempts.length === 1) {
                await gate.promise;
                return Response.json({}, { status: 503 });
              }
              return Response.json({});
            },
          },
        });
        const fallback = await addApiAccount(fixture, "sk-fallback", 20);
        if (!hasFallback)
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fallback.id,
          });
        const send = () =>
          fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
            headers: authHeaders(fixture.key),
            body: claudeBody(sessionId),
          });
        const old = send();
        try {
          await vi.waitFor(() => expect(attempts).toEqual(["sk-first"]));
          await addApiAccount(fixture, "sk-new", 10);
          await fixture.host.harness.behavior.callRpc("account.disable", {
            id: fixture.account.id,
          });
          const rebound = await send();
          expect(rebound.status).toBe(200);
          await rebound.text();
          gate.resolve();
          const exhausted = await old;
          expect(exhausted.status).toBe(hasFallback ? 200 : 503);
          await exhausted.text();
          await fixture.host.harness.behavior.callRpc("account.enable", {
            id: fixture.account.id,
          });
          const next = await send();
          expect(next.status).toBe(200);
          await next.text();
          expect(attempts).toEqual(
            hasFallback
              ? ["sk-first", "sk-new", "sk-fallback", "sk-new"]
              : ["sk-first", "sk-new", "sk-new"],
          );
        } finally {
          gate.resolve();
          const response = await old;
          if (!response.bodyUsed) await response.text();
        }
      },
    );

    it("preserves a newer session binding to an already-attempted account", async () => {
      const gate = deferred();
      const attempts: Array<string | null> = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        priority: 0,
        options: {
          fetch: async (_input, init) => {
            const key = new Headers(init?.headers).get("x-api-key");
            attempts.push(key);
            if (attempts.length === 1)
              return Response.json({}, { status: 503 });
            if (key === "sk-second") {
              await gate.promise;
              return Response.json({}, { status: 503 });
            }
            return Response.json({});
          },
        },
      });
      const second = await addApiAccount(fixture, "sk-second", 10);
      await addApiAccount(fixture, "sk-fallback", 20);
      const send = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        });
      const old = send();
      try {
        await vi.waitFor(() =>
          expect(attempts).toEqual(["sk-first", "sk-second"]),
        );
        await fixture.host.harness.behavior.callRpc("account.disable", {
          id: second.id,
        });
        const rebound = await send();
        expect(rebound.status).toBe(200);
        await rebound.text();
        gate.resolve();
        const fallback = await old;
        expect(fallback.status).toBe(200);
        await fallback.text();
        const next = await send();
        expect(next.status).toBe(200);
        await next.text();
        expect(attempts).toEqual([
          "sk-first",
          "sk-second",
          "sk-first",
          "sk-fallback",
          "sk-first",
        ]);
      } finally {
        gate.resolve();
        const response = await old;
        if (!response.bodyUsed) await response.text();
      }
    });

    it("isolates provider bindings and retains them on hub restart", async () => {
      const attempts: Array<string | null> = [];
      const started = new Set<string>();
      const fixture = await affinityFixture("codex", async (_input, init) => {
        const headers = new Headers(init?.headers);
        const provider = headers.has("x-api-key") ? "claude" : "codex";
        attempts.push(headers.get("x-api-key") ?? headers.get("authorization"));
        if (!started.has(provider)) {
          started.add(provider);
          return openStream();
        }
        return Response.json({});
      });
      await addApiAccount(fixture, "sk-claude-first");
      const claudeSecond = await addApiAccount(fixture, "sk-claude-second");
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      const codexSecond = accounts.find(
        (account) => account.codexAccountId === "codex-account-2",
      );
      if (codexSecond === undefined)
        throw new Error("Missing second Codex account.");
      const sendClaude = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: claudeBody(sessionId),
        });
      const sendCodex = () =>
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
          headers: { ...authHeaders(fixture.key), "session-id": sessionId },
          body: "{}",
        });
      const held = [await sendClaude(), await sendCodex()];
      try {
        for (const account of [claudeSecond, codexSecond])
          await fixture.host.harness.behavior.callRpc("account.setPriority", {
            accountId: account.id,
            priority: 0,
          });
        await (await sendClaude()).text();
        await (await sendCodex()).text();
        for (const response of held) await response.body?.cancel();
        fixture.service.controller.abort();
        await fixture.service.done;
        const restarted = fixture.host.harness.behavior.runService("hub");
        cleanups.push(async () => {
          restarted.controller.abort();
          await restarted.done;
        });
        await vi.waitFor(async () => {
          const status = statusSchema.parse(
            await fixture.host.harness.behavior.callRpc("status.get", null),
          );
          expect(status.accepting).toBe(true);
        });
        await (await sendClaude()).text();
        await (await sendCodex()).text();
        expect(attempts).toEqual([
          "sk-claude-first",
          "Bearer sk-first",
          "sk-claude-first",
          "Bearer sk-first",
          "sk-claude-first",
          "Bearer sk-first",
        ]);
      } finally {
        for (const response of held)
          if (!response.bodyUsed) await response.body?.cancel();
      }
    });

    it("evicts the least recently used binding at capacity", async () => {
      let lastKey: string | null = null;
      let attempts = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        apiKey: "sk-first",
        options: {
          now: () => 1_800_000_000_000,
          maxAffinityBindings: 4,
          fetch: async (_input, init) => {
            lastKey = new Headers(init?.headers).get("x-api-key");
            attempts += 1;
            return attempts === 1 ? openStream() : Response.json({});
          },
        },
      });
      const second = await addApiAccount(fixture, "sk-second");
      const send = async (id: string) => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: claudeBody(id),
          },
        );
        await response.text();
        return lastKey;
      };
      const held = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: claudeBody("oldest"),
        },
      );
      try {
        await movePoolToOtherAccount(fixture, "claude");
        for (let index = 1; index < 4; index += 1)
          await send(`session-${index}`);
        const touched = await send("oldest");
        await send("newest");
        const retained = await send("oldest");
        await held.body?.cancel();
        await movePoolToOtherAccount(fixture, "claude", second.id);
        const nextOldest = await send("session-2");
        const evicted = await send("session-1");
        expect([touched, retained, nextOldest, evicted]).toEqual([
          "sk-first",
          "sk-first",
          "sk-second",
          "sk-first",
        ]);
      } finally {
        if (!held.bodyUsed) await held.body?.cancel();
      }
    });
  });

  it("serializes refresh, writes new tokens with 0600 mode, and uses them", async () => {
    let now = 1_800_000_000_000;
    let refreshCalls = 0;
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/oauth/token") {
        refreshCalls += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: "oauth-new",
            refresh_token: "refresh-new",
            expires_in: 3600,
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: {
        now: () => now,
        seedClaude: async () =>
          claudeLoginSeed({ expiresAt: now + 10 * 60 * 1_000 }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    expect(refreshCalls).toBe(0);
    now += 6 * 60 * 1_000;
    let releaseSecretReads = () => {};
    const secretReadsReleased = new Promise<void>((resolve) => {
      releaseSecretReads = resolve;
    });
    const readSecret = AccountStore.prototype.readSecret;
    const pendingSecretReads: ReturnType<typeof readSecret>[] = [];
    const readSecretSpy = vi
      .spyOn(AccountStore.prototype, "readSecret")
      .mockImplementation(async function (this: AccountStore, accountId) {
        const reading = readSecret.call(this, accountId);
        pendingSecretReads.push(reading);
        const secret = await reading;
        await secretReadsReleased;
        return secret;
      });
    const recordUsed = vi.spyOn(AccountStore.prototype, "recordUsed");
    const requests = [1, 2].map(() =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      }),
    );
    try {
      await vi.waitFor(() => {
        expect(recordUsed).toHaveBeenCalledTimes(2);
      });
      await Promise.all(recordUsed.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await Promise.all(pendingSecretReads);
      releaseSecretReads();
      const responses = await Promise.all(requests);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      await Promise.all(responses.map((response) => response.text()));
    } finally {
      releaseSecretReads();
      await Promise.allSettled(requests);
      readSecretSpy.mockRestore();
      recordUsed.mockRestore();
    }
    expect(refreshCalls).toBe(1);
    expect(authorizations).toEqual(["Bearer oauth-new", "Bearer oauth-new"]);
    const secretPath = path.join(
      fixture.dataDir,
      "plugins",
      "account-pool",
      "secrets",
      "accounts",
      `account-${fixture.account.id}.json`,
    );
    const secret = accountSecretSchema.parse(
      JSON.parse(await fs.readFile(secretPath, "utf8")),
    );
    expect(secret).toMatchObject({
      kind: "oauth",
      accessToken: "oauth-new",
      refreshToken: "refresh-new",
    });
    if (process.platform !== "win32") {
      expect((await fs.stat(secretPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("refreshes unrelated accounts independently", async () => {
    let now = 1_800_000_000_000;
    let releaseFirstRefresh = () => {};
    const firstRefreshReleased = new Promise<void>((resolve) => {
      releaseFirstRefresh = resolve;
    });
    const refreshes: string[] = [];
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      if (request.url === "/oauth/token") {
        const { refresh_token } = z
          .object({ refresh_token: z.string() })
          .parse(JSON.parse((await readRequestBody(request)).toString()));
        refreshes.push(refresh_token);
        if (refresh_token === "refresh-1") await firstRefreshReleased;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            access_token: `new-${refresh_token}`,
            refresh_token: `next-${refresh_token}`,
            expires_in: 3600,
          }),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    let imported = 0;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: {
        now: () => now,
        seedClaude: async () => {
          imported += 1;
          return claudeLoginSeed({
            accessToken: `access-${imported}`,
            refreshToken: `refresh-${imported}`,
            email: `account-${imported}@example.com`,
            expiresAt: now + 10 * 60 * 1_000,
          });
        },
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    const second = accountSchema.parse(
      await addOAuthAccount(fixture.host, {
        provider: "claude",
        label: "second",
        priority: 200,
      }),
    );
    expect(refreshes).toEqual([]);
    now += 6 * 60 * 1_000;
    const requests: Promise<Response>[] = [];
    try {
      requests.push(
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      await vi.waitFor(() => {
        expect(refreshes).toEqual(["refresh-1"]);
      });
      await fixture.host.harness.behavior.callRpc("account.disable", {
        id: fixture.account.id,
      });
      requests.push(
        fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
          headers: authHeaders(fixture.key),
          body: "{}",
        }),
      );
      await vi.waitFor(() => {
        expect(authorizations).toEqual(["Bearer new-refresh-2"]);
      });
    } finally {
      releaseFirstRefresh();
      await Promise.allSettled(requests);
    }
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await Promise.all(responses.map((response) => response.text()));
    expect(refreshes).toEqual(["refresh-1", "refresh-2"]);
    expect(authorizations).toEqual([
      "Bearer new-refresh-2",
      "Bearer new-refresh-1",
    ]);
  });

  describe.each<{ provider: "claude" | "codex"; route: string }>([
    { provider: "claude", route: "/v1/messages" },
    { provider: "codex", route: "/v1/responses" },
  ])("$provider OAuth refresh recovery", ({ provider, route }) => {
    it.each([
      {
        name: "uses valid tokens during temporary failure and retries after backoff",
        elapsedMinutes: 6,
        failureStatus: 503,
        expectedStatus: 200,
      },
      {
        name: "temporarily rejects expired tokens and recovers after backoff",
        elapsedMinutes: 11,
        failureStatus: 503,
        expectedStatus: 503,
      },
      {
        name: "keeps invalid_grant accounts excluded despite a valid access token",
        elapsedMinutes: 6,
        failureStatus: 400,
        expectedStatus: 429,
      },
    ])("$name", async ({ elapsedMinutes, failureStatus, expectedStatus }) => {
      let now = 1_800_000_000_000;
      const expiresAt = now + 10 * 60 * 1_000;
      const oldToken = testJwt({ exp: expiresAt / 1_000 });
      const newToken = testJwt({ exp: now / 1_000 + 3600 });
      let refreshStatus = failureStatus;
      let refreshCalls = 0;
      const authorizations: Array<string | undefined> = [];
      const upstream = await startUpstream(async (request, response) => {
        await readRequestBody(request);
        response.writeHead(
          request.url === "/oauth/token" ? refreshStatus : 200,
          { "content-type": "application/json" },
        );
        if (request.url === "/oauth/token") {
          refreshCalls += 1;
          response.end(
            JSON.stringify(
              refreshStatus === 200
                ? {
                    access_token: newToken,
                    refresh_token: "new-refresh",
                    expires_in: 3600,
                  }
                : {
                    error:
                      refreshStatus === 400
                        ? "invalid_grant"
                        : "temporarily_unavailable",
                  },
            ),
          );
          return;
        }
        authorizations.push(request.headers.authorization);
        response.end("{}");
      });
      cleanups.push(upstream.close);
      const fixture = await createFixture({
        upstreamUrl: upstream.url,
        provider,
        source: "oauth",
        options: {
          now: () => now,
          seedClaude: async () =>
            claudeLoginSeed({ accessToken: oldToken, expiresAt }),
          seedCodex: async () => ({
            accessToken: oldToken,
            refreshToken: "old-refresh",
            idToken: null,
            accountId: "chatgpt-account",
            email: "codex@example.com",
            expiresAt,
          }),
          refreshUrl: `${upstream.url}/oauth/token`,
          codexRefreshUrl: `${upstream.url}/oauth/token`,
          codexUsageUrl: EMPTY_USAGE_URL,
        },
      });
      expect(refreshCalls).toBe(0);
      now += elapsedMinutes * 60 * 1_000;
      for (let request = 0; request < 2; request += 1) {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          route,
          { headers: authHeaders(fixture.key), body: "{}" },
        );
        await response.text();
        expect(response.status).toBe(expectedStatus);
        expect(refreshCalls).toBe(1);
      }
      const accounts = z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        );
      expect(accounts[0]?.error).toEqual(
        failureStatus === 400
          ? expect.stringContaining("OAuth refresh failed")
          : null,
      );
      expect(authorizations).toEqual(
        expectedStatus === 200
          ? [`Bearer ${oldToken}`, `Bearer ${oldToken}`]
          : [],
      );
      refreshStatus = 200;
      now += 1_000;
      const recovered = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        route,
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await recovered.text();
      expect(recovered.status).toBe(failureStatus === 400 ? 429 : 200);
      expect(refreshCalls).toBe(failureStatus === 400 ? 1 : 2);
      if (failureStatus !== 400) {
        expect(authorizations.at(-1)).toBe(`Bearer ${newToken}`);
        const recoveredAccounts = z
          .array(accountSummarySchema)
          .parse(
            await fixture.host.harness.behavior.callRpc("account.list", null),
          );
        expect(recoveredAccounts[0]?.error).toBeNull();
      }
    });
  });

  it("expires fallback tokens during refresh backoff and caps Retry-After", async () => {
    let now = 1_800_000_000_000;
    const expiresAt = now + 10 * 60 * 1_000;
    let refreshCalls = 0;
    let refreshStatus = 503;
    const authorizations: Array<string | undefined> = [];
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      if (request.url === "/oauth/token") {
        refreshCalls += 1;
        response.writeHead(refreshStatus, {
          "content-type": "application/json",
          "retry-after": "120",
        });
        response.end(
          JSON.stringify(
            refreshStatus === 503
              ? { error: "temporarily_unavailable" }
              : { access_token: "oauth-new", expires_in: 3600 },
          ),
        );
        return;
      }
      authorizations.push(request.headers.authorization);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: {
        now: () => now,
        seedClaude: async () => claudeLoginSeed({ expiresAt }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    now = expiresAt - 500;
    const attempts: Array<
      [advanceMs: number, expectedStatus: number, expectedRefreshes: number]
    > = [
      [0, 200, 1],
      [500, 503, 1],
      [59_499, 503, 1],
      [1, 200, 2],
    ];
    for (const [advanceMs, expectedStatus, expectedRefreshes] of attempts) {
      now += advanceMs;
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      await response.text();
      expect(response.status).toBe(expectedStatus);
      expect(refreshCalls).toBe(expectedRefreshes);
      refreshStatus = 200;
    }
    expect(authorizations).toEqual(["Bearer oauth-access", "Bearer oauth-new"]);
  });

  it("marks refresh and upstream authorization failures as account errors", async () => {
    const upstream = await startUpstream((request, response) => {
      if (request.url === "/oauth/token") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end("{}");
        return;
      }
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":{"message":"bad account"}}');
    });
    cleanups.push(upstream.close);
    const refreshFixture = await createFixture({
      upstreamUrl: upstream.url,
      source: "oauth",
      options: {
        seedClaude: async () =>
          claudeLoginSeed({ expiresAt: Date.now() + 1_000 }),
        refreshUrl: `${upstream.url}/oauth/token`,
      },
    });
    const refreshResponse =
      await refreshFixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(refreshFixture.key), body: "{}" },
      );
    expect(refreshResponse.status).toBe(429);
    const refreshAccounts = z
      .array(accountSummarySchema)
      .parse(
        await refreshFixture.host.harness.behavior.callRpc(
          "account.list",
          null,
        ),
      );
    expect(refreshAccounts[0]?.status).toBe("error");
    expect(refreshAccounts[0]?.error).toContain("OAuth refresh failed");

    const authFixture = await createFixture({ upstreamUrl: upstream.url });
    const authResponse = await authFixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(authFixture.key), body: "{}" },
    );
    expect(authResponse.status).toBe(401);
    await authResponse.text();
    const authAccounts = z
      .array(accountSummarySchema)
      .parse(
        await authFixture.host.harness.behavior.callRpc("account.list", null),
      );
    expect(authAccounts[0]?.status).toBe("error");
    expect(authAccounts[0]?.error).toContain("bad account");
  });

  it("suppresses env and health only for the provider whose routing is off", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        fetch: async () => Response.json({}),
        codexUsageUrl: EMPTY_USAGE_URL,
        seedCodex: async () => ({
          accessToken: "codex-access",
          refreshToken: "codex-refresh",
          idToken: "codex-id",
          accountId: "chatgpt-account",
          email: "codex@example.com",
          expiresAt: Date.now() + 60_000,
        }),
      },
    });
    await addOAuthAccount(fixture.host, {
      provider: "codex",
      label: null,
      priority: 100,
    });
    const disabled = await fixture.host.harness.behavior.runCli([
      "routing",
      "claude",
      "--off",
    ]);
    expect(disabled).toMatchObject({ exitCode: 0 });
    await expect(
      fixture.host.harness.behavior.resolveProviderEnv("claude-code", {
        threadId: "thread-off",
        projectId: "project-one",
        hostId: "host-one",
      }),
    ).resolves.toEqual([]);
    await expect(
      fixture.host.harness.behavior.resolveProviderEnvHealth("claude-code", {
        hostId: "host-one",
      }),
    ).resolves.toBeNull();
    await expect(resolveCodexToken(fixture.host)).resolves.toMatchObject({
      baseUrl: "/api/v1/plugins/account-pool-prewarm/http/v1",
    });
    const result = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(result.routing).toEqual({ claude: false, codex: true });
  });

  it("records the selected account's last-use time and host", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    let now = 1_800_000_000_000;
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => now },
    });
    const changedCount = () =>
      fixture.host.harness.inspection.realtimeSignals.filter(
        (signal) => signal.channel === "accounts-changed",
      ).length;
    const baseline = changedCount();
    const forward = async (key: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(key), body: "{}" },
      );
      await response.text();
    };
    await forward(fixture.key);
    expect(changedCount()).toBe(baseline + 1);
    now += 1_000;
    await forward(fixture.key);
    expect(changedCount()).toBe(baseline + 1);
    const secondHostKey = await resolveToken(
      fixture.host,
      "host-two",
      "thread-two",
    );
    await forward(secondHostKey);
    expect(changedCount()).toBe(baseline + 2);
    const result = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(result.accounts[0]).toMatchObject({
      lastUsedAt: now,
      lastUsedHostId: "host-two",
      lastUsedHostName: "Two",
    });
  });

  it("sets priority, refreshes one account, and returns status over RPC", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const priority = z.object({ account: accountSchema.nullable() }).parse(
      await fixture.host.harness.behavior.callRpc("account.setPriority", {
        accountId: fixture.account.id,
        priority: 42,
      }),
    );
    expect(priority.account?.priority).toBe(42);
    const refreshed = z
      .object({ account: accountSummarySchema.nullable() })
      .parse(
        await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
          accountId: fixture.account.id,
        }),
      );
    expect(refreshed.account?.id).toBe(fixture.account.id);
    expect(
      statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      ).accounts[0]?.priority,
    ).toBe(42);
  });

  it("drains completed streams and aborts a stuck stream after the stop deadline", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: started\n\n");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { drainTimeoutMs: 40 },
    });
    const response = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: authHeaders(fixture.key),
        body: "{}",
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected a streaming body.");
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: started\n\n");
    const startedAt = Date.now();
    fixture.service.controller.abort();
    await fixture.service.done;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    const stopped = await reader.read();
    expect(new TextDecoder().decode(stopped.value)).toContain(
      "Account Pooler stopped",
    );
    const rejected = await fixture.host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: authHeaders(fixture.key), body: "{}" },
    );
    expect(rejected.status).toBe(503);
  });
});

describe("hub stop and OAuth refresh", () => {
  it("lets an in-flight OAuth refresh finish and persist before the hub stops", async () => {
    let refreshCalls = 0;
    const gate = deferred();
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          await gate.promise;
          return Response.json({
            access_token: "oauth-rotated",
            refresh_token: "oauth-refresh-rotated",
            expires_in: 3600,
          });
        }
        const authorization = new Headers(init?.headers).get("authorization");
        return authorization === "Bearer oauth-old"
          ? Response.json({ error: { message: "expired" } }, { status: 401 })
          : Response.json({});
      },
      Date.now,
      { drainTimeoutMs: 10 },
    );
    const request = fixture.host.harness.behavior
      .fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      })
      .catch(() => null);
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    let stopped = false;
    fixture.service.controller.abort();
    const done = fixture.service.done.then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stopped).toBe(false);
    gate.resolve();
    await done;
    await request;
    const store = new AccountStore(
      fixture.host.bb.storage.kv,
      path.join(fixture.dataDir, "plugins", fixture.host.bb.pluginId, "secrets", "accounts"),
    );
    expect(await store.readSecret(fixture.account.id)).toMatchObject({
      kind: "oauth",
      accessToken: "oauth-rotated",
      refreshToken: "oauth-refresh-rotated",
    });
  });

  it("starts no new OAuth refresh once the hub has stopped", async () => {
    let clock = Date.now();
    let refreshCalls = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return Response.json({ access_token: "oauth-late", expires_in: 3600 });
        }
        return Response.json({});
      },
      () => clock,
    );
    fixture.service.controller.abort();
    await fixture.service.done;
    clock += 2 * 60 * 60 * 1_000;
    await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: fixture.account.id,
    });
    expect(refreshCalls).toBe(0);
    const store = new AccountStore(
      fixture.host.bb.storage.kv,
      path.join(fixture.dataDir, "plugins", fixture.host.bb.pluginId, "secrets", "accounts"),
    );
    expect(await store.readSecret(fixture.account.id)).toMatchObject({
      accessToken: "oauth-old",
    });
    expect(
      new QuotaStore(fixture.host.bb.storage.database()).get(fixture.account.id)
        .error,
    ).toBeNull();
  });

  it("stops waiting for a hung refresh after the refresh drain bound", async () => {
    let refreshCalls = 0;
    const fixture = await createOAuthRequestFixture(
      "claude",
      async (input, init) => {
        if (String(input).endsWith("/oauth/token")) {
          refreshCalls += 1;
          return new Promise<Response>(() => {});
        }
        const authorization = new Headers(init?.headers).get("authorization");
        return authorization === "Bearer oauth-old"
          ? Response.json({ error: { message: "expired" } }, { status: 401 })
          : Response.json({});
      },
      Date.now,
      { drainTimeoutMs: 10, refreshDrainTimeoutMs: 50 },
    );
    void fixture.host.harness.behavior
      .fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body: "{}",
      })
      .catch(() => null);
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    const startedAt = Date.now();
    fixture.service.controller.abort();
    await fixture.service.done;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe("sequential pool recovery", () => {
  const body = JSON.stringify({
    model: "claude-opus-4-1",
    metadata: { user_id: JSON.stringify({ session_id: "review-session" }) },
  });

  it("bounds repeated waits when a session's rate-limit hold keeps extending", async () => {
    let attempts = 0;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      options: {
        now: () => 1_800_000_000_000,
        fetch: async () =>
          ++attempts === 1
            ? Response.json({})
            : Response.json(
                {},
                { status: 429, headers: { "retry-after": "0.01" } },
              ),
      },
    });
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
        signal: AbortSignal.timeout(1_000),
      });
    await (await send()).text();
    const paced = await send();
    expect(paced.status).toBe(429);
    await paced.text();
    const held = await send();
    expect(held.status).toBe(429);
    await held.text();
    expect(attempts).toBe(3);
  });

  it("keeps a paced session on its account when another request arrives during a short hold", async () => {
    const attempts: Array<string | null> = [];
    let now = 1_800_000_000_000;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        now: () => now,
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return attempts.length === 2
            ? Response.json(
                {},
                {
                  status: 429,
                  headers: {
                    "retry-after": "0.25",
                    "anthropic-ratelimit-unified-5h-status": "allowed",
                    "anthropic-ratelimit-unified-overage-status": "rejected",
                  },
                },
              )
            : Response.json({});
        },
      },
    });
    await addApiAccount(fixture, "sk-second");
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
      });
    await (await send()).text();
    const paced = send();
    try {
      await vi.waitFor(async () => {
        const status = statusSchema.parse(
          await fixture.host.harness.behavior.callRpc("status.get", null),
        );
        expect(
          status.accounts.find((account) => account.id === fixture.account.id)
            ?.status,
        ).toBe("held");
      });
      const duringHold = send();
      now += 249;
      const duringHoldResponse = await duringHold;
      expect(duringHoldResponse.status).toBe(200);
      await duringHoldResponse.text();
      now += 1;
      await (await paced).text();
      await (await send()).text();
      expect(attempts).toEqual([
        "sk-first",
        "sk-first",
        "sk-first",
        "sk-first",
        "sk-first",
      ]);
    } finally {
      const response = await paced;
      if (!response.bodyUsed) await response.text();
    }
  });

  it("keeps the last working binding after every account fails during a provider outage", async () => {
    const attempts: Array<string | null> = [];
    let outage = false;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        fetch: async (_input, init) => {
          attempts.push(new Headers(init?.headers).get("x-api-key"));
          return Response.json({}, { status: outage ? 503 : 200 });
        },
      },
    });
    await addApiAccount(fixture, "sk-second");
    const send = () =>
      fixture.host.harness.behavior.fetchHttp("POST", "/v1/messages", {
        headers: authHeaders(fixture.key),
        body,
      });
    await (await send()).text();
    outage = true;
    const failed = await send();
    expect(failed.status).toBe(503);
    await failed.text();
    outage = false;
    await (await send()).text();
    expect(attempts).toEqual(["sk-first", "sk-first", "sk-second", "sk-first"]);
  });

  it("keeps Codex over-limit accounts ineligible until reset when utilization is omitted", async () => {
    let imported = 0;
    const attempts: Array<string | null> = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "codex",
      source: "oauth",
      options: {
        codexUsageUrl: EMPTY_USAGE_URL,
        seedCodex: async () => ({
          accessToken: imported++ === 0 ? "sk-first" : "sk-second",
          refreshToken: "refresh",
          idToken: null,
          accountId: `review-codex-account-${imported}`,
          email: null,
          expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        }),
        fetch: async (input, init) => {
          if (String(input) === EMPTY_USAGE_URL) return Response.json({});
          const key = new Headers(init?.headers).get("authorization");
          attempts.push(key);
          return key === "Bearer sk-first"
            ? Response.json(
                {},
                {
                  status: 429,
                  headers: {
                    "x-codex-primary-over-limit": "true",
                    "x-codex-primary-reset-after-seconds": "60",
                    "x-codex-primary-window-minutes": "300",
                  },
                },
              )
            : Response.json({});
        },
      },
    });
    await addOAuthAccount(fixture.host, {
      provider: "codex",
      label: null,
      priority: 100,
    });
    for (const session of ["first-session", "second-session"]) {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: { ...authHeaders(fixture.key), "thread-id": session },
          body: "{}",
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(attempts).toEqual([
      "Bearer sk-first",
      "Bearer sk-second",
      "Bearer sk-second",
    ]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(
      status.accounts.find((account) => account.id === fixture.account.id)
        ?.status,
    ).toBe("exhausted");
  });

  it.each([
    ["funded", { has_credits: true, unlimited: false }, null, 200],
    ["unlimited", { has_credits: false, unlimited: true }, null, 200],
    ["depleted", { has_credits: false, unlimited: false }, null, 429],
    ["unknown", null, null, 429],
    [
      "spending cap",
      { has_credits: true, unlimited: true },
      { reached: true },
      429,
    ],
    [
      "individual cap",
      { has_credits: true, unlimited: false },
      {
        reached: false,
        individual_limit: { remaining_percent: 0, reset_at: 4102444800 },
      },
      429,
    ],
  ])(
    "routes Codex credit fallback with %s allowance",
    async (_label, credits, spendControl, expected) => {
      let calls = 0;
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        provider: "codex",
        source: "oauth",
        options: {
          codexUsageUrl: "https://upstream.example/usage",
          seedCodex: async () => ({
            accessToken: "codex-credit",
            refreshToken: "refresh",
            expiresAt: Date.now() + 3600000,
            idToken: null,
            accountId: "codex-qa",
            email: null,
          }),
          fetch: async (input) => {
            if (new URL(String(input)).pathname === "/usage")
              return Response.json({
                rate_limit: {
                  primary_window: {
                    used_percent: spendControl === null ? 100 : 10,
                    reset_at: 4102444800,
                  },
                },
                credits,
                spend_control: spendControl,
              });
            calls++;
            return Response.json({ ok: true });
          },
        },
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        { headers: authHeaders(fixture.key), body: "{}" },
      );
      expect(response.status).toBe(expected);
      await response.text();
      expect(calls).toBe(expected === 200 ? 1 : 0);
      const report = statusSchema.parse(
        await fixture.host.harness.behavior.callRpc("status.get", null),
      );
      expect(report.accounts[0]?.extraUsage?.status ?? null).toBe(
        credits === null ? null : expected === 200 ? "allowed" : "rejected",
      );
    },
  );

  it("returns Codex paid pins to recovered subscriptions and persists spending restrictions", async () => {
    let now = Date.now();
    let imports = 0;
    let includedPercent = 10;
    let spendingBlocked = false;
    const calls: string[] = [];
    const options: TestPluginOptions = {
      now: () => now,
      codexUsageUrl: "https://upstream.example/usage",
      seedCodex: async () => ({
        accessToken: ++imports === 1 ? "paid" : "included",
        refreshToken: "refresh",
        expiresAt: now + 3600000,
        idToken: null,
        accountId: "codex-qa",
        email: null,
      }),
      fetch: async (input, init) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        if (new URL(String(input)).pathname === "/usage")
          return Response.json({
            rate_limit: {
              primary_window: {
                used_percent: auth === "Bearer paid" ? 100 : includedPercent,
                reset_at: 4102444800,
              },
            },
            credits: {
              has_credits: auth === "Bearer paid",
              unlimited: false,
            },
          });
        calls.push(auth);
        return spendingBlocked
          ? Response.json(
              {},
              {
                status: 429,
                headers: {
                  "x-codex-rate-limit-reached-type":
                    "workspace_member_usage_limit_reached",
                },
              },
            )
          : Response.json({ ok: true });
      },
    };
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      provider: "codex",
      source: "oauth",
      priority: 1,
      options,
    });
    const second = accountSchema.parse(
      await addOAuthAccount(fixture.host, {
        provider: "codex",
        label: "Included",
        priority: 2,
      }),
    );
    let host = fixture.host;
    const send = async () => {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/responses",
        {
          headers: {
            ...authHeaders(fixture.key),
            "session-id": "credit-session",
          },
          body: "{}",
        },
      );
      await response.text();
      return response.status;
    };
    expect(await send()).toBe(200);
    includedPercent = 100;
    await host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: second.id,
    });
    expect(await send()).toBe(200);
    includedPercent = 10;
    now += 30000;
    expect(await send()).toBe(200);
    expect(calls).toEqual([
      "Bearer included",
      "Bearer paid",
      "Bearer included",
    ]);
    includedPercent = 100;
    await host.harness.behavior.callRpc("account.refreshUsage", {
      accountId: second.id,
    });
    spendingBlocked = true;
    expect(await send()).toBe(429);
    host = await host.harness.lifecycle.reload(
      testPlugin(options),
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
    });
    await vi.waitFor(async () =>
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true),
    );
    expect(await send()).toBe(429);
    expect(calls).toHaveLength(4);
    expect(
      statusSchema
        .parse(await host.harness.behavior.callRpc("status.get", null))
        .accounts.find((a) => a.id === fixture.account.id)?.usageRestriction
        ?.reason,
    ).toBe("workspace_member_usage_limit_reached");
  });

  it.each([
    [
      "enabled",
      {
        is_enabled: true,
        monthly_limit: 1000,
        used_credits: 100,
        utilization: 10,
      },
      200,
    ],
    [
      "unlimited",
      {
        is_enabled: true,
        monthly_limit: null,
        used_credits: 100,
        utilization: null,
      },
      200,
    ],
    [
      "disabled",
      { is_enabled: false, monthly_limit: 1000, used_credits: 0 },
      429,
    ],
    [
      "spent",
      { is_enabled: true, monthly_limit: 1000, used_credits: 1000 },
      429,
    ],
    ["100 percent", { is_enabled: true, utilization: 100 }, 429],
    ["unobserved", null, 429],
  ])(
    "routes exhausted Claude accounts with %s extra usage",
    async (_name, extraUsage, expectedStatus) => {
      const calls: string[] = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        source: "oauth",
        options: {
          usageUrl: "https://upstream.example/usage",
          seedClaude: async () => claudeLoginSeed(),
          fetch: async (input) => {
            const pathname = new URL(String(input)).pathname;
            if (pathname === "/usage")
              return Response.json({
                five_hour: { utilization: 100, resets_at: "4102444800" },
                extra_usage: extraUsage,
              });
            calls.push(pathname);
            return Response.json({ ok: true });
          },
        },
      });
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body,
        },
      );
      expect(response.status).toBe(expectedStatus);
      await response.text();
      expect(calls).toEqual(expectedStatus === 200 ? ["/v1/messages"] : []);
      const status = await fixture.host.harness.behavior.runCli([
        "status",
        "--json",
      ]);
      expect(
        statusReportSchema.parse(JSON.parse(status.stdout)).accounts[0],
      ).toMatchObject({
        status: expectedStatus === 200 ? "ready" : "exhausted",
        extraUsage:
          extraUsage === null
            ? null
            : {
                status: expectedStatus === 200 ? "allowed" : "rejected",
                source: "usage",
              },
      });
    },
  );

  it.each(["shared", "family"])(
    "prefers subscription quota over %s extra usage and leaves paid pins on recovery",
    async (scope) => {
      let now = Date.now();
      let firstPercent = 100;
      let secondPercent = 10;
      let importCount = 0;
      const attempts: string[] = [];
      const fixture = await createFixture({
        upstreamUrl: "https://upstream.example",
        source: "oauth",
        priority: 1,
        options: {
          now: () => now,
          usageUrl: "https://upstream.example/usage",
          seedClaude: async () =>
            claudeLoginSeed({
              accessToken: ++importCount === 1 ? "paid" : "included",
            }),
          fetch: async (input, init) => {
            const key = new Headers(init?.headers).get("authorization");
            if (new URL(String(input)).pathname === "/usage")
              return Response.json({
                [scope === "shared" ? "five_hour" : "seven_day_opus"]: {
                  utilization:
                    key === "Bearer paid" ? firstPercent : secondPercent,
                  resets_at: "4102444800",
                },
                extra_usage: {
                  is_enabled: key === "Bearer paid",
                  monthly_limit: 1000,
                  used_credits: 0,
                },
              });
            attempts.push(key ?? "missing");
            return Response.json({ ok: true });
          },
        },
      });
      const second = accountSchema.parse(
        await addOAuthAccount(fixture.host, {
          provider: "claude",
          label: "included",
          priority: 2,
        }),
      );
      const send = async (id: string) => {
        const response = await fixture.host.harness.behavior.fetchHttp(
          "POST",
          "/v1/messages",
          {
            headers: authHeaders(fixture.key),
            body: JSON.stringify({
              model: "claude-opus-4-1",
              metadata: { user_id: JSON.stringify({ session_id: id }) },
            }),
          },
        );
        expect(response.status).toBe(200);
        await response.text();
      };
      await send("pinned");
      secondPercent = 100;
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: second.id,
      });
      await send("pinned");
      await send("new-paid");
      secondPercent = 10;
      now += 30_000;
      await send("new-paid");
      await send("new-included");
      firstPercent = 0;
      await fixture.host.harness.behavior.callRpc("account.refreshUsage", {
        accountId: fixture.account.id,
      });
      await send("new-included");
      expect(attempts).toEqual([
        "Bearer included",
        "Bearer paid",
        "Bearer paid",
        "Bearer included",
        "Bearer included",
        "Bearer included",
      ]);
    },
  );

  it("learns extra usage from headers, preserves it across restart, and stops on an overage rejection", async () => {
    let rejectOverage = false;
    let upstreamCalls = 0;
    const options: TestPluginOptions = {
      usageUrl: "https://upstream.example/usage",
      seedClaude: async () => claudeLoginSeed(),
      fetch: async (input) => {
        if (new URL(String(input)).pathname === "/usage")
          return Response.json({});
        upstreamCalls++;
        return Response.json(
          {},
          {
            status: rejectOverage ? 429 : 200,
            headers: {
              "anthropic-ratelimit-unified-5h-utilization": "1",
              "anthropic-ratelimit-unified-5h-status": "rejected",
              "anthropic-ratelimit-unified-5h-reset": "4102444800",
              "anthropic-ratelimit-unified-overage-status": rejectOverage
                ? "rejected"
                : "allowed_warning",
            },
          },
        );
      },
    };
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "oauth",
      options,
    });
    let host = fixture.host;
    const send = async () => {
      const response = await host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
      return response.status;
    };
    expect(await send()).toBe(200);
    host = await host.harness.lifecycle.reload(
      testPlugin(options),
    );
    const service = host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      service.controller.abort();
      await service.done;
      await host.harness.lifecycle.dispose();
    });
    await vi.waitFor(async () => {
      expect(
        statusSchema.parse(
          await host.harness.behavior.callRpc("status.get", null),
        ).accepting,
      ).toBe(true);
    });
    expect(await send()).toBe(200);
    rejectOverage = true;
    expect(await send()).toBe(429);
    expect(await send()).toBe(429);
    expect(upstreamCalls).toBe(3);
  });

  it("refreshes exhausted usage before refusing a request, at most every 30 seconds per account", async () => {
    let now = Date.now();
    let usagePercent = 100;
    const calls: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "oauth",
      options: {
        now: () => now,
        usageUrl: "https://upstream.example/usage",
        seedClaude: async () => claudeLoginSeed(),
        fetch: async (input) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          if (url.pathname === "/usage")
            return Response.json({
              seven_day: {
                utilization: usagePercent,
                resets_at: String(Math.floor(now / 1_000) + 3 * 86_400),
              },
            });
          return Response.json({});
        },
      },
    });
    const send = async () => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
      return response.status;
    };
    expect(calls).toEqual(["/usage"]);
    expect(await send()).toBe(429);
    now += 30_000;
    expect(await send()).toBe(429);
    expect(await send()).toBe(429);
    usagePercent = 30;
    expect(await send()).toBe(429);
    now += 30_000;
    expect(await send()).toBe(200);
    expect(calls).toEqual(["/usage", "/usage", "/usage", "/v1/messages"]);
  });

  it("lets concurrent requests share an exhausted-usage recheck", async () => {
    let now = Date.now();
    let usagePercent = 100;
    let releaseUsage = () => {};
    const usageGate = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    const calls: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      source: "oauth",
      options: {
        now: () => now,
        usageUrl: "https://upstream.example/usage",
        seedClaude: async () => claudeLoginSeed(),
        fetch: async (input) => {
          const url = new URL(String(input));
          calls.push(url.pathname);
          if (url.pathname === "/usage") {
            if (usagePercent < 100) await usageGate;
            return Response.json({
              seven_day: {
                utilization: usagePercent,
                resets_at: String(Math.floor(now / 1_000) + 3 * 86_400),
              },
            });
          }
          return Response.json({});
        },
      },
    });
    const send = async () => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        { headers: authHeaders(fixture.key), body },
      );
      await response.text();
      return response.status;
    };
    usagePercent = 30;
    now += 30_000;
    const statuses = Promise.all([send(), send()]);
    await vi.waitFor(() => expect(calls).toEqual(["/usage", "/usage"]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseUsage();
    expect(await statuses).toEqual([200, 200]);
    expect(calls).toEqual(["/usage", "/usage", "/v1/messages", "/v1/messages"]);
  });

  it("applies reordered failover atomically without moving current conversations", async () => {
    const attempts: Array<string | null> = [];
    let rejectFirst = false;
    let rejectThird = false;
    const fixture = await createFixture({
      upstreamUrl: "https://upstream.example",
      apiKey: "sk-first",
      options: {
        fetch: async (_input, init) => {
          const key = new Headers(init?.headers).get("x-api-key");
          attempts.push(key);
          return Response.json(
            {},
            {
              status:
                (key === "sk-first" && rejectFirst) ||
                (key === "sk-third" && rejectThird)
                  ? 503
                  : 200,
            },
          );
        },
      },
    });
    const second = await addApiAccount(fixture, "sk-second");
    const third = await addApiAccount(fixture, "sk-third");
    const send = async (session: string) => {
      const response = await fixture.host.harness.behavior.fetchHttp(
        "POST",
        "/v1/messages",
        {
          headers: authHeaders(fixture.key),
          body: JSON.stringify({
            metadata: { user_id: JSON.stringify({ session_id: session }) },
          }),
        },
      );
      expect(response.status).toBe(200);
      await response.text();
    };
    await send("original");
    const reorder = await fixture.host.harness.behavior.runCli([
      "account",
      "reorder",
      "claude",
      fixture.account.id,
      third.id,
      second.id,
    ]);
    expect(reorder.exitCode).toBe(0);
    const ordered = z
      .array(accountSummarySchema)
      .parse(await fixture.host.harness.behavior.callRpc("account.list", null));
    expect(ordered.map((account) => account.id)).toEqual([
      fixture.account.id,
      third.id,
      second.id,
    ]);
    const persisted = z
      .array(accountSchema)
      .parse(await fixture.host.bb.storage.kv.get("accounts:v1"));
    expect(
      persisted.find((account) => account.id === third.id)?.priority,
    ).toBeLessThan(
      persisted.find((account) => account.id === second.id)?.priority ?? 0,
    );
    for (const accountIds of [
      [fixture.account.id],
      [fixture.account.id, third.id, third.id],
      [fixture.account.id, third.id, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    ]) {
      await expect(
        fixture.host.harness.behavior.callRpc("account.reorder", {
          provider: "claude",
          accountIds,
        }),
      ).rejects.toThrow("exactly once");
    }
    expect(await fixture.host.bb.storage.kv.get("accounts:v1")).toEqual(
      persisted,
    );
    await send("new-before-failover");
    rejectFirst = true;
    await send("advance");
    rejectFirst = false;
    await send("new-after-recovery");
    rejectThird = true;
    await send("advance-again");
    expect(attempts).toEqual([
      "sk-first",
      "sk-first",
      "sk-first",
      "sk-third",
      "sk-third",
      "sk-third",
      "sk-second",
    ]);
    const negativePriority = await fixture.host.harness.behavior.runCli([
      "account",
      "priority",
      second.id,
      "-1",
    ]);
    expect(negativePriority.exitCode, negativePriority.stderr).toBe(0);
    const priority = await fixture.host.harness.behavior.runCli([
      "account",
      "priority",
      second.id,
      "0",
    ]);
    expect(priority.exitCode).toBe(0);
    expect(
      z
        .array(accountSummarySchema)
        .parse(
          await fixture.host.harness.behavior.callRpc("account.list", null),
        )[0]?.id,
    ).toBe(second.id);
  });
});

it("logs a sanitized transport cause when pooled fetch fails", async () => {
  const fixture = await createFixture({
    upstreamUrl: "https://upstream.example",
    options: {
      fetch: async () => {
        throw new TypeError("fetch failed with private request data", {
          cause: Object.assign(
            new Error("The session has been destroyed: secret-token"),
            {
              code: "ERR_HTTP2_INVALID_SESSION",
            },
          ),
        });
      },
    },
  });
  const response = await fixture.host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: authHeaders(fixture.key),
      body: "{}",
    },
  );
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("secret-token");
  expect(fixture.host.harness.inspection.logEntries).toContainEqual({
    level: "warn",
    message:
      "Account Pooler claude transport failed: ERR_HTTP2_INVALID_SESSION.",
  });
  expect(
    JSON.stringify(fixture.host.harness.inspection.logEntries),
  ).not.toContain("secret-token");
  expect(
    JSON.stringify(fixture.host.harness.inspection.logEntries),
  ).not.toContain("private request data");
});

it("drains a streamed response before disposing the owned transport", async () => {
  const finish = deferred();
  const upstream = await startUpstream(async (request, response) => {
    await readRequestBody(request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("first");
    await finish.promise;
    response.end("last");
  });
  cleanups.push(upstream.close);
  const hooks: Array<() => void | Promise<void>> = [];
  const fixture = await createFixture({
    upstreamUrl: upstream.url,
    beforePlugin(host) {
      const register = host.bb.onDispose.bind(host.bb);
      vi.spyOn(host.bb, "onDispose").mockImplementation((hook) => {
        hooks.push(hook);
        register(hook);
      });
    },
  });
  const response = await fixture.host.harness.behavior.fetchHttp(
    "POST",
    "/v1/messages",
    {
      headers: authHeaders(fixture.key),
      body: "{}",
    },
  );
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Expected a stream");
  expect(new TextDecoder().decode((await reader.read()).value)).toBe("first");
  const disposeTransport = hooks[0];
  if (disposeTransport === undefined)
    throw new Error("Expected transport disposal");
  const tail = reader.read().then(
    (result) => ({
      kind: "chunk",
      text: new TextDecoder().decode(result.value),
    }),
    () => ({ kind: "error", text: "" }),
  );
  const disposing = disposeTransport();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish.resolve();
    expect(await tail).toEqual({ kind: "chunk", text: "last" });
    expect((await reader.read()).done).toBe(true);
    await disposing;
  } finally {
    finish.resolve();
    await reader.cancel().catch(() => undefined);
    await disposing;
  }
});

it("publishes pooled usage without a display plugin and does not invent unobserved utilization", async () => {
  const upstream = await startUpstream((_request, response) => {
    response.end();
  });
  cleanups.push(upstream.close);
  const fixture = await createFixture({ upstreamUrl: upstream.url });
  const inventory = usageResourceListSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageListMethod, {}),
  );
  expect(inventory.label).toBe("Account Pooler");
  expect(inventory.resources).toEqual([
    expect.objectContaining({
      id: fixture.account.id,
      providerId: "claude-code",
      label: fixture.account.label,
      scope: { kind: "shared" },
    }),
  ]);
  const result = usageMeasurementSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
      resourceId: fixture.account.id,
      refresh: false,
    }),
  );
  // An API key has no subscription windows: that is a plan without limits,
  // not a failed measurement, so it must not mark the shared group failed.
  expect(result).toMatchObject({
    observedAt: null,
    usage: { status: "ok", windows: [] },
  });
  expect(
    fixture.host.harness.registrations.experimental_publishedRpcMethods.map(
      (entry) => entry.method,
    ),
  ).toEqual(expect.arrayContaining([usageListMethod, usageFetchMethod]));
});

it("still reports an unobserved subscription account as an error, not as a plan without limits", async () => {
  const now = () => Date.parse("2026-11-15T12:00:00Z");
  const fixture = await createOAuthRequestFixture(
    "claude",
    async () => new Response("unavailable", { status: 503 }),
    now,
  );
  const result = usageMeasurementSchema.parse(
    await fixture.host.harness.behavior.callRpc(usageFetchMethod, {
      resourceId: fixture.account.id,
      refresh: false,
    }),
  );
  expect(result.usage.status).toBe("error");
});

it("publishes an empty shared usage group before any accounts or settings are configured", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bb-empty-usage-pool-"));
  const host = createFakePluginHost({
    pluginId: "account-pool",
    dataDir,
    sdk: sdkStubs(),
  });
  const fetch = vi.fn(async () => {
    throw new Error("An empty pool must not contact an upstream");
  });
  try {
    await testPlugin({ fetch })(host.bb);
    await grantRoles(host);
    expect(
      host.harness.registrations.experimental_publishedRpcMethods.map(
        (entry) => entry.method,
      ),
    ).toContain(usageListMethod);
    await expect(
      host.harness.behavior.callRpc(usageListMethod, {}),
    ).resolves.toEqual({ label: "Account Pooler", resources: [] });
    await expect(
      host.harness.behavior.callRpc(usageFetchMethod, {
        resourceId: "removed",
        refresh: false,
      }),
    ).rejects.toThrow("no longer exists");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await host.harness.lifecycle.dispose();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

describe("Account Pool nested proxy", () => {
  const PARENT_TOKEN = "vqMIj4xUiI3PyvKS2SllSKHsOfxLF_sAZwzNAAvV9TQ";

  interface ParentRecord {
    url: string;
    token: string | null;
    authorization: string | null;
    body: string;
  }

  async function startParent(args: {
    availability?: { claude: boolean; codex: boolean };
    availabilityStatus?: number;
  }): Promise<{ upstream: Upstream; records: ParentRecord[] }> {
    const records: ParentRecord[] = [];
    const upstream = await startUpstream(async (request, response) => {
      const body = await readRequestBody(request);
      records.push({
        url: request.url ?? "",
        token:
          (request.headers["x-bb-account-pool-token"] as string | undefined) ??
          null,
        authorization: request.headers.authorization ?? null,
        body: body.toString("utf8"),
      });
      if ((request.url ?? "").startsWith("/availability")) {
        const status = args.availabilityStatus ?? 200;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify(args.availability ?? { claude: true, codex: true }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
    });
    return { upstream, records };
  }

  async function createChild(args: {
    parentUrl: string | null;
    parentMode?: "proxy" | "isolate";
  }): Promise<ReturnType<typeof createFakePluginHost>> {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "bb-account-pool-child-"),
    );
    const host = createFakePluginHost({
      pluginId: "account-pool",
      dataDir,
      sdk: sdkStubs(),
    });
    if (args.parentMode !== undefined) {
      await host.bb.storage.kv.set("config", { parentMode: args.parentMode });
    }
    await testPlugin({
      usageUrl: "data:application/json,{}",
      availabilityTtlMs: 0,
      env:
        args.parentUrl === null
          ? {}
          : {
              BB_ACCOUNT_POOL_PARENT_URL: args.parentUrl,
              BB_ACCOUNT_POOL_PARENT_TOKEN: PARENT_TOKEN,
            },
    })(host.bb);
    await grantRoles(host);
    host.harness.behavior.runService("hub");
    cleanups.push(async () => {
      await host.harness.lifecycle.dispose();
      await fs.rm(dataDir, { recursive: true, force: true });
    });
    return host;
  }

  it("keeps the Claude catalog alias through a parent pool", async () => {
    const parent = await startUpstream(async (request, response) => {
      if (request.url === "/availability") {
        response.end(JSON.stringify({ claude: true, codex: true })); return;
      }
      expect(request.url).toBe("/models?limit=10");
      expect(request.headers["x-bb-account-pool-token"]).toBe(PARENT_TOKEN);
      expect((await readRequestBody(request)).length).toBe(0);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }));
    });
    cleanups.push(parent.close);
    const child = await createChild({ parentUrl: parent.url });
    const key = await resolveToken(child);
    const response = await child.harness.behavior.fetchHttp("GET", "/models?limit=10", { headers: authHeaders(key) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: [{ id: "claude-opus-5-5" }] });
  });

  it("reads retry availability from the parent and fails closed on an unsupported parent", async () => {
    let supported = true;
    const parent = await startUpstream((request, response) => {
      expect(request.headers["x-bb-account-pool-token"]).toBe(PARENT_TOKEN);
      response.setHeader("content-type", "application/json");
      if (request.url === "/availability")
        response.end(JSON.stringify({ claude: true, codex: true }));
      else {
        expect(request.url).toBe(
          "/retry-availability?provider=claude&family=opus",
        );
        response.statusCode = supported ? 200 : 404;
        response.end(
          JSON.stringify({ kind: "blocked", retryAt: 1_800_003_600_000 }),
        );
      }
    });
    cleanups.push(parent.close);
    const child = await createChild({ parentUrl: parent.url });
    await resolveToken(child);
    const input = { threadId: "thread-one", requestId: "creq_aaaaaaaaaa" };
    expect(
      await child.harness.behavior.callRpc(retryAvailabilityMethod, input),
    ).toEqual({ kind: "blocked", retryAt: 1_800_003_600_000 });
    supported = false;
    expect(
      await child.harness.behavior.callRpc(retryAvailabilityMethod, input),
    ).toEqual({ kind: "unavailable", reason: "source-unavailable" });
  });

  const PROVIDER_ENV = {
    claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
    codex: ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"],
  } as const;

  function envNames(entries: Array<{ name: string }>): string[] {
    return entries.map((entry) => entry.name);
  }

  const neutralised = (provider: "claude" | "codex") =>
    PROVIDER_ENV[provider].map((name) => ({
      name,
      value: "",
      reason:
        "Account Pooler is isolated from the parent bb server's pool on this instance",
    }));

  it.each([
    {
      label: "the instance is set to isolate",
      provider: "claude" as const,
      parentMode: "isolate" as const,
      availability: undefined,
      stopParent: false,
    },
    {
      label: "the parent cannot serve the provider",
      provider: "codex" as const,
      parentMode: undefined,
      availability: { claude: true, codex: false },
      stopParent: false,
    },
    {
      label: "the parent is unreachable",
      provider: "claude" as const,
      parentMode: undefined,
      availability: undefined,
      stopParent: true,
    },
  ])("neutralises inherited routing when $label", async (args) => {
    const parent = await startParent(
      args.availability === undefined
        ? {}
        : { availability: args.availability },
    );
    if (args.stopParent) await parent.upstream.close();
    else cleanups.push(parent.upstream.close);
    const host = await createChild({
      parentUrl: parent.upstream.url,
      ...(args.parentMode === undefined ? {} : { parentMode: args.parentMode }),
    });
    await expect(
      host.harness.behavior.resolveProviderEnv(
        args.provider === "claude" ? "claude-code" : "codex",
        {
          threadId: "thread-one",
          projectId: "project-one",
          hostId: "host-one",
        },
      ),
    ).resolves.toEqual(neutralised(args.provider));
  });

  it("contributes self-pointing routing and the marker while proxying", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const host = await createChild({ parentUrl: parent.upstream.url });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    expect(envNames(entries)).toEqual([
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ENABLE_TOOL_SEARCH",
      "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "ENABLE_PROMPT_CACHING_1H",
      "BB_ACCOUNT_POOL_PARENT_URL",
      "BB_ACCOUNT_POOL_PARENT_TOKEN",
    ]);
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_BASE_URL")?.value,
    ).toEqual({ serverPath: "/api/v1/plugins/account-pool-prewarm/http" });
    expect(
      entries.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN")?.value,
    ).not.toBe(PARENT_TOKEN);
  });

  it("forwards pooled traffic to the parent with the parent token", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const host = await createChild({ parentUrl: parent.upstream.url });
    const entries = await host.harness.behavior.resolveProviderEnv(
      "claude-code",
      { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
    );
    const childToken = entries.find(
      (entry) => entry.name === "ANTHROPIC_AUTH_TOKEN",
    )?.value;
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      {
        headers: { authorization: `Bearer ${String(childToken)}` },
        body: JSON.stringify({ model: "claude-opus-4", messages: [] }),
      },
    );
    expect(response.status).toBe(200);
    await response.text();
    const forwarded = parent.records.filter(
      (record) => record.url === "/v1/messages",
    );
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.token).toBe(PARENT_TOKEN);
    expect(forwarded[0]?.authorization).toBeNull();
    expect(JSON.parse(forwarded[0]?.body ?? "{}")).toEqual({
      model: "claude-opus-4",
      messages: [],
    });
  });

  it("rejects pooled traffic that does not present the child's own token", async () => {
    const parent = await startParent({});
    cleanups.push(parent.upstream.close);
    const host = await createChild({ parentUrl: parent.upstream.url });
    const response = await host.harness.behavior.fetchHttp(
      "POST",
      "/v1/messages",
      { headers: { authorization: `Bearer ${PARENT_TOKEN}` }, body: "{}" },
    );
    expect(response.status).toBe(401);
    expect(
      parent.records.filter((record) => record.url === "/v1/messages"),
    ).toHaveLength(0);
  });

  it("serves availability only to hub token holders", async () => {
    const upstream = await startUpstream(async (request, response) => {
      await readRequestBody(request);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    cleanups.push(upstream.close);
    const fixture = await createFixture({ upstreamUrl: upstream.url });
    const denied = await fixture.host.harness.behavior.fetchHttp(
      "GET",
      "/availability",
      {},
    );
    expect(denied.status).toBe(401);
    const allowed = await fixture.host.harness.behavior.fetchHttp(
      "GET",
      "/availability",
      { headers: { "x-bb-account-pool-token": fixture.key } },
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ claude: true, codex: false });
  });
});

 it.each(["claude", "codex"] as const)("keeps %s health independent from enablement and filters usage by enabled only", async (provider) => {
 const fixture = await createOAuthRequestFixture(provider, async () => Response.json({}), () => Date.now());
 const id = fixture.account.id;
 const quotas = new QuotaStore(fixture.host.bb.storage.database());
 const base = quotas.get(id);
 const now = Date.now();
 const cases = [
 {status: "ready", quota: base},
 {status: "error", quota: {...base, error: "temporary"}},
 {status: "held", quota: {...base, heldUntil: now + 3600000}},
 {status: "exhausted", quota: {...base, fiveHourUtilization: 1, fiveHourResetAt: now + 3600000}},
 ...(provider === "claude" ? ([400,403] as const).map(status => ({status: status === 400 ? "verification-required" : "access-blocked", quota: {...base, accessBlocked: {status, type: null, message: null, observedAt: now}}})) : []),
 ];
 for (const c of cases) {
 expect(accountStatus({...fixture.account, enabled: false}, c.quota, 0.98, now)).toBe(c.status);
 expect(accountStatus({...fixture.account, enabled: true}, c.quota, 0.98, now)).toBe(c.status);
 }
 if (provider === "claude") quotas.setAccessBlocked(id, {status:403,type:null,message:null,observedAt:now});
 await fixture.host.harness.behavior.callRpc("account.disable", {id});
 expect(usageResourceListSchema.parse(await fixture.host.harness.behavior.callRpc(usageListMethod, {})).resources).toEqual([]);
 await expect(fixture.host.harness.behavior.callRpc(usageFetchMethod, {resourceId:id,refresh:false})).rejects.toThrow("no longer exists");
 const disabled = z.array(accountSummarySchema).parse(await fixture.host.harness.behavior.callRpc("account.list",null))[0]!;
 expect(disabled).toMatchObject({enabled:false,status:provider === "claude" ? "access-blocked" : "ready"});
 await fixture.host.harness.behavior.callRpc("account.enable", {id});
 expect(usageResourceListSchema.parse(await fixture.host.harness.behavior.callRpc(usageListMethod, {})).resources.map(a=>a.id)).toContain(id);
 const measurement = usageMeasurementSchema.parse(await fixture.host.harness.behavior.callRpc(usageFetchMethod, {resourceId:id,refresh:false}));
 if(provider === "claude") expect(measurement.usage).toMatchObject({status:"error",message:"Access blocked (403)"});
 });


describe("Hermes Anthropic proxy contract", () => {
  it("authenticates the Claude catalog alias and preserves its query without sending a body", async () => {
    const requests: Request[] = [];
    const catalog = { data: [{ id: "claude-opus-5-5", type: "model" }], has_more: false };
    const fixture = await createFixture({
      upstreamUrl: "https://claude.example",
      options: { fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json(catalog);
      } },
    });
    const denied = await fixture.host.harness.behavior.fetchHttp("GET", "/models");
    expect(denied.status).toBe(401);
    expect(requests).toHaveLength(0);
    const response = await fixture.host.harness.behavior.fetchHttp("GET", "/models?limit=100&after_id=prior", { headers: authHeaders(fixture.key) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(catalog);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://claude.example/v1/models?limit=100&after_id=prior");
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(await requests[0]?.text()).toBe("");
  });

});

describe("OpenAI Platform API keys", () => {
  it("adds a Codex key through RPC and forwards Responses and compact without subscription identity", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const fixture = await createFixture({
      upstreamUrl: "https://chatgpt.com/backend-api/codex",
      provider: "codex",
      apiKey: "sk-openai-test-only",
      options: {
        fetch: async (input, init) => {
          seen.push({
            url: String(input),
            headers: new Headers(init?.headers),
            body: Buffer.from(init?.body as ArrayBuffer).toString(),
          });
          return new Response('data: {"type":"response.completed"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          });
        },
      },
    });
    expect(fixture.account.label).toBe("OpenAI API key");
    const { token } = await resolveCodexToken(fixture.host);
    for (const route of ["/v1/responses", "/v1/responses/compact"]) {
      const response = await fixture.host.harness.behavior.fetchHttp("POST", route, {
        headers: {
          ...authHeaders(token),
          "chatgpt-account-id": "must-not-leak",
          "x-codex-internal-test": "must-not-leak",
        },
        body: '{"model":"gpt-test","input":[],"store":false,"stream":true}',
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("response.completed");
    }
    expect(seen.map((item) => item.url)).toEqual([
      "https://api.openai.com/v1/responses",
      "https://api.openai.com/v1/responses/compact",
    ]);
    for (const item of seen) {
      expect(item.headers.get("authorization")).toBe("Bearer sk-openai-test-only");
      expect(item.headers.has("chatgpt-account-id")).toBe(false);
      expect(item.headers.has("x-codex-internal-test")).toBe(false);
      expect(item.body).toBe('{"model":"gpt-test","input":[],"store":false,"stream":true}');
    }
    expect(
      JSON.stringify(await fixture.host.harness.behavior.callRpc("status.get", null)),
    ).not.toContain("sk-openai-test-only");
  });

  it("accepts Codex API keys through the CLI", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.example",
      options: { fetch: async () => Response.json({}) },
    });
    const result = await fixture.host.harness.behavior.runCli([
      "account",
      "add",
      "--provider",
      "codex",
      "--api-key",
      "sk-cli-test-only",
      "--json",
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("sk-cli-test-only");
  });

  it("persists insufficient_quota and fails over once instead of retrying a spent API key", async () => {
    const attempts: string[] = [];
    const fixture = await createFixture({
      upstreamUrl: "https://chatgpt.com/backend-api/codex",
      provider: "codex",
      apiKey: "sk-spent",
      priority: 1,
      options: {
        fetch: async (_input, init) => {
          const key = new Headers(init?.headers).get("authorization") ?? "";
          attempts.push(key);
          return key === "Bearer sk-spent"
            ? Response.json(
                {
                  error: {
                    code: "insufficient_quota",
                    type: "insufficient_quota",
                    message: "No credits",
                  },
                },
                { status: 429 },
              )
            : Response.json({ id: "ok" });
        },
      },
    });
    await fixture.host.harness.behavior.callRpc("account.add", {
      provider: "codex",
      source: { kind: "api-key", apiKey: "sk-working" },
      label: null,
      priority: 2,
    });
    const { token } = await resolveCodexToken(fixture.host);
    for (const session of ["first", "second"]) {
      const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
        headers: { ...authHeaders(token), "session-id": session },
        body: '{"model":"gpt-test","input":[]}',
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(attempts).toEqual(["Bearer sk-spent", "Bearer sk-working", "Bearer sk-working"]);
    const status = statusSchema.parse(
      await fixture.host.harness.behavior.callRpc("status.get", null),
    );
    expect(status.accounts.find((item) => item.id === fixture.account.id)?.error).toContain(
      "insufficient_quota",
    );
  });
});

it("switches from a spent ChatGPT subscription to an OpenAI key without leaking identity", async () => {
  const attempts: Array<{ url: string; auth: string | null; account: string | null }> = [];
  const fixture = await createFixture({
    upstreamUrl: "https://chatgpt.com/backend-api/codex",
    provider: "codex",
    source: "oauth",
    priority: 1,
    options: {
      codexUsageUrl: "https://usage.example/usage",
      seedCodex: async () => ({
        accessToken: "oauth-live-test",
        refreshToken: "refresh-test",
        idToken: null,
        accountId: "subscription-id",
        email: "test@example.com",
        expiresAt: Date.now() + 3600000,
      }),
      fetch: async (input, init) => {
        if (String(input).includes("usage.example")) return Response.json({});
        const headers = new Headers(init?.headers);
        attempts.push({
          url: String(input),
          auth: headers.get("authorization"),
          account: headers.get("chatgpt-account-id"),
        });
        return headers.get("authorization") === "Bearer oauth-live-test"
          ? Response.json(
              { error: "spent" },
              {
                status: 429,
                headers: {
                  "x-codex-primary-used-percent": "100",
                  "x-codex-primary-reset-after-seconds": "3600",
                },
              },
            )
          : Response.json({ id: "api-ok" });
      },
    },
  });
  await fixture.host.harness.behavior.callRpc("account.add", {
    provider: "codex",
    source: { kind: "api-key", apiKey: "sk-fallback-test" },
    label: null,
    priority: 2,
  });
  const { token } = await resolveCodexToken(fixture.host);
  const response = await fixture.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
    headers: authHeaders(token),
    body: '{"model":"gpt-test","input":[]}',
  });
  expect(response.status).toBe(200);
  await response.text();
  expect(attempts).toEqual([
    {
      url: "https://chatgpt.com/backend-api/codex/responses",
      auth: "Bearer oauth-live-test",
      account: "subscription-id",
    },
    { url: "https://api.openai.com/v1/responses", auth: "Bearer sk-fallback-test", account: null },
  ]);
});

it("does not poison an OpenAI key when a model returns 403", async () => {
  let denied = true;
  const fixture = await createFixture({
    upstreamUrl: "https://unused.example",
    provider: "codex",
    options: {
      fetch: async () =>
        denied
          ? Response.json({ error: { code: "model_not_allowed" } }, { status: 403 })
          : Response.json({ id: "ok" }),
    },
  });
  const { token } = await resolveCodexToken(fixture.host);
  const send = () =>
    fixture.host.harness.behavior.fetchHttp("POST", "/v1/responses", {
      headers: authHeaders(token),
      body: '{"model":"gpt-test","input":[]}',
    });
  const failed = await send();
  expect(failed.status).toBe(403);
  await failed.text();
  denied = false;
  const recovered = await send();
  expect(recovered.status).toBe(200);
  await recovered.text();
});

describe("machine roles, default deny", () => {
  it.each([null, "proxy", "isolate"] as const)(
    "neutralizes ordinary and catalog env for both providers with parent %s",
    async (mode) => {
      const upstream = vi.fn(async () =>
        Response.json({ claude: true, codex: true }),
      );
      const fixture = await createFixture({
        upstreamUrl: "https://unused.invalid",
        options: {
          fetch: upstream,
          env:
            mode === null
              ? {}
              : {
                  [PARENT_URL_ENV]: "https://parent.invalid",
                  [PARENT_TOKEN_ENV]: "p".repeat(43),
                  ANTHROPIC_CUSTOM_HEADERS:
                    "Other: retained\nx-BB-project: proj_old",
                },
        },
      });
      if (mode !== null)
        await fixture.host.harness.behavior.callRpc("config.set", {
          parentMode: mode,
        });
      const { callRpc, runCli, resolveProviderEnv, resolveProviderEnvHealth } =
        fixture.host.harness.behavior;
      expect(
        (await runCli(["machine", "role", "host-one", "none", "--json"]))
          .exitCode,
      ).toBe(0);
      expect(await callRpc("hostRole.list", null)).toContainEqual({
        hostId: "host-one",
        hostName: "One",
        enrolled: true,
        role: null,
      });
      upstream.mockClear();
      await fixture.host.bb.storage.kv.delete("retry-route:thread-one");
      for (const provider of ["claude-code", "codex"]) {
        for (const threadId of [null, "thread-one"]) {
          if (threadId !== null)
            await fixture.host.bb.storage.kv.set(
              `retry-route:${threadId}`,
              "claude",
            );
          const entries = await resolveProviderEnv(provider, {
            threadId,
            projectId: null,
            hostId: "host-one",
          });
          for (const name of [
            "ANTHROPIC_BASE_URL",
            "ANTHROPIC_AUTH_TOKEN",
            "CODEX_OPENAI_BASE_URL",
            "CODEX_POOL_AUTH_TOKEN",
            PARENT_URL_ENV,
            PARENT_TOKEN_ENV,
          ])
            expect(entries.find((e) => e.name === name)?.value).toBe("");
          expect(
            entries.find((e) => e.name === "ANTHROPIC_CUSTOM_HEADERS")?.value,
          ).toBeUndefined();
          expect(await fixture.host.bb.storage.kv.list("retry-route:")).toEqual(
            [],
          );
        }
        expect(
          await resolveProviderEnvHealth(provider, { hostId: "host-one" }),
        ).toBeNull();
      }
      expect(upstream).not.toHaveBeenCalled();
      expect(
        await resolveToken(fixture.host, "host-two", "thread-two"),
      ).not.toBe("");
      await callRpc("hostRole.set", {
        hostId: "host-one",
        role: "trusted",
      });
      expect(
        JSON.parse((await runCli(["machine", "list", "--json"])).stdout)
          .machines[0].role,
      ).toBe("trusted");
    },
  );

  it.each([false, true])(
    "denies every authenticated HTTP route and stale retry markers without forwarding (parent=%s)",
    async (parent) => {
      const upstream = vi.fn(async () =>
        Response.json({ claude: true, codex: true }),
      );
      const fixture = await createFixture({
        upstreamUrl: "https://unused.invalid",
        options: {
          fetch: upstream,
          ...(parent
            ? {
                env: {
                  [PARENT_URL_ENV]: "https://parent.invalid",
                  [PARENT_TOKEN_ENV]: "p".repeat(43),
                },
              }
            : {}),
        },
      });
      const previous = fixture.key;
      await fixture.host.harness.behavior.callRpc("token.rotate", {
        machine: "host-one",
      });
      const current = await resolveToken(fixture.host);
      await fixture.host.harness.behavior.callRpc("hostRole.set", {
        hostId: "host-one",
        role: "none",
      });
      upstream.mockClear();
      for (const token of [previous, current]) {
        for (const route of fixture.host.harness.inspection.registrations.httpRoutes.filter(
          (r) => r.method !== "HEAD",
        )) {
          const response = await fixture.host.harness.behavior.fetchHttp(
            route.method,
            route.path,
            {
              headers: authHeaders(token),
              ...(route.method === "POST" ? { body: "{}" } : {}),
            },
          );
          expect(response.status, `${route.method} ${route.path}`).toBe(401);
        }
      }
      expect(
        await fixture.host.harness.behavior.callRpc(retryAvailabilityMethod, {
          threadId: "thread-one",
          requestId: "request-one",
        }),
      ).toEqual({ kind: "not-routed" });
      expect(upstream).not.toHaveBeenCalled();
    },
  );

  const secretsOf = (fixture: Fixture) =>
    path.join(fixture.dataDir, "plugins", "account-pool", "secrets", "accounts");
  const tokenFile = (fixture: Fixture, hostId: string) =>
    path.join(secretsOf(fixture), `hub-token-${hostId}.json`);
  const availability = (fixture: Fixture, token: string) =>
    fixture.host.harness.behavior
      .fetchHttp("GET", AVAILABILITY_PATH, { headers: authHeaders(token) })
      .then((response) => response.status);
  const ROUTING_NAMES = [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "CODEX_OPENAI_BASE_URL",
    "CODEX_POOL_AUTH_TOKEN",
    PARENT_URL_ENV,
    PARENT_TOKEN_ENV,
  ];

  it("gives a role-less or unknown host neutral env and mints no token, with or without a thread", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: { fetch: async () => Response.json({}) },
    });
    const { callRpc, resolveProviderEnv, resolveProviderEnvHealth } =
      fixture.host.harness.behavior;
    await callRpc("hostRole.set", { hostId: "host-two", role: "none" });
    for (const hostId of ["host-two", "host-unknown"])
      for (const provider of ["claude-code", "codex"])
        for (const threadId of [null, "thread-two"]) {
          const entries = await resolveProviderEnv(provider, {
            threadId,
            projectId: "project-one",
            hostId,
          });
          expect(entries.map((e) => e.name).sort()).toEqual(
            [...ROUTING_NAMES].sort(),
          );
          expect(entries.every((e) => e.value === "")).toBe(true);
          expect(
            await resolveProviderEnvHealth(provider, { hostId }),
          ).toBeNull();
        }
    expect(
      (await fs.readdir(secretsOf(fixture))).filter((name) =>
        name.startsWith("hub-token-"),
      ),
    ).toEqual(["hub-token-host-one.json"]);
    await expect(
      callRpc("token.rotate", { machine: "host-two" }),
    ).rejects.toThrow();
  });

  // Rewritten in block P2: a worker no longer gets the hub token (see
  // "worker passes" below), so only server and trusted are checked here.
  it.each(["server", "trusted"] as const)(
    "routes a host with role %s through the hub",
    async (role) => {
      const fixture = await createFixture({
        upstreamUrl: "https://unused.invalid",
        options: { fetch: async () => Response.json({}) },
      });
      await fixture.host.harness.behavior.callRpc("hostRole.set", {
        hostId: "host-two",
        role,
      });
      for (const threadId of [null, "thread-two"]) {
        const entries = await fixture.host.harness.behavior.resolveProviderEnv(
          "claude-code",
          { threadId, projectId: null, hostId: "host-two" },
        );
        const token = entries.find((e) => e.name === "ANTHROPIC_AUTH_TOKEN");
        expect(typeof token?.value === "string" && token.value.length).toBe(43);
        expect(await availability(fixture, token?.value as string)).toBe(200);
      }
    },
  );

  it("revokes the token when the role is removed and mints a new one on a new role", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: { fetch: async () => Response.json({}) },
    });
    const { callRpc } = fixture.host.harness.behavior;
    const previous = fixture.key;
    await callRpc("token.rotate", { machine: "host-one" });
    const current = await resolveToken(fixture.host);
    expect(await availability(fixture, previous)).toBe(200);
    await callRpc("hostRole.set", { hostId: "host-one", role: "none" });
    await expect(fs.access(tokenFile(fixture, "host-one"))).rejects.toThrow();
    for (const token of [previous, current])
      expect(await availability(fixture, token)).toBe(401);
    await callRpc("hostRole.set", { hostId: "host-one", role: "trusted" });
    expect(await availability(fixture, current)).toBe(401);
    const next = await resolveToken(fixture.host);
    expect([previous, current]).not.toContain(next);
    expect(await availability(fixture, next)).toBe(200);
  });

  it("keeps the token on a role-to-role change", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: { fetch: async () => Response.json({}) },
    });
    const before = await fs.stat(tokenFile(fixture, "host-one"));
    await fixture.host.harness.behavior.callRpc("hostRole.set", {
      hostId: "host-one",
      role: "server",
    });
    const after = await fs.stat(tokenFile(fixture, "host-one"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(await resolveToken(fixture.host)).toBe(fixture.key);
    expect(await availability(fixture, fixture.key)).toBe(200);
  });

  it("upgrades an opt-out store without revoking included hosts and drops excluded hosts' kept tokens", async () => {
    const kept = (hostId: string, value: string) => ({
      hostId,
      value,
      mintedAt: 1,
      lastUsedAt: null,
      previous: [],
    });
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: { fetch: async () => Response.json({}) },
      roles: false,
      beforePlugin(host) {
        // The opt-out build's store: host-two excluded after it had a token.
        const db = host.bb.storage.database();
        host.bb.storage.migrate(db, QUOTA_MIGRATIONS.slice(0, 9));
        db.prepare(
          "INSERT INTO pool_host_exclusion(host_id) VALUES ('host-two'), ('host-gone')",
        ).run();
        const dir = path.join(
          host.bb.server.experimental_dataDir,
          "plugins",
          "account-pool",
          "secrets",
          "accounts",
        );
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        for (const [hostId, value] of [
          ["host-one", "A".repeat(43)],
          ["host-two", "B".repeat(43)],
        ] as const)
          writeFileSync(
            path.join(dir, `hub-token-${hostId}.json`),
            `${JSON.stringify(kept(hostId, value))}\n`,
            { mode: 0o600 },
          );
      },
    });
    expect(
      await fixture.host.harness.behavior.callRpc("hostRole.list", null),
    ).toEqual([
      { hostId: "host-one", hostName: "One", enrolled: true, role: "trusted" },
      { hostId: "host-two", hostName: "Two", enrolled: true, role: null },
    ]);
    await expect(
      fs.access(tokenFile(fixture, "host-one")),
    ).resolves.toBeUndefined();
    await expect(fs.access(tokenFile(fixture, "host-two"))).rejects.toThrow();
    expect(await availability(fixture, "A".repeat(43))).toBe(200);
    expect(await availability(fixture, "B".repeat(43))).toBe(401);
    expect(await resolveToken(fixture.host)).toBe("A".repeat(43));
    expect(
      fixture.host.bb.storage
        .database()
        .prepare("SELECT host_id FROM pool_host_exclusion ORDER BY host_id")
        .all(),
    ).toEqual([{ host_id: "host-gone" }, { host_id: "host-two" }]);
  });

  it("prunes a role-less host's token and projects exclusions on status", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: { fetch: async () => Response.json({}) },
    });
    await resolveToken(fixture.host, "host-two", "thread-two");
    const db = fixture.host.bb.storage.database();
    db.prepare("DELETE FROM pool_host_role WHERE host_id = 'host-two'").run();
    await fixture.host.harness.behavior.callRpc("status.get", null);
    await expect(fs.access(tokenFile(fixture, "host-two"))).rejects.toThrow();
    await expect(
      fs.access(tokenFile(fixture, "host-one")),
    ).resolves.toBeUndefined();
    expect(
      db.prepare("SELECT host_id FROM pool_host_exclusion").all(),
    ).toEqual([{ host_id: "host-two" }]);
  });

  it("serves a former native-cell host like any other host and denies it without a role", async () => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      beforePlugin(host) {
        // Rows the native-cell build left: an enabled, qualified cell on host-one.
        const db = host.bb.storage.database();
        host.bb.storage.migrate(db, QUOTA_MIGRATIONS);
        db.prepare(
          "UPDATE native_policy SET enabled = 1, qualified = 1 WHERE id = 1",
        ).run();
        db.prepare(
          "INSERT INTO native_cell (id, hostId, generation, label, workspace, sshTarget, enabled, qualified) VALUES ('cell-one', 'host-one', 'g1', 'Cell', '/workspace', 'cell.invalid', 1, 1)",
        ).run();
      },
    });
    const { hooks } = fixture.host.harness.inspection.registrations;
    expect(hooks["message.dispatch"]).toBeNull();
    expect(await resolveToken(fixture.host, "host-one", "thread-one")).not.toBe(
      "",
    );
    await fixture.host.harness.behavior.callRpc("hostRole.set", {
      hostId: "host-one",
      role: "none",
    });
    for (const provider of ["claude-code", "codex"]) {
      const entries = await fixture.host.harness.behavior.resolveProviderEnv(
        provider,
        { threadId: "thread-one", projectId: "project-one", hostId: "host-one" },
      );
      for (const name of ["ANTHROPIC_AUTH_TOKEN", "CODEX_POOL_AUTH_TOKEN"])
        expect(entries.find((e) => e.name === name)?.value).toBe("");
    }
    expect(
      fixture.host.bb.storage
        .database()
        .prepare("SELECT hostId FROM native_cell")
        .all(),
    ).toEqual([{ hostId: "host-one" }]);
  });
});

it("rechecks policy while retry request events are resolving", async () => {
  const gate = deferred();
  const entered = deferred();
  const fixture = await createFixture({
    upstreamUrl: "https://unused.invalid",
    options: { fetch: async () => Response.json({}) },
  });
  fixture.host.harness.sdk.stub("threads.events.list", async () => {
    entered.resolve();
    await gate.promise;
    return [
      {
        data: {
          requestId: "request-one",
          execution: { model: "claude-sonnet" },
        },
      },
    ];
  });
  const pending = fixture.host.harness.behavior.callRpc(
    retryAvailabilityMethod,
    { threadId: "thread-one", requestId: "request-one" },
  );
  await entered.promise;
  await fixture.host.harness.behavior.callRpc("hostRole.set", {
    hostId: "host-one",
    role: "none",
  });
  gate.resolve();
  expect(await pending).toEqual({ kind: "not-routed" });
});

it.each([null, undefined, "failure"])(
  "fails closed for unresolved retry host %s",
  async (value) => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: { fetch: async () => Response.json({}) },
    });
    fixture.host.harness.sdk.stub("threads.get", async () => {
      if (value === "failure") throw new Error("unavailable");
      return { host: value };
    });
    expect(
      await fixture.host.harness.behavior.callRpc(retryAvailabilityMethod, {
        threadId: "thread-one",
        requestId: "request-one",
      }),
    ).toEqual({ kind: "unavailable", reason: "source-unavailable" });
  },
);

it.each(["claude-code", "codex"])(
  "rechecks %s env and health after awaited parent availability",
  async (provider) => {
    let delayed = false;
    const entered = deferred();
    const release = deferred();
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: {
        availabilityTtlMs: 0,
        env: {
          [PARENT_URL_ENV]: "https://parent.invalid",
          [PARENT_TOKEN_ENV]: "p".repeat(43),
        },
        fetch: async () => {
          if (delayed) {
            entered.resolve();
            await release.promise;
          }
          return Response.json({ claude: true, codex: true });
        },
      },
    });
    delayed = true;
    const health = fixture.host.harness.behavior.resolveProviderEnvHealth(
      provider,
      { hostId: "host-one" },
    );
    const env = fixture.host.harness.behavior.resolveProviderEnv(provider, {
      hostId: "host-one",
      threadId: "thread-one",
      projectId: null,
    });
    await entered.promise;
    await fixture.host.harness.behavior.callRpc("hostRole.set", {
      hostId: "host-one",
      role: "none",
    });
    release.resolve();
    expect(await health).toBeNull();
    expect(
      (await env).every(
        (entry) => typeof entry.value === "string" && entry.value === "",
      ),
    ).toBe(true);
    expect(
      await fixture.host.bb.storage.kv.get("retry-route:thread-one"),
    ).toBeUndefined();
  },
);

it("validates machine policy and exposes CLI help without minting a token", async () => {
  const fixture = await createFixture({
    upstreamUrl: "https://unused.invalid",
    options: { fetch: async () => Response.json({}) },
  });
  await expect(
    fixture.host.harness.behavior.callRpc("hostRole.set", {
      hostId: "host-one",
      role: "none",
      provider: "claude",
    }),
  ).rejects.toThrow();
  for (const command of ["list", "role"]) {
    const help = await fixture.host.harness.behavior.runCli([
      "machine",
      command,
      "--help",
    ]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("--json");
  }
  for (const args of [
    ["role", "missing", "trusted"],
    ["role", "host-one", "admin"],
    ["role", "bad/id", "none"],
    ["exclude", "host-one"],
    ["include", "host-one"],
  ]) {
    const result = await fixture.host.harness.behavior.runCli([
      "machine",
      ...args,
      "--json",
    ]);
    expect(result.exitCode, args.join(" ")).not.toBe(0);
  }
  expect(
    (
      await fixture.host.harness.behavior.runCli([
        "machine",
        "role",
        "missing",
        "none",
        "--json",
      ])
    ).exitCode,
  ).toBe(0);
  expect(
    await fixture.host.harness.behavior.callRpc("hostRole.list", null),
  ).toEqual([
    { hostId: "host-one", hostName: "One", enrolled: true, role: "trusted" },
    { hostId: "host-two", hostName: "Two", enrolled: true, role: "trusted" },
  ]);
});

it.each(["claude-code", "codex"])(
  "merges role-less %s routes without clobbering target-only headers or credentials",
  async (provider) => {
    const fixture = await createFixture({
      upstreamUrl: "https://unused.invalid",
      options: {
        fetch: async () => Response.json({}),
        env: {
          ANTHROPIC_CUSTOM_HEADERS:
            "Server: different\nx-bb-project: proj_server",
        },
      },
    });
    await fixture.host.harness.behavior.callRpc("hostRole.set", {
      hostId: "host-one",
      role: "none",
    });
    const entries = await fixture.host.harness.behavior.resolveProviderEnv(
      provider,
      { hostId: "host-one", threadId: null, projectId: null },
    );
    const inherited = {
      ANTHROPIC_BASE_URL: "old-anthropic",
      ANTHROPIC_AUTH_TOKEN: "old-auth",
      CODEX_OPENAI_BASE_URL: "old-codex",
      CODEX_POOL_AUTH_TOKEN: "old-pool",
      [PARENT_URL_ENV]: "old-parent",
      [PARENT_TOKEN_ENV]: "old-parent-auth",
      ANTHROPIC_API_KEY: "synthetic-host-key",
      OPENAI_API_KEY: "synthetic-openai-key",
      ANTHROPIC_CUSTOM_HEADERS:
        " Other: host-only\r\nx-bb-project: proj_host\n",
      ENABLE_TOOL_SEARCH: "host-setting",
      ENABLE_PROMPT_CACHING_1H: "host-cache",
    };
    const merged = {
      ...inherited,
      ...Object.fromEntries(entries.map((entry) => [entry.name, entry.value])),
    };
    expect(entries).toHaveLength(6);
    for (const name of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "CODEX_OPENAI_BASE_URL",
      "CODEX_POOL_AUTH_TOKEN",
      PARENT_URL_ENV,
      PARENT_TOKEN_ENV,
    ] as const)
      expect(merged[name]).toBe("");
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ENABLE_TOOL_SEARCH",
      "ENABLE_PROMPT_CACHING_1H",
    ] as const)
      expect(merged[name]).toBe(inherited[name]);
  },
);

describe("worker passes", () => {
  const WORKER = "host-two";
  const secretsOf = (fixture: Fixture) =>
    path.join(fixture.dataDir, "plugins", "account-pool", "secrets", "accounts");
  const MESSAGE = JSON.stringify({
    model: "claude-haiku-4-5-20251001",
    messages: [{ role: "user", content: "AUDIT-BODY-MARKER" }],
  });

  async function workerFixture(
    args: {
      options?: TestPluginOptions;
      upstream?: UpstreamHandler;
      codex?: boolean;
    } = {},
  ) {
    const clock = { time: Date.now() };
    const calls: string[] = [];
    const upstream = await startUpstream(
      args.upstream ??
        (async (request, response) => {
          calls.push(`${request.method} ${request.url}`);
          await readRequestBody(request);
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
        }),
    );
    cleanups.push(upstream.close);
    const fixture = await createFixture({
      upstreamUrl: upstream.url,
      options: { now: () => clock.time, ...args.options },
    });
    const threads = new Map<string, Record<string, unknown> | Error>();
    fixture.host.harness.sdk.stub("threads.get", async (input: unknown) => {
      const { threadId } = z.object({ threadId: z.string() }).parse(input);
      const thread = threads.get(threadId) ?? {
        host: { id: WORKER },
        archivedAt: null,
        deletedAt: null,
      };
      if (thread instanceof Error) throw thread;
      return thread;
    });
    fixture.host.harness.sdk.stub("hosts.get", async () => ({ id: WORKER }));
    const { callRpc, resolveProviderEnv, fetchHttp } =
      fixture.host.harness.behavior;
    await callRpc("hostRole.set", { hostId: WORKER, role: "worker" });
    if (args.codex === true)
      await callRpc("account.add", {
        provider: "codex",
        source: { kind: "api-key", apiKey: "sk-codex" },
        label: null,
        priority: 100,
      });
    const env = async (
      threadId: string | null,
      provider: "claude-code" | "codex" = "claude-code",
      hostId = WORKER,
    ) =>
      Object.fromEntries(
        (
          await resolveProviderEnv(provider, {
            threadId,
            projectId: null,
            hostId,
          })
        ).map((entry) => [entry.name, entry.value]),
      );
    const pass = async (threadId: string | null, hostId = WORKER) =>
      String((await env(threadId, "claude-code", hostId)).ANTHROPIC_AUTH_TOKEN);
    const send = async (
      credential: string,
      route = "/v1/messages",
      method: "GET" | "POST" = "POST",
      body = MESSAGE,
    ) => {
      const response = await fetchHttp(method, route, {
        headers: authHeaders(credential),
        ...(method === "POST" ? { body } : {}),
      });
      await response.text();
      return response.status;
    };
    const audit = async () =>
      z
        .object({ entries: z.array(z.record(z.string(), z.unknown())) })
        .parse(
          JSON.parse(
            (await fixture.host.harness.behavior.runCli(["audit", "--json"]))
              .stdout,
          ),
        )
        .entries.reverse();
    return { fixture, clock, calls, threads, env, pass, send, audit, callRpc };
  }

  it("gives a worker thread its own pass for both providers and no hub token", async () => {
    const { fixture, env, pass } = await workerFixture({ codex: true });
    for (const provider of ["claude-code", "codex"] as const) {
      const entries = await env("thread-two", provider);
      const credential =
        provider === "claude-code"
          ? entries.ANTHROPIC_AUTH_TOKEN
          : entries.CODEX_POOL_AUTH_TOKEN;
      expect(credential).toMatch(/^pt1\.thread-two\.[A-Za-z0-9_-]{43}$/u);
      expect(entries[PARENT_URL_ENV]).toBe("");
      expect(entries[PARENT_TOKEN_ENV]).toBe("");
    }
    expect(await pass("thread-two")).toBe(await pass("thread-two"));
    expect(await pass("thread-three")).not.toBe(await pass("thread-two"));
    expect(
      (await fs.readdir(secretsOf(fixture))).filter((name) =>
        name.startsWith("hub-token-"),
      ),
    ).toEqual(["hub-token-host-one.json"]);
  });

  it("accepts a thread pass on model routes and refuses forged or malformed ones with 401", async () => {
    const { pass, send, calls } = await workerFixture();
    const two = await pass("thread-two");
    const three = await pass("thread-three");
    expect(await send(two)).toBe(200);
    expect(await send(two, "/v1/responses")).not.toBe(401);
    const mac = two.split(".")[2] as string;
    const forged = [
      `pt1.thread-three.${mac}`,
      `pt1.thread-two.${three.split(".")[2]}`,
      `pt1.thread-two.${mac.slice(2)}`,
      `pt1.thread-two.${mac}AA`,
      `pt1.thread-two.${mac}.x`,
      `pc1.host-two.${mac}`,
    ];
    calls.length = 0;
    for (const credential of forged) {
      expect(await send(credential), credential).toBe(401);
      expect(await send(credential, "/v1/responses"), credential).toBe(401);
    }
    expect(calls).toEqual([]);
  });

  it.each([false, true])(
    "lets the catalog pass of a thread-less send only list models (parent proxy %s)",
    async (parent) => {
      const parentCalls: string[] = [];
      const { pass, send, calls } = await workerFixture(
        parent
          ? {
              options: {
                env: {
                  [PARENT_URL_ENV]: "https://parent.invalid",
                  [PARENT_TOKEN_ENV]: "p".repeat(43),
                },
                fetch: async (input) => {
                  parentCalls.push(String(input));
                  return Response.json(
                    String(input).endsWith(AVAILABILITY_PATH)
                      ? { claude: true, codex: true }
                      : { data: [] },
                  );
                },
              },
            }
          : {},
      );
      const catalog = await pass(null);
      expect(catalog).toMatch(/^pc1\.host-two\.[A-Za-z0-9_-]{43}$/u);
      expect(await send(catalog, "/models", "GET")).toBe(200);
      // No codex account locally: past the pass and the gate, then 503.
      expect(await send(catalog, "/v1/models", "GET")).toBe(parent ? 200 : 503);
      const forwarded = parent ? parentCalls.length : calls.length;
      for (const route of [
        "/v1/messages",
        "/v1/messages/count_tokens",
        "/v1/responses",
        "/v1/images/generations",
      ])
        expect(await send(catalog, route), route).toBe(403);
      expect(await send(catalog, AVAILABILITY_PATH, "GET")).toBe(403);
      expect(
        await send(
          catalog,
          "/retry-availability?provider=claude&family=haiku",
          "GET",
        ),
      ).toBe(403);
      expect(parent ? parentCalls.length : calls.length).toBe(forwarded);
    },
  );

  it("keeps a thread's pass through the archive undo grace, restores it on undo and drops it on delete", async () => {
    const { fixture, clock, threads, pass, send } = await workerFixture();
    const emit = fixture.host.harness.behavior.emitThreadEvent.bind(
      fixture.host.harness.behavior,
    );
    const thread = (archivedAt: number | null, deletedAt: number | null = null) =>
      makeThreadResponse({ id: "thread-two", archivedAt, deletedAt });
    const first = await pass("thread-two");
    expect((await emit("thread.archived", { thread: thread(clock.time) })).errors).toEqual([]);
    clock.time += 29_000;
    expect(await send(first, AVAILABILITY_PATH, "GET")).toBe(200);
    expect((await emit("thread.unarchived", { thread: thread(null) })).errors).toEqual([]);
    clock.time += 60_000;
    expect(await send(first, AVAILABILITY_PATH, "GET")).toBe(200);
    await emit("thread.archived", { thread: thread(clock.time) });
    clock.time += 30_000;
    expect(await send(first, AVAILABILITY_PATH, "GET")).toBe(401);
    threads.set("thread-two", {
      host: { id: WORKER },
      archivedAt: null,
      deletedAt: null,
    });
    await emit("thread.unarchived", { thread: thread(null) });
    const second = await pass("thread-two");
    expect(second).not.toBe(first);
    expect(await send(second, AVAILABILITY_PATH, "GET")).toBe(200);
    await emit("thread.deleted", { thread: thread(null, clock.time) });
    expect(await send(second, AVAILABILITY_PATH, "GET")).toBe(401);
    const third = await pass("thread-two");
    expect(await send(second, AVAILABILITY_PATH, "GET")).toBe(401);
    expect(await send(third, AVAILABILITY_PATH, "GET")).toBe(200);
    await emit("experimental_host.deleted", {
      host: makeHostResponse({ id: WORKER }),
    });
    expect(await send(third, AVAILABILITY_PATH, "GET")).toBe(401);
  });

  it("moves between worker and token roles without leaving a credential behind", async () => {
    const { fixture, pass, send, callRpc } = await workerFixture();
    const threadPass = await pass("thread-two");
    const catalog = await pass(null);
    // worker -> worker changes nothing.
    await callRpc("hostRole.set", { hostId: WORKER, role: "worker" });
    expect(await send(threadPass, AVAILABILITY_PATH, "GET")).toBe(200);
    // worker -> trusted: thread passes die, the machine gets a hub token.
    // The catalog pass still only lists models.
    await callRpc("hostRole.set", { hostId: WORKER, role: "trusted" });
    expect(await send(threadPass, AVAILABILITY_PATH, "GET")).toBe(401);
    expect(await send(catalog, "/models", "GET")).toBe(200);
    expect(await send(catalog)).toBe(403);
    const token = await pass("thread-two");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(await send(token, AVAILABILITY_PATH, "GET")).toBe(200);
    // trusted -> worker: the hub token dies and its file goes.
    await callRpc("hostRole.set", { hostId: WORKER, role: "worker" });
    expect(await send(token, AVAILABILITY_PATH, "GET")).toBe(401);
    await expect(
      fs.access(path.join(secretsOf(fixture), `hub-token-${WORKER}.json`)),
    ).rejects.toThrow();
    const next = await pass("thread-two");
    expect(next).not.toBe(threadPass);
    expect(await send(next, AVAILABILITY_PATH, "GET")).toBe(200);
    // The old pass never comes back.
    expect(await send(threadPass, AVAILABILITY_PATH, "GET")).toBe(401);
    // No role: nothing works.
    await callRpc("hostRole.set", { hostId: WORKER, role: "none" });
    expect(await send(next, AVAILABILITY_PATH, "GET")).toBe(401);
    expect(await send(catalog, "/models", "GET")).toBe(401);
    expect(await callRpc("pass.list", null)).toEqual([]);
  });

  // A later build issues passes on every role; after a rollback to this one a
  // turn in flight on a trusted machine keeps working.
  it("accepts a pass held by a trusted machine and refuses it once the role is gone", async () => {
    const { fixture, pass, send, callRpc } = await workerFixture();
    const held = await pass("thread-two");
    // The later build's state: the same row, the machine now trusted.
    fixture.host.bb.storage
      .database()
      .prepare("UPDATE pool_host_role SET role = 'trusted' WHERE host_id = ?")
      .run(WORKER);
    expect(await send(held, AVAILABILITY_PATH, "GET")).toBe(200);
    expect(await send(held)).toBe(200);
    // One reconcile round keeps it too.
    const round = fixture.host.harness.behavior.runService("pass-reconcile");
    round.controller.abort();
    await round.done;
    expect(await callRpc("pass.list", null)).toHaveLength(1);
    expect(await send(held, AVAILABILITY_PATH, "GET")).toBe(200);
    await callRpc("hostRole.set", { hostId: WORKER, role: "none" });
    expect(await send(held, AVAILABILITY_PATH, "GET")).toBe(401);
  });

  // The roles build (P1) keeps a worker's hub token; after a roll-forward that
  // token must not work and the next status deletes its file.
  it("refuses a hub token kept for a machine that became a worker under an older build", async () => {
    const { fixture, pass, send, callRpc } = await workerFixture();
    await callRpc("hostRole.set", { hostId: WORKER, role: "trusted" });
    const token = await pass("thread-two");
    expect(token).not.toMatch(/^pt1\./u);
    expect(await send(token)).toBe(200);
    fixture.host.bb.storage
      .database()
      .prepare("UPDATE pool_host_role SET role = 'worker' WHERE host_id = ?")
      .run(WORKER);
    expect(await send(token)).toBe(401);
    await fixture.host.harness.behavior.runCli(["status", "--json"]);
    expect(
      (await fs.readdir(secretsOf(fixture))).filter((name) =>
        name.startsWith("hub-token-"),
      ),
    ).toEqual(["hub-token-host-one.json"]);
  });

  // L1: the role row is committed before the callback runs, so a failing
  // audit write must not keep a former worker's passes alive.
  it("revokes a former worker's passes even when the role-change audit write fails", async () => {
    const { fixture, pass, send, callRpc } = await workerFixture();
    const held = await pass("thread-two");
    fixture.host.bb.storage
      .database()
      .exec(
        "CREATE TRIGGER fail_role_audit BEFORE INSERT ON pool_audit WHEN NEW.reason = 'role-change' BEGIN SELECT RAISE(FAIL, 'disk full'); END",
      );
    await callRpc("hostRole.set", { hostId: WORKER, role: "trusted" });
    expect(await callRpc("pass.list", null)).toEqual([]);
    expect(await send(held, AVAILABILITY_PATH, "GET")).toBe(401);
  });

  // L2: a row issued on any role (a later build) is still marked archived when
  // no machine is a worker.
  it("archives an existing pass when no machine is a worker", async () => {
    const { fixture, clock, pass, send } = await workerFixture();
    const held = await pass("thread-two");
    fixture.host.bb.storage
      .database()
      .prepare("UPDATE pool_host_role SET role = 'trusted' WHERE host_id = ?")
      .run(WORKER);
    const { errors } = await fixture.host.harness.behavior.emitThreadEvent(
      "thread.archived",
      { thread: makeThreadResponse({ id: "thread-two", archivedAt: clock.time }) },
    );
    expect(errors).toEqual([]);
    expect(await send(held, AVAILABILITY_PATH, "GET")).toBe(200);
    clock.time += 30_000;
    expect(await send(held, AVAILABILITY_PATH, "GET")).toBe(401);
  });

  // L3: a role change while the env contribution awaits bb leaves neither a
  // pass row nor a credential in the environment: inside the issue (the
  // missed-unarchive lookup) and after it (the retry-route write).
  it("contributes nothing when the machine stops being a worker during the contribution", async () => {
    const { fixture, clock, env, pass, callRpc } = await workerFixture();
    await pass("thread-two");
    await fixture.host.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread-two", archivedAt: clock.time }),
    });
    fixture.host.harness.sdk.stub("threads.get", async () => {
      await callRpc("hostRole.set", { hostId: WORKER, role: "trusted" });
      return { host: { id: WORKER }, archivedAt: null, deletedAt: null };
    });
    const during = await env("thread-two");
    expect(during.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(during.ANTHROPIC_BASE_URL).toBe("");
    expect(await callRpc("pass.list", null)).toEqual([]);

    await callRpc("hostRole.set", { hostId: WORKER, role: "worker" });
    const kv = fixture.host.bb.storage.kv;
    const set = kv.set.bind(kv);
    kv.set = (async (key: string, value: unknown) => {
      if (key === "retry-route:thread-three")
        await callRpc("hostRole.set", { hostId: WORKER, role: "trusted" });
      return set(key, value as never);
    }) as typeof kv.set;
    const after = await env("thread-three");
    expect(after.ANTHROPIC_AUTH_TOKEN).toBe("");
    expect(after.ANTHROPIC_BASE_URL).toBe("");
  });

  it("refuses to rotate a worker's token and points to pass revoke", async () => {
    const { fixture, callRpc } = await workerFixture();
    await expect(callRpc("token.rotate", { machine: WORKER })).rejects.toThrow(
      "per-thread passes",
    );
    const cli = await fixture.host.harness.behavior.runCli([
      "token",
      "rotate",
      "--machine",
      WORKER,
    ]);
    expect(cli.exitCode).not.toBe(0);
    expect(`${cli.stdout}${cli.stderr}`).toContain("bb pool pass revoke");
  });

  it("revokes one thread's pass by command and never prints a pass", async () => {
    const { fixture, pass, send, callRpc } = await workerFixture();
    const { runCli } = fixture.host.harness.behavior;
    const first = await pass("thread-two");
    await pass(null);
    const listed = await runCli(["pass", "list", "--json"]);
    expect(JSON.parse(listed.stdout)).toEqual({
      passes: [
        {
          threadId: "thread-two",
          hostId: WORKER,
          issuedAt: expect.any(Number),
          state: "active",
        },
      ],
    });
    expect(await callRpc("pass.list", null)).toEqual(
      JSON.parse(listed.stdout).passes,
    );
    const revoked = await runCli(["pass", "revoke", "thread-two", "--json"]);
    expect(JSON.parse(revoked.stdout)).toEqual({
      threadId: "thread-two",
      revoked: true,
    });
    expect(await callRpc("pass.revoke", { threadId: "thread-two" })).toEqual({
      threadId: "thread-two",
      revoked: false,
    });
    expect(await send(first, AVAILABILITY_PATH, "GET")).toBe(401);
    const second = await pass("thread-two");
    expect(await send(second, AVAILABILITY_PATH, "GET")).toBe(200);
    const outputs = [
      listed.stdout,
      revoked.stdout,
      (await runCli(["pass", "list"])).stdout,
      (await runCli(["audit"])).stdout,
      (await runCli(["audit", "--json"])).stdout,
      JSON.stringify(await callRpc("audit.list", {})),
    ].join("\n");
    expect(outputs).not.toMatch(/pt1\.|pc1\./u);
  });

  it("logs one select per session and account, never per request, and nothing for catalog or token counts", async () => {
    const keys: string[] = [];
    const { fixture, pass, send, audit } = await workerFixture({
      upstream: async (request, response) => {
        keys.push(String(request.headers["x-api-key"]));
        await readRequestBody(request);
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
    });
    await addApiAccount(fixture, "sk-two");
    const credential = await pass("thread-two");
    const session = (id: string) =>
      JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        metadata: { user_id: JSON.stringify({ session_id: id }) },
        messages: [{ role: "user", content: "AUDIT-BODY-MARKER" }],
      });
    for (let index = 0; index < 10; index++)
      expect(
        await send(
          credential,
          "/v1/messages",
          "POST",
          session(index % 2 === 0 ? "session-a" : "session-b"),
        ),
      ).toBe(200);
    expect(await send(credential, "/v1/messages/count_tokens")).toBe(200);
    expect(await send(credential, "/models", "GET")).toBe(200);
    const selects = (await audit()).filter((entry) => entry.reason === "select");
    expect(selects).toHaveLength(2);
    expect(selects.map((entry) => entry.threadId)).toEqual([
      "thread-two",
      "thread-two",
    ]);
    expect(selects.every((entry) => entry.hostId === WORKER)).toBe(true);
    expect(keys.filter((key) => key !== "undefined")).toHaveLength(12);
    expect(JSON.stringify(await audit())).not.toContain("AUDIT-BODY-MARKER");
  });

  it("logs limits, failover, passes and role changes without request content", async () => {
    let calls = 0;
    const { fixture, pass, send, audit } = await workerFixture({
      upstream: async (request, response) => {
        calls++;
        await readRequestBody(request);
        if (calls === 1) {
          response.writeHead(429, {
            "content-type": "application/json",
            "anthropic-ratelimit-unified-5h-status": "allowed",
            "anthropic-ratelimit-unified-7d-status": "allowed",
            "anthropic-ratelimit-unified-7d_oi-reset": "4102452000",
            "anthropic-ratelimit-unified-7d_oi-status": "rejected",
          });
          response.end('{"rejected":true}');
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      },
    });
    const second = await addApiAccount(fixture, "sk-two");
    const credential = await pass("thread-two");
    expect(
      await send(
        credential,
        "/v1/messages",
        "POST",
        JSON.stringify({
          model: "claude-fable-5",
          messages: [{ role: "user", content: "AUDIT-BODY-MARKER" }],
        }),
      ),
    ).toBe(200);
    await fixture.host.harness.behavior.callRpc("hostRole.set", {
      hostId: WORKER,
      role: "trusted",
    });
    const rows = (await audit()).map((entry) =>
      [entry.reason, entry.threadId, entry.accountId, entry.detail].join(":"),
    );
    expect(rows).toEqual([
      expect.stringMatching(/^role-change:::none->trusted$/u),
      expect.stringMatching(/^role-change:::none->trusted$/u),
      "role-change:::trusted->worker",
      "pass-issued:thread-two::",
      `limit:thread-two:${fixture.account.id}:quota`,
      `failover:thread-two:${second.id}:quota`,
      `select:thread-two:${second.id}:`,
      "pass-revoked:thread-two::role",
      "role-change:::worker->trusted",
    ]);
    expect(JSON.stringify(await audit())).not.toMatch(
      /AUDIT-BODY-MARKER|claude-fable|sk-/u,
    );
  });

  it("gives server and trusted machines exactly the P1 hub-token env, with and without a thread", async () => {
    const { env } = await workerFixture({ codex: true });
    for (const threadId of [null, "thread-one"]) {
      const claude = await env(threadId, "claude-code", "host-one");
      const codex = await env(threadId, "codex", "host-one");
      const token = claude.ANTHROPIC_AUTH_TOKEN;
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(claude).toEqual({
        ANTHROPIC_BASE_URL: expect.objectContaining({ serverPath: expect.any(String) }),
        ANTHROPIC_AUTH_TOKEN: token,
        ENABLE_TOOL_SEARCH: "true",
        _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
        [PARENT_URL_ENV]: expect.objectContaining({ serverPath: expect.any(String) }),
        [PARENT_TOKEN_ENV]: token,
      });
      expect(codex).toEqual({
        CODEX_OPENAI_BASE_URL: expect.objectContaining({ serverPath: expect.any(String) }),
        CODEX_POOL_AUTH_TOKEN: token,
        [PARENT_URL_ENV]: expect.objectContaining({ serverPath: expect.any(String) }),
        [PARENT_TOKEN_ENV]: token,
      });
    }
  });
});
