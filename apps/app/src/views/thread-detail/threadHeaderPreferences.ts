import { createSyncedPreferenceAtom } from "@/lib/ui-preferences/synced-preference-atom";

export const threadHeaderPinnedAtom = createSyncedPreferenceAtom(
  "threadHeader.pinned",
);

export function toggleHeaderPin(keys: string[], key: string): string[] {
  return keys.includes(key)
    ? keys.filter((value) => value !== key)
    : [...keys, key];
}

export function partitionHeaderContributions<T extends { key: string }>(
  items: T[],
  keys: string[],
) {
  const byKey = new Map(items.map((item) => [item.key, item]));
  return {
    pinned: [...new Set(keys)].flatMap((key) => {
      const item = byKey.get(key);
      return item ? [item] : [];
    }),
    more: items.filter((item) => !keys.includes(item.key)),
  };
}

export function activateHeaderComponent(host: HTMLElement | undefined) {
  host
    ?.querySelector<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [role="button"]:not([aria-disabled="true"]), [tabindex]:not([tabindex="-1"])',
    )
    ?.click();
}
