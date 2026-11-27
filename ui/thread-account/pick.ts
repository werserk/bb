// Pure pick rules: what a picker choice sends, when it needs a new Codex
// session and a confirm dialog, and the note a `set` answer leaves (§2, §3).
import { formatReset, type ThreadAccountGet, type ThreadAccountList, type ThreadAccountSet } from "./view.js";

export type PickTarget =
  | { kind: "auto" }
  | { kind: "named"; accountId: string; accountLabel: string }
  | { kind: "on-limit"; onLimit: "fallback-auto" | "stop" };

/** True when the target is the policy the thread already has (send nothing). */
export function isSamePolicy(get: ThreadAccountGet, target: PickTarget): boolean {
  const policy = get.policy;
  if (!isKnownMode(get)) return false;
  if (target.kind === "auto") return policy.mode === "auto";
  if (target.kind === "named")
    return policy.mode === "named" && policy.accountId === target.accountId;
  return policy.mode !== "named" || policy.onLimit === target.onLimit;
}

/** False for a policy mode this UI does not know (a newer pool). */
export function isKnownMode(get: ThreadAccountGet): boolean {
  const mode: string = get.policy.mode;
  return mode === "auto" || mode === "named";
}

export function needsNewSession(get: ThreadAccountGet, target: PickTarget): boolean {
  if (target.kind !== "named") return false;
  if (get.provider !== "codex") return false;
  if (get.serving?.accountId === target.accountId) return false;
  if (get.grandfathered) return true;
  return get.serving !== null;
}

export interface ConfirmParts {
  title: string;
  paragraphs: string[];
  confirmLabel: string;
  newSession: boolean;
}

export const GRANDFATHERED_TEXT =
  "This thread runs on the machine token. Pinning moves it to its own pass at its next turn; its session is rebuilt once. The context is kept; background shells, monitors and subagents end.";
export const CODEX_SESSION_TEXT =
  "Codex sessions are tied to their account. The timeline stays; the model context starts over. The thread must be idle.";
export const CODEX_PICKER_NOTE =
  "Codex: changing the account, Auto included, may restart the session; pinning another account starts a new one.";

/** The confirm dialog for a pick, or null when the pick needs none. */
export function confirmParts(get: ThreadAccountGet, target: PickTarget): ConfirmParts | null {
  if (target.kind !== "named") return null;
  const newSession = needsNewSession(get, target);
  const paragraphs = [
    ...(get.grandfathered ? [GRANDFATHERED_TEXT] : []),
    ...(newSession ? [CODEX_SESSION_TEXT] : []),
  ];
  if (paragraphs.length === 0) return null;
  return {
    title: `Pin this thread to ${target.accountLabel}?`,
    paragraphs,
    confirmLabel: newSession ? "Pin and start new session" : `Pin to ${target.accountLabel}`,
    newSession,
  };
}

/** The `set` input for a pick; null when nothing is to be sent. */
export function setInputFor(
  get: ThreadAccountGet,
  target: PickTarget,
  newSession: boolean,
): {
  threadId: string;
  policy: { mode: "auto" } | { mode: "named"; accountId: string; onLimit?: "fallback-auto" | "stop" };
  expectedRevision: number;
  newSession?: boolean;
} | null {
  if (!isKnownMode(get) || isSamePolicy(get, target)) return null;
  const common = { threadId: get.threadId, expectedRevision: get.revision };
  if (target.kind === "auto") return { ...common, policy: { mode: "auto" } };
  if (target.kind === "on-limit") {
    if (get.policy.mode !== "named") return null;
    return {
      ...common,
      policy: { mode: "named", accountId: get.policy.accountId, onLimit: target.onLimit },
    };
  }
  // Switching between pinned accounts keeps the thread's on-limit rule (F3).
  const onLimit = get.policy.mode === "named" ? get.policy.onLimit : undefined;
  return {
    ...common,
    policy: { mode: "named", accountId: target.accountId, ...(onLimit === undefined ? {} : { onLimit }) },
    ...(newSession ? { newSession: true } : {}),
  };
}

/** The note a `set` answer leaves in the row and the picker's live region. */
export function setResultNote(result: ThreadAccountSet): string | null {
  if (result.ok) {
    if (!result.changed) return null;
    if (result.sessionRebuild === "new-session")
      return result.message === null ? "New Codex session started." : `New Codex session started. ${result.message}`;
    return result.message;
  }
  const reason: string = result.reason;
  if (reason === "revision-conflict") return "Changed elsewhere; refreshed.";
  if (reason === "not-idle") return "The thread is busy. Try again when it is idle.";
  return result.message === "" ? "The pool refused the change." : result.message;
}

// ---- Picker rows ----

export interface PickerAccountRow {
  accountId: string;
  label: string;
  secondary: string;
  usable: boolean;
  /** Why the row cannot be picked, for aria-describedby. */
  reasonText: string | null;
}

const KIND_TEXT: Record<string, string> = { oauth: "Subscription", "api-key": "API key" };

/** "pro" → "Pro"; without a plan, the account kind in words. */
function planText(entry: { subscriptionType: string | null; kind: string }): string {
  const plan = entry.subscriptionType;
  if (plan !== null && plan !== "") return plan.charAt(0).toUpperCase() + plan.slice(1);
  return KIND_TEXT[entry.kind] ?? entry.kind;
}

export function pickerRows(accounts: ThreadAccountList | null, now: number): PickerAccountRow[] {
  if (accounts === null) return [];
  return accounts.accounts
    .filter((entry) => entry.reason !== "other-provider" && entry.reason !== "not-pooled")
    .map((entry) => {
      const reasonText = entry.usable
        ? null
        : entry.reason === "at-limit"
          ? entry.resetAt === null
            ? "At limit"
            : `At limit until ${formatReset(entry.resetAt, now)}`
          : "Unavailable";
      return {
        accountId: entry.accountId,
        label: entry.accountLabel,
        secondary: reasonText ?? planText(entry),
        usable: entry.usable,
        reasonText,
      };
    });
}
