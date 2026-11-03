import {
  Activity,
  memo,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { THREAD_QUERY_KEY } from "@/hooks/queries/query-keys";
import { useSplitWorkspaceActive } from "@/hooks/useSplitWorkspaceActive";
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
  hiddenThreadIds: readonly string[],
): void {
  const [, setRevision] = useState(0);
  const hiddenKey = hiddenThreadIds.join("\n");
  useEffect(() => {
    if (hiddenKey === "") {
      return;
    }
    const hidden = new Set(hiddenKey.split("\n"));
    return queryClient.getQueryCache().subscribe((event) => {
      const queryKey = event.query.queryKey;
      if (
        queryKey[0] === THREAD_QUERY_KEY &&
        typeof queryKey[1] === "string" &&
        hidden.has(queryKey[1])
      ) {
        setRevision((revision) => revision + 1);
      }
    });
  }, [queryClient, hiddenKey]);
}

const RetainedThreadView = memo(function RetainedThreadView({
  projectId,
  threadId,
  timelineEnabled,
}: PaneThreadKeepAliveProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    return () => {
      for (const media of root?.querySelectorAll<HTMLMediaElement>(
        "audio, video",
      ) ?? []) {
        media.pause();
      }
    };
  }, []);
  return (
    <div ref={rootRef} className="contents">
      <ThreadDetailView
        surface="pane"
        projectId={projectId}
        threadId={threadId}
        timelineEnabled={timelineEnabled}
      />
    </div>
  );
});

function RetainingPane({
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
  useHiddenThreadCacheRevision(
    queryClient,
    next.slots
      .filter((slot) => slot.threadId !== threadId)
      .map((slot) => slot.threadId),
  );
  return (
    <>
      {next.slots.map((slot) => {
        const visible = slot.threadId === threadId;
        return (
          <Activity key={slot.threadId} mode={visible ? "visible" : "hidden"}>
            <RetainedThreadView
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

export function PaneThreadKeepAlive(props: PaneThreadKeepAliveProps) {
  const splitWorkspaceActive = useSplitWorkspaceActive();
  if (!splitWorkspaceActive) {
    return <ThreadDetailView surface="pane" {...props} />;
  }
  return <RetainingPane {...props} />;
}
