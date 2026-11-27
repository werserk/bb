// Pure mapping from thread-account.v1 answers to what the account row, the
// picker and the limit card show. No React, no I/O: every rule here has a
// test in view.test.ts.
import type {
  ThreadAccountSetResult,
  ThreadAccountState,
} from "../../src/thread-account.js";

export type ThreadAccountGet = ThreadAccountState;
export type ThreadAccountSet = ThreadAccountSetResult;
export interface ThreadAccountEntry {
  accountId: string;
  accountLabel: string;
  provider: "claude" | "codex";
  kind: string;
  subscriptionType: string | null;
  usable: boolean;
  reason: "not-pooled" | "other-provider" | "unavailable" | "at-limit" | null;
  resetAt: number | null;
}
export interface ThreadAccountList {
  threadId: string;
  provider: "claude" | "codex" | null;
  accounts: ThreadAccountEntry[];
}
export type LimitEvent = NonNullable<ThreadAccountGet["lastLimit"]>;

export type ViewState =
  | "hidden"
  | "loading"
  | "offline"
  | "error"
  | "machine-token"
  | "not-routed"
  | "auto-idle"
  | "auto"
  | "auto-fallback"
  | "named"
  | "named-on-auto"
  | "named-stopped";
export type Tone = "muted" | "default" | "warning" | "destructive";

export interface LimitCardView {
  id: number;
  tone: "warning" | "destructive";
  icon: "AlertTriangle" | "Pause";
  title: string;
  /** Text parts; a number is a reset time rendered in a `<time>`. */
  body: Array<string | { resetAt: number | null }>;
  action: "choose" | "use-auto" | "back-to-auto";
  actionLabel: string;
  dismissLabel: string;
}

export interface ThreadAccountView {
  state: ViewState;
  label: string;
  icon: "Spinner" | "CloudOff" | "AlertTriangle" | "ComputerCloud" | "Layers" | "Pin" | "Pause";
  tone: Tone;
  /** A warning dot beside the icon, with sr-only text "limit" (S6). */
  dot: boolean;
  details: string;
  limit: LimitCardView | null;
  /** The picker can change the policy (not while loading or offline). */
  canPick: boolean;
}

export const REMOVED_ACCOUNT = "Removed account";
const DAY_MS = 24 * 60 * 60 * 1000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface RpcErrorLike {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}

export function isPoolOffline(error: RpcErrorLike): boolean {
  return (
    error.code === "transport_error" ||
    error.code === "unknown_method" ||
    error.status === 503
  );
}

function routeOf(get: ThreadAccountGet): "pass" | "machine-token" | "none" {
  const route: string = get.route;
  return route === "pass" || route === "machine-token" ? route : "none";
}

function findAccount(
  accounts: ThreadAccountList | null,
  accountId: string | null,
): ThreadAccountEntry | undefined {
  if (accounts === null || accountId === null) return undefined;
  return accounts.accounts.find((entry) => entry.accountId === accountId);
}

/**
 * Whether the thread's last limit event still describes it (§2). `accounts`
 * null means not loaded yet: the event is taken as current until it loads.
 */
export function isLimitCurrent(
  get: ThreadAccountGet,
  accounts: ThreadAccountList | null,
  dismissedId: number | null,
  now: number,
): boolean {
  const limit = get.lastLimit;
  if (limit === null) return false;
  if (get.updatedAt !== null && get.updatedAt > limit.at) return false;
  if (dismissedId === limit.id) return false;
  const account = findAccount(accounts, limit.accountId);
  const action: string = limit.action;
  if (action === "stopped" || action === "served-auto") {
    if (get.policy.mode !== "named") return false;
    if (limit.accountId !== null && get.policy.accountId !== limit.accountId)
      return false;
    if (
      action === "served-auto" &&
      get.serving !== null &&
      get.serving.accountId === limit.accountId &&
      get.serving.since > limit.at
    )
      return false;
    if (accounts === null || account === undefined) return true;
    return account.reason === "at-limit" || account.reason === "unavailable";
  }
  if (action === "fell-back") {
    if (get.policy.mode !== "auto") return false;
    if (now - limit.at >= DAY_MS) return false;
    return !(account?.usable ?? false);
  }
  return false;
}

/** The one time at which the current limit may resolve by itself (M3). */
export function nextTimerAt(
  get: ThreadAccountGet | null,
  accounts: ThreadAccountList | null,
  now: number,
): number | null {
  const limit = get?.lastLimit ?? null;
  if (limit === null) return null;
  const resetAt = findAccount(accounts, limit.accountId)?.resetAt ?? null;
  return resetAt !== null && resetAt > now ? resetAt : null;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Local `14:20`; `Tue 09:00` beyond 24 h; "its reset" when unknown. */
export function formatReset(resetAt: number | null, now: number): string {
  if (resetAt === null) return "its reset";
  const date = new Date(resetAt);
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return resetAt - now > DAY_MS ? `${DAYS[date.getDay()]} ${time}` : time;
}

function formatTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function limitLabel(get: ThreadAccountGet, limit: LimitEvent): string {
  if (limit.accountLabel !== null) return limit.accountLabel;
  if (get.policy.mode === "named" && get.policy.accountId === limit.accountId)
    return get.policy.accountLabel ?? REMOVED_ACCOUNT;
  return REMOVED_ACCOUNT;
}

function servingLabel(get: ThreadAccountGet): string | null {
  if (get.serving === null) return null;
  return get.serving.accountLabel ?? REMOVED_ACCOUNT;
}

function limitCard(
  get: ThreadAccountGet,
  limit: LimitEvent,
  accounts: ThreadAccountList | null,
): LimitCardView | null {
  const name = limitLabel(get, limit);
  const resetAt = findAccount(accounts, limit.accountId)?.resetAt ?? null;
  const cause: string = limit.cause;
  const action: string = limit.action;
  if (action === "fell-back") {
    const serving = servingLabel(get);
    return {
      id: limit.id,
      tone: "warning",
      icon: "AlertTriangle",
      title: cause === "deleted" ? `${name} was removed` : `${name} hit its limit`,
      body: [
        cause === "deleted" || serving === null
          ? "The pool moved this thread to Auto."
          : `The pool moved this thread to Auto. ${serving} serves it now.`,
      ],
      action: "choose",
      actionLabel: "Choose account",
      dismissLabel: "Keep Auto",
    };
  }
  if (action === "served-auto") {
    return {
      id: limit.id,
      tone: "warning",
      icon: "AlertTriangle",
      title: `${name} is unavailable`,
      body: [
        `It is disabled, signed out or blocked. Auto serves this thread until ${name} is back; the thread stays pinned to it.`,
      ],
      action: "use-auto",
      actionLabel: "Use Auto",
      dismissLabel: "Dismiss",
    };
  }
  if (action === "stopped") {
    const isLimit = cause === "limit";
    return {
      id: limit.id,
      tone: "destructive",
      icon: "Pause",
      title: isLimit
        ? `${name} hit its limit: stopped`
        : cause === "deleted"
          ? `${name} was removed: stopped`
          : `${name} is unavailable: stopped`,
      body: isLimit
        ? ["This thread waits until ", { resetAt }, " or until you switch."]
        : ["This thread is set to stop."],
      action: "back-to-auto",
      actionLabel: "Back to Auto",
      dismissLabel: isLimit ? "Wait" : "Dismiss",
    };
  }
  return null;
}

const ON_LIMIT_TEXT: Record<string, string> = {
  "fallback-auto": "Move to Auto",
  stop: "Stop until reset",
};

export interface ViewInput {
  get: ThreadAccountGet | null;
  accounts: ThreadAccountList | null;
  error: RpcErrorLike | null;
  dismissedId: number | null;
  now: number;
}

function base(
  state: ViewState,
  label: string,
  icon: ThreadAccountView["icon"],
  tone: Tone,
  details: string,
  canPick: boolean,
): ThreadAccountView {
  return { state, label, icon, tone, dot: false, details, limit: null, canPick };
}

export function threadAccountView(input: ViewInput): ThreadAccountView {
  const { get, accounts, error, dismissedId, now } = input;
  if (get === null) {
    if (error === null)
      return base("loading", "Account", "Spinner", "muted", "Reading this thread's account.", false);
    if (isPoolOffline(error))
      return base(
        "offline",
        "Pool offline",
        "CloudOff",
        "warning",
        "The Account Pooler is not answering. The thread keeps running; its account is not shown.",
        false,
      );
    return base("error", "Account unknown", "AlertTriangle", "warning", "Could not read this thread's account.", false);
  }
  if (get.provider === null) return base("hidden", "", "Layers", "muted", "", false);

  const route = routeOf(get);
  const serving = servingLabel(get);
  const limit = get.lastLimit;
  const current = limit !== null && isLimitCurrent(get, accounts, dismissedId, now);
  const card = current && limit !== null ? limitCard(get, limit, accounts) : null;
  const action: string | null = current && limit !== null ? limit.action : null;

  if (get.policy.mode === "named") {
    const name = get.policy.accountLabel ?? REMOVED_ACCOUNT;
    if (action === "stopped" && limit !== null) {
      const resetAt = findAccount(accounts, limit.accountId)?.resetAt ?? null;
      const why = limit.cause === "limit" ? "which hit its limit" : limit.cause === "deleted" ? "which was removed" : "which is unavailable";
      return {
        ...base("named-stopped", `${name} · stopped`, "Pause", "destructive", `Pinned to ${name}, ${why}. Stopped until ${formatReset(resetAt, now)}.`, true),
        limit: card,
      };
    }
    if (action === "served-auto")
      return {
        ...base("named-on-auto", `${name} · on Auto`, "Pin", "warning", `Pinned to ${name}, which is unavailable. Auto serves this thread until ${name} is back.`, true),
        limit: card,
      };
    const rule = ON_LIMIT_TEXT[get.policy.onLimit] ?? "Move to Auto";
    const details =
      route === "machine-token"
        ? `Pinned to ${name}. Its last turn ran on the machine token; the pin applies from its next turn on its own pass.`
        : route === "none" && serving !== null
          ? `Pinned to ${name}. Its last turn did not go through the pool; the pin applies to turns that do.`
          : `Pinned to ${name}. At its limit: ${rule}.`;
    return base("named", name, "Pin", "default", details, true);
  }

  if (action === "fell-back" && limit !== null) {
    const name = limitLabel(get, limit);
    return {
      ...base(
        "auto-fallback",
        serving === null ? "Auto" : `Auto · ${serving}`,
        "Layers",
        "default",
        `Auto since ${name} hit its limit at ${formatTime(limit.at)}.${serving === null ? "" : ` Served by ${serving}.`}`,
        true,
      ),
      dot: true,
      limit: card,
    };
  }
  if (route === "machine-token")
    return base(
      "machine-token",
      "Machine token",
      "ComputerCloud",
      "muted",
      "Started before per-thread accounts: uses this machine's pool token, and the pool picks the account per request.",
      true,
    );
  if (route === "none" && serving !== null)
    return base(
      "not-routed",
      "Not routed",
      "CloudOff",
      "muted",
      `Its last turn did not go through the pool, so no account policy applied. Earlier turns: ${serving}.`,
      true,
    );
  if (get.serving === null || serving === null)
    return base("auto-idle", "Auto", "Layers", "muted", "Auto. No routed turn yet.", true);
  return base("auto", `Auto · ${serving}`, "Layers", "default", `Auto. Served by ${serving} since ${formatTime(get.serving.since)}.`, true);
}
