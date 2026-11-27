import { useCallback, useState, useSyncExternalStore } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk";

export interface PluginSubmission {
  pluginId: string;
  data: JsonValue;
}

export const RUN_ROW_SUBMISSION_MAX_BYTES = 16 * 1024;
export const TWO_PLUGIN_SUBMISSIONS_MESSAGE =
  "Two plugins want to add data to this send. Clear the account choice or send without the plugin action.";

export function jsonByteLength(value: JsonValue): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

export type MergedPluginSubmission =
  | { ok: true; value: PluginSubmission | undefined }
  | { ok: false; message: string };

export function mergePluginSubmissions(
  rowItem: PluginSubmission | null,
  submitted: PluginSubmission | undefined,
): MergedPluginSubmission {
  if (submitted === undefined) {
    return { ok: true, value: rowItem ?? undefined };
  }
  if (rowItem !== null && rowItem.pluginId !== submitted.pluginId) {
    return { ok: false, message: TWO_PLUGIN_SUBMISSIONS_MESSAGE };
  }
  return { ok: true, value: submitted };
}

export interface RunRowSubmission {
  current: PluginSubmission | null;

  setFor(pluginId: string, data: JsonValue | null): boolean;

  clear(): void;
}

interface Held {
  scopeKey: string;
  value: PluginSubmission;
}

export function createRunRowSubmissionStore() {
  let held: Held | null = null;
  const listeners = new Set<() => void>();
  const emit = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get(): Held | null {
      return held;
    },
    set(scopeKey: string, pluginId: string, data: JsonValue | null): boolean {
      const holder = held?.scopeKey === scopeKey ? held.value : null;
      if (data === null) {
        if (holder?.pluginId === pluginId || holder === null) {
          if (held !== null) {
            held = null;
            emit();
          }
        }
        return true;
      }
      if (holder !== null && holder.pluginId !== pluginId) return false;
      if (jsonByteLength(data) > RUN_ROW_SUBMISSION_MAX_BYTES) return false;
      held = { scopeKey, value: { pluginId, data } };
      emit();
      return true;
    },
    clear(): void {
      if (held === null) return;
      held = null;
      emit();
    },
  };
}

export function useRunRowSubmission(scopeKey: string): RunRowSubmission {
  const [store] = useState(createRunRowSubmissionStore);
  const held = useSyncExternalStore(store.subscribe, store.get, store.get);
  const current = held?.scopeKey === scopeKey ? held.value : null;
  const setFor = useCallback(
    (pluginId: string, data: JsonValue | null) =>
      store.set(scopeKey, pluginId, data),
    [scopeKey, store],
  );
  return { current, setFor, clear: store.clear };
}
