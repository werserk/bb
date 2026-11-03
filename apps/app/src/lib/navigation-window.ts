import type { QueryClient } from "@tanstack/react-query";
import type { ThreadTimelineResponse } from "@bb/server-contract";
import {
  threadDetailBootstrapQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";

export const NAVIGATION_WINDOW_MAX_MS = 1000;

interface OpenWindow {
  closeTimer: ReturnType<typeof setTimeout>;
  unsubscribe: () => void;
}

const listeners = new Set<() => void>();
let boundQueryClient: QueryClient | null = null;

export function bindNavigationWindowQueryClient(
  queryClient: QueryClient,
): () => void {
  boundQueryClient = queryClient;
  return () => {
    if (boundQueryClient === queryClient) {
      boundQueryClient = null;
      closeNavigationWindow();
    }
  };
}
const waiters = new Set<() => void>();
let current: OpenWindow | null = null;

function notify(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

function hasFirstContent(queryClient: QueryClient, threadId: string): boolean {
  const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
    threadTimelineQueryKey(threadId),
  );
  return timeline !== undefined && timeline.rows.length > 0;
}

function hasFailed(queryClient: QueryClient, threadId: string): boolean {
  return [
    threadDetailBootstrapQueryKey(threadId),
    threadTimelineQueryKey(threadId),
  ].some((queryKey) => queryClient.getQueryState(queryKey)?.status === "error");
}

export function closeNavigationWindow(): void {
  if (current === null) {
    return;
  }
  clearTimeout(current.closeTimer);
  current.unsubscribe();
  current = null;
  const released = [...waiters];
  waiters.clear();
  for (const release of released) {
    release();
  }
  notify();
}

export function openNavigationWindow(threadId: string): void {
  const queryClient = boundQueryClient;
  if (queryClient === null) {
    return;
  }
  if (hasFirstContent(queryClient, threadId)) {
    closeNavigationWindow();
    return;
  }
  const wasOpen = current !== null;
  if (current !== null) {
    clearTimeout(current.closeTimer);
    current.unsubscribe();
  }
  const settle = () => {
    if (
      hasFirstContent(queryClient, threadId) ||
      hasFailed(queryClient, threadId)
    ) {
      closeNavigationWindow();
    }
  };
  current = {
    closeTimer: setTimeout(closeNavigationWindow, NAVIGATION_WINDOW_MAX_MS),
    unsubscribe: queryClient.getQueryCache().subscribe(settle),
  };
  if (!wasOpen) {
    notify();
  }
}

export function isNavigationWindowOpen(): boolean {
  return current !== null;
}

export function subscribeNavigationWindow(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function waitForNavigationSettled(): Promise<void> {
  if (current === null) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(release, NAVIGATION_WINDOW_MAX_MS);
    function release(): void {
      clearTimeout(timer);
      waiters.delete(release);
      resolve();
    }
    waiters.add(release);
  });
}
