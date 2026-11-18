export interface JournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface JournalLocks {
  request(
    name: string,
    options: { mode: "exclusive" } & (
      | { ifAvailable: true; signal?: never }
      | { signal: AbortSignal; ifAvailable?: never }
    ),
    callback: (lock: object | null) => Promise<void>,
  ): Promise<unknown>;
}
/** A predecessor journal's entries, kept until its document is gone. */
interface InheritedJournal {
  journalId: string;
  entries: unknown[];
}
const MAX_INHERITED = 8;
function inheritedOf(stored: unknown): InheritedJournal[] {
  if (
    !stored ||
    typeof stored !== "object" ||
    !("inherited" in stored) ||
    !Array.isArray(stored.inherited)
  )
    return [];
  return stored.inherited.filter(
    (item: unknown): item is InheritedJournal =>
      !!item &&
      typeof item === "object" &&
      "journalId" in item &&
      typeof item.journalId === "string" &&
      "entries" in item &&
      Array.isArray(item.entries),
  );
}
export type JournalStatus =
  | "waiting"
  | "owned"
  | "unavailable"
  | "hidden"
  | "unsaved";
export class PendingSendJournal {
  status: JournalStatus = "unavailable";
  private controller: AbortController | undefined;
  private release: (() => void) | undefined;
  private generation = 0;
  private journalId = "";
  private pristine = false;
  private inherited: InheritedJournal[] = [];
  private hydrate: (entries: unknown[]) => void = () => {};
  constructor(
    private options: {
      key: string;
      reload: boolean;
      storage?: JournalStorage;
      locks?: JournalLocks;
      onChange?: () => void;
    },
  ) {}
  private setStatus(status: JournalStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onChange?.();
  }
  start(hydrate: (entries: unknown[]) => void) {
    this.hydrate = hydrate;
    this.acquire(this.options.reload);
  }
  private acquire(reload: boolean, fresh = false) {
    this.controller?.abort();
    this.release?.();
    const generation = ++this.generation;
    this.pristine = fresh;
    const controller = new AbortController();
    this.controller = controller;
    const { storage, locks, key } = this.options;
    if (!storage || !locks) {
      this.setStatus("unavailable");
      return;
    }
    this.inherited = [];
    if (fresh) {
      this.journalId = crypto.randomUUID();
      // This tab's storage may hold a journal whose document still owns its
      // lock (an unloading predecessor, or the tab this one duplicated).
      // Its entries can be the only copy of their text, so they ride along
      // in `inherited` instead of being overwritten by the first save.
      try {
        const raw = storage.getItem(key);
        const stored: unknown = raw === null ? null : JSON.parse(raw);
        if (
          stored &&
          typeof stored === "object" &&
          "version" in stored &&
          stored.version === 1 &&
          "journalId" in stored &&
          typeof stored.journalId === "string" &&
          "entries" in stored &&
          Array.isArray(stored.entries)
        )
          this.inherited = [
            ...inheritedOf(stored),
            { journalId: stored.journalId, entries: stored.entries },
          ];
      } catch {}
    } else {
      try {
        const raw = storage.getItem(key);
        const parsed: unknown = raw === null ? null : JSON.parse(raw);
        if (
          parsed &&
          typeof parsed === "object" &&
          "version" in parsed &&
          parsed.version === 1 &&
          "journalId" in parsed &&
          typeof parsed.journalId === "string" &&
          "entries" in parsed &&
          Array.isArray(parsed.entries)
        ) {
          this.journalId = parsed.journalId;
        } else if (raw !== null) {
          this.setStatus("unavailable");
          return;
        } else this.journalId = crypto.randomUUID();
      } catch {
        this.setStatus("unavailable");
        return;
      }
    }
    this.setStatus("waiting");
    void locks
      .request(
        `bb-pending-send/${key}/${this.journalId}`,
        {
          mode: "exclusive",
          ...(reload ? { signal: controller.signal } : { ifAvailable: true }),
        },
        async (lock) => {
          if (generation !== this.generation || controller.signal.aborted)
            return;
          if (lock === null) {
            if (fresh) this.setStatus("unavailable");
            else this.acquire(false, true);
            return;
          }
          if (fresh) {
            const adopted = await this.adoptInherited(generation);
            if (adopted === undefined) return;
            this.hydrate(adopted);
            this.setStatus("owned");
            await new Promise<void>((resolve) => {
              this.release = resolve;
              controller.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            });
            return;
          }
          try {
            const raw = storage.getItem(key);
            const current: unknown = raw === null ? null : JSON.parse(raw);
            if (
              current !== null &&
              (typeof current !== "object" ||
                !("version" in current) ||
                current.version !== 1 ||
                !("journalId" in current) ||
                current.journalId !== this.journalId ||
                !("entries" in current) ||
                !Array.isArray(current.entries))
            ) {
              this.setStatus("unavailable");
              return;
            }
            this.inherited = inheritedOf(current);
            const adopted = await this.adoptInherited(generation);
            if (adopted === undefined) return;
            this.hydrate([
              ...(current &&
              typeof current === "object" &&
              "entries" in current &&
              Array.isArray(current.entries)
                ? current.entries
                : []),
              ...adopted,
            ]);
          } catch {
            this.setStatus("unavailable");
            return;
          }
          this.setStatus("owned");
          await new Promise<void>((resolve) => {
            this.release = resolve;
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        },
      )
      .catch(() => {
        if (generation === this.generation && !controller.signal.aborted)
          this.setStatus("unavailable");
      });
  }
  /**
   * Entries of inherited journals whose lock is free (their document is
   * gone) become this journal's own; the rest stay inherited. `undefined`
   * when a newer acquire or Hide superseded this one meanwhile.
   */
  private async adoptInherited(generation: number) {
    const adopted: unknown[] = [];
    const kept: InheritedJournal[] = [];
    for (const journal of this.inherited) {
      if (journal.journalId === this.journalId) continue;
      let free = false;
      try {
        await this.options.locks?.request(
          `bb-pending-send/${this.options.key}/${journal.journalId}`,
          { mode: "exclusive", ifAvailable: true },
          async (lock) => {
            free = lock !== null;
          },
        );
      } catch {}
      if (free) adopted.push(...journal.entries);
      else if (journal.entries.length > 0) kept.push(journal);
    }
    if (generation !== this.generation) return undefined;
    this.inherited = kept.slice(-MAX_INHERITED);
    if (adopted.length > 0) this.pristine = false;
    return adopted;
  }
  /**
   * `fallback` is a smaller form of the same entries (without resend
   * payloads); it is written when storage refuses `entries`, so a quota
   * failure never drops the visible entries from the journal.
   */
  save(entries: unknown[], fallback?: () => unknown[]) {
    if (this.status !== "owned" && this.status !== "unsaved") return;
    if (this.pristine) {
      if (entries.length === 0) return;
      this.pristine = false;
    }
    for (const candidate of fallback ? [entries, fallback] : [entries]) {
      try {
        this.options.storage?.setItem(
          this.options.key,
          JSON.stringify({
            version: 1,
            journalId: this.journalId,
            entries: typeof candidate === "function" ? candidate() : candidate,
            ...(this.inherited.length > 0 ? { inherited: this.inherited } : {}),
          }),
        );
        this.setStatus("owned");
        return;
      } catch {}
    }
    this.setStatus("unsaved");
  }
  hide() {
    ++this.generation;
    this.controller?.abort();
    this.release?.();
    this.setStatus("hidden");
  }
  refresh() {
    this.acquire(this.options.reload);
  }
  /**
   * Scope change (sign-out, identity switch): remove this scope's stored
   * entries. A pristine journal owns its fresh lock while the stored key
   * still holds a previous document's entries (an unloading predecessor, or
   * the copy a duplicated tab inherited). Session storage is per tab, so
   * removing that key cannot touch another live document's journal. A
   * waiting journal owns nothing and never touches storage.
   */
  forget() {
    if (this.status === "owned" || this.status === "unsaved") {
      try {
        this.options.storage?.removeItem(this.options.key);
      } catch {}
    }
    this.inherited = [];
    this.hide();
  }
  dispose() {
    ++this.generation;
    this.controller?.abort();
    this.release?.();
  }
}
