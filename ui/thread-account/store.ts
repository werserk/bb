// One store per thread id, shared by every consumer of that thread (the
// account row, the picker and the limit card, across panes). It holds the
// `get` and `accounts` answers, coalesces refetches with a trailing debounce,
// keeps one reset timer, and remembers the locally dismissed limit (§5).
import { setInputFor, setResultNote, type PickTarget } from "./pick.js";
import {
  nextTimerAt,
  type RpcErrorLike,
  type ThreadAccountGet,
  type ThreadAccountList,
  type ThreadAccountSet,
} from "./view.js";

export const DEBOUNCE_MS = 300;
export const NOTE_MS = 6000;
const MAX_TIMER_MS = 2 ** 31 - 1;
export const DISMISS_KEY_PREFIX = "account-pool.limit-dismissed.";

export type ThreadAccountCaller = (method: string, input: unknown) => Promise<unknown>;

export interface ThreadAccountSnapshot {
  get: ThreadAccountGet | null;
  getError: RpcErrorLike | null;
  accounts: ThreadAccountList | null;
  dismissedId: number | null;
  note: string | null;
  busy: boolean;
}

interface Pending {
  get: boolean;
  accounts: boolean;
}

function readDismissed(threadId: string): number | null {
  try {
    const raw = globalThis.localStorage?.getItem(DISMISS_KEY_PREFIX + threadId);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value) ? value : null;
  } catch {
    return null;
  }
}

function writeDismissed(threadId: string, id: number): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY_PREFIX + threadId, String(id));
  } catch {
    // Storage may be blocked; the dismissal then lasts for this page only.
  }
}

function asError(error: unknown): RpcErrorLike {
  return typeof error === "object" && error !== null
    ? (error as RpcErrorLike)
    : { message: String(error) };
}

export class ThreadAccountStore {
  private snapshot: ThreadAccountSnapshot;
  private readonly listeners = new Set<() => void>();
  private pending: Pending = { get: false, accounts: false };
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private resetTimerAt: number | null = null;
  private noteTimer: ReturnType<typeof setTimeout> | null = null;
  private getSeq = 0;
  private accountsSeq = 0;
  private accountsDirty = true;
  private pickersOpen = 0;
  refs = 0;
  started = false;

  constructor(
    readonly threadId: string,
    private call: ThreadAccountCaller,
    private readonly now: () => number = Date.now,
  ) {
    this.snapshot = {
      get: null,
      getError: null,
      accounts: null,
      dismissedId: readDismissed(threadId),
      note: null,
      busy: false,
    };
  }

  setCaller(call: ThreadAccountCaller): void {
    this.call = call;
  }

  getSnapshot = (): ThreadAccountSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(patch: Partial<ThreadAccountSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.armResetTimer();
    for (const listener of this.listeners) listener();
  }

  /** First load: both answers at once, no debounce. */
  start(): void {
    void this.fetchGet();
    void this.fetchAccounts();
  }

  /** Queue refetches; they run together DEBOUNCE_MS after the last request. */
  schedule(what: Partial<Pending>): void {
    this.pending = {
      get: this.pending.get || (what.get ?? false),
      accounts: this.pending.accounts || (what.accounts ?? false),
    };
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const run = this.pending;
      this.pending = { get: false, accounts: false };
      if (run.get) void this.fetchGet();
      if (run.accounts) void this.fetchAccounts();
    }, DEBOUNCE_MS);
  }

  onThreadChanged(payload: unknown): void {
    const threadId =
      typeof payload === "object" && payload !== null
        ? (payload as { threadId?: unknown }).threadId
        : undefined;
    if (threadId === this.threadId) this.schedule({ get: true });
  }

  onAccountsChanged(): void {
    this.accountsDirty = true;
    const needAccounts = this.pickersOpen > 0 || this.snapshot.get?.lastLimit != null;
    this.schedule({ get: true, accounts: needAccounts });
  }

  onReconnect(): void {
    this.schedule({ get: true, accounts: true });
  }

  pickerOpened(): void {
    this.pickersOpen += 1;
    if (this.accountsDirty || this.snapshot.accounts === null) void this.fetchAccounts();
  }

  pickerClosed(): void {
    this.pickersOpen = Math.max(0, this.pickersOpen - 1);
  }

  retry(): void {
    void this.fetchGet();
    void this.fetchAccounts();
  }

  dismiss(id: number): void {
    writeDismissed(this.threadId, id);
    this.update({ dismissedId: id });
  }

  private async fetchGet(): Promise<void> {
    const seq = ++this.getSeq;
    try {
      const get = (await this.call("thread-account.v1.get", {
        threadId: this.threadId,
      })) as ThreadAccountGet;
      if (seq === this.getSeq) this.update({ get, getError: null });
    } catch (error) {
      if (seq === this.getSeq) this.update({ get: null, getError: asError(error) });
    }
  }

  private async fetchAccounts(): Promise<void> {
    const seq = ++this.accountsSeq;
    this.accountsDirty = false;
    try {
      const accounts = (await this.call("thread-account.v1.accounts", {
        threadId: this.threadId,
      })) as ThreadAccountList;
      if (seq === this.accountsSeq) this.update({ accounts });
    } catch {
      // The picker shows no rows; `get` carries the error state.
      if (seq === this.accountsSeq) this.update({ accounts: null });
    }
  }

  /**
   * Send a pick. `seen` is the state a confirm dialog showed: its revision
   * guards the write, so a change made meanwhile conflicts instead of being
   * overwritten. Returns the answer, or null when nothing was sent.
   */
  async pick(
    target: PickTarget,
    newSession: boolean,
    seen: ThreadAccountGet | null = null,
  ): Promise<ThreadAccountSet | null> {
    const get = seen ?? this.snapshot.get;
    if (get === null || this.snapshot.busy) return null;
    const input = setInputFor(get, target, newSession);
    if (input === null) return null;
    this.update({ busy: true });
    let result: ThreadAccountSet;
    try {
      result = (await this.call("thread-account.v1.set", input)) as ThreadAccountSet;
    } catch {
      this.update({ busy: false });
      this.showNote("Could not change the account.");
      return null;
    }
    if (result.ok) {
      const { ok: _ok, changed: _changed, sessionRebuild: _rebuild, message: _message, ...state } = result;
      this.getSeq += 1; // An in-flight get is older than this answer.
      this.update({ busy: false, get: state });
    } else {
      this.update({ busy: false });
      if (result.reason === "revision-conflict") void this.fetchGet();
      if (result.reason === "at-limit" || result.reason === "unavailable") void this.fetchAccounts();
    }
    this.showNote(setResultNote(result));
    return result;
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

  private armResetTimer(): void {
    const at = nextTimerAt(this.snapshot.get, this.snapshot.accounts, this.now());
    if (at === this.resetTimerAt) return;
    if (this.resetTimer !== null) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.resetTimerAt = at;
    if (at === null || this.refs === 0) return;
    const delay = at - this.now();
    if (delay > MAX_TIMER_MS) return;
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.resetTimerAt = null;
      void this.fetchAccounts();
    }, Math.max(0, delay));
  }

  dispose(): void {
    for (const timer of [this.debounce, this.resetTimer, this.noteTimer])
      if (timer !== null) clearTimeout(timer);
    this.debounce = this.resetTimer = this.noteTimer = null;
    this.resetTimerAt = null;
    this.listeners.clear();
  }
}

const stores = new Map<string, ThreadAccountStore>();

/** The thread's store, created on first use; it fetches once retained. */
export function getStore(threadId: string, call: ThreadAccountCaller): ThreadAccountStore {
  let store = stores.get(threadId);
  if (store === undefined) {
    store = new ThreadAccountStore(threadId, call);
    stores.set(threadId, store);
  } else {
    store.setCaller(call);
  }
  return store;
}

/**
 * Hold the store while a consumer is mounted. The last release drops it on
 * the next task, so an immediate re-retain (StrictMode, a pane move) keeps it.
 */
export function retainStore(store: ThreadAccountStore): () => void {
  if (stores.get(store.threadId) !== store) stores.set(store.threadId, store);
  store.refs += 1;
  if (!store.started) {
    store.started = true;
    store.start();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    store.refs -= 1;
    if (store.refs > 0) return;
    setTimeout(() => {
      if (store.refs > 0) return;
      store.dispose();
      store.started = false;
      if (stores.get(store.threadId) === store) stores.delete(store.threadId);
    }, 0);
  };
}

/** Test hook: drop every store. */
export function resetStoresForTest(): void {
  for (const store of stores.values()) store.dispose();
  stores.clear();
}
