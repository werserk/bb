import { z } from "zod";
import {
  retryAvailabilitySchema,
  type RetryAvailability,
} from "./retry-contract.js";
import { HUB_TOKEN_HEADER } from "./parent-pool.js";
import type {
  Account,
  AccountPingResult,
  AccountPoolConfig,
  AccountQuota,
  AccountSecret,
  ModelFamily,
  PoolProvider,
  PoolStatus,
} from "./contracts.js";
import { createClaudeAdapter } from "./claude-adapter.js";
import {
  createCodexAdapter,
  DEFAULT_CODEX_REFRESH_URL,
  DEFAULT_CODEX_USAGE_URL,
} from "./codex-adapter.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import {
  OAUTH_REFRESH_TIMEOUT_MS,
  OAuthRefreshError,
  TransientOAuthRefreshError,
  UsageAuthenticationError,
} from "./provider-adapter.js";
import {
  accountStatus,
  blockingResetAt,
  governingWeeklyResetAt,
  hasExtraUsage,
  isQuotaExhausted,
  isSharedQuotaExhausted,
  isUsageRestricted,
  retryAfterMilliseconds,
} from "./quota.js";
import type {
  AccountBinding,
  AccountStore,
  HubTokenStore,
  PoolAffinityStore,
  QuotaStore,
} from "./store.js";
import { parentRequestHeaders, type ParentPool } from "./parent-pool.js";
import { orderForProject, readProjectId } from "./project-priority.js";
import { PROVIDER_UPSTREAMS, type ProviderUpstreams } from "./upstreams.js";
import type { AuditInput } from "./audit-log.js";
import { looksLikePass, type PassPrincipal } from "./thread-pass.js";
import {
  NAMED_LIMIT_THRESHOLD,
  namedAccountState,
  type NamedAccountState,
  type OnLimit,
  type Serving,
  type ThreadPolicy,
} from "./thread-policy.js";

// Who sent a request: a machine (hub token) or, on a worker machine, one
// thread (thread pass) or the model catalog (catalog pass).
export type HubPrincipal = { kind: "host"; hostId: string } | PassPrincipal;

export interface HubPasses {
  verify(presented: string): Promise<PassPrincipal | null>;
}

// Thread account policies (block P3, thread-policy.ts), as the hub uses them.
export interface HubThreadPolicies {
  get(threadId: string): ThreadPolicy;
  // Compare-and-set to `auto` after a real limit; false when another writer won.
  fallBack(threadId: string, revision: number): boolean;
  servingFor(threadId: string): Serving | null;
  noteServing(threadId: string, accountId: string, at: number): void;
}

interface NamedRoute {
  accountId: string;
  onLimit: OnLimit;
  revision: number;
  updatedAt: number | null;
}

const MAX_NAMED_LIMIT_KEYS = 10_000;
// How often one request re-reads a policy that changed under it.
const MAX_POLICY_READS = 3;

// Requests that reach a model. The audit logs only these: catalog listings and
// token counts never pick an account for a conversation.
const AUDITED_ROUTES = new Set([
  "/v1/messages",
  "/v1/responses",
  "/v1/responses/compact",
  "/v1/images/generations",
  "/v1/images/edits",
  "/v1/alpha/search",
]);
const CATALOG_ROUTES = new Set(["/models", "/v1/models"]);
const MAX_AUDIT_SELECT_KEYS = 10_000;

type FailoverCause = "quota" | "rate-limit" | "auth" | "upstream";

const ROUTE = "/api/v1/plugins/account-pool-prewarm/http";
const DEFAULT_REFRESH_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const DEFAULT_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const DEFAULT_USAGE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const EXHAUSTED_USAGE_REFRESH_INTERVAL_MS = 30 * 1_000;
const MAX_INLINE_HOLD_MS = 20_000;
const MAX_REFRESH_BACKOFF_MS = 60_000;
const MAX_REFRESH_BACKOFFS = 1_024;
const UPSTREAM_REJECTION_HOLD_MS = 60_000;
const MAX_FAILURE_DETAIL_BYTES = 1_024;
const FAILURE_DISPOSAL_TIMEOUT_MS = 250;
const AFFINITY_IDLE_TTL_MS = 65 * 60 * 1_000;
const MAX_AFFINITY_BINDINGS = 4_096;
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

interface HubOptions {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  maxAffinityBindings: number;
  hubTokens: HubTokenStore;
  passes: HubPasses | null;
  policies: HubThreadPolicies | null;
  audit: (entry: AuditInput) => void;
  onThreadAccountChanged: (threadId: string) => void;
  getSettings: () => AccountPoolConfig;
  adapters: ReadonlyMap<PoolProvider, ProviderAdapter>;
  fetch: typeof fetch;
  now: () => number;
  drainTimeoutMs: number;
  refreshDrainTimeoutMs: number;
  getParentRoute: () => ParentPool | null;
  getProjectOrder: (projectId: string) => readonly string[] | null;
  onAccountsChanged: () => void;
  onUpstreamError: (provider: PoolProvider, error: unknown) => void;
  onOAuthRefresh: (
    provider: PoolProvider,
    accountId: string,
    outcome: "succeeded" | "failed",
    message: string,
  ) => void;
}

interface SelectedAccount {
  account: Account;
  quota: AccountQuota;
  keepAffinity: boolean;
  accept: () => void;
}

interface ActiveAccount {
  accountId: string;
}

interface PacingFlight {
  heldUntil: number;
  result: Promise<void>;
}

interface RoutingAttempt {
  binding: AccountBinding | null;
  active: ActiveAccount | null;
  pinnedAccountId: string | null;
}
interface UpstreamResult {
  response: Response;
  controller: AbortController;
  release: () => void;
}

interface RefreshBackoff {
  kind: "proactive" | "rejected" | "upstream";
  accessToken: string;
  retryAt: number;
  delayMs: number;
  error: TransientOAuthRefreshError;
}

type SecretUse = { kind: "normal" } | { kind: "rejected"; accessToken: string };

type SecretFlight =
  | { kind: "refresh"; use: SecretUse; result: Promise<AccountSecret> }
  | { kind: "rejection-check"; result: Promise<void> };

interface FailureSummary {
  status: number;
  message: string;
  headers: Record<string, string>;
}

class UpstreamConnectionError extends Error {}

export class AccountPoolHub {
  private accepting = false;
  private stopped = new AbortController();
  private readonly inFlightByAccount = new Map<string, number>();
  private readonly activeControllers = new Set<AbortController>();
  private readonly refreshes = new Map<string, SecretFlight>();
  private readonly refreshBackoffs = new Map<string, RefreshBackoff>();
  private readonly pacingByAccount = new Map<string, PacingFlight>();
  private affinityBindings = new Map<string, AccountBinding>();
  private activeAccounts = new Map<PoolProvider, ActiveAccount>();
  // Last account logged as `select` per [provider, principal, session].
  private readonly auditedSelections = new Map<string, string>();
  // Last `named-limit` row per thread that does not change the policy (stop,
  // unavailable): repeats are not logged until a success or a policy change.
  private readonly namedLimitNotes = new Map<string, string>();
  private readonly usageRefreshes = new Map<string, Promise<void>>();
  private readonly lastUsageRefreshAt = new Map<string, number>();
  private readonly drainWaiters = new Set<() => void>();

  constructor(private readonly options: HubOptions) {}

  async start(signal: AbortSignal): Promise<void> {
    this.affinityBindings = this.options.affinity.loadBindings(
      this.options.now() - AFFINITY_IDLE_TTL_MS,
      MAX_AFFINITY_BINDINGS,
    );
    this.activeAccounts = this.options.affinity.loadActiveAccounts();
    this.pacingByAccount.clear();
    this.stopped = new AbortController();
    this.accepting = true;
    while (!signal.aborted) {
      await this.refreshUsage();
      await waitForDelay(DEFAULT_USAGE_REFRESH_INTERVAL_MS, signal);
    }
    await this.stop();
  }

  async authenticate(request: Request): Promise<HubPrincipal | null> {
    const token =
      request.headers.get("x-bb-account-pool-token") ??
      readBearer(request.headers.get("authorization"));
    if (token === null) return null;
    if (looksLikePass(token))
      return this.options.passes === null
        ? null
        : this.options.passes.verify(token);
    const hostId = await this.options.hubTokens.authenticate(token);
    return hostId === null ? null : { kind: "host", hostId };
  }

  async handle(
    request: Request,
    provider: PoolProvider,
    routePath: string,
  ): Promise<Response> {
    const adapter = this.adapter(provider);
    const principal = await this.authenticate(request);
    if (principal === null) {
      return adapter.errorResponse(401, "Invalid Account Pooler bearer token.");
    }
    // Before any other branch, the parent proxy included: a catalog pass only
    // lists models.
    if (principal.kind === "catalog" && !CATALOG_ROUTES.has(routePath))
      return adapter.errorResponse(
        403,
        "This Account Pooler pass only lists models.",
      );
    if (!this.accepting)
      return adapter.errorResponse(
        503,
        "Account Pooler is not accepting requests.",
      );
    const parent = this.options.getParentRoute();
    if (parent !== null) {
      return this.forwardToParent(request, adapter, routePath, parent);
    }
    const projectId =
      provider === "claude" ? readProjectId(request.headers) : null;
    return this.forward(
      request,
      new Uint8Array(await request.arrayBuffer()),
      adapter,
      principal,
      routePath,
      projectId === null ? null : this.options.getProjectOrder(projectId),
    );
  }

  async ping(
    accountId: string,
    diagnostic = false,
  ): Promise<AccountPingResult> {
    if (!this.accepting)
      throw new Error("Account Pooler is not accepting requests.");
    if (this.options.getParentRoute() !== null)
      throw new Error("Ping requires a local pool, not parent proxy mode.");
    const account = await this.options.accounts.get(accountId);
    if (
      account === null ||
      account.provider !== "claude" ||
      (!diagnostic && !account.enabled)
    ) {
      throw new Error("Ping requires an enabled local Claude account.");
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      this.stopped.signal,
    ]);
    if (!diagnostic) await abortable(this.refreshUsage(accountId), signal);
    const quota = this.options.quotas.get(accountId);
    const now = this.options.now();
    if (
      !diagnostic &&
      (quota.accessBlocked !== null ||
        quota.error !== null ||
        isUsageRestricted(quota, now) ||
        (quota.heldUntil !== null && quota.heldUntil > now) ||
        isQuotaExhausted(
          quota,
          "haiku",
          this.options.getSettings().switchThreshold,
          now,
        ))
    ) {
      throw new Error("The target account is unavailable for a Haiku ping.");
    }
    const current = await this.options.accounts.get(accountId);
    if (
      !this.accepting ||
      current === null ||
      (!diagnostic && !current.enabled) ||
      current.provider !== "claude"
    ) {
      throw new Error("The target account is no longer available.");
    }
    const adapter = this.adapter("claude");
    const secret = await abortable(
      this.freshSecret(current, adapter, { kind: "normal" }),
      signal,
    );
    const model = "claude-haiku-4-5-20251001";
    const request = new Request("http://localhost/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...(secret.kind === "oauth"
          ? { "anthropic-beta": "oauth-2025-04-20" }
          : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        stream: false,
        messages: [{ role: "user", content: "Hi" }],
      }),
    });
    const parsed = adapter.parseRequest(
      new Uint8Array(await request.arrayBuffer()),
      request.headers,
    );
    const upstream = await this.fetchUpstream(
      request,
      parsed.forAccount(current),
      current,
      secret,
      adapter,
    );
    let disposed = false;
    try {
      const observed = adapter.quotaFromHeaders(
        accountId,
        upstream.response.headers,
        this.options.quotas.get(accountId),
        "haiku",
        this.options.now(),
      );
      this.options.quotas.put(
        upstream.response.status === 429 &&
          !adapter.isQuotaRejection(upstream.response.headers)
          ? {
              ...observed,
              heldUntil:
                this.options.now() +
                retryAfterMilliseconds(
                  upstream.response.headers.get("retry-after"),
                  this.options.now(),
                ),
            }
          : observed,
      );
      let error: Pick<AccountPingResult, "error"> = {};
      let detail = "";
      if (!upstream.response.ok) {
        disposed = true;
        detail = await this.discardUpstream(upstream, true);
        error = pingError(detail, secret);
      }
      this.observeAccess(current, upstream.response.status, detail, secret);
      if (upstream.response.status === 401 && secret.kind === "oauth") {
        try {
          await abortable(
            this.freshSecret(current, adapter, {
              kind: "rejected",
              accessToken: secret.accessToken,
            }),
            signal,
          );
        } catch (refreshError) {
          signal.throwIfAborted();
          if (!(refreshError instanceof TransientOAuthRefreshError)) {
            await this.rejectCredential(current, secret, signal, () =>
              this.markError(accountId, errorMessage(refreshError)),
            );
          }
        }
      }
      return {
        accountId,
        model,
        status: upstream.response.status,
        ok: upstream.response.ok,
        ...error,
      };
    } finally {
      if (!disposed) await this.discardUpstream(upstream, false);
    }
  }

  private observeAccess(
    account: Account,
    status: number,
    detail: string,
    secret: AccountSecret,
  ): void {
    const blocked = isAccessFailure(status, detail);
    if (
      account.provider !== "claude" ||
      (!blocked && (status < 200 || status >= 300))
    )
      return;
    const quota = this.options.quotas.get(account.id);
    const error = pingError(detail, secret).error;
    this.options.quotas.setAccessBlocked(
      account.id,
      blocked
        ? {
            status: status === 400 ? 400 : 403,
            type: error?.type ?? null,
            message: error?.message ?? null,
            observedAt: this.options.now(),
          }
        : null,
    );
    if (blocked || quota.accessBlocked !== null)
      this.options.onAccountsChanged();
  }

  private trackRequest(
    request: Request,
    onRelease?: () => void,
  ): { controller: AbortController; release: () => void } {
    const controller = new AbortController();
    const abortFromRequest = () => controller.abort(request.signal.reason);
    this.activeControllers.add(controller);
    if (request.signal.aborted) abortFromRequest();
    else
      request.signal.addEventListener("abort", abortFromRequest, {
        once: true,
      });
    let released = false;
    return {
      controller,
      release: () => {
        if (released) return;
        released = true;
        request.signal.removeEventListener("abort", abortFromRequest);
        this.activeControllers.delete(controller);
        onRelease?.();
      },
    };
  }

  private async forwardToParent(
    request: Request,
    adapter: ProviderAdapter,
    routePath: string,
    parent: ParentPool,
  ): Promise<Response> {
    const { controller, release } = this.trackRequest(request);
    try {
      const search = new URL(request.url).search;
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer();
      const response = await this.options
        .fetch(`${parent.baseUrl}${routePath}${search}`, {
          method: request.method,
          headers: parentRequestHeaders(request.headers, parent.token),
          ...(body === undefined ? {} : { body }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Parent pool unreachable.", {
            cause,
          });
        });
      return this.clientResponse({ response, controller, release });
    } catch (error) {
      release();
      if (request.signal.aborted)
        return adapter.errorResponse(
          499,
          "Account Pooler request was canceled.",
        );
      if (error instanceof UpstreamConnectionError)
        return adapter.errorResponse(
          502,
          "Account Pooler could not reach the parent pool.",
        );
      throw error;
    }
  }

  async refreshUsage(accountId?: string, force = false): Promise<void> {
    const accounts = (await this.options.accounts.list()).filter(
      (account) =>
        account.enabled &&
        account.kind === "oauth" &&
        (accountId === undefined || account.id === accountId),
    );
    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(
          account,
          force ? 0 : DEFAULT_USAGE_REFRESH_INTERVAL_MS,
          force,
        ),
      ),
    );
  }

  private async refreshExhaustedUsage(
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
  ): Promise<void> {
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const accounts = (await this.options.accounts.list()).filter((account) => {
      if (
        !candidateIds.has(account.id) ||
        attempted.has(account.id) ||
        !account.enabled ||
        account.kind !== "oauth"
      )
        return false;
      const quota = this.options.quotas.get(account.id);
      return (
        quota.error === null && isQuotaExhausted(quota, family, threshold, now)
      );
    });
    await Promise.all(
      accounts.map((account) =>
        this.refreshAccountUsage(account, EXHAUSTED_USAGE_REFRESH_INTERVAL_MS),
      ),
    );
  }

  private async refreshAccountUsage(
    account: Account,
    minIntervalMs: number,
    recoverError = false,
  ): Promise<void> {
    const adapter = this.adapter(account.provider);
    if ((this.inFlightByAccount.get(account.id) ?? 0) > 0) return;
    const running = this.usageRefreshes.get(account.id);
    if (running !== undefined) return running;
    const now = this.options.now();
    const last = this.lastUsageRefreshAt.get(account.id);
    if (last !== undefined && now - last < minIntervalMs) return;
    this.lastUsageRefreshAt.set(account.id, now);
    const recover =
      recoverError && this.options.quotas.get(account.id).error !== null;
    const refresh = adapter
      .refreshUsage({
        account,
        freshSecret: (rejected) =>
          this.freshSecret(
            account,
            adapter,
            rejected === undefined
              ? { kind: "normal" }
              : { kind: "rejected", accessToken: rejected.accessToken },
            recover,
          ).catch(
            async (error: unknown) => {
              if (!(error instanceof TransientOAuthRefreshError)) {
                if (rejected !== undefined) {
                  await this.rejectCredential(
                    account,
                    rejected,
                    this.stopped.signal,
                    () => this.markError(account.id, errorMessage(error)),
                  );
                } else if (recover) {
                  this.markError(account.id, errorMessage(error));
                }
              }
              throw error;
            },
          ),
        accounts: this.options.accounts,
        quotas: this.options.quotas,
        fetch: this.options.fetch,
        now: this.options.now,
      })
      .catch(async (error: unknown) => {
        if (error instanceof UsageAuthenticationError) {
          await this.rejectCredential(
            account,
            error.rejected,
            this.stopped.signal,
            () => this.markError(account.id, error.message),
          );
        }
      })
      .finally(() => this.usageRefreshes.delete(account.id));
    this.usageRefreshes.set(account.id, refresh);
    return refresh;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.stopped.abort(new Error("Account Pooler stopped accepting requests."));
    await this.drainRequests();
    await this.settleRefreshes();
  }

  // A refresh cut off after the provider rotated the refresh token would lose
  // the new pair and force a re-login, so stop waits for it (bounded).
  private async settleRefreshes(): Promise<void> {
    if (this.refreshes.size === 0) return;
    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<void>((resolve) => {
      timeout = setTimeout(() => {
        expired = true;
        resolve();
      }, this.options.refreshDrainTimeoutMs);
    });
    while (this.refreshes.size > 0 && !expired) {
      await Promise.race([
        Promise.allSettled(
          [...this.refreshes.values()].map((flight) => flight.result),
        ),
        deadline,
      ]);
    }
    if (timeout !== null) clearTimeout(timeout);
  }

  private async drainRequests(): Promise<void> {
    if (this.inFlightCount() === 0) return;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      new Promise<void>((resolve) => this.drainWaiters.add(resolve)),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, this.options.drainTimeoutMs);
      }),
    ]);
    if (timeout !== null) clearTimeout(timeout);
    if (this.inFlightCount() === 0) return;
    for (const controller of this.activeControllers) {
      controller.abort(
        new Error(
          "Account Pooler stopped before the upstream response completed.",
        ),
      );
    }
  }

  async status(): Promise<Omit<PoolStatus, "routing" | "parent">> {
    const settings = this.options.getSettings();
    const now = this.options.now();
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    return {
      route: ROUTE,
      enabledAccountCount: accounts.filter((account) => account.enabled).length,
      inFlight: this.inFlightCount(),
      accepting: this.accepting,
      hosts: await this.options.hubTokens.list(),
      accounts: accounts.map((account) => {
        const quota = this.options.quotas.get(account.id);
        const { accountId: _accountId, ...quotaFields } = quota;
        return {
          ...account,
          lastUsedHostName: null,
          ...quotaFields,
          inFlight: this.inFlightByAccount.get(account.id) ?? 0,
          status: accountStatus(account, quota, settings.switchThreshold, now),
        };
      }),
    };
  }

  private async forward(
    request: Request,
    body: Uint8Array,
    adapter: ProviderAdapter,
    principal: HubPrincipal,
    routePath: string,
    projectOrder: readonly string[] | null,
  ): Promise<Response> {
    const { hostId } = principal;
    const threadId = principal.kind === "thread" ? principal.threadId : null;
    const audited = AUDITED_ROUTES.has(routePath);
    const audit = (
      reason: "select" | "failover" | "limit" | "named-limit" | "policy",
      accountId: string | null,
      detail: string | null = null,
    ) => {
      if (!audited) return;
      this.options.audit({
        reason,
        provider: adapter.provider,
        threadId,
        hostId,
        accountId,
        detail,
      });
    };
    let cause: FailoverCause = "upstream";
    const signal = AbortSignal.any([request.signal, this.stopped.signal]);
    const attempted = new Set<string>();
    const waited = new Set<string>();
    const routing: RoutingAttempt = {
      binding: null,
      active: null,
      pinnedAccountId: null,
    };
    let previousAccountId: string | null = null;
    let failure: FailureSummary | null = null;
    let usageRefreshed = false;
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === adapter.provider,
    );
    const candidateIds = new Set(accounts.map((account) => account.id));
    const parsed = adapter.parseRequest(body, request.headers);
    const family = parsed.family;
    const affinityKey =
      parsed.affinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.affinityId]);
    const parentAffinityKey =
      affinityKey === null || parsed.parentAffinityId === null
        ? null
        : JSON.stringify([adapter.provider, hostId, parsed.parentAffinityId]);
    // A thread pinned to a named account of this provider (block P3) uses only
    // that account until it cannot serve; then its on-limit rule applies.
    const policies = this.options.policies;
    let policyReads = 0;
    const readNamed = (): NamedRoute | null => {
      if (threadId === null || policies === null) return null;
      policyReads += 1;
      let policy: ThreadPolicy;
      try {
        policy = policies.get(threadId);
      } catch {
        return null;
      }
      return policy.mode === "named" && policy.provider === adapter.provider
        ? {
            accountId: policy.accountId,
            onLimit: policy.onLimit,
            revision: policy.revision,
            updatedAt: policy.updatedAt,
          }
        : null;
    };
    let named = readNamed();
    let namedRefreshed = false;
    const namedStates = new Map<string, NamedAccountState>();
    const setAside = (accountId: string) => {
      if (candidateIds.has(accountId)) attempted.add(accountId);
    };
    try {
      while (attempted.size < candidateIds.size || named !== null) {
        signal.throwIfAborted();
        let selected: SelectedAccount | null;
        if (named !== null) {
          const accountId = named.accountId;
          if (attempted.has(accountId) && !namedStates.has(accountId)) {
            // A quota rejection is the real limit. Any other failure is
            // transient unless it left the account unusable (D2).
            if (cause === "quota") namedStates.set(accountId, "limit");
            else {
              const after = await this.namedAccount(accountId, family, false);
              if (after.state === "ok") break;
              namedStates.set(accountId, after.state);
            }
          }
          const looked = await abortable(
            this.namedAccount(
              accountId,
              family,
              !namedRefreshed && !attempted.has(accountId),
            ),
            signal,
          );
          namedRefreshed = true;
          const state = namedStates.get(accountId) ?? looked.state;
          if (
            state === "ok" &&
            looked.account !== null &&
            looked.quota !== null &&
            looked.account.provider === adapter.provider
          ) {
            selected = this.selectNamed(looked.account, looked.quota, affinityKey);
          } else {
            const notServing = state === "ok" ? "deleted" : state;
            namedStates.set(accountId, notServing);
            setAside(accountId);
            if (!audited || threadId === null || policies === null) {
              // Token counts and other side routes never change a policy.
              named = null;
              continue;
            }
            if (named.onLimit === "stop") {
              if (
                this.firstNamedLimit(
                  threadId,
                  `${named.revision}:${notServing}-stop`,
                )
              ) {
                audit("named-limit", accountId, `${notServing}-stop`);
                this.options.onThreadAccountChanged(threadId);
              }
              const resetAt =
                notServing === "limit" && looked.quota !== null
                  ? blockingResetAt(
                      looked.quota,
                      family,
                      NAMED_LIMIT_THRESHOLD,
                      this.options.now(),
                    )
                  : null;
              return adapter.errorResponse(
                429,
                namedStopMessage(notServing, looked.account?.label ?? null),
                resetAt === null
                  ? {}
                  : {
                      "retry-after": String(
                        Math.max(
                          1,
                          Math.ceil((resetAt - this.options.now()) / 1_000),
                        ),
                      ),
                    },
              );
            }
            if (notServing === "unavailable") {
              // Served by auto for this request; the policy stays (D2).
              if (
                this.firstNamedLimit(
                  threadId,
                  `${named.revision}:unavailable-fallback-auto`,
                )
              ) {
                audit("named-limit", accountId, "unavailable-fallback-auto");
                this.options.onThreadAccountChanged(threadId);
              }
              named = null;
              continue;
            }
            if (policies.fallBack(threadId, named.revision)) {
              audit("named-limit", accountId, `${notServing}-fallback-auto`);
              audit("policy", null, "auto@limit");
              this.namedLimitNotes.delete(threadId);
              this.options.onThreadAccountChanged(threadId);
              named = null;
            } else {
              // Another writer changed the policy first: follow what it wrote.
              named = policyReads < MAX_POLICY_READS ? readNamed() : null;
              if (named !== null) namedStates.delete(named.accountId);
            }
            continue;
          }
        } else {
          selected = await this.select(
            adapter.provider,
            candidateIds,
            attempted,
            family,
            affinityKey,
            parentAffinityKey,
            previousAccountId,
            routing,
            signal,
            projectOrder,
          );
          if (
            !usageRefreshed &&
            (selected === null ||
              isQuotaExhausted(
                selected.quota,
                family,
                this.options.getSettings().switchThreshold,
                this.options.now(),
              ))
          ) {
            usageRefreshed = true;
            await abortable(
              this.refreshExhaustedUsage(candidateIds, attempted, family),
              signal,
            );
            continue;
          }
        }
        if (selected === null) break;
        let pacing: PacingFlight | null = null;
        const heldMs = (selected.quota.heldUntil ?? 0) - this.options.now();
        let activePacing = this.pacingByAccount.get(selected.account.id);
        if (
          activePacing !== undefined &&
          (activePacing.heldUntil !== selected.quota.heldUntil || heldMs <= 0)
        ) {
          this.releasePacing(selected.account.id, activePacing);
          activePacing = undefined;
        }
        if (heldMs > 0) {
          if (activePacing !== undefined) {
            pacing = activePacing;
            waited.add(selected.account.id);
            await abortable(activePacing.result, signal);
          } else if (
            heldMs > MAX_INLINE_HOLD_MS ||
            waited.has(selected.account.id)
          ) {
            failure = {
              status: 429,
              message:
                "The current Account Pooler account is temporarily rate limited.",
              headers: { "retry-after": String(Math.ceil(heldMs / 1_000)) },
            };
            audit("limit", selected.account.id, "rate-limit");
            cause = "rate-limit";
            if (selected.keepAffinity)
              return adapter.errorResponse(
                failure.status,
                failure.message,
                failure.headers,
              );
            attempted.add(selected.account.id);
            previousAccountId = selected.account.id;
            continue;
          } else {
            waited.add(selected.account.id);
            await waitForDelay(heldMs, signal);
            continue;
          }
        }
        if (previousAccountId !== null && previousAccountId !== selected.account.id)
          audit("failover", selected.account.id, cause);
        previousAccountId = selected.account.id;
        attempted.add(selected.account.id);
        const changed = await this.options.accounts.recordUsed(
          selected.account.id,
          this.options.now(),
          hostId,
        );
        if (changed) this.options.onAccountsChanged();
        let secret: AccountSecret;
        try {
          signal.throwIfAborted();
          secret = await abortable(
            this.freshSecret(selected.account, adapter, { kind: "normal" }),
            signal,
          );
        } catch (error) {
          if (pacing !== null) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          signal.throwIfAborted();
          if (error instanceof TransientOAuthRefreshError) {
            failure = { status: 503, message: error.message, headers: {} };
          } else {
            this.markError(selected.account.id, errorMessage(error));
          }
          continue;
        }
        let authRetried = false;
        let paced = waited.has(selected.account.id);
        while (true) {
          signal.throwIfAborted();
          let upstream: UpstreamResult;
          try {
            upstream = await this.fetchUpstream(
              request,
              parsed.forAccount(selected.account),
              selected.account,
              secret,
              adapter,
            );
          } catch (error) {
            if (pacing !== null) {
              this.releasePacing(selected.account.id, pacing);
              pacing = null;
            }
            signal.throwIfAborted();
            if (!(error instanceof UpstreamConnectionError)) throw error;
            failure = {
              status: 502,
              message:
                "Account Pooler could not reach " + adapter.upstreamName + ".",
              headers: {},
            };
            break;
          }
          if (request.signal.aborted) {
            await this.discardUpstream(upstream, false);
            signal.throwIfAborted();
          }
          const { response } = upstream;
          const observed = adapter.quotaFromHeaders(
            selected.account.id,
            response.headers,
            this.options.quotas.get(selected.account.id),
            family,
            this.options.now(),
          );
          this.options.quotas.put(observed);
          if (pacing !== null && !response.ok) {
            this.releasePacing(selected.account.id, pacing);
            pacing = null;
          }
          if (adapter.provider === "claude" && response.status === 400) {
            const detail = await boundedErrorDetail(response.clone());
            if (isAccessFailure(400, detail)) {
              this.observeAccess(selected.account, 400, detail, secret);
              failure = { status: 400, message: detail, headers: {} };
              await this.discardUpstream(upstream, false);
              break;
            }
          }
          if (response.status === 429) {
            if (adapter.provider === "codex" && secret.kind === "api-key") {
              const detail = await boundedErrorDetail(response.clone());
              const parsed = openAiQuotaErrorSchema.safeParse(parseErrorJson(detail));
              if (
                parsed.success &&
                (parsed.data.error.code === "insufficient_quota" ||
                  parsed.data.error.type === "insufficient_quota")
              ) {
                audit("limit", selected.account.id, "quota");
                cause = "quota";
                const message =
                  "OpenAI API insufficient_quota. Restore project credits, then enable the account to retry.";
                await this.rejectCredential(selected.account, secret, signal, () =>
                  this.markError(selected.account.id, message),
                );
                failure = { status: 429, message, headers: {} };
                await this.discardUpstream(upstream, false);
                break;
              }
            }
            if (adapter.isQuotaRejection(response.headers)) {
              audit("limit", selected.account.id, "quota");
              cause = "quota";
              await this.discardUpstream(upstream, false);
              break;
            }
            const waitMs = retryAfterMilliseconds(
              response.headers.get("retry-after"),
              this.options.now(),
            );
            const heldUntil = this.options.now() + waitMs;
            this.options.quotas.put({
              ...observed,
              heldUntil,
            });
            if (!paced && waitMs <= MAX_INLINE_HOLD_MS) {
              paced = true;
              pacing = {
                heldUntil,
                result: waitForDelay(waitMs, this.stopped.signal),
              };
              this.pacingByAccount.set(selected.account.id, pacing);
              await this.discardUpstream(upstream, false);
              await abortable(pacing.result, signal);
              continue;
            }
            audit("limit", selected.account.id, "rate-limit");
            cause = "rate-limit";
            if (!selected.keepAffinity) {
              failure = {
                status: 429,
                message: await this.discardUpstream(upstream, true),
                headers: { "retry-after": String(Math.ceil(waitMs / 1_000)) },
              };
              break;
            }
          }
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 408 ||
            response.status === 500 ||
            response.status === 502 ||
            response.status === 503 ||
            response.status === 504 ||
            response.status === 529
          ) {
            cause =
              response.status === 401 || response.status === 403
                ? "auth"
                : "upstream";
            const retryAfter = response.headers.get("retry-after");
            const detail = await this.discardUpstream(upstream, true);
            signal.throwIfAborted();
            failure = {
              status: response.status,
              message:
                detail ||
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  ".",
              headers: retryAfter === null ? {} : { "retry-after": retryAfter },
            };
            if (adapter.provider === "claude" && response.status === 403) {
              this.observeAccess(selected.account, 403, detail, secret);
              break;
            }
            const rejected = response.status === 401 || (response.status === 403 && !(adapter.provider === "codex" && secret.kind === "api-key"));
            if (rejected && secret.kind === "oauth" && !authRetried) {
              authRetried = true;
              try {
                secret = await abortable(
                  this.freshSecret(selected.account, adapter, {
                    kind: "rejected",
                    accessToken: secret.accessToken,
                  }),
                  signal,
                );
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof TransientOAuthRefreshError) {
                  failure = {
                    status: 503,
                    message: error.message,
                    headers: {},
                  };
                } else {
                  const message = errorMessage(error);
                  await this.rejectCredential(
                    selected.account,
                    secret,
                    signal,
                    () => this.markError(selected.account.id, message),
                  );
                }
                break;
              }
              continue;
            }
            if (rejected && secret.kind === "oauth") {
              const accessToken = secret.accessToken;
              const hold = new TransientOAuthRefreshError(
                adapter.upstreamName +
                  " returned HTTP " +
                  response.status +
                  " for a freshly refreshed credential, so the Account Pooler is treating it as an upstream failure: " +
                  failure.message,
                0,
              );
              failure = { status: 503, message: hold.message, headers: {} };
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () =>
                  this.holdUpstreamRejection(
                    selected.account.id,
                    accessToken,
                    hold,
                  ),
              );
            } else if (rejected) {
              const message = failure.message;
              await this.rejectCredential(
                selected.account,
                secret,
                signal,
                () => this.markError(selected.account.id, message),
              );
            }
            break;
          }
          if (response.ok) {
            this.observeAccess(selected.account, response.status, "", secret);
            selected.accept();
            // The named account served again: its next limit is news. A
            // request served by auto for an unavailable named account keeps
            // the note, so the stretch stays one row.
            if (threadId !== null && named !== null)
              this.namedLimitNotes.delete(threadId);
            this.auditSelect(
              audited,
              adapter.provider,
              principal,
              parsed.affinityId,
              selected.account.id,
              named,
            );
          }
          return this.clientResponse(upstream);
        }
      }
      signal.throwIfAborted();
      return failure === null
        ? this.noEligibleResponse(accounts, family, adapter)
        : adapter.errorResponse(
            failure.status,
            failure.message,
            failure.headers,
          );
    } catch (error) {
      if (!signal.aborted) throw error;
      return adapter.errorResponse(
        request.signal.aborted ? 499 : 503,
        request.signal.aborted
          ? "Account Pooler request was canceled."
          : "Account Pooler stopped accepting requests.",
      );
    }
  }

  // One `select` row per account change of a session, not per request: the
  // key is [provider, principal, session]. Threads of one machine run on
  // different accounts at once, so a key without the session would log on
  // nearly every request.
  private auditSelect(
    audited: boolean,
    provider: PoolProvider,
    principal: HubPrincipal,
    affinityId: string | null,
    accountId: string,
    named: NamedRoute | null,
  ): void {
    if (!audited) return;
    const threadId = principal.kind === "thread" ? principal.threadId : null;
    // `switch`: the first request that moves a thread to the account a later
    // `set` named. Moves by the pool itself stay `select` / `failover`.
    let reason: "select" | "switch" = "select";
    const policies = this.options.policies;
    if (threadId !== null && policies !== null) {
      const previous = policies.servingFor(threadId);
      if (
        named !== null &&
        named.accountId === accountId &&
        named.updatedAt !== null &&
        previous !== null &&
        previous.accountId !== accountId &&
        named.updatedAt >= previous.at
      )
        reason = "switch";
      policies.noteServing(threadId, accountId, this.options.now());
      // Only a real change of the serving account (any policy) is a signal;
      // the next request of the same session on the same account is not.
      if (previous?.accountId !== accountId)
        this.options.onThreadAccountChanged(threadId);
    }
    const key = JSON.stringify([
      provider,
      principal.kind === "thread"
        ? `thread:${principal.threadId}`
        : `host:${principal.hostId}`,
      affinityId ?? "-",
    ]);
    if (this.auditedSelections.get(key) === accountId) {
      this.auditedSelections.delete(key);
      this.auditedSelections.set(key, accountId);
      return;
    }
    this.auditedSelections.delete(key);
    this.auditedSelections.set(key, accountId);
    while (this.auditedSelections.size > MAX_AUDIT_SELECT_KEYS) {
      const oldest = this.auditedSelections.keys().next();
      if (oldest.done) break;
      this.auditedSelections.delete(oldest.value);
    }
    this.options.audit({
      reason,
      provider,
      threadId,
      hostId: principal.hostId,
      accountId,
    });
  }

  // Dedupes `named-limit` rows that change no policy: one per thread, policy
  // revision and detail until the named account serves again.
  private firstNamedLimit(threadId: string, key: string): boolean {
    if (this.namedLimitNotes.get(threadId) === key) return false;
    this.namedLimitNotes.delete(threadId);
    this.namedLimitNotes.set(threadId, key);
    while (this.namedLimitNotes.size > MAX_NAMED_LIMIT_KEYS) {
      const oldest = this.namedLimitNotes.keys().next();
      if (oldest.done) break;
      this.namedLimitNotes.delete(oldest.value);
    }
    return true;
  }

  private async namedAccount(
    accountId: string,
    family: ModelFamily,
    refresh: boolean,
  ): Promise<{
    state: NamedAccountState;
    account: Account | null;
    quota: AccountQuota | null;
  }> {
    const account = await this.options.accounts.get(accountId);
    let quota = account === null ? null : this.options.quotas.get(accountId);
    let state = namedAccountState(account, quota, family, this.options.now());
    if (state === "limit" && refresh && account !== null && account.kind === "oauth") {
      await this.refreshAccountUsage(account, EXHAUSTED_USAGE_REFRESH_INTERVAL_MS);
      quota = this.options.quotas.get(accountId);
      state = namedAccountState(account, quota, family, this.options.now());
    }
    return { state, account, quota };
  }

  // The named account as a pinned session: holds over 20 s return 429 instead
  // of failing over, the session is bound to it on success, and the pool's
  // active account does not move.
  private selectNamed(
    account: Account,
    quota: AccountQuota,
    affinityKey: string | null,
  ): SelectedAccount {
    return {
      account,
      quota,
      keepAffinity: true,
      accept: () => {
        if (affinityKey === null) return;
        const accepted = { accountId: account.id, lastUsedAt: this.options.now() };
        this.options.affinity.putBinding(affinityKey, accepted);
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, accepted);
        while (this.affinityBindings.size > this.options.maxAffinityBindings) {
          const oldest = this.affinityBindings.keys().next();
          if (oldest.done) break;
          this.affinityBindings.delete(oldest.value);
          this.options.affinity.removeBinding(oldest.value);
        }
      },
    };
  }

  private async discardUpstream(
    upstream: UpstreamResult,
    readDetail: boolean,
  ): Promise<string> {
    const reader = upstream.response.body?.getReader();
    if (reader === undefined) {
      upstream.controller.abort();
      upstream.release();
      return "";
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<string>((resolve) => {
      timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
    });
    let detail = "";
    try {
      if (!readDetail) return detail;
      return await Promise.race([
        (async () => {
          const decoder = new TextDecoder();
          let bytes = 0;
          while (bytes < MAX_FAILURE_DETAIL_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            const part = chunk.value.subarray(
              0,
              MAX_FAILURE_DETAIL_BYTES - bytes,
            );
            bytes += part.byteLength;
            detail += decoder.decode(part, { stream: true });
          }
          return (detail + decoder.decode()).trim();
        })().catch(() => detail.trim()),
        deadline,
      ]);
    } finally {
      upstream.controller.abort();
      await Promise.race([reader.cancel().catch(() => undefined), deadline]);
      clearTimeout(timeout);
      upstream.release();
    }
  }

  private async rejectCredential(
    account: Account,
    rejected: AccountSecret,
    signal: AbortSignal,
    apply: () => void,
  ): Promise<void> {
    if (rejected.kind !== "oauth") {
      apply();
      return;
    }
    while (true) {
      signal.throwIfAborted();
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        await abortable(
          existing.result.then(
            () => undefined,
            () => undefined,
          ),
          signal,
        );
        continue;
      }
      const flight: SecretFlight = {
        kind: "rejection-check",
        result: this.options.accounts
          .readSecret(account.id)
          .then((current) => {
            const backoff = this.refreshBackoffs.get(account.id);
            if (
              !signal.aborted &&
              current.kind === "oauth" &&
              current.accessToken === rejected.accessToken &&
              !(
                backoff !== undefined &&
                backoff.kind !== "proactive" &&
                backoff.accessToken === current.accessToken
              )
            ) {
              apply();
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      await abortable(flight.result, signal);
      return;
    }
  }

  private async select(
    provider: PoolProvider,
    candidateIds: ReadonlySet<string>,
    attempted: ReadonlySet<string>,
    family: ModelFamily,
    affinityKey: string | null,
    parentAffinityKey: string | null,
    previousAccountId: string | null,
    routing: RoutingAttempt,
    signal: AbortSignal,
    projectOrder: readonly string[] | null,
  ): Promise<SelectedAccount | null> {
    const accounts = (await this.options.accounts.list()).sort(
      (left, right) => left.priority - right.priority,
    );
    signal.throwIfAborted();
    const now = this.options.now();
    const threshold = this.options.getSettings().switchThreshold;
    const available = accounts
      .filter((account) => account.provider === provider && account.enabled)
      .map((account) => ({
        account,
        quota: this.options.quotas.get(account.id),
      }))
      .filter(
        ({ account, quota }) =>
          (account.provider !== "claude" || quota.accessBlocked === null) &&
          quota.error === null &&
          !isUsageRestricted(quota, now),
      )
      .filter(
        ({ quota }) =>
          !isSharedQuotaExhausted(quota, threshold, now) ||
          hasExtraUsage(quota),
      );
    let eligible = available.filter(
      ({ quota }) =>
        !isQuotaExhausted(quota, family, threshold, now) ||
        hasExtraUsage(quota),
    );
    const included = eligible.filter(
      ({ quota }) => !isQuotaExhausted(quota, family, threshold, now),
    );
    if (
      included.some(
        ({ account, quota }) =>
          candidateIds.has(account.id) &&
          !attempted.has(account.id) &&
          (quota.heldUntil === null || quota.heldUntil <= now),
      )
    ) {
      eligible = included;
    }
    const unattempted = eligible.filter(
      ({ account }) =>
        candidateIds.has(account.id) && !attempted.has(account.id),
    );
    const candidates = unattempted.filter(
      ({ quota }) => quota.heldUntil === null || quota.heldUntil <= now,
    );
    let binding =
      affinityKey === null ? undefined : this.affinityBindings.get(affinityKey);
    const boundAccountId =
      binding !== undefined && now - binding.lastUsedAt < AFFINITY_IDLE_TTL_MS
        ? binding.accountId
        : null;
    const bound =
      boundAccountId !== null
        ? eligible.find(({ account }) => account.id === boundAccountId)
        : undefined;
    let inherited: (typeof candidates)[number] | undefined;
    if (bound === undefined && parentAffinityKey !== null) {
      const parent = this.affinityBindings.get(parentAffinityKey);
      if (
        parent !== undefined &&
        now - parent.lastUsedAt < AFFINITY_IDLE_TTL_MS
      ) {
        inherited = unattempted.find(
          ({ account }) => account.id === parent.accountId,
        );
      }
    }
    let active = this.activeAccounts.get(provider);
    const activeAccount = eligible.find(
      ({ account }) => account.id === active?.accountId,
    );
    const anchorId = previousAccountId ?? boundAccountId ?? active?.accountId;
    const anchorIndex = accounts.findIndex(
      (account) => account.id === anchorId,
    );
    const ordered =
      projectOrder === null
        ? [
            ...accounts.slice(anchorIndex + 1),
            ...accounts.slice(0, anchorIndex + 1),
          ]
        : orderForProject(accounts, projectOrder);
    const next = ordered
      .map((account) =>
        candidates.find((candidate) => candidate.account.id === account.id),
      )
      .find((candidate) => candidate !== undefined);
    const selected =
      bound !== undefined && unattempted.includes(bound)
        ? bound
        : (inherited ??
          (projectOrder === null &&
          boundAccountId === null &&
          previousAccountId === null &&
          activeAccount !== undefined &&
          unattempted.includes(activeAccount)
            ? activeAccount
            : next) ??
          null);
    if (selected === null) return null;
    if (routing.active === null)
      routing.pinnedAccountId = boundAccountId ?? inherited?.account.id ?? null;
    if (affinityKey !== null && binding === undefined) {
      binding = { accountId: selected.account.id, lastUsedAt: now };
      this.affinityBindings.set(affinityKey, binding);
    }
    if (binding !== undefined && binding.accountId === selected.account.id) {
      binding.lastUsedAt = now;
      if (affinityKey !== null) {
        this.affinityBindings.delete(affinityKey);
        this.affinityBindings.set(affinityKey, binding);
      }
    }
    while (this.affinityBindings.size > this.options.maxAffinityBindings) {
      const oldest = this.affinityBindings.keys().next();
      if (!oldest.done) {
        this.affinityBindings.delete(oldest.value);
        this.options.affinity.removeBinding(oldest.value);
      }
    }
    const chosenByProject =
      projectOrder !== null && selected !== bound && selected !== inherited;
    if (active === undefined) {
      active = { accountId: selected.account.id };
      if (!chosenByProject) this.activeAccounts.set(provider, active);
    }
    routing.binding ??= binding ?? null;
    routing.active ??= active;
    const familyDetour = (accountId: string | null) =>
      available.some(
        ({ account, quota }) =>
          account.id === accountId &&
          !isSharedQuotaExhausted(quota, threshold, now) &&
          isQuotaExhausted(quota, family, threshold, now),
      );
    const rebind =
      affinityKey !== null &&
      !familyDetour(boundAccountId) &&
      (bound === undefined ||
        bound.account.id === selected.account.id ||
        (binding === routing.binding && attempted.has(bound.account.id)));
    const advance =
      !chosenByProject &&
      !familyDetour(active.accountId) &&
      (activeAccount === undefined ||
        active.accountId === selected.account.id ||
        (active === routing.active && attempted.has(active.accountId)));
    return {
      ...selected,
      keepAffinity: selected.account.id === routing.pinnedAccountId,
      accept: () => {
        if (rebind && this.affinityBindings.get(affinityKey) === binding) {
          const accepted = {
            accountId: selected.account.id,
            lastUsedAt: this.options.now(),
          };
          this.options.affinity.putBinding(affinityKey, accepted);
          this.affinityBindings.delete(affinityKey);
          this.affinityBindings.set(affinityKey, accepted);
        }
        if (advance && this.activeAccounts.get(provider) === active) {
          this.options.affinity.putActiveAccount(provider, selected.account.id);
          this.activeAccounts.set(provider, { accountId: selected.account.id });
        }
      },
    };
  }

  private async freshSecret(
    account: Account,
    adapter: ProviderAdapter,
    use: SecretUse,
    recover = false,
  ): Promise<AccountSecret> {
    while (true) {
      const existing = this.refreshes.get(account.id);
      if (existing !== undefined) {
        if (existing.kind === "rejection-check") {
          await existing.result;
          continue;
        }
        let secret: AccountSecret;
        try {
          secret = await existing.result;
        } catch (error) {
          const current = this.refreshes.get(account.id);
          if (current !== undefined && current !== existing) continue;
          throw error;
        }
        const current = this.refreshes.get(account.id);
        if (current !== undefined && current !== existing) continue;
        const backoff = this.refreshBackoffs.get(account.id);
        if (
          secret.kind === "oauth" &&
          backoff?.accessToken === secret.accessToken &&
          backoff.kind !== "proactive"
        )
          continue;
        if (
          use.kind === "normal" ||
          secret.kind !== "oauth" ||
          secret.accessToken !== use.accessToken ||
          (existing.use.kind === "rejected" &&
            existing.use.accessToken === use.accessToken)
        ) {
          return secret;
        }
        continue;
      }
      // Once stopped, start no new refresh: the transport is about to close,
      // and a rotated refresh token lost with it would force a re-login.
      if (this.stopped.signal.aborted)
        throw new TransientOAuthRefreshError(
          "Account Pooler stopped; no new token refresh starts.",
          0,
        );
      const flight: Extract<SecretFlight, { kind: "refresh" }> = {
        kind: "refresh",
        use,
        result: this.options.accounts
          .readSecret(account.id)
          .then(async (secret) => {
            let backoff = this.refreshBackoffs.get(account.id);
            if (
              secret.kind !== "oauth" ||
              backoff?.accessToken !== secret.accessToken
            ) {
              this.refreshBackoffs.delete(account.id);
              backoff = undefined;
            }
            const explicitlyRejected =
              secret.kind === "oauth" &&
              use.kind === "rejected" &&
              secret.accessToken === use.accessToken;
            const forceRefresh =
              recover || explicitlyRejected || backoff?.kind === "rejected";
            if (forceRefresh && secret.kind === "oauth") {
              flight.use = {
                kind: "rejected",
                accessToken: secret.accessToken,
              };
            }
            const error = this.options.quotas.get(account.id).error;
            if (error !== null && !recover) throw new Error(error);
            if (
              !recover &&
              backoff !== undefined &&
              this.options.now() < backoff.retryAt &&
              (!explicitlyRejected || backoff.kind !== "proactive")
            ) {
              if (
                backoff.kind === "proactive" &&
                !forceRefresh &&
                secret.kind === "oauth" &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw backoff.error;
            }
            try {
              const result = await adapter.refreshSecret({
                account,
                secret,
                accounts: this.options.accounts,
                quotas: this.options.quotas,
                fetch: this.options.fetch,
                now: this.options.now,
                forceRefresh,
              });
              this.refreshBackoffs.delete(account.id);
              if (result.refreshed) {
                this.options.onOAuthRefresh(
                  account.provider,
                  account.id,
                  "succeeded",
                  `previousExpiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, expiresAt=${result.secret.kind === "oauth" ? result.secret.expiresAt : null}, forced=${forceRefresh}.`,
                );
                const quota = this.options.quotas.get(account.id);
                this.options.quotas.put({ ...quota, error: null });
              }
              return result.secret;
            } catch (error) {
              this.options.onOAuthRefresh(
                account.provider,
                account.id,
                "failed",
                `${error instanceof OAuthRefreshError ? error.message : "Stored credential refresh failed."} expiresAt=${secret.kind === "oauth" ? secret.expiresAt : null}, forced=${forceRefresh}.`,
              );
              if (
                !(error instanceof TransientOAuthRefreshError) ||
                secret.kind !== "oauth"
              ) {
                this.refreshBackoffs.delete(account.id);
                throw error;
              }
              const delayMs = Math.min(
                MAX_REFRESH_BACKOFF_MS,
                Math.max(
                  backoff === undefined ? 1_000 : backoff.delayMs * 2,
                  error.retryAfterMs,
                ),
              );
              this.refreshBackoffs.delete(account.id);
              this.refreshBackoffs.set(account.id, {
                kind: forceRefresh ? "rejected" : "proactive",
                accessToken: secret.accessToken,
                retryAt: this.options.now() + delayMs,
                delayMs,
                error,
              });
              while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
                const oldest = this.refreshBackoffs.keys().next();
                if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
              }
              if (
                !forceRefresh &&
                secret.expiresAt !== null &&
                secret.expiresAt > this.options.now()
              ) {
                return secret;
              }
              throw error;
            }
          })
          .finally(() => {
            if (this.refreshes.get(account.id) === flight)
              this.refreshes.delete(account.id);
          }),
      };
      this.refreshes.set(account.id, flight);
      return flight.result;
    }
  }

  private async fetchUpstream(
    request: Request,
    body: Uint8Array,
    account: Account,
    secret: AccountSecret,
    adapter: ProviderAdapter,
  ): Promise<UpstreamResult> {
    this.increment(account.id);
    const { controller, release } = this.trackRequest(request, () =>
      this.decrement(account.id),
    );
    try {
      const upstreamBody = new ArrayBuffer(body.byteLength);
      new Uint8Array(upstreamBody).set(body);
      const url = adapter.upstreamUrl(request, account);
      const headers = adapter.requestHeaders(request.headers, account, secret);
      const response = await this.options
        .fetch(url, {
          method: request.method,
          headers,
          ...(request.method === "GET" || request.method === "HEAD"
            ? {}
            : { body: upstreamBody }),
          signal: controller.signal,
        })
        .catch((cause: unknown) => {
          if (!controller.signal.aborted)
            this.options.onUpstreamError(adapter.provider, cause);
          throw new UpstreamConnectionError("Upstream connection failed.", {
            cause,
          });
        });
      return { response, controller, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private clientResponse(upstream: UpstreamResult): Response {
    const headers = new Headers();
    for (const [name, value] of upstream.response.headers) {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers.append(name, value);
    }
    if (upstream.response.body === null) {
      upstream.release();
      return new Response(null, {
        status: upstream.response.status,
        statusText: upstream.response.statusText,
        headers,
      });
    }
    const reader = upstream.response.body.getReader();
    const eventStream =
      upstream.response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        ?.trim()
        .toLowerCase() === "text/event-stream";
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            upstream.release();
            controller.close();
          } else controller.enqueue(chunk.value);
        } catch (error) {
          upstream.release();
          if (!eventStream) {
            controller.error(
              error instanceof Error ? error : new Error(String(error)),
            );
            return;
          }
          controller.enqueue(
            new TextEncoder().encode(
              `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: errorMessage(error) } })}\n\n`,
            ),
          );
          controller.close();
        }
      },
      async cancel() {
        upstream.controller.abort();
        await reader.cancel().catch(() => undefined);
        upstream.release();
      },
    });
    return new Response(body, {
      status: upstream.response.status,
      statusText: upstream.response.statusText,
      headers,
    });
  }

  async retryAvailability(
    provider: PoolProvider,
    family: ModelFamily,
    threadId: string | null = null,
  ): Promise<RetryAvailability> {
    const parent = this.options.getParentRoute();
    if (parent !== null) {
      try {
        const response = await this.options.fetch(
          `${parent.baseUrl}/retry-availability?provider=${provider}&family=${family}`,
          {
            headers: { [HUB_TOKEN_HEADER]: parent.token },
            signal: AbortSignal.timeout(2_000),
          },
        );
        if (response.ok)
          return retryAvailabilitySchema.parse(await response.json());
        await response.body?.cancel();
      } catch {
        return { kind: "unavailable", reason: "source-unavailable" };
      }
      return { kind: "unavailable", reason: "source-unavailable" };
    }
    const accounts = (await this.options.accounts.list()).filter(
      (account) => account.provider === provider,
    );
    // A thread pinned with `stop` waits for its own account only (block P3).
    const policy =
      threadId === null || this.options.policies === null
        ? null
        : this.options.policies.get(threadId);
    if (
      policy?.mode === "named" &&
      policy.provider === provider &&
      policy.onLimit === "stop"
    )
      return this.accountAvailability(
        accounts.filter((account) => account.id === policy.accountId),
        family,
        NAMED_LIMIT_THRESHOLD,
      );
    return this.accountAvailability(accounts, family);
  }

  private accountAvailability(
    accounts: readonly Account[],
    family: ModelFamily,
    threshold = this.options.getSettings().switchThreshold,
  ): RetryAvailability {
    const enabled = accounts.filter((account) => account.enabled);
    if (enabled.length === 0)
      return { kind: "unavailable", reason: "no-enabled-account" };
    const now = this.options.now();
    const resets: number[] = [];
    let unknown = false;
    for (const account of enabled) {
      const quota = this.options.quotas.get(account.id);
      if (
        quota.error !== null ||
        (account.provider === "claude" && quota.accessBlocked !== null)
      )
        continue;
      if (isUsageRestricted(quota, now)) {
        unknown = true;
        continue;
      }
      const exhausted =
        isQuotaExhausted(quota, family, threshold, now) &&
        !hasExtraUsage(quota);
      const resetAt = exhausted
        ? blockingResetAt(quota, family, threshold, now)
        : now;
      if (resetAt === null) {
        unknown = true;
        continue;
      }
      const availableAt = Math.max(resetAt, quota.heldUntil ?? 0);
      if (availableAt <= now) return { kind: "ready" };
      resets.push(availableAt);
    }
    return resets.length > 0
      ? { kind: "blocked", retryAt: Math.min(...resets) }
      : {
          kind: "unavailable",
          reason: unknown ? "reset-unknown" : "authentication",
        };
  }

  private noEligibleResponse(
    accounts: readonly Account[],
    family: ModelFamily,
    adapter: ProviderAdapter,
  ): Response {
    if (!accounts.some((account) => account.enabled)) {
      return adapter.errorResponse(
        503,
        "Account Pooler has no enabled account",
      );
    }
    const now = this.options.now();
    const availability = this.accountAvailability(accounts, family);
    const next =
      availability.kind === "blocked" ? availability.retryAt : undefined;
    const retryAfter = Math.max(
      1,
      Math.ceil(((next ?? now + 1_000) - now) / 1_000),
    );
    return adapter.errorResponse(
      429,
      next === undefined
        ? "No Account Pooler account is currently eligible."
        : `No Account Pooler account is currently eligible. Next account is expected to be available at ${new Date(next).toISOString()} (in ${retryAfter} seconds).`,
      { "retry-after": String(retryAfter) },
    );
  }

  private holdUpstreamRejection(
    accountId: string,
    accessToken: string,
    error: TransientOAuthRefreshError,
  ): void {
    this.refreshBackoffs.delete(accountId);
    this.refreshBackoffs.set(accountId, {
      kind: "upstream",
      accessToken,
      retryAt: this.options.now() + UPSTREAM_REJECTION_HOLD_MS,
      delayMs: UPSTREAM_REJECTION_HOLD_MS,
      error,
    });
    while (this.refreshBackoffs.size > MAX_REFRESH_BACKOFFS) {
      const oldest = this.refreshBackoffs.keys().next();
      if (!oldest.done) this.refreshBackoffs.delete(oldest.value);
    }
  }

  private markError(accountId: string, message: string): void {
    const quota = this.options.quotas.get(accountId);
    this.options.quotas.put({ ...quota, error: message.slice(0, 1_000) });
  }

  private releasePacing(accountId: string, pacing: PacingFlight): void {
    if (this.pacingByAccount.get(accountId) === pacing)
      this.pacingByAccount.delete(accountId);
  }

  private adapter(provider: PoolProvider): ProviderAdapter {
    const adapter = this.options.adapters.get(provider);
    if (adapter === undefined)
      throw new Error(`Missing ${provider} Account Pooler adapter.`);
    return adapter;
  }

  private increment(accountId: string): void {
    this.inFlightByAccount.set(
      accountId,
      (this.inFlightByAccount.get(accountId) ?? 0) + 1,
    );
  }

  private decrement(accountId: string): void {
    const next = Math.max(0, (this.inFlightByAccount.get(accountId) ?? 1) - 1);
    if (next === 0) this.inFlightByAccount.delete(accountId);
    else this.inFlightByAccount.set(accountId, next);
    if (this.inFlightCount() !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private inFlightCount(): number {
    let total = 0;
    for (const count of this.inFlightByAccount.values()) total += count;
    return total;
  }
}

export function createHub(options: {
  accounts: AccountStore;
  quotas: QuotaStore;
  affinity: PoolAffinityStore;
  hubTokens: HubTokenStore;
  passes?: HubPasses | null;
  policies?: HubThreadPolicies | null;
  audit?: (entry: AuditInput) => void;
  onThreadAccountChanged?: (threadId: string) => void;
  getSettings: () => AccountPoolConfig;
  fetch?: typeof fetch;
  now?: () => number;
  refreshUrl?: string;
  codexRefreshUrl?: string;
  codexUsageUrl?: string;
  usageUrl?: string;
  profileUrl?: string;
  upstreams?: Partial<ProviderUpstreams>;
  drainTimeoutMs?: number;
  refreshDrainTimeoutMs?: number;
  maxAffinityBindings?: number;
  getParentRoute?: () => ParentPool | null;
  getProjectOrder?: (projectId: string) => readonly string[] | null;
  onAccountsChanged?: () => void;
  onUpstreamError?: (provider: PoolProvider, error: unknown) => void;
  onOAuthRefresh?: HubOptions["onOAuthRefresh"];
}): AccountPoolHub {
  const upstreams: ProviderUpstreams = {
    ...PROVIDER_UPSTREAMS,
    ...options.upstreams,
  };
  const adapters: ReadonlyMap<PoolProvider, ProviderAdapter> = new Map([
    [
      "claude",
      createClaudeAdapter({
        refreshUrl: options.refreshUrl ?? DEFAULT_REFRESH_URL,
        usageUrl: options.usageUrl ?? DEFAULT_USAGE_URL,
        profileUrl: options.profileUrl ?? DEFAULT_PROFILE_URL,
        upstreamBaseUrl: upstreams.anthropic,
      }),
    ],
    [
      "codex",
      createCodexAdapter({
        refreshUrl: options.codexRefreshUrl ?? DEFAULT_CODEX_REFRESH_URL,
        usageUrl: options.codexUsageUrl ?? DEFAULT_CODEX_USAGE_URL,
        chatgptBaseUrl: upstreams.chatgptCodex,
        openaiBaseUrl: upstreams.openai,
      }),
    ],
  ]);
  return new AccountPoolHub({
    accounts: options.accounts,
    quotas: options.quotas,
    affinity: options.affinity,
    maxAffinityBindings: options.maxAffinityBindings ?? MAX_AFFINITY_BINDINGS,
    hubTokens: options.hubTokens,
    passes: options.passes ?? null,
    policies: options.policies ?? null,
    audit: options.audit ?? (() => {}),
    onThreadAccountChanged: options.onThreadAccountChanged ?? (() => {}),
    getSettings: options.getSettings,
    adapters,
    fetch: options.fetch ?? fetch,
    now: options.now ?? Date.now,
    drainTimeoutMs: options.drainTimeoutMs ?? 60_000,
    refreshDrainTimeoutMs:
      options.refreshDrainTimeoutMs ?? OAUTH_REFRESH_TIMEOUT_MS + 5_000,
    getParentRoute: options.getParentRoute ?? (() => null),
    getProjectOrder: options.getProjectOrder ?? (() => null),
    onAccountsChanged: options.onAccountsChanged ?? (() => {}),
    onUpstreamError: options.onUpstreamError ?? (() => {}),
    onOAuthRefresh: options.onOAuthRefresh ?? (() => {}),
  });
}

function namedStopMessage(
  state: "limit" | "deleted" | "unavailable",
  label: string | null,
): string {
  const account = label === null ? "an account" : `account ${label}`;
  const what =
    state === "limit"
      ? "which hit its limit"
      : state === "deleted"
        ? "which was removed from the pool"
        : "which is unavailable now (disabled, signed out or blocked)";
  return `This thread is set to ${account}, ${what}; its on-limit rule is stop. Switch the account or set auto with \`bb pool thread set <thread-id> auto\`.`;
}

function readBearer(value: string | null): string | null {
  if (value === null) return null;
  return /^Bearer\s+(.+)$/iu.exec(value)?.[1] ?? null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    timeout.unref();
    const abort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function pingError(
  detail: string,
  secret: AccountSecret,
): Pick<AccountPingResult, "error"> {
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return {};
  }
  const parsed = z
    .object({
      error: z.object({ type: z.string(), message: z.string() }),
    })
    .safeParse(value);
  if (!parsed.success) return {};
  const credentials =
    secret.kind === "oauth"
      ? [secret.accessToken, secret.refreshToken, secret.idToken]
      : [secret.apiKey];
  const sanitize = (value: string) => {
    for (const credential of credentials) {
      if (credential) value = value.replaceAll(credential, "[REDACTED]");
    }
    return value
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
      .replace(/\bsk-[\w-]+/g, "[REDACTED]")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 512);
  };
  return {
    error: {
      type: sanitize(parsed.data.error.type),
      message: sanitize(parsed.data.error.message),
    },
  };
}

function isAccessFailure(status: number, detail: string): boolean {
  if (status === 403) return true;
  if (status !== 400) return false;
  try {
    return z
      .object({
        error: z.object({
          type: z.literal("invalid_request_error"),
          message: z.literal("Identity verification is required to continue."),
        }),
      })
      .safeParse(JSON.parse(detail)).success;
  } catch {
    return false;
  }
}

async function boundedErrorDetail(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<string>((resolve) => {
    timeout = setTimeout(() => resolve(""), FAILURE_DISPOSAL_TIMEOUT_MS);
  });
  const read = async () => {
    const decoder = new TextDecoder();
    let bytes = 0;
    let detail = "";
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return detail + decoder.decode();
      bytes += chunk.value.byteLength;
      if (bytes > MAX_FAILURE_DETAIL_BYTES) return "";
      detail += decoder.decode(chunk.value, { stream: true });
    }
  };
  try {
    return await Promise.race([read().catch(() => ""), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
  }
}

const openAiQuotaErrorSchema = z.object({
  error: z.object({ code: z.string().nullish(), type: z.string().nullish() }),
});

function parseErrorJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
