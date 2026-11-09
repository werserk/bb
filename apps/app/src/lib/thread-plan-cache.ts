import type { ThreadPlanView, ThreadPlansReadResponse } from "@bb/domain";
export class ThreadPlanCache {
  plans: Record<string, ThreadPlanView> = {};
  errors: Record<string, string> = {};
  private dirty = new Map<string, number>();
  private queue = new Set<string>();
  private flight = new Set<string>();
  private active = 0;
  private revision = 0;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();
  constructor(
    private read: (ids: readonly string[]) => Promise<ThreadPlansReadResponse>,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  snapshot = () => this.revision;
  private emit() {
    this.revision++;
    for (const fn of this.listeners) fn();
  }
  loaded(ids: readonly string[]) {
    return ids.filter(
      (id) => this.plans[id] && !this.dirty.has(id) && !this.errors[id],
    );
  }
  ensure(ids: readonly string[]) {
    const missing = ids.filter(
      (id) => !this.plans[id] && !this.errors[id] && !this.dirty.has(id),
    );
    if (missing.length) void this.refresh(missing);
  }
  refresh(ids: readonly string[]): Promise<void> {
    for (const id of new Set(ids)) {
      this.dirty.set(id, (this.dirty.get(id) ?? 0) + 1);
      delete this.errors[id];
      this.queue.add(id);
    }
    this.emit();
    this.pump();
    return new Promise((resolve) => {
      const check = () => {
        if (ids.every((id) => !this.dirty.has(id))) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
  }
  private pump() {
    while (this.active < 2) {
      const ids = [...this.queue]
        .filter((id) => !this.flight.has(id))
        .slice(0, 40);
      if (!ids.length) break;
      const generations = ids.map((id) => this.dirty.get(id));
      for (const id of ids) {
        this.queue.delete(id);
        this.flight.add(id);
      }
      this.active++;
      void this.read(ids)
        .then(
          (result) => {
            ids.forEach((id, index) => {
              if (this.dirty.get(id) !== generations[index]) return;
              const view = result.plans[id];
              const previous = this.plans[id];
              if (view && (!previous || view.revision >= previous.revision))
                this.plans = { ...this.plans, [id]: view };
              else
                this.errors[id] =
                  result.errors[id] ??
                  (view ? "Stale plan revision" : "Incomplete plan response");
              this.dirty.delete(id);
            });
          },
          (error) => {
            ids.forEach((id, index) => {
              if (this.dirty.get(id) === generations[index]) {
                this.errors[id] =
                  error instanceof Error ? error.message : "Plan unavailable";
                this.dirty.delete(id);
              }
            });
          },
        )
        .finally(() => {
          for (const id of ids) this.flight.delete(id);
          this.active--;
          this.emit();
          this.pump();
          for (const check of this.waiters) check();
        });
    }
  }
}
