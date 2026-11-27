// Synthetic thread-account.v1 answers for tests and the local harness. Labels
// are made up ("Work A/B/C"); no real account appears here.
import type { AccountSummary } from "../../src/contracts.js";
import type {
  LimitEvent,
  ThreadAccountEntry,
  ThreadAccountGet,
  ThreadAccountList,
} from "./view.js";

export const T0 = Date.UTC(2026, 10, 27, 12, 0, 0);
export const THREAD = "thr_test1";

export function getState(patch: Partial<ThreadAccountGet> = {}): ThreadAccountGet {
  return {
    threadId: THREAD,
    provider: "claude",
    policy: { mode: "auto" },
    revision: 1,
    updatedAt: null,
    grandfathered: false,
    route: "pass",
    serving: { accountId: "acc_b", accountLabel: "Work B", provider: "claude", since: T0 - 60_000 },
    lastLimit: null,
    switchContinuity: "continues",
    note: null,
    ...patch,
  };
}

export function named(
  accountId = "acc_a",
  accountLabel: string | null = "Work A",
  onLimit: "fallback-auto" | "stop" = "fallback-auto",
): ThreadAccountGet["policy"] {
  return { mode: "named", accountId, accountLabel, onLimit };
}

export function limitEvent(patch: Partial<LimitEvent> = {}): LimitEvent {
  return {
    id: 7,
    at: T0 - 5 * 60_000,
    accountId: "acc_a",
    accountLabel: "Work A",
    cause: "limit",
    action: "fell-back",
    ...patch,
  };
}

export function entry(patch: Partial<ThreadAccountEntry> & { accountId: string }): ThreadAccountEntry {
  return {
    accountLabel: patch.accountId,
    provider: "claude",
    kind: "oauth",
    subscriptionType: "max",
    usable: true,
    reason: null,
    resetAt: null,
    ...patch,
  };
}

export function accountList(entries?: ThreadAccountEntry[]): ThreadAccountList {
  return {
    threadId: THREAD,
    provider: "claude",
    accounts: entries ?? [
      entry({ accountId: "acc_a", accountLabel: "Work A" }),
      entry({ accountId: "acc_b", accountLabel: "Work B", subscriptionType: "pro" }),
      entry({ accountId: "acc_c", accountLabel: "Work C", usable: false, reason: "at-limit", resetAt: T0 + 2 * 3600_000 }),
      entry({ accountId: "acc_x", accountLabel: "Codex X", provider: "codex", usable: false, reason: "other-provider" }),
    ],
  };
}

/** Accounts with A at its limit until `resetAt`. */
export function aAtLimit(resetAt: number | null = T0 + 3600_000): ThreadAccountList {
  const list = accountList();
  return {
    ...list,
    accounts: list.accounts.map((item) =>
      item.accountId === "acc_a" ? { ...item, usable: false, reason: "at-limit", resetAt } : item,
    ),
  };
}

/** An `account.list` entry: Claude, enabled, ready, low usage. */
export function summary(patch: Partial<AccountSummary> & { id: string; label: string }): AccountSummary {
  return {
    provider: "claude",
    kind: "oauth",
    email: null,
    accountUuid: null,
    subscriptionType: "max",
    rateLimitTier: null,
    enabled: true,
    priority: 100,
    createdAt: T0 - 86_400_000,
    lastUsedAt: null,
    lastUsedHostId: null,
    lastUsedHostName: null,
    accessBlocked: null,
    usageRestriction: null,
    extraUsage: null,
    fiveHourUtilization: 0.2,
    fiveHourResetAt: T0 + 3600_000,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: { fable: null, sonnet: null, opus: null, haiku: null, other: null },
    limitWindows: [],
    observedAt: T0 - 60_000,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...patch,
  };
}

export const ID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const ID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const ID_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const ID_X = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

/** Claude A; B past the switch threshold (status exhausted) but under the real limit; C at it; Codex X. */
export function summaries(): AccountSummary[] {
  return [
    summary({ id: ID_B, label: "Work B", priority: 200, fiveHourUtilization: 0.99, status: "exhausted" }),
    summary({ id: ID_A, label: "Work A", priority: 100 }),
    summary({ id: ID_C, label: "Work C", priority: 300, fiveHourUtilization: 1, status: "exhausted" }),
    summary({ id: ID_X, label: "Codex X", provider: "codex", priority: 50 }),
  ];
}
