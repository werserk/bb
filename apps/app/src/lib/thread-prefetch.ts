import type { QueryClient } from "@tanstack/react-query";
import { threadDetailBootstrapQueryKey } from "@/hooks/queries/query-keys";
import {
  THREAD_DETAIL_STALE_TIME_MS,
  threadDetailBootstrapQueryOptions,
} from "@/hooks/queries/thread-queries";
import { appQueryClient } from "./app-query-client";

export const THREAD_PREFETCH_WINDOW_MS = 10_000;
export const THREAD_PREFETCH_MAX_PER_WINDOW = 4;

interface ThreadPrefetchEnvironment {
  now: () => number;
  isDocumentHidden: () => boolean;
  isDataSaverOn: () => boolean;
}

const browserEnvironment: ThreadPrefetchEnvironment = {
  now: () => Date.now(),
  isDocumentHidden: () =>
    typeof document !== "undefined" && document.visibilityState === "hidden",
  isDataSaverOn: () =>
    typeof navigator !== "undefined" &&
    (navigator as { connection?: { saveData?: boolean } }).connection
      ?.saveData === true,
};

export function createThreadPrefetch(
  queryClient: QueryClient,
  environment: ThreadPrefetchEnvironment = browserEnvironment,
): (threadId: string) => void {
  const startedAtByThread = new Map<string, number>();
  let inFlight = false;

  return (threadId) => {
    if (
      threadId === "" ||
      inFlight ||
      environment.isDocumentHidden() ||
      environment.isDataSaverOn()
    ) {
      return;
    }

    const state = queryClient.getQueryState(
      threadDetailBootstrapQueryKey(threadId),
    );
    const now = environment.now();
    if (
      state?.fetchStatus === "fetching" ||
      (state?.dataUpdatedAt !== undefined &&
        state.dataUpdatedAt > 0 &&
        now - state.dataUpdatedAt <= THREAD_DETAIL_STALE_TIME_MS)
    ) {
      return;
    }

    for (const [id, startedAt] of startedAtByThread) {
      if (now - startedAt >= THREAD_PREFETCH_WINDOW_MS) {
        startedAtByThread.delete(id);
      }
    }
    if (
      !startedAtByThread.has(threadId) &&
      startedAtByThread.size >= THREAD_PREFETCH_MAX_PER_WINDOW
    ) {
      return;
    }
    startedAtByThread.set(threadId, now);

    inFlight = true;
    void queryClient
      .prefetchQuery({
        ...threadDetailBootstrapQueryOptions(queryClient, threadId, {
          timelinePrefetch: true,
        }),
        retry: false,
        staleTime: THREAD_DETAIL_STALE_TIME_MS,
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

export const prefetchThread = createThreadPrefetch(appQueryClient);
