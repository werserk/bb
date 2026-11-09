import { useEffect, useId, useSyncExternalStore } from "react";
const claims = new Map<string, Map<string, number>>();
const listeners = new Set<() => void>();
function emit() {
  for (const listener of listeners) listener();
}
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function usePlanEditorOwner(
  key: string,
  priority: number,
  enabled = true,
): boolean {
  const id = useId();
  useEffect(() => {
    if (!enabled) return;
    const owners = claims.get(key) ?? new Map<string, number>();
    owners.set(id, priority);
    claims.set(key, owners);
    emit();
    return () => {
      owners.delete(id);
      if (!owners.size) claims.delete(key);
      emit();
    };
  }, [key, id, priority, enabled]);
  return useSyncExternalStore(
    subscribe,
    () => {
      const owners = claims.get(key);
      if (!enabled) return false;
      if (!owners) return true;
      return [...owners].sort((a, b) => b[1] - a[1])[0]?.[0] === id;
    },
    () => false,
  );
}

export function useHasPlanEditor(key: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () =>
      [...(claims.get(key)?.values() ?? [])].some((priority) => priority > 0),
    () => false,
  );
}
