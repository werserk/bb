// A new thread's account (tasks 5.3): the picker's store shape with no thread
// id. The choice stays local until the send, where it travels as this
// plugin's submission; the message.dispatch hook applies it on the thread's
// first dispatch (src/dispatch-account.ts, docs/THREAD_ACCOUNT_V1.md).
import { dispatchAccountSchema, type AccountSummary, type DispatchAccount, type PoolProvider } from "../../src/contracts.js";
import { blockingResetAt, NAMED_LIMIT_THRESHOLD, namedAccountState } from "../../src/quota.js";
import { setInputFor, type PickTarget } from "./pick.js";
import { NOTE_MS, type ThreadAccountSnapshot } from "./store.js";
import {
  threadAccountView,
  type ThreadAccountGet,
  type ThreadAccountList,
  type ThreadAccountSet,
  type ThreadAccountView,
} from "./view.js";

/** Core's `setSubmission`: false when it refuses the data. */
export type SetSubmission = (data: DispatchAccount | null) => boolean;
export type LoadAccounts = () => Promise<AccountSummary[]>;

export const DRAFT_TITLE = "Account for the new thread";
export const DRAFT_AUTO_DETAILS = "Auto. The pool picks the account and fails over.";
export const DRAFT_REFUSED_NOTE =
  "This send already carries another plugin's data, so the account stays Auto.";
export const DRAFT_ACCOUNTS_ERROR_NOTE = "Could not read the pool's accounts.";
/** A restored pin before the account list says its name. */
export const DRAFT_PINNED_LABEL = "Pinned account";

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

export function draftView(snapshot: ThreadAccountSnapshot, now: number): ThreadAccountView {
  const view = threadAccountView({ get: labelled(snapshot), accounts: snapshot.accounts, error: null, dismissedId: null, now });
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
      this.update({
        get: draftGet(this.provider, {
          mode: "named",
          accountId: policy.accountId,
          accountLabel: null,
          onLimit: policy.onLimit ?? "fallback-auto",
        }),
      });
    } else {
      if (submission !== null && submission !== undefined) this.submit(null);
      this.held = false;
      this.update({ get: draftGet(this.provider, AUTO) });
    }
    void this.fetchAccounts();
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
      this.update({ get: draftGet(this.provider, AUTO) });
      this.showNote(DRAFT_REFUSED_NOTE);
      return null;
    }
    this.held = data !== null;
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
