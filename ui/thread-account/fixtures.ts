// Synthetic thread-account.v1 answers for tests and the local harness. Labels
// are made up ("Work A/B/C"); no real account appears here.
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
