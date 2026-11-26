import type { QueryClient } from "@tanstack/react-query";
import type { LoadedTimelineState } from "@bb/client-core";

const MAX_RETAINED_LOADED_TIMELINES = 8;
const retainedLoadedTimelines = new WeakMap<
  QueryClient,
  Map<string, LoadedTimelineState>
>();

export function retainedLoadedTimeline(
  queryClient: QueryClient,
  surfaceKey: string,
): LoadedTimelineState | undefined {
  return retainedLoadedTimelines.get(queryClient)?.get(surfaceKey);
}

export function retainLoadedTimeline(
  queryClient: QueryClient,
  loaded: LoadedTimelineState,
): void {
  let retained = retainedLoadedTimelines.get(queryClient);
  if (retained === undefined) {
    retained = new Map();
    retainedLoadedTimelines.set(queryClient, retained);
  }
  retained.delete(loaded.surfaceKey);
  retained.set(loaded.surfaceKey, loaded);
  while (retained.size > MAX_RETAINED_LOADED_TIMELINES) {
    const oldest = retained.keys().next().value;
    if (oldest === undefined) break;
    retained.delete(oldest);
  }
}

export function retainedLoadedRowCount(
  queryClient: QueryClient,
  threadId: string,
): number {
  let count = 0;
  for (const [surfaceKey, loaded] of retainedLoadedTimelines.get(queryClient) ??
    []) {
    if (surfaceKey === threadId || surfaceKey.startsWith(`${threadId}:`)) {
      count = Math.max(count, loaded.rows.length);
    }
  }
  return count;
}
