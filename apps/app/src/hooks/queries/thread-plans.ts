import { useEffect, useRef, useSyncExternalStore } from "react";
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
  if (!ids.length) return;
  if (!detach) {
    const detachChanged = wsManager.onChanged((event) => {
      if (event.entity !== "thread") return;
      const affected = event.id
        ? consumers.has(event.id)
          ? [event.id]
          : []
        : [...consumers.keys()];
      if (affected.length) void threadPlanCache.refresh(affected);
    });
    const detachConnected = wsManager.onConnected(() => {
      if (consumers.size) void threadPlanCache.refresh([...consumers.keys()]);
    });
    detach = () => {
      detachChanged();
      detachConnected();
    };
  }
  const fresh = ids.filter((id) => !consumers.has(id));
  for (const id of ids) {
    if (!consumers.has(id))
      wsManager.subscribe({ kind: "thread-detail", threadId: id });
    consumers.set(id, (consumers.get(id) ?? 0) + 1);
  }
  threadPlanCache.setSubscribedThreadIds([...consumers.keys()]);
  if (fresh.length) void threadPlanCache.refresh(fresh);
  else threadPlanCache.ensure(ids);
}
function release(ids: readonly string[]) {
  for (const id of ids) {
    const count = (consumers.get(id) ?? 1) - 1;
    if (count) consumers.set(id, count);
    else {
      consumers.delete(id);
      wsManager.unsubscribe({ kind: "thread-detail", threadId: id });
    }
  }
  threadPlanCache.setSubscribedThreadIds([...consumers.keys()]);
  if (!consumers.size) {
    detach?.();
    detach = null;
  }
}
export function useThreadPlans({
  threadIds,
}: {
  threadIds: readonly string[];
}): ThreadPlansResult {
  const snapshot = useSyncExternalStore(
    threadPlanCache.subscribe,
    threadPlanCache.snapshot,
    threadPlanCache.snapshot,
  );
  const key = JSON.stringify([...new Set(threadIds)]);
  const retained = useRef<readonly string[]>([]);
  useEffect(() => {
    const next: string[] = JSON.parse(key);
    release(retained.current.filter((id) => !next.includes(id)));
    retain(next.filter((id) => !retained.current.includes(id)));
    retained.current = next;
  }, [key]);
  useEffect(
    () => () => {
      release(retained.current);
      retained.current = [];
    },
    [],
  );
  const ids: string[] = JSON.parse(key);
  const loaded = ids.filter(
    (id) =>
      snapshot.loadedThreadIds.includes(id) &&
      snapshot.subscribedThreadIds.includes(id),
  );
  const errors = Object.fromEntries(
    ids.flatMap((id) =>
      snapshot.errors[id] ? [[id, snapshot.errors[id]!]] : [],
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
    plans: snapshot.plans,
    errors,
    refresh: (ids) => threadPlanCache.refresh(ids ?? JSON.parse(key)),
  };
}
