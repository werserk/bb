import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk";

export interface PluginSubmission {
  pluginId: string;
  data: JsonValue;
}

export const RUN_ROW_SUBMISSION_MAX_BYTES = 16 * 1024;
export const TWO_PLUGIN_SUBMISSIONS_MESSAGE =
  "Two plugins want to add data to this send. Clear the account choice or send without the plugin action.";

function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sameJson(source: unknown, copy: JsonValue): boolean {
  if (
    source === null ||
    typeof source === "string" ||
    typeof source === "boolean"
  ) {
    return source === copy;
  }
  if (typeof source === "number") {
    return Number.isFinite(source) && source === copy;
  }
  if (Array.isArray(source)) {
    return (
      Array.isArray(copy) &&
      source.length === copy.length &&
      source.every((item, index) => sameJson(item, copy[index] as JsonValue))
    );
  }
  if (typeof source !== "object" || !isPlainObject(source)) return false;
  if (copy === null || typeof copy !== "object" || Array.isArray(copy)) {
    return false;
  }
  const keys = Object.keys(source);
  return (
    keys.length === Object.keys(copy).length &&
    keys.every(
      (key) =>
        Object.hasOwn(copy, key) &&
        sameJson(
          (source as Record<string, unknown>)[key],
          copy[key] as JsonValue,
        ),
    )
  );
}

export function snapshotJson(
  data: unknown,
): { value: JsonValue; bytes: number } | null {
  try {
    const text = JSON.stringify(data) as string | undefined;
    if (text === undefined) return null;
    const value = JSON.parse(text) as JsonValue;
    if (!sameJson(data, value)) return null;
    return { value, bytes: new TextEncoder().encode(text).length };
  } catch {
    return null;
  }
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
      const snapshot = snapshotJson(data);
      if (snapshot === null) return false;
      if (snapshot.bytes > RUN_ROW_SUBMISSION_MAX_BYTES) return false;
      held = { scopeKey, value: { pluginId, data: snapshot.value } };
      emit();
      return true;
    },
    clear(): void {
      if (held === null) return;
      held = null;
      emit();
    },
    keepOnly(scopeKey: string): void {
      if (held === null || held.scopeKey === scopeKey) return;
      held = null;
      emit();
    },
  };
}

export function useRunRowSubmission(scopeKey: string): RunRowSubmission {
  const [store] = useState(createRunRowSubmissionStore);
  const held = useSyncExternalStore(store.subscribe, store.get, store.get);
  const current = held?.scopeKey === scopeKey ? held.value : null;
  useEffect(() => store.keepOnly(scopeKey), [scopeKey, store]);
  const setFor = useCallback(
    (pluginId: string, data: JsonValue | null) =>
      store.set(scopeKey, pluginId, data),
    [scopeKey, store],
  );
  return { current, setFor, clear: store.clear };
}
