import { handleResponses } from "./responses-nonstream.js";
import {
  HostRoles,
  HostNotPermittedError,
  createHostRoleHandlers,
  hostIdSchema,
  migrateHostRoles,
} from "./host-roles.js";
import { ACCOUNT_POOL_HOST_ROLES_CHANGED } from "./realtime.js";
import { AuditLog, createAuditHandlers } from "./audit-log.js";
import {
  PassKey,
  ThreadPasses,
  createPassHandlers,
  isNotFound,
} from "./thread-pass.js";
import {
  retryAvailabilityContract,
  retryAvailabilityMethod,
  type RetryAvailability,
} from "./retry-contract.js";
import { modelFamily } from "./quota.js";
import { modelFamilySchema } from "./contracts.js";
import { registerUsageSource } from "./usage-source.js";
import {
  createUpstreamTransport,
  transportErrorCode,
} from "./upstream-transport.js";
import path from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { registerPoolCli } from "./cli.js";
import {
  REMOVED_CONFIG_KEYS,
  accountPoolConfigSchema,
  accountPoolConfigSetInputSchema,
  poolAvailabilitySchema,
  type AccountPoolConfigController,
  type PoolProvider,
  type PoolStatus,
} from "./contracts.js";
import {
  AVAILABILITY_PATH,
  PARENT_TOKEN_ENV,
  PARENT_URL_ENV,
  ParentAvailability,
  readParentPool,
  type ParentPool,
} from "./parent-pool.js";
import { createHub } from "./hub.js";
import { PROVIDER_UPSTREAMS, type ProviderUpstreams } from "./upstreams.js";
import {
  CUSTOM_HEADERS_ENV,
  ProjectPriority,
  createProjectPriorityHandlers,
  projectHeaderValue,
} from "./project-priority.js";
import { PoolOperations } from "./operations.js";
import { accountPoolRpcContract, createRpcHandlers } from "./rpc.js";
import { ClaudeOAuthLogin } from "./oauth-login.js";
import { CodexDeviceLogin } from "./codex-device-login.js";
import {
  ACCOUNT_POOL_ACCOUNTS_CHANGED,
  ACCOUNT_POOL_CONFIG_CHANGED,
} from "./realtime.js";
import {
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QUOTA_MIGRATIONS,
  QuotaStore,
  RoutingStore,
} from "./store.js";

// The values the removed upstream settings defaulted to before P0.
const FORMER_UPSTREAM_DEFAULTS: Readonly<Record<string, string>> = {
  anthropicUpstreamBaseUrl: PROVIDER_UPSTREAMS.anthropic,
  codexUpstreamBaseUrl: PROVIDER_UPSTREAMS.chatgptCodex,
};

export interface AccountPoolPluginOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  availabilityTtlMs?: number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  drainTimeoutMs?: number;
  refreshDrainTimeoutMs?: number;
  maxAffinityBindings?: number;
  disposeTimeoutMs?: number;
  // Test-only: replaces the fixed provider upstreams. The shipped plugin is
  // `createAccountPoolPlugin()` with no options, and no RPC, CLI, env or stored
  // config reaches this field.
  upstreams?: Partial<ProviderUpstreams>;
  oauthAuthorizeUrl?: string;
  oauthTokenUrl?: string;
  oauthProfileUrl?: string;
  codexAuthBaseUrl?: string;
}

const DISPOSE_INSPECTION_TIMEOUT_MS = 2_000;
// How often worker passes are checked against bb (archive, delete, removed
// machines) and the audit log is pruned; also runs once at start.
const RECONCILE_INTERVAL_MS = 15 * 60 * 1_000;
const DISPOSE_INSPECTION_TIMEOUT = Symbol("dispose-inspection-timeout");
const HUB_BASE_PATH = "/api/v1/plugins/account-pool-prewarm/http";

const PROVIDER_ROUTING_ENV: Record<PoolProvider, readonly string[]> = {
  claude: ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN"],
  codex: ["CODEX_OPENAI_BASE_URL", "CODEX_POOL_AUTH_TOKEN"],
};

interface PoolEnvEntry {
  name: string;
  value: string | { serverPath: string };
  reason: string;
}

export function helloResponse(): Response {
  return new Response(null, { status: 200 });
}

export function createAccountPoolPlugin(
  options: AccountPoolPluginOptions = {},
) {
  return async function accountPoolPlugin(bb: BbPluginApi): Promise<void> {
    const storedConfig = z
      .record(z.string(), z.unknown())
      .parse((await bb.storage.kv.get("config")) ?? {});
    const removedKeys = REMOVED_CONFIG_KEYS.filter((key) => key in storedConfig);
    // A stored upstream other than the old default is the one trace that the
    // removed setting was used; name the key, never the value.
    const nonDefaultUpstreams = Object.entries(FORMER_UPSTREAM_DEFAULTS)
      .filter(
        ([key, value]) => key in storedConfig && storedConfig[key] !== value,
      )
      .map(([key]) => key);
    for (const key of removedKeys) delete storedConfig[key];
    let currentSettings = accountPoolConfigSchema.parse(storedConfig);
    if (removedKeys.length > 0) {
      await bb.storage.kv.set("config", currentSettings);
      const upstreamKeys = removedKeys.some((key) => key in FORMER_UPSTREAM_DEFAULTS);
      bb.log.warn(
        [
          `Ignored removed config keys: ${removedKeys.join(", ")}.`,
          ...(upstreamKeys ? ["Provider upstreams are fixed in code."] : []),
          ...(nonDefaultUpstreams.length > 0
            ? [
                `A non-default upstream was stored for ${nonDefaultUpstreams.join(", ")} (value not logged).`,
              ]
            : []),
        ].join(" "),
      );
    }
    const config: AccountPoolConfigController = {
      get: () => currentSettings,
      set: async (input) => {
        const update = accountPoolConfigSetInputSchema.parse(input);
        const next = accountPoolConfigSchema.parse({
          ...currentSettings,
          ...update,
        });
        await bb.storage.kv.set("config", next);
        currentSettings = next;
        bb.realtime.publish(ACCOUNT_POOL_CONFIG_CHANGED, {});
        return next;
      },
    };
    const secretDir = path.join(
      bb.server.experimental_dataDir,
      "plugins",
      bb.pluginId,
      "secrets",
      "accounts",
    );
    const accounts = new AccountStore(bb.storage.kv, secretDir);
    await accounts.initialize();
    const now = options.now ?? Date.now;
    const db = bb.storage.database();
    // Order matters: list hosts, then migrate + seed roles in one transaction,
    // then prune tokens. Pruning before the seed would revoke every machine.
    const enrolledHosts = await bb.sdk.hosts.list();
    const enrolledIds = enrolledHosts.map((host) => host.id);
    migrateHostRoles(
      db,
      () => bb.storage.migrate(db, QUOTA_MIGRATIONS),
      enrolledIds,
    );
    const audit = new AuditLog(db, now);
    const hostRoles: HostRoles = new HostRoles(
      db,
      () => bb.sdk.hosts.list(),
      async (hostId, previous, next) => {
        audit.append({
          reason: "role-change",
          hostId,
          detail: `${previous ?? "none"}->${next ?? "none"}`,
        });
        // A worker never holds a hub token; a machine that stops being a
        // worker, or loses its role, loses its passes. Other changes keep the
        // token (P1).
        if (next === null || next === "worker") await hubTokens.revoke(hostId);
        if (previous === "worker" || next === null)
          passes.revokeHost(hostId, "role");
      },
      () => bb.realtime.publish(ACCOUNT_POOL_HOST_ROLES_CHANGED, {}),
    );
    const permitted = (hostId: string) => hostRoles.hasRole(hostId);
    const isWorker = (hostId: string) => hostRoles.roleOf(hostId) === "worker";
    // Only `server` and `trusted` machines hold a hub token.
    const holdsHubToken = (hostId: string) => {
      const role = hostRoles.roleOf(hostId);
      return role === "server" || role === "trusted";
    };
    const hubTokens = new HubTokenStore(secretDir, now, holdsHubToken);
    await hubTokens.initialize();
    await hubTokens.prune(enrolledIds);
    const passThreadSchema = z.object({
      host: z.object({ id: hostIdSchema }).nullable(),
      archivedAt: z.number().nullable(),
      deletedAt: z.number().nullable(),
    });
    const passes = new ThreadPasses({
      db,
      key: new PassKey(secretDir, (message) => bb.log.error(message)),
      now,
      audit,
      mayHold: isWorker,
      mayPresent: permitted,
      getThread: async (threadId) => {
        try {
          const thread = passThreadSchema.parse(
            await bb.sdk.threads.get({ threadId, include: "host" }),
          );
          return {
            hostId: thread.host?.id ?? null,
            archivedAt: thread.archivedAt,
            deletedAt: thread.deletedAt,
          };
        } catch (error) {
          if (isNotFound(error)) return null;
          throw error;
        }
      },
      hostExists: async (hostId) => {
        try {
          await bb.sdk.hosts.get({ hostId });
          return true;
        } catch (error) {
          if (isNotFound(error)) return false;
          throw error;
        }
      },
    });
    const routing = new RoutingStore(bb.storage.kv, now);
    const projectPriority = new ProjectPriority(bb.storage.kv, () =>
      accounts.list(),
    );
    await projectPriority.load();
    const parentPool = readParentPool(options.env ?? process.env);
    const proxyingParent = (): ParentPool | null =>
      parentPool !== null && currentSettings.parentMode === "proxy"
        ? parentPool
        : null;
    const quotas = new QuotaStore(db);
    const transport =
      options.fetch === undefined ? createUpstreamTransport() : null;
    const upstreamFetch = options.fetch ?? transport?.fetch;
    const hub = createHub({
      accounts,
      quotas,
      affinity: new PoolAffinityStore(db),
      hubTokens,
      passes,
      audit: (entry) => {
        try {
          audit.append(entry);
        } catch (error) {
          bb.log.warn(
            `Account Pooler could not write an audit entry: ${error instanceof Error ? error.message : String(error)}.`,
          );
        }
      },
      getSettings: () => currentSettings,
      fetch: upstreamFetch,
      now,
      refreshUrl: options.refreshUrl,
      codexRefreshUrl: options.codexRefreshUrl,
      codexUsageUrl: options.codexUsageUrl,
      usageUrl: options.usageUrl,
      profileUrl: options.oauthProfileUrl,
      upstreams: options.upstreams,
      drainTimeoutMs: options.drainTimeoutMs,
      refreshDrainTimeoutMs: options.refreshDrainTimeoutMs,
      maxAffinityBindings: options.maxAffinityBindings,
      getParentRoute: proxyingParent,
      getProjectOrder: (projectId) => projectPriority.get(projectId),
      onUpstreamError: (provider, error) =>
        bb.log.warn(
          `Account Pooler ${provider} transport failed: ${transportErrorCode(error)}.`,
        ),
      onAccountsChanged: () =>
        bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      onOAuthRefresh: (provider, accountId, outcome, detail) => {
        const message = `Account Pooler ${provider} account ${accountId} OAuth refresh ${outcome}: ${detail}`;
        if (outcome === "succeeded") bb.log.info(message);
        else bb.log.warn(message);
      },
    });
    if (transport !== null) {
      bb.onDispose(async () => {
        await hub.stop();
        await transport.destroy();
      });
    }
    const availability =
      parentPool === null
        ? null
        : new ParentAvailability({
            parent: parentPool,
            fetch: upstreamFetch ?? fetch,
            now,
            ...(options.availabilityTtlMs === undefined
              ? {}
              : { ttlMs: options.availabilityTtlMs }),
            onError: (error) =>
              bb.log.warn(
                `Account Pooler could not read parent availability: ${error instanceof Error ? error.message : String(error)}.`,
              ),
          });
    const parentStatus = async (): Promise<PoolStatus["parent"]> =>
      parentPool === null || availability === null
        ? null
        : {
            baseUrl: parentPool.baseUrl,
            mode: currentSettings.parentMode,
            availability: await availability.get(),
          };
    const operations = new PoolOperations(
      accounts,
      quotas,
      hub,
      hubTokens,
      routing,
      async () => {
        const hosts = await bb.sdk.hosts.list();
        hostRoles.project(hosts.map((host) => host.id));
        return hosts;
      },
      async (hostId) =>
        (await bb.sdk.system.providerStates({ hostId })).providers,
      now,
      () => bb.realtime.publish(ACCOUNT_POOL_ACCOUNTS_CHANGED, {}),
      (accountId) => hub.refreshUsage(accountId, true),
      parentStatus,
      (hostId) =>
        isWorker(hostId)
          ? "This machine is a worker: its threads hold per-thread passes, not a machine token. Revoke one thread's pass with `bb pool pass revoke <thread-id>`."
          : null,
    );
    const login = new ClaudeOAuthLogin({
      fetch: upstreamFetch,
      now,
      authorizeUrl: options.oauthAuthorizeUrl,
      tokenUrl: options.oauthTokenUrl,
      profileUrl: options.oauthProfileUrl,
      addAccount: (authenticated) => operations.addOAuth(authenticated),
    });
    const codexLogin = new CodexDeviceLogin({
      fetch: upstreamFetch,
      now,
      authBaseUrl: options.codexAuthBaseUrl,
      addAccount: (authenticated) => operations.addCodexOAuth(authenticated),
    });
    if ((await accounts.list()).every((account) => !account.enabled)) {
      bb.status.needsConfiguration(
        "Add and enable a Claude or Codex account with `bb pool account add`.",
      );
    }
    const routedProviderSchema = z.enum(["claude", "codex"]);
    const failedRequestSchema = z.object({
      requestId: z.string(),
      execution: z.object({ model: z.string() }),
    });
    const retryAvailability = async (input: {
      threadId: string;
      requestId: string;
    }): Promise<RetryAvailability> => {
      const provider = routedProviderSchema.safeParse(
        await bb.storage.kv.get(`retry-route:${input.threadId}`),
      );
      if (!provider.success) return { kind: "not-routed" };
      let hostId: string;
      try {
        const thread = z
          .object({ host: z.object({ id: hostIdSchema }).nullable() })
          .parse(
            await bb.sdk.threads.get({
              threadId: input.threadId,
              include: "host",
            }),
          );
        if (thread.host === null)
          return { kind: "unavailable", reason: "source-unavailable" };
        hostId = thread.host.id;
      } catch {
        return { kind: "unavailable", reason: "source-unavailable" };
      }
      const denied = async (): Promise<RetryAvailability> => {
        await bb.storage.kv.delete(`retry-route:${input.threadId}`);
        return { kind: "not-routed" };
      };
      if (!permitted(hostId)) return denied();
      const events = await bb.sdk.threads.events.list({
        threadId: input.threadId,
        types: ["client/turn/requested"],
        order: "desc",
        limit: "1",
      });
      const request = failedRequestSchema.safeParse(events[0]?.data);
      if (!request.success || request.data.requestId !== input.requestId)
        return { kind: "unavailable", reason: "source-unavailable" };
      if (!permitted(hostId)) return denied();
      const result = await hub.retryAvailability(
        provider.data,
        modelFamily(request.data.execution.model),
      );
      return permitted(hostId) ? result : denied();
    };
    bb.rpc.register(
      retryAvailabilityContract,
      { [retryAvailabilityMethod]: retryAvailability },
      {
        experimental_discoverable: true,
        experimental_description:
          "Account Pooler retry availability for routed failed turns.",
      },
    );
    registerUsageSource(bb, hub);
    bb.rpc.register(
      accountPoolRpcContract,
      createRpcHandlers(
        operations,
        login,
        codexLogin,
        config,
        createProjectPriorityHandlers(projectPriority),
        createHostRoleHandlers(hostRoles),
        createPassHandlers(passes),
        createAuditHandlers(audit),
      ),
    );
    registerPoolCli(
      bb,
      operations,
      login,
      codexLogin,
      config,
      projectPriority,
      hostRoles,
      passes,
      audit,
      now,
    );
    const canServe = async (provider: PoolProvider): Promise<boolean> => {
      if (!(await operations.isRoutingEnabled(provider))) return false;
      if (proxyingParent() !== null && availability !== null) {
        return (await availability.get())[provider];
      }
      return operations.hasUsableEnabledAccount(provider);
    };
    const markerEntries = (token: string): PoolEnvEntry[] => [
      {
        name: PARENT_URL_ENV,
        value: { serverPath: HUB_BASE_PATH },
        reason: "Account Pooler hub for nested bb servers on this machine",
      },
      {
        name: PARENT_TOKEN_ENV,
        value: token,
        reason: "Account Pooler hub token for this machine",
      },
    ];
    // A worker's pass belongs to one thread, so nested bb servers get no hub.
    const workerMarkerEntries = (): PoolEnvEntry[] =>
      [PARENT_URL_ENV, PARENT_TOKEN_ENV].map((name) => ({
        name,
        value: "",
        reason:
          "Worker machines hold per-thread passes, which nested bb servers cannot use",
      }));
    const neutralized = (provider: PoolProvider): PoolEnvEntry[] =>
      PROVIDER_ROUTING_ENV[provider].map((name) => ({
        name,
        value: "",
        reason:
          "Account Pooler is isolated from the parent bb server's pool on this instance",
      }));
    const contributeFor =
      (
        provider: PoolProvider,
        serving: (
          token: string,
          projectId: string | null,
        ) => Promise<PoolEnvEntry[]>,
      ) =>
      async (context: {
        threadId: string | null;
        projectId: string | null;
        hostId: string;
      }) => {
        const { threadId } = context;
        const unpermitted = async (
          reason = "This machine has no Account Pooler role, so it gets no central Claude and Codex routing.",
        ): Promise<PoolEnvEntry[]> => {
          if (threadId !== null)
            await bb.storage.kv.delete(`retry-route:${threadId}`);
          return [
            ...[
              "ANTHROPIC_BASE_URL",
              "ANTHROPIC_AUTH_TOKEN",
              "CODEX_OPENAI_BASE_URL",
              "CODEX_POOL_AUTH_TOKEN",
              PARENT_URL_ENV,
              PARENT_TOKEN_ENV,
            ].map((name) => ({ name, value: "", reason })),
          ];
        };
        if (!permitted(context.hostId)) return unpermitted();
        const bypassed =
          threadId !== null && (await routing.isBypassed(threadId));
        const worker = isWorker(context.hostId);
        if (!bypassed && (await canServe(provider))) {
          let token: string;
          if (worker) {
            // A thread gets its own pass; a send without a thread (the model
            // catalog) gets a pass that only lists models.
            const pass =
              threadId === null
                ? await passes.catalogPass(context.hostId)
                : await passes.issue(threadId, context.hostId);
            if (pass === null)
              return unpermitted(
                "Account Pooler could not issue a pass for this worker thread, so it gets no central routing.",
              );
            token = pass;
          } else {
            try {
              token = await hubTokens.forHost(context.hostId);
            } catch (error) {
              if (error instanceof HostNotPermittedError) return unpermitted();
              throw error;
            }
          }
          if (threadId !== null) {
            await bb.storage.kv.set(`retry-route:${threadId}`, provider);
            if (provider === "claude") {
              await routing.recordRouted(threadId, context.hostId);
            }
          }
          const entries = [
            ...(await serving(token, context.projectId)),
            ...(worker ? workerMarkerEntries() : markerEntries(token)),
          ];
          return !permitted(context.hostId) || isWorker(context.hostId) !== worker
            ? unpermitted()
            : entries;
        }
        if (threadId !== null) {
          await bb.storage.kv.delete(`retry-route:${threadId}`);
        }
        return !permitted(context.hostId)
          ? unpermitted()
          : parentPool === null
            ? []
            : neutralized(provider);
      };
    const projectHeaderEntries = (projectId: string | null): PoolEnvEntry[] => {
      const value = projectHeaderValue(
        projectId,
        (options.env ?? process.env)[CUSTOM_HEADERS_ENV],
      );
      return value === null
        ? []
        : [
            {
              name: CUSTOM_HEADERS_ENV,
              value,
              reason:
                "Tells the Account Pooler hub which bb project a request belongs to, so its account order applies to new sessions",
            },
          ];
    };
    const subscriptionCacheEntries = async (): Promise<PoolEnvEntry[]> =>
      proxyingParent() === null &&
      (await operations.routesOnlyApiKeys("claude"))
        ? []
        : [
            {
              name: "ENABLE_PROMPT_CACHING_1H",
              value: "1",
              reason:
                "Claude Code uses a 5-minute prompt cache behind a custom base URL; subscription accounts get the 1-hour cache Claude Code uses for a direct subscription login",
            },
          ];
    const proxiedHealth = async (provider: PoolProvider, hostId: string) =>
      permitted(hostId) &&
      (await canServe(provider)) &&
      permitted(hostId)
        ? {
            label: "Proxied",
            statusMessage:
              proxyingParent() === null
                ? "Credentials are provided by the Account Pooler hub."
                : "Credentials are proxied to the parent bb server's Account Pooler.",
          }
        : null;
    bb.providers.experimental_contributeEnv(
      "claude-code",
      contributeFor("claude", async (token, projectId) => [
        {
          name: "ANTHROPIC_BASE_URL",
          value: { serverPath: HUB_BASE_PATH },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "ANTHROPIC_AUTH_TOKEN",
          value: token,
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
        ...(await subscriptionCacheEntries()),
        ...projectHeaderEntries(projectId),
      ]),
    );
    bb.providers.experimental_contributeEnvHealth("claude-code", (context) =>
      proxiedHealth("claude", context.hostId),
    );
    bb.providers.experimental_contributeEnv(
      "codex",
      contributeFor("codex", async (token) => [
        {
          name: "CODEX_OPENAI_BASE_URL",
          value: { serverPath: `${HUB_BASE_PATH}/v1` },
          reason: "Routed through the Account Pooler hub",
        },
        {
          name: "CODEX_POOL_AUTH_TOKEN",
          value: token,
          reason: "Account Pooler hub token for this machine",
        },
      ]),
    );
    bb.providers.experimental_contributeEnvHealth("codex", (context) =>
      proxiedHealth("codex", context.hostId),
    );
    bb.onDispose(async () => {
      codexLogin.dispose();
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const inspection = inspectDisableState(bb, operations);
        const timeout = new Promise<typeof DISPOSE_INSPECTION_TIMEOUT>(
          (resolve) => {
            timer = setTimeout(
              () => resolve(DISPOSE_INSPECTION_TIMEOUT),
              options.disposeTimeoutMs ?? DISPOSE_INSPECTION_TIMEOUT_MS,
            );
            timer.unref();
          },
        );
        const result = await Promise.race([inspection, timeout]);
        if (result === DISPOSE_INSPECTION_TIMEOUT) {
          bb.log.debug("Account Pooler disable inspection timed out.");
          return;
        }
        if (result !== null) bb.log.warn(result);
      } catch (error) {
        bb.log.debug(
          `Account Pooler disable inspection skipped: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    });
    for (const route of ["/v1/messages", "/v1/messages/count_tokens"]) {
      bb.http.route(
        "POST",
        route,
        (context) => hub.handle(context.req.raw, "claude", route),
        { auth: "none" },
      );
    }
    for (const route of [
      "/v1/responses",
      "/v1/responses/compact",
      "/v1/images/generations",
      "/v1/images/edits",
      "/v1/alpha/search",
    ]) {
      bb.http.route(
        "POST",
        route,
        (context) =>
          route === "/v1/responses"
            ? handleResponses(context.req.raw, (request) =>
                hub.handle(request, "codex", route),
              )
            : hub.handle(context.req.raw, "codex", route),
        { auth: "none" },
      );
    }
    bb.http.route(
      "GET",
      "/models",
      (context) => hub.handle(context.req.raw, "claude", "/models"),
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      "/v1/models",
      (context) => hub.handle(context.req.raw, "codex", "/v1/models"),
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      AVAILABILITY_PATH,
      async (context) => {
        const principal = await hub.authenticate(context.req.raw);
        if (principal === null) return new Response(null, { status: 401 });
        if (principal.kind === "catalog")
          return new Response(null, { status: 403 });
        return Response.json(
          poolAvailabilitySchema.parse({
            claude: await canServe("claude"),
            codex: await canServe("codex"),
          }),
        );
      },
      { auth: "none" },
    );
    bb.http.route(
      "GET",
      "/retry-availability",
      async (context) => {
        const principal = await hub.authenticate(context.req.raw);
        if (principal === null) return new Response(null, { status: 401 });
        if (principal.kind === "catalog")
          return new Response(null, { status: 403 });
        const query = z
          .object({ provider: routedProviderSchema, family: modelFamilySchema })
          .safeParse(
            Object.fromEntries(new URL(context.req.raw.url).searchParams),
          );
        if (!query.success) return new Response(null, { status: 400 });
        return Response.json(
          await hub.retryAvailability(query.data.provider, query.data.family),
        );
      },
      { auth: "none" },
    );
    bb.http.route("HEAD", "/api/hello", () => helloResponse(), {
      auth: "none",
    });
    bb.background.service("hub", {
      start: (signal) => hub.start(signal),
    });
    // Thread lifecycle revokes worker passes. Events missed while the plugin
    // was down are caught by the reconcile below.
    bb.events.on("thread.archived", async ({ thread }) => {
      // Without a worker there is no pass to revoke and no race to close.
      if (hostRoles.hasAny("worker"))
        await passes.archived(thread.id, thread.archivedAt ?? now());
    });
    bb.events.on("thread.unarchived", ({ thread }) => {
      passes.unarchived(thread.id);
    });
    bb.events.on("thread.deleted", ({ thread }) => {
      passes.revokeThread(thread.id, "deleted");
    });
    bb.events.on("experimental_host.deleted", ({ host }) => {
      passes.revokeHost(host.id, "host-removed");
    });
    bb.background.service("pass-reconcile", {
      start: async (signal) => {
        while (!signal.aborted) {
          try {
            await passes.reconcile();
            audit.prune();
          } catch (error) {
            bb.log.warn(
              `Account Pooler pass reconcile failed: ${error instanceof Error ? error.message : String(error)}.`,
            );
          }
          await new Promise<void>((resolve) => {
            if (signal.aborted) return resolve();
            const wake = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", wake);
              resolve();
            };
            const timer = setTimeout(wake, RECONCILE_INTERVAL_MS);
            timer.unref();
            signal.addEventListener("abort", wake, { once: true });
          });
        }
      },
    });
  };
}

async function inspectDisableState(
  bb: BbPluginApi,
  operations: PoolOperations,
): Promise<string | null> {
  const installed = await bb.sdk.plugins.list();
  const disabled =
    installed.plugins.find((plugin) => plugin.id === bb.pluginId)?.enabled ===
    false;
  if (!disabled) return null;
  const warnings = await operations.routedThreadsWithoutLocalLogin();
  if (warnings.length === 0) return null;
  return `Account Pooler disabled with ${warnings.length} recently routed thread${warnings.length === 1 ? "" : "s"} on machines without a local Claude login. Run bb pool status before disabling to inspect them.`;
}

export default createAccountPoolPlugin();
