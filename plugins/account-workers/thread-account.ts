import { PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const THREAD_ACCOUNT_V1 = "thread-account.v1";
const SET = `${THREAD_ACCOUNT_V1}.set`;
const GET = `${THREAD_ACCOUNT_V1}.get`;
const ACCOUNTS = `${THREAD_ACCOUNT_V1}.accounts`;
export const SPAWN_METHODS = [SET, GET, ACCOUNTS] as const;
export const LIST_METHODS = [GET] as const;

export const POOLED_PROVIDERS: Readonly<Record<string, string>> = { "claude-code": "claude", codex: "codex" };

export const ON_LIMIT = ["fallback-auto", "stop"] as const;
export type OnLimit = (typeof ON_LIMIT)[number];

export const PROBE_THREAD_ID = "aw_account_probe";
export const POOL_TIMEOUT_MS = 10_000;
export const LIST_TIMEOUT_MS = 5_000;

export type PoolSdk = { plugins: Pick<BbPluginApi["sdk"]["plugins"], "experimental_discoverRpc" | "callRpc"> };

const accountsSchema = z
  .object({
    accounts: z.array(z.object({ accountId: z.string().min(1), accountLabel: z.string(), provider: z.string() }).passthrough()),
  })
  .passthrough();

const policySchema = z
  .object({ mode: z.string(), accountId: z.string().optional(), accountLabel: z.string().nullable().optional(), onLimit: z.string().optional() })
  .passthrough();

const servingSchema = z.object({ accountId: z.string(), accountLabel: z.string().nullable() }).passthrough().nullable();

const setSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), policy: policySchema, revision: z.number() }).passthrough(),
  z.object({ ok: z.literal(false), reason: z.string(), message: z.string(), resetAt: z.number().optional() }).passthrough(),
]);

const getSchema = z.object({ policy: policySchema, serving: servingSchema }).passthrough();

export interface ChosenAccount {
  accountId: string;
  accountLabel: string;
}

export interface AppliedAccount extends ChosenAccount {
  onLimit: OnLimit;
  revision: number;
  warning: string | null;
}

export interface ThreadAccountView {
  policy: z.infer<typeof policySchema>;
  serving: z.infer<typeof servingSchema>;
}

export function within(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function publishers(sdk: PoolSdk, methods: readonly string[], signal?: AbortSignal): Promise<string[]> {
  const published = await sdk.plugins.experimental_discoverRpc({ signal: within(POOL_TIMEOUT_MS, signal) });
  const byPlugin = new Map<string, Set<string>>();
  for (const entry of published) {
    if (!methods.includes(entry.method)) continue;
    byPlugin.set(entry.pluginId, (byPlugin.get(entry.pluginId) ?? new Set()).add(entry.method));
  }
  return [...byPlugin].filter(([, found]) => methods.every((m) => found.has(m))).map(([id]) => id);
}

export async function discoverPool(sdk: PoolSdk, signal?: AbortSignal): Promise<string> {
  let found: string[];
  try {
    found = await publishers(sdk, SPAWN_METHODS, signal);
  } catch (error) {
    throw new PluginCliError(`--account: could not list plugin contracts: ${message(error)}`, { code: "account_pool_unreachable" });
  }
  if (found.length === 0) {
    throw new PluginCliError(
      `--account needs the Account Pooler's ${THREAD_ACCOUNT_V1}; no running plugin publishes it (missing, disabled or older). Spawn without --account or update the pool.`,
      { code: "account_pool_missing" },
    );
  }
  if (found.length > 1) {
    throw new PluginCliError(`--account: several plugins publish ${THREAD_ACCOUNT_V1} (${found.join(", ")}); expected one`, {
      code: "account_pool_ambiguous",
    });
  }
  return found[0]!;
}

export async function findReader(sdk: PoolSdk): Promise<string | null> {
  try {
    const found = await publishers(sdk, LIST_METHODS);
    return found.length === 1 ? found[0]! : null;
  } catch {
    return null;
  }
}

export async function resolveAccount(
  sdk: PoolSdk,
  pluginId: string,
  pooledProvider: string,
  wanted: string,
  probeThreadId: string,
  signal?: AbortSignal,
): Promise<ChosenAccount> {
  let listed: z.infer<typeof accountsSchema>["accounts"];
  try {
    listed = (
      await sdk.plugins.callRpc({
        pluginId,
        method: ACCOUNTS,
        input: { threadId: probeThreadId },
        outputSchema: accountsSchema,
        signal: within(POOL_TIMEOUT_MS, signal),
      })
    ).accounts;
  } catch (error) {
    throw new PluginCliError(`--account: the pool's account list failed: ${message(error)}`, { code: "account_pool_error" });
  }
  const mine = listed.filter((a) => a.provider === pooledProvider);
  const byId = mine.find((a) => a.accountId === wanted);
  if (byId !== undefined) return { accountId: byId.accountId, accountLabel: byId.accountLabel };
  const byLabel = mine.filter((a) => a.accountLabel === wanted);
  if (byLabel.length === 1) return { accountId: byLabel[0]!.accountId, accountLabel: byLabel[0]!.accountLabel };
  if (byLabel.length > 1) {
    throw new PluginCliError(
      `Account label ${wanted} is ambiguous (${byLabel.map((a) => a.accountId).join(", ")}); use the account id`,
      { code: "account_ambiguous" },
    );
  }
  const elsewhere = listed.some((a) => a.accountId === wanted || a.accountLabel === wanted);
  throw new PluginCliError(
    elsewhere
      ? `Account ${wanted} belongs to another provider; this thread's provider is ${pooledProvider}`
      : `No ${pooledProvider} account ${wanted} in the pool`,
    { code: "account_unknown" },
  );
}

export async function readThreadAccount(
  sdk: PoolSdk,
  pluginId: string,
  threadId: string,
  signal: AbortSignal,
): Promise<ThreadAccountView> {
  const state = await sdk.plugins.callRpc({ pluginId, method: GET, input: { threadId }, outputSchema: getSchema, signal });
  return { policy: state.policy, serving: state.serving };
}

function resetText(resetAt: number | undefined): string {
  return resetAt === undefined ? "" : ` (resets ${new Date(resetAt).toISOString()})`;
}

export async function applyAccount(
  sdk: PoolSdk,
  pluginId: string,
  threadId: string,
  account: ChosenAccount,
  onLimit: OnLimit,
  signal?: AbortSignal,
): Promise<AppliedAccount> {
  let result: z.infer<typeof setSchema>;
  try {
    result = await sdk.plugins.callRpc({
      pluginId,
      method: SET,
      input: { threadId, policy: { mode: "named", accountId: account.accountId, onLimit } },
      outputSchema: setSchema,
      signal: within(POOL_TIMEOUT_MS, signal),
    });
  } catch (error) {
    throw new PluginCliError(`--account: setting the account failed, its state is unknown: ${message(error)}`, { code: "account_pool_error" });
  }
  if (!result.ok) {
    throw new PluginCliError(
      `Account ${account.accountLabel} refused for this thread: ${result.reason}: ${result.message}${resetText(result.resetAt)}`,
      { code: "account_refused" },
    );
  }
  const { policy } = result;
  if (policy.mode !== "named" || policy.accountId !== account.accountId || policy.onLimit !== onLimit) {
    throw new PluginCliError(
      `--account: the pool answered ok but stored ${policy.mode}${policy.accountId === undefined ? "" : ` ${policy.accountId}`}${policy.onLimit === undefined ? "" : ` (${policy.onLimit})`}`,
      { code: "account_not_applied" },
    );
  }
  let warning: string | null = null;
  try {
    const { serving } = await readThreadAccount(sdk, pluginId, threadId, within(POOL_TIMEOUT_MS, signal));
    if (serving !== null && serving.accountId !== account.accountId) {
      warning = `the first request ran on ${serving.accountLabel ?? serving.accountId} (${serving.accountId}) before the policy was set`;
    }
  } catch (error) {
    warning = `serving account not confirmed: ${message(error)}`;
  }
  return { ...account, onLimit, revision: result.revision, warning };
}

export async function resetToAuto(sdk: PoolSdk, pluginId: string, threadId: string): Promise<void> {
  const result = await sdk.plugins.callRpc({
    pluginId,
    method: SET,
    input: { threadId, policy: { mode: "auto" } },
    outputSchema: setSchema,
    signal: AbortSignal.timeout(POOL_TIMEOUT_MS),
  });
  if (!result.ok) throw new Error(`${result.reason}: ${result.message}`);
}

export function describeThreadAccount(view: ThreadAccountView): string {
  const serving = view.serving === null ? "—" : (view.serving.accountLabel ?? view.serving.accountId);
  const policy =
    view.policy.mode === "named"
      ? `${view.policy.accountLabel ?? view.policy.accountId ?? "?"} (${view.policy.onLimit ?? "?"})`
      : view.policy.mode;
  return `account ${serving}, policy ${policy}`;
}
