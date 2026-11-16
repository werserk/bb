export function createAdmissionLedger<T>(now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: T }>();
  const prune = () => {
    for (const [key, item] of entries)
      if (now() - item.at >= 3600000) entries.delete(key);
  };
  return {
    get(key: string) {
      prune();
      return entries.get(key)?.value;
    },
    admit(key: string, value: T, limit: number) {
      prune();
      if (entries.has(key)) return false;
      if (entries.size >= limit) return false;
      entries.set(key, { at: now(), value });
      return true;
    },
    size() {
      prune();
      return entries.size;
    },
  };
}
