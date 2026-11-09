import { useEffect, useSyncExternalStore } from "react";
import type { ThreadPlansResult } from "@get-bb/plugin-sdk";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { ThreadPlanCache } from "@/lib/thread-plan-cache";
export const threadPlanCache = new ThreadPlanCache((threadIds) =>
  sdk.threads.plans({ threadIds }),
);
const consumers = new Map<string, number>();
let detach: (() => void) | null = null;
function retain(ids: readonly string[]) {
  if (!detach)
    detach = wsManager.onChanged((event) => {
      if (event.entity !== "thread") return;
      const affected = event.id
        ? consumers.has(event.id)
          ? [event.id]
          : []
        : [...consumers.keys()];
      if (affected.length) void threadPlanCache.refresh(affected);
    });
  for (const id of ids) {
    if (!consumers.has(id))
      wsManager.subscribe({ kind: "thread-detail", threadId: id });
    consumers.set(id, (consumers.get(id) ?? 0) + 1);
  }
  threadPlanCache.ensure(ids);
  return () => {
    for (const id of ids) {
      const count = (consumers.get(id) ?? 1) - 1;
      if (count) consumers.set(id, count);
      else {
        consumers.delete(id);
        wsManager.unsubscribe({ kind: "thread-detail", threadId: id });
      }
    }
    if (!consumers.size) {
      detach?.();
      detach = null;
    }
  };
}
export function useThreadPlans({
  threadIds,
}: {
  threadIds: readonly string[];
}): ThreadPlansResult {
  useSyncExternalStore(
    threadPlanCache.subscribe,
    threadPlanCache.snapshot,
    threadPlanCache.snapshot,
  );
  const key = JSON.stringify([...new Set(threadIds)]);
  useEffect(() => retain(JSON.parse(key)), [key]);
  const ids: string[] = JSON.parse(key);
  const loaded = threadPlanCache.loaded(ids);
  const errors = Object.fromEntries(
    ids.flatMap((id) =>
      threadPlanCache.errors[id] ? [[id, threadPlanCache.errors[id]!]] : [],
    ),
  );
  return {
    status: Object.keys(errors).length
      ? "error"
      : loaded.length === ids.length
        ? "ready"
        : "loading",
    requestedThreadIds: ids,
    loadedThreadIds: loaded,
    plans: threadPlanCache.plans,
    errors,
    refresh: (ids) => threadPlanCache.refresh(ids ?? JSON.parse(key)),
  };
}
