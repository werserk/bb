// A new thread's account (tasks 5.3): the picker's store shape with no thread
// id. The choice stays local until the send, where it travels as this
// plugin's submission; the message.dispatch hook applies it on the thread's
// first dispatch (src/dispatch-account.ts, docs/THREAD_ACCOUNT_V1.md).
import { dispatchAccountSchema, type AccountSummary, type DispatchAccount, type PoolProvider } from "../../src/contracts.js";
import { blockingResetAt, NAMED_LIMIT_THRESHOLD, namedAccountState } from "../../src/quota.js";
import { setInputFor, type PickTarget } from "./pick.js";
import { NOTE_MS, type ThreadAccountSnapshot } from "./store.js";
import {
  REMOVED_ACCOUNT,
  threadAccountView,
  type ThreadAccountGet,
  type ThreadAccountList,
  type ThreadAccountSet,
  type ThreadAccountView,
} from "./view.js";

/** Core's `setSubmission`: false when it refuses the data. */
export type SetSubmission = (data: DispatchAccount | null) => boolean;
export type LoadAccounts = () => Promise<AccountSummary[]>;

/**
 * Where a new thread's pick outlives the composer. Core holds this plugin's
 * submission only in memory, so a page reload or a composer remount mounts the
 * chip with nothing; the store then puts the remembered pick back into core's
 * draft. `read` returns only data the dispatch hook would parse.
 */
export interface DraftMemory {
  read(): DispatchAccount | null;
  write(data: DispatchAccount | null): void;
}

export const NO_DRAFT_MEMORY: DraftMemory = { read: () => null, write: () => {} };

/** Per tab: a reload keeps the pick, a new tab starts on Auto. */
export function sessionDraftMemory(key: string, storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = sessionStorageOrNull()): DraftMemory {
  if (storage === null) return NO_DRAFT_MEMORY;
  return {
    read() {
      try {
        const text = storage.getItem(key);
        if (text === null) return null;
        const parsed = dispatchAccountSchema.safeParse(JSON.parse(text));
        if (parsed.success && parsed.data.policy.mode === "named") return parsed.data;
        storage.removeItem(key);
        return null;
      } catch {
        return null;
      }
    },
    write(data) {
      try {
        if (data === null) storage.removeItem(key);
        else storage.setItem(key, JSON.stringify(data));
      } catch {
        // Storage full or blocked: the pick still holds until the reload.
      }
    },
  };
}

function sessionStorageOrNull(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function draftMemoryKey(projectId: string | null, provider: PoolProvider): string {
  return `account-pool:new-thread-account:v1\u0000${projectId ?? ""}\u0000${provider}`;
}

export const DRAFT_TITLE = "Account for the new thread";
export const DRAFT_AUTO_DETAILS = "Auto. The pool picks the account and fails over.";
export const DRAFT_REFUSED_NOTE =
  "This send already carries another plugin's data, so the account stays Auto.";
export const DRAFT_ACCOUNTS_ERROR_NOTE = "Could not read the pool's accounts.";
/** A restored pin before the account list says its name. */
export const DRAFT_PINNED_LABEL = "Pinned account";
export const DRAFT_REMOVED_DETAILS = "Pinned to an account the pool no longer has. Choose another account or Auto.";

export function draftGet(provider: PoolProvider, policy: ThreadAccountGet["policy"]): ThreadAccountGet {
  return {
    threadId: "",
    provider,
    policy,
    revision: 0,
    updatedAt: null,
    grandfathered: false,
    route: "none",
    serving: null,
    lastLimit: null,
    switchContinuity: "continues",
    note: null,
  };
}

/**
 * The provider's accounts from `account.list`, in priority order. Usable is
 * what `set` checks on the first dispatch, where the thread has no model yet,
 * so only the shared quota counts (THREAD_ACCOUNT_V1.md, "New thread account").
 */
export function draftAccountList(
  provider: PoolProvider,
  summaries: readonly AccountSummary[],
  now: number,
): ThreadAccountList {
  return {
    threadId: "",
    provider,
    accounts: summaries
      .filter((summary) => summary.provider === provider)
      .sort((left, right) => left.priority - right.priority)
      .map((summary) => {
        const state = namedAccountState(summary, { ...summary, accountId: summary.id }, null, now);
        const reason = state === "ok" ? null : state === "limit" ? "at-limit" : "unavailable";
        return {
          accountId: summary.id,
          accountLabel: summary.label,
          provider: summary.provider,
          kind: summary.kind,
          subscriptionType: summary.subscriptionType,
          usable: reason === null,
          reason,
          resetAt: reason === "at-limit" ? blockingResetAt(summary, null, NAMED_LIMIT_THRESHOLD, now) : null,
        };
      }),
  };
}

/**
 * Core's draft data carries only the account id, so a pin restored on mount
 * takes its name from the account list: a placeholder until the list loads,
 * the removed-account label when the list no longer has it.
 */
function labelled(snapshot: ThreadAccountSnapshot): ThreadAccountGet | null {
  const get = snapshot.get;
  if (get === null || get.policy.mode !== "named" || get.policy.accountLabel !== null) return get;
  const { accountId } = get.policy;
  const label =
    snapshot.accounts === null
      ? DRAFT_PINNED_LABEL
      : (snapshot.accounts.accounts.find((item) => item.accountId === accountId)?.accountLabel ?? null);
  return { ...get, policy: { ...get.policy, accountLabel: label } };
}

/** The pin's account is not in the loaded list: the hook would refuse the send. */
function pinRemoved(snapshot: ThreadAccountSnapshot): boolean {
  const get = snapshot.get;
  if (get === null || get.policy.mode !== "named" || snapshot.accounts === null) return false;
  const { accountId } = get.policy;
  return !snapshot.accounts.accounts.some((item) => item.accountId === accountId);
}

export function draftView(snapshot: ThreadAccountSnapshot, now: number): ThreadAccountView {
  const view = threadAccountView({ get: labelled(snapshot), accounts: snapshot.accounts, error: null, dismissedId: null, now });
  if (pinRemoved(snapshot)) return { ...view, label: REMOVED_ACCOUNT, tone: "warning", details: DRAFT_REMOVED_DETAILS };
  return view.state === "auto-idle" ? { ...view, details: DRAFT_AUTO_DETAILS } : view;
}

const AUTO: ThreadAccountGet["policy"] = { mode: "auto" };

export class DraftAccountStore {
  private snapshot: ThreadAccountSnapshot;
  private readonly listeners = new Set<() => void>();
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private accountsSeq = 0;
  private pickersOpen = 0;
  /** This item's data is in core's draft. */
  private held = false;

  constructor(
    readonly provider: PoolProvider,
    private submit: SetSubmission,
    private load: LoadAccounts,
    private readonly now: () => number = Date.now,
    private readonly memory: DraftMemory = NO_DRAFT_MEMORY,
  ) {
    this.snapshot = {
      get: draftGet(provider, AUTO),
      getError: null,
      accounts: null,
      dismissedId: null,
      note: null,
      busy: false,
    };
  }

  setSources(submit: SetSubmission, load: LoadAccounts): void {
    this.submit = submit;
    this.load = load;
  }

  getSnapshot = (): ThreadAccountSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ThreadAccountSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /**
   * Mount: show what core's draft holds for this plugin, so a pick survives a
   * remount. Data the hook would not parse is cleared, so the chip and the
   * send agree on Auto.
   */
  start(submission: unknown): void {
    const parsed = dispatchAccountSchema.safeParse(submission);
    const policy = parsed.success ? parsed.data.policy : null;
    if (policy !== null && policy.mode === "named") {
      this.held = true;
      this.memory.write({ policy });
      this.showPin(policy, null);
    } else if (submission === null || submission === undefined) {
      this.restoreRemembered();
    } else {
      this.submit(null);
      this.memory.write(null);
      this.held = false;
      this.update({ get: draftGet(this.provider, AUTO) });
    }
    void this.fetchAccounts();
  }

  /** Core holds nothing (a reload or a remount): put the remembered pick back. */
  private restoreRemembered(): void {
    const remembered = this.memory.read();
    if (remembered !== null && remembered.policy.mode === "named" && this.submit(remembered)) {
      this.held = true;
      this.showPin(remembered.policy, null);
      return;
    }
    if (remembered !== null) this.memory.write(null);
    this.held = false;
    this.update({ get: draftGet(this.provider, AUTO) });
  }

  private showPin(policy: Extract<DispatchAccount["policy"], { mode: "named" }>, accountLabel: string | null): void {
    this.update({
      get: draftGet(this.provider, {
        mode: "named",
        accountId: policy.accountId,
        accountLabel,
        onLimit: policy.onLimit ?? "fallback-auto",
      }),
    });
  }

  /** Core dropped this plugin's draft (it clears it after a send): forget the pick. */
  coreCleared(): void {
    this.memory.write(null);
    if (!this.held) return;
    this.held = false;
    this.update({ get: draftGet(this.provider, AUTO) });
  }

  /** Unmount: ignore answers still in flight and drop the note timer. */
  stop(): void {
    this.accountsSeq += 1;
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = null;
  }

  pickerOpened(): void {
    this.pickersOpen += 1;
    void this.fetchAccounts();
  }

  pickerClosed(): void {
    this.pickersOpen = Math.max(0, this.pickersOpen - 1);
  }

  onAccountsChanged(): void {
    if (this.pickersOpen > 0) void this.fetchAccounts();
  }

  retry(): void {
    void this.fetchAccounts();
  }

  private async fetchAccounts(): Promise<void> {
    const seq = ++this.accountsSeq;
    try {
      const summaries = await this.load();
      if (seq === this.accountsSeq)
        this.update({ accounts: draftAccountList(this.provider, summaries, this.now()) });
    } catch {
      if (seq === this.accountsSeq) {
        this.update({ accounts: null });
        this.showNote(DRAFT_ACCOUNTS_ERROR_NOTE);
      }
    }
  }

  /** Apply a pick locally and hand it to core. Nothing reaches the pool yet. */
  async pick(target: PickTarget): Promise<ThreadAccountSet | null> {
    const get = this.snapshot.get;
    const input = get === null ? null : setInputFor(get, target, false);
    if (get === null || input === null) return null;
    const { policy } = input;
    const data: DispatchAccount | null = policy.mode === "auto" ? null : { policy };
    if (!this.submit(data)) {
      // Keep Auto, in core's draft as well as on the chip.
      if (this.held) this.submit(null);
      this.held = false;
      this.memory.write(null);
      this.update({ get: draftGet(this.provider, AUTO) });
      this.showNote(DRAFT_REFUSED_NOTE);
      return null;
    }
    this.held = data !== null;
    this.memory.write(data);
    const label =
      target.kind === "named" ? target.accountLabel : get.policy.mode === "named" ? get.policy.accountLabel : null;
    this.update({
      get: draftGet(
        this.provider,
        policy.mode === "auto"
          ? AUTO
          : { mode: "named", accountId: policy.accountId, accountLabel: label, onLimit: policy.onLimit ?? "fallback-auto" },
      ),
    });
    this.showNote(null);
    return null;
  }

  private showNote(note: string | null): void {
    if (this.noteTimer !== null) clearTimeout(this.noteTimer);
    this.noteTimer = null;
    this.update({ note });
    if (note === null) return;
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null;
      this.update({ note: null });
    }, NOTE_MS);
  }
}
