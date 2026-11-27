import {
  cliCommand,
  defineRpcContract,
  PluginCliError,
  type ExperimentalPluginRpcCaller,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AuditEntry, AuditLog } from "./audit-log.js";
import type {
  Account,
  AccountQuota,
  PoolProvider,
  ThreadStatusSummary,
} from "./contracts.js";
import { blockingResetAt, modelFamily } from "./quota.js";
import {
  NAMED_LIMIT_THRESHOLD,
  ON_LIMIT_RULES,
  callerDetail,
  namedAccountState,
  policyDetail,
  type PolicyCaller,
  type PolicyContent,
  type ThreadPolicy,
  type ThreadPolicyStore,
} from "./thread-policy.js";

// The public contract `thread-account.v1` (block P3): a thread's account
// policy, the account serving it, the accounts it may use and its account
// events. docs/THREAD_ACCOUNT_V1.md is the reference; v1 only gains optional
// output fields and new enum values.

export const THREAD_ACCOUNT_V1 = "thread-account.v1";
// A Claude session continues on another account. Whether a Codex session does
// is measured in block P4; until then a Codex switch may restart it.
const SWITCH_CONTINUITY: Record<PoolProvider, "continues" | "may-restart"> = {
  claude: "continues",
  codex: "may-restart",
};
const CODEX_NOTE =
  "A Codex switch may need a new Codex session (set it with newSession / --new-session while the thread is idle).";

const idSchema = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/u);
const providerSchema = z.enum(["claude", "codex"]);
const onLimitSchema = z.enum(ON_LIMIT_RULES);

const policySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("auto") }).strict(),
  z
    .object({
      mode: z.literal("named"),
      accountId: z.string().min(1),
      accountLabel: z.string().nullable(),
      onLimit: onLimitSchema,
    })
    .strict(),
]);

const limitEventSchema = z
  .object({
    id: z.number().int().positive(),
    at: z.number().int().nonnegative(),
    accountId: z.string().nullable(),
    accountLabel: z.string().nullable(),
    cause: z.enum(["limit", "deleted", "unavailable"]),
    action: z.enum(["fell-back", "served-auto", "stopped"]),
  })
  .strict();

export const threadAccountStateSchema = z
  .object({
    threadId: idSchema,
    provider: providerSchema.nullable(),
    policy: policySchema,
    revision: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative().nullable(),
    grandfathered: z.boolean(),
    serving: z
      .object({
        accountId: z.string().min(1),
        accountLabel: z.string().nullable(),
        provider: providerSchema.nullable(),
        since: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    lastLimit: limitEventSchema.nullable(),
    switchContinuity: z.enum(["continues", "may-restart", "new-session"]),
    note: z.string().nullable(),
  })
  .strict();
export type ThreadAccountState = z.infer<typeof threadAccountStateSchema>;

export const SET_REFUSALS = [
  "unknown-thread",
  "not-writable",
  "not-pooled",
  "unknown-account",
  "other-provider",
  "unavailable",
  "at-limit",
  "revision-conflict",
  "not-idle",
  "new-session-not-codex",
  "new-session-not-needed",
] as const;
type SetRefusal = (typeof SET_REFUSALS)[number];

const setInputSchema = z
  .object({
    threadId: idSchema,
    policy: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("auto") }).strict(),
      z
        .object({
          mode: z.literal("named"),
          accountId: z.string().min(1),
          onLimit: onLimitSchema.optional(),
        })
        .strict(),
    ]),
    expectedRevision: z.number().int().nonnegative().optional(),
    newSession: z.boolean().optional(),
  })
  .strict();
export type ThreadAccountSetInput = z.infer<typeof setInputSchema>;

const setOutputSchema = z.union([
  threadAccountStateSchema
    .extend({
      ok: z.literal(true),
      changed: z.boolean(),
      sessionRebuild: z.enum(["none", "next-turn", "new-session"]),
      message: z.string().nullable(),
    })
    .strict(),
  z
    .object({
      ok: z.literal(false),
      reason: z.enum(SET_REFUSALS),
      message: z.string(),
      resetAt: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type ThreadAccountSetResult = z.infer<typeof setOutputSchema>;

const ACCOUNT_REASONS = ["not-pooled", "other-provider", "unavailable", "at-limit"] as const;
const accountsOutputSchema = z
  .object({
    threadId: idSchema,
    provider: providerSchema.nullable(),
    accounts: z.array(
      z
        .object({
          accountId: z.string().min(1),
          accountLabel: z.string(),
          provider: providerSchema,
          kind: z.string(),
          subscriptionType: z.string().nullable(),
          usable: z.boolean(),
          reason: z.enum(ACCOUNT_REASONS).nullable(),
          resetAt: z.number().int().nonnegative().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

const EVENT_KINDS = ["select", "failover", "switch", "policy", "named-limit"] as const;
const eventsInputSchema = z
  .object({
    threadId: idSchema,
    afterId: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
const eventsOutputSchema = z
  .object({
    events: z.array(
      z
        .object({
          id: z.number().int().positive(),
          at: z.number().int().nonnegative(),
          kind: z.enum(EVENT_KINDS),
          accountId: z.string().nullable(),
          accountLabel: z.string().nullable(),
          detail: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const threadAccountContract = defineRpcContract({
  [`${THREAD_ACCOUNT_V1}.get`]: {
    input: z.object({ threadId: idSchema }).strict(),
    output: threadAccountStateSchema,
    experimental_description:
      "A thread's account policy (auto, or a named account with an on-limit rule), the account serving it, and its last limit event.",
  },
  [`${THREAD_ACCOUNT_V1}.set`]: {
    input: setInputSchema,
    output: setOutputSchema,
    experimental_description:
      "Set a thread's account policy. The next model request uses it. Refusals carry a reason code and a message.",
  },
  [`${THREAD_ACCOUNT_V1}.accounts`]: {
    input: z.object({ threadId: idSchema }).strict(),
    output: accountsOutputSchema,
    experimental_description:
      "The pool's accounts in priority order, each with whether this thread may use it now.",
  },
  [`${THREAD_ACCOUNT_V1}.events`]: {
    input: eventsInputSchema,
    output: eventsOutputSchema,
    experimental_description:
      "A thread's account events (select, failover, switch, policy, named-limit), oldest first after afterId.",
  },
} as const);

// What the service needs from bb and the pool.
export interface ThreadAccountDeps {
  policies: ThreadPolicyStore;
  audit: AuditLog;
  listAccounts: () => Promise<Account[]>;
  quota: (accountId: string) => AccountQuota;
  now: () => number;
  // null when the thread does not exist.
  getThread: (threadId: string) => Promise<{
    providerId: string;
    status: string;
    archivedAt: number | null;
    deletedAt: number | null;
  } | null>;
  // The model of the thread's last turn, null when unknown.
  lastModel: (threadId: string) => Promise<string | null>;
  // Whether the thread still runs on the machine token (server and trusted
  // machines, created before this build first started, no policy row yet).
  grandfathered: (threadId: string) => Promise<boolean>;
  clearContext: (threadId: string) => Promise<void>;
  onChanged: (threadId: string) => void;
}

export function pooledProvider(providerId: string): PoolProvider | null {
  return providerId === "claude-code"
    ? "claude"
    : providerId === "codex"
      ? "codex"
      : null;
}

function refusal(
  reason: SetRefusal,
  message: string,
  resetAt?: number | null,
): ThreadAccountSetResult {
  return {
    ok: false,
    reason,
    message,
    ...(resetAt === null || resetAt === undefined ? {} : { resetAt }),
  };
}

function limitEvent(
  entry: AuditEntry,
  label: (accountId: string | null) => string | null,
): z.infer<typeof limitEventSchema> | null {
  const match = /^(limit|deleted|unavailable)-(fallback-auto|stop)$/u.exec(
    entry.detail ?? "",
  );
  if (match === null) return null;
  const cause = match[1] as "limit" | "deleted" | "unavailable";
  return {
    id: entry.id,
    at: entry.ts,
    accountId: entry.accountId,
    accountLabel: label(entry.accountId),
    cause,
    action:
      match[2] === "stop"
        ? "stopped"
        : cause === "unavailable"
          ? "served-auto"
          : "fell-back",
  };
}

function content(policy: ThreadPolicy): PolicyContent {
  return policy.mode === "auto"
    ? { mode: "auto" }
    : {
        mode: "named",
        provider: policy.provider,
        accountId: policy.accountId,
        onLimit: policy.onLimit,
      };
}

function sameContent(left: PolicyContent, right: PolicyContent): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ThreadAccounts {
  constructor(private readonly deps: ThreadAccountDeps) {}

  async get(threadId: string): Promise<ThreadAccountState> {
    idSchema.parse(threadId);
    const thread = await this.deps.getThread(threadId);
    const provider =
      thread === null ? null : pooledProvider(thread.providerId);
    return this.state(threadId, provider, await this.label());
  }

  private async label(): Promise<{
    of: (accountId: string | null) => string | null;
    providerOf: (accountId: string) => PoolProvider | null;
  }> {
    const accounts = new Map(
      (await this.deps.listAccounts()).map((account) => [account.id, account]),
    );
    return {
      of: (accountId) =>
        accountId === null ? null : (accounts.get(accountId)?.label ?? null),
      providerOf: (accountId) => accounts.get(accountId)?.provider ?? null,
    };
  }

  private async state(
    threadId: string,
    provider: PoolProvider | null,
    labels: Awaited<ReturnType<ThreadAccounts["label"]>>,
    continuity?: "new-session",
  ): Promise<ThreadAccountState> {
    const policy = this.deps.policies.get(threadId);
    const serving = this.deps.policies.servingFor(threadId);
    const lastLimit = this.deps.audit.threadEvents(threadId, ["named-limit"], 0, 1_000).at(-1);
    return {
      threadId,
      provider,
      policy:
        policy.mode === "auto"
          ? { mode: "auto" }
          : {
              mode: "named",
              accountId: policy.accountId,
              accountLabel: labels.of(policy.accountId),
              onLimit: policy.onLimit,
            },
      revision: policy.revision,
      updatedAt: policy.updatedAt,
      grandfathered: await this.deps.grandfathered(threadId),
      serving:
        serving === null
          ? null
          : {
              accountId: serving.accountId,
              accountLabel: labels.of(serving.accountId),
              provider: labels.providerOf(serving.accountId),
              since: serving.at,
            },
      lastLimit:
        lastLimit === undefined ? null : limitEvent(lastLimit, labels.of),
      switchContinuity:
        continuity ?? (provider === null ? "may-restart" : SWITCH_CONTINUITY[provider]),
      note: provider === "codex" ? CODEX_NOTE : null,
    };
  }

  async set(
    input: ThreadAccountSetInput,
    caller: PolicyCaller,
  ): Promise<ThreadAccountSetResult> {
    const request = setInputSchema.parse(input);
    const { threadId } = request;
    const thread = await this.deps.getThread(threadId);
    if (thread === null || thread.deletedAt !== null)
      return refusal("unknown-thread", `Thread ${threadId} does not exist.`);
    if (thread.archivedAt !== null)
      return refusal(
        "not-writable",
        `Thread ${threadId} is archived; unarchive it to change its account.`,
      );
    const provider = pooledProvider(thread.providerId);
    let next: PolicyContent = { mode: "auto" };
    const accounts = await this.deps.listAccounts();
    const wanted = request.policy;
    if (wanted.mode === "named") {
      if (provider === null)
        return refusal(
          "not-pooled",
          "This thread's provider is not routed through the Account Pooler.",
        );
      const account =
        accounts.find((candidate) => candidate.id === wanted.accountId) ??
        null;
      if (account === null)
        return refusal("unknown-account", "No pool account has this id.");
      if (account.provider !== provider)
        return refusal(
          "other-provider",
          `Account ${account.label} is a ${account.provider} account; this thread runs ${provider}.`,
        );
      const model = await this.deps.lastModel(threadId);
      const family = model === null ? null : modelFamily(model);
      const quota = this.deps.quota(account.id);
      const usable = namedAccountState(account, quota, family, this.deps.now());
      if (usable === "unavailable" || usable === "deleted")
        return refusal(
          "unavailable",
          `Account ${account.label} is unavailable now (disabled, signed out or blocked).`,
        );
      if (usable === "limit") {
        const resetAt = blockingResetAt(
          quota,
          family,
          NAMED_LIMIT_THRESHOLD,
          this.deps.now(),
        );
        return refusal(
          "at-limit",
          `Account ${account.label} is at its ${family === null || family === "other" ? "" : `${family[0]?.toUpperCase()}${family.slice(1)} `}limit${resetAt === null ? "" : ` until ${new Date(resetAt).toISOString()}`}.`,
          resetAt,
        );
      }
      next = {
        mode: "named",
        provider,
        accountId: account.id,
        onLimit: wanted.onLimit ?? "fallback-auto",
      };
    }
    const current = this.deps.policies.get(threadId);
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== current.revision
    )
      return refusal(
        "revision-conflict",
        `The policy changed meanwhile (revision ${current.revision}); read it again.`,
      );
    const newSession = request.newSession === true;
    if (newSession) {
      if (provider !== "codex")
        return refusal(
          "new-session-not-codex",
          "A new session is only for Codex threads; a Claude session continues on the new account.",
        );
      const serving = this.deps.policies.servingFor(threadId);
      if (next.mode !== "named" || serving?.accountId === next.accountId)
        return refusal(
          "new-session-not-needed",
          "The thread stays on the account serving it now, so it needs no new session.",
        );
      if (thread.status !== "idle" && thread.status !== "error")
        return refusal(
          "not-idle",
          "A new session needs the thread to be idle. Try again when its turn ends.",
        );
    }
    const before = content(current);
    const hadRow = this.deps.policies.has(threadId);
    const wasGrandfathered = await this.deps.grandfathered(threadId);
    const labels = await this.label();
    if (sameContent(before, next) && !newSession) {
      return {
        ok: true,
        changed: false,
        sessionRebuild: "none",
        message: null,
        ...(await this.state(threadId, provider, labels)),
      };
    }
    // `auto` with no row is the default: nothing to store, nothing rebuilt.
    if (next.mode === "auto" && !hadRow)
      return {
        ok: true,
        changed: false,
        sessionRebuild: "none",
        message: null,
        ...(await this.state(threadId, provider, labels)),
      };
    const revision = this.deps.policies.write(threadId, next, current.revision);
    if (revision === null)
      return refusal(
        "revision-conflict",
        "The policy changed meanwhile; read it again.",
      );
    this.deps.audit.append({
      reason: "policy",
      provider: provider ?? null,
      threadId,
      accountId: next.mode === "named" ? next.accountId : null,
      detail: `${policyDetail(next)}@${callerDetail(caller)}${newSession ? "+new-session" : ""}`,
    });
    if (newSession) {
      try {
        await this.deps.clearContext(threadId);
      } catch {
        // No half state: put the previous policy back.
        if (this.deps.policies.write(threadId, before, revision) !== null)
          this.deps.audit.append({
            reason: "policy",
            provider: provider ?? null,
            threadId,
            accountId: before.mode === "named" ? before.accountId : null,
            detail: `${policyDetail(before)}@revert`,
          });
        this.deps.onChanged(threadId);
        return refusal(
          "not-idle",
          "bb could not start a new session (the thread is busy or waiting for input); the policy was not changed.",
        );
      }
    }
    this.deps.onChanged(threadId);
    const sessionRebuild = newSession
      ? "new-session"
      : wasGrandfathered
        ? "next-turn"
        : "none";
    return {
      ok: true,
      changed: true,
      sessionRebuild,
      message:
        sessionRebuild === "next-turn"
          ? "This thread moves to its own pass at its next turn; its session will be rebuilt once (the context is kept; background shells, monitors and subagents end)."
          : sessionRebuild === "new-session"
            ? "A new Codex session starts at the next turn on the new account; the timeline is kept, the model context is not."
            : null,
      ...(await this.state(
        threadId,
        provider,
        labels,
        newSession ? "new-session" : undefined,
      )),
    };
  }

  async accounts(threadId: string): Promise<z.infer<typeof accountsOutputSchema>> {
    idSchema.parse(threadId);
    const thread = await this.deps.getThread(threadId);
    const provider = thread === null ? null : pooledProvider(thread.providerId);
    const model = provider === null ? null : await this.deps.lastModel(threadId);
    const family = model === null ? null : modelFamily(model);
    const now = this.deps.now();
    const accounts = (await this.deps.listAccounts()).sort(
      (left, right) => left.priority - right.priority,
    );
    return {
      threadId,
      provider,
      accounts: accounts.map((account) => {
        const quota = this.deps.quota(account.id);
        const state = namedAccountState(account, quota, family, now);
        const reason =
          provider === null
            ? "not-pooled"
            : account.provider !== provider
              ? "other-provider"
              : state === "ok"
                ? null
                : state === "limit"
                  ? "at-limit"
                  : "unavailable";
        return {
          accountId: account.id,
          accountLabel: account.label,
          provider: account.provider,
          kind: account.kind,
          subscriptionType: account.subscriptionType,
          usable: reason === null,
          reason,
          resetAt:
            reason === "at-limit"
              ? blockingResetAt(quota, family, NAMED_LIMIT_THRESHOLD, now)
              : null,
        };
      }),
    };
  }

  async events(
    input: z.infer<typeof eventsInputSchema>,
  ): Promise<z.infer<typeof eventsOutputSchema>> {
    const request = eventsInputSchema.parse(input);
    const labels = await this.label();
    return {
      events: this.deps.audit
        .threadEvents(
          request.threadId,
          EVENT_KINDS,
          request.afterId ?? 0,
          request.limit ?? 50,
        )
        .flatMap((entry) => {
          const kind = z.enum(EVENT_KINDS).safeParse(entry.reason);
          return kind.success
            ? [
                {
                  id: entry.id,
                  at: entry.ts,
                  kind: kind.data,
                  accountId: entry.accountId,
                  accountLabel: labels.of(entry.accountId),
                  detail: entry.detail,
                },
              ]
            : [];
        }),
    };
  }

  // Threads with a named policy or routed in the last 24 h.
  async list(): Promise<
    Array<{
      threadId: string;
      policy: string;
      servingAccountId: string | null;
      servingLabel: string | null;
      since: number | null;
    }>
  > {
    const labels = await this.label();
    const rows = new Map<
      string,
      { policy: string; servingAccountId: string | null; since: number | null }
    >();
    for (const { threadId, policy } of this.deps.policies.named())
      rows.set(threadId, {
        policy: `${labels.of(policy.mode === "named" ? policy.accountId : null) ?? (policy.mode === "named" ? policy.accountId : "auto")} (${policy.mode === "named" ? policy.onLimit : "auto"})`,
        servingAccountId: null,
        since: null,
      });
    for (const routed of this.deps.audit.recentServing(
      this.deps.now() - 24 * 60 * 60 * 1_000,
    )) {
      const row = rows.get(routed.threadId) ?? {
        policy: "auto",
        servingAccountId: null,
        since: null,
      };
      rows.set(routed.threadId, {
        ...row,
        servingAccountId: routed.accountId,
        since: routed.at,
      });
    }
    return [...rows].map(([threadId, row]) => ({
      threadId,
      ...row,
      servingLabel: labels.of(row.servingAccountId),
    }));
  }

  async summary(): Promise<ThreadStatusSummary> {
    const labels = await this.label();
    const since = this.deps.now() - 24 * 60 * 60 * 1_000;
    const counts = new Map<string, number>();
    for (const routed of this.deps.audit.recentServing(since))
      counts.set(routed.accountId, (counts.get(routed.accountId) ?? 0) + 1);
    return {
      namedPolicies: this.deps.policies.named().length,
      servingByAccount: [...counts].map(([accountId, threads]) => ({
        accountId,
        accountLabel: labels.of(accountId),
        threads,
      })),
      machineTokenSelections: this.deps.audit.machineTokenSelections(since),
    };
  }
}

export function rpcCaller(caller: ExperimentalPluginRpcCaller): PolicyCaller {
  return caller.kind === "plugin"
    ? { kind: "plugin", pluginId: caller.pluginId }
    : { kind: "client" };
}

export function createThreadAccountHandlers(service: ThreadAccounts) {
  return {
    [`${THREAD_ACCOUNT_V1}.get`]: ({ threadId }: { threadId: string }) =>
      service.get(threadId),
    [`${THREAD_ACCOUNT_V1}.set`]: (
      input: ThreadAccountSetInput,
      context?: { experimental_caller?: ExperimentalPluginRpcCaller },
    ) =>
      service.set(
        input,
        rpcCaller(context?.experimental_caller ?? { kind: "client" }),
      ),
    [`${THREAD_ACCOUNT_V1}.accounts`]: ({ threadId }: { threadId: string }) =>
      service.accounts(threadId),
    [`${THREAD_ACCOUNT_V1}.events`]: (input: z.infer<typeof eventsInputSchema>) =>
      service.events(input),
  };
}

const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const THREAD_POSITIONAL = {
  name: "thread-id",
  description: "Exact thread ID (agents pass \"$BB_THREAD_ID\")",
  required: true,
} as const;

function threadArg(value: unknown): string {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success)
    throw new PluginCliError("Invalid thread ID.", { code: "pool_command_failed" });
  return parsed.data;
}

function formatState(state: ThreadAccountState): string {
  const policy =
    state.policy.mode === "auto"
      ? "auto"
      : `named ${state.policy.accountLabel ?? state.policy.accountId} (on limit: ${state.policy.onLimit})`;
  const serving =
    state.serving === null
      ? state.grandfathered
        ? "not routed per thread (machine token; pin an account to give it its own pass)"
        : "not routed yet"
      : `${state.serving.accountLabel ?? state.serving.accountId} since ${new Date(state.serving.since).toISOString()}`;
  return [
    `Thread: ${state.threadId}`,
    `Provider: ${state.provider ?? "not pooled"}`,
    `Policy: ${policy} (revision ${state.revision})`,
    `Serving: ${serving}`,
    ...(state.lastLimit === null
      ? []
      : [
          `Last limit: ${state.lastLimit.accountLabel ?? state.lastLimit.accountId ?? "-"} ${state.lastLimit.cause}, ${state.lastLimit.action} at ${new Date(state.lastLimit.at).toISOString()}`,
        ]),
    ...(state.note === null ? [] : [state.note]),
  ].join("\n");
}

export function createThreadAccountCommands(service: ThreadAccounts) {
  const resolveAccount = async (
    threadId: string,
    target: string,
  ): Promise<string> => {
    const { accounts } = await service.accounts(threadId);
    if (accounts.some((account) => account.accountId === target)) return target;
    const byLabel = accounts.filter((account) => account.accountLabel === target);
    if (byLabel.length === 1 && byLabel[0] !== undefined) return byLabel[0].accountId;
    throw new PluginCliError(
      byLabel.length > 1
        ? `More than one account is labelled "${target}"; use the account id (bb pool thread accounts ${threadId}).`
        : `No account has the id or label "${target}" (bb pool thread accounts ${threadId}).`,
      { code: "pool_command_failed" },
    );
  };
  return {
    "thread show": cliCommand({
      summary: "Show a thread's account policy and the account serving it",
      positionals: [THREAD_POSITIONAL],
      options: { json },
      run: async (input) => {
        const state = await service.get(threadArg(input.positionals["thread-id"]));
        return {
          exitCode: 0,
          stdout: input.options.json ? `${JSON.stringify(state)}\n` : `${formatState(state)}\n`,
        };
      },
    }),
    "thread set": cliCommand({
      summary:
        "Pin a thread to an account (id or unique label) or set it back to auto; the next model request uses it",
      positionals: [
        THREAD_POSITIONAL,
        { name: "account", description: "auto, an account id, or a unique label", required: true },
      ],
      options: {
        "on-limit": {
          type: "string",
          description: "fallback-auto (default) or stop: what happens when the account hits its limit",
        },
        "new-session": {
          type: "boolean",
          description: "Codex only: start a new Codex session on the new account (the thread must be idle)",
        },
        "expected-revision": {
          type: "string",
          description: "Refuse if the policy revision is no longer this one",
        },
        json,
      },
      run: async (input) => {
        const threadId = threadArg(input.positionals["thread-id"]);
        const target = String(input.positionals.account);
        const onLimit = input.options["on-limit"];
        if (onLimit !== undefined && !onLimitSchema.safeParse(onLimit).success)
          throw new PluginCliError("--on-limit takes fallback-auto or stop.", {
            code: "pool_command_failed",
          });
        const expected = input.options["expected-revision"];
        const result = await service.set(
          {
            threadId,
            policy:
              target === "auto"
                ? { mode: "auto" }
                : {
                    mode: "named",
                    accountId: await resolveAccount(threadId, target),
                    ...(onLimit === undefined
                      ? {}
                      : { onLimit: onLimitSchema.parse(onLimit) }),
                  },
            ...(expected === undefined ? {} : { expectedRevision: Number(expected) }),
            ...(input.options["new-session"] === true ? { newSession: true } : {}),
          },
          { kind: "cli" },
        );
        if (input.options.json)
          return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result)}\n` };
        if (!result.ok)
          throw new PluginCliError(`${result.message} (${result.reason})`, {
            code: "pool_command_failed",
          });
        return {
          exitCode: 0,
          stdout: `${result.changed ? "Updated." : "Unchanged."}\n${formatState(result)}\n${result.message === null ? "" : `${result.message}\n`}`,
        };
      },
    }),
    "thread accounts": cliCommand({
      summary: "List the accounts in priority order and whether this thread may use each",
      positionals: [THREAD_POSITIONAL],
      options: { json },
      run: async (input) => {
        const result = await service.accounts(threadArg(input.positionals["thread-id"]));
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify(result)}\n`
            : `${result.accounts
                .map((account) =>
                  [
                    account.accountId,
                    account.accountLabel,
                    account.provider,
                    account.subscriptionType ?? "-",
                    account.usable ? "usable" : account.reason,
                    account.resetAt === null ? "" : new Date(account.resetAt).toISOString(),
                  ].join("\t"),
                )
                .join("\n")}\n`,
        };
      },
    }),
    "thread events": cliCommand({
      summary: "Show a thread's account events, oldest first",
      positionals: [THREAD_POSITIONAL],
      options: {
        after: { type: "string", description: "Only events after this event id" },
        limit: { type: "string", description: "At most this many events (1-200, default 50)" },
        json,
      },
      run: async (input) => {
        const result = await service.events({
          threadId: threadArg(input.positionals["thread-id"]),
          ...(input.options.after === undefined ? {} : { afterId: Number(input.options.after) }),
          ...(input.options.limit === undefined ? {} : { limit: Number(input.options.limit) }),
        });
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify(result)}\n`
            : result.events.length === 0
              ? "No account events.\n"
              : `${result.events
                  .map((event) =>
                    [
                      event.id,
                      new Date(event.at).toISOString(),
                      event.kind,
                      event.accountLabel ?? event.accountId ?? "-",
                      event.detail ?? "-",
                    ].join("\t"),
                  )
                  .join("\n")}\n`,
        };
      },
    }),
    "thread list": cliCommand({
      summary: "List threads with a named account or routed in the last 24 h, with the account serving each",
      options: { json },
      run: async (input) => {
        const rows = await service.list();
        return {
          exitCode: 0,
          stdout: input.options.json
            ? `${JSON.stringify({ threads: rows })}\n`
            : rows.length === 0
              ? "No routed threads in the last 24 h and no named policies.\n"
              : `${rows
                  .map((row) =>
                    [
                      row.threadId,
                      row.policy,
                      row.servingLabel ?? row.servingAccountId ?? "-",
                      row.since === null ? "-" : new Date(row.since).toISOString(),
                    ].join("\t"),
                  )
                  .join("\n")}\n`,
        };
      },
    }),
  };
}
