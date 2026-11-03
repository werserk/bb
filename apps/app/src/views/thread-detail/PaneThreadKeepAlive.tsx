import { Activity, useRef, useState, useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { THREAD_QUERY_KEY } from "@/hooks/queries/query-keys";
import {
  canRetainCachedThread,
  initialPaneRetention,
  reconcilePaneRetention,
} from "./pane-thread-retention";
import { LazyThreadDetailView as ThreadDetailView } from "./LazyThreadDetailView";

interface PaneThreadKeepAliveProps {
  projectId: string;
  threadId: string;
  timelineEnabled: boolean;
}

function useHiddenThreadCacheRevision(
  queryClient: QueryClient,
  hiddenThreadIds: ReadonlySet<string>,
): number {
  const hiddenRef = useRef(hiddenThreadIds);
  hiddenRef.current = hiddenThreadIds;
  const revisionRef = useRef(0);
  const subscribe = (notify: () => void) =>
    queryClient.getQueryCache().subscribe((event) => {
      const queryKey = event.query.queryKey;
      if (
        queryKey[0] === THREAD_QUERY_KEY &&
        typeof queryKey[1] === "string" &&
        hiddenRef.current.has(queryKey[1])
      ) {
        revisionRef.current += 1;
        notify();
      }
    });
  return useSyncExternalStore(
    subscribe,
    () => revisionRef.current,
    () => 0,
  );
}

export function PaneThreadKeepAlive({
  projectId,
  threadId,
  timelineEnabled,
}: PaneThreadKeepAliveProps) {
  const queryClient = useQueryClient();
  const [state, setState] = useState(() =>
    initialPaneRetention({ projectId, threadId }),
  );
  const next = reconcilePaneRetention(
    state,
    { projectId, threadId },
    (candidateId, options) =>
      canRetainCachedThread(queryClient, candidateId, options),
  );
  if (next !== state) {
    setState(next);
  }
  const hiddenThreadIds = new Set(
    next.slots
      .filter((slot) => slot.threadId !== threadId)
      .map((slot) => slot.threadId),
  );
  useHiddenThreadCacheRevision(queryClient, hiddenThreadIds);
  return (
    <>
      {next.slots.map((slot) => {
        const visible = slot.threadId === threadId;
        return (
          <Activity key={slot.threadId} mode={visible ? "visible" : "hidden"}>
            <ThreadDetailView
              surface="pane"
              projectId={slot.projectId}
              threadId={slot.threadId}
              timelineEnabled={timelineEnabled && visible}
            />
          </Activity>
        );
      })}
    </>
  );
}
