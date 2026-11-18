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
    if (fresh) this.journalId = crypto.randomUUID();
    else {
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
            this.hydrate([]);
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
            this.hydrate(
              current &&
                typeof current === "object" &&
                "entries" in current &&
                Array.isArray(current.entries)
                ? current.entries
                : [],
            );
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
  save(entries: unknown[]) {
    if (this.status !== "owned" && this.status !== "unsaved") return;
    if (this.pristine) {
      if (entries.length === 0) return;
      this.pristine = false;
    }
    try {
      this.options.storage?.setItem(
        this.options.key,
        JSON.stringify({ version: 1, journalId: this.journalId, entries }),
      );
      this.setStatus("owned");
    } catch {
      this.setStatus("unsaved");
    }
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
  forget() {
    if (
      !this.pristine &&
      (this.status === "owned" || this.status === "unsaved")
    ) {
      try {
        this.options.storage?.removeItem(this.options.key);
      } catch {}
    }
    this.hide();
  }
  dispose() {
    ++this.generation;
    this.controller?.abort();
    this.release?.();
  }
}
