import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  threadDetailBootstrapQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import {
  NAVIGATION_WINDOW_MAX_MS,
  bindNavigationWindowQueryClient,
  closeNavigationWindow,
  isNavigationWindowOpen,
  openNavigationWindow,
  subscribeNavigationWindow,
  waitForNavigationSettled,
} from "./navigation-window";

const timeline = (rowCount: number) => ({ rows: new Array(rowCount).fill({}) });

describe("navigation window", () => {
  let queryClient: QueryClient;
  let unbind: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient();
    unbind = bindNavigationWindowQueryClient(queryClient);
  });

  afterEach(() => {
    unbind();
    vi.useRealTimers();
  });

  it("opens on navigation and closes when the target timeline has rows", async () => {
    const onChange = vi.fn();
    const stop = subscribeNavigationWindow(onChange);
    openNavigationWindow("t1");
    expect(isNavigationWindowOpen()).toBe(true);
    const released = vi.fn();
    void waitForNavigationSettled().then(released);

    queryClient.setQueryData(threadTimelineQueryKey("other"), timeline(3));
    await vi.advanceTimersByTimeAsync(0);
    expect(isNavigationWindowOpen()).toBe(true);

    queryClient.setQueryData(threadTimelineQueryKey("t1"), timeline(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(isNavigationWindowOpen()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledTimes(2);
    stop();
  });

  it("closes on an empty timeline too, so an empty thread does not hold background reads", async () => {
    openNavigationWindow("t1");
    queryClient.setQueryData(threadTimelineQueryKey("t1"), timeline(0));
    await vi.advanceTimersByTimeAsync(0);
    expect(isNavigationWindowOpen()).toBe(false);
  });

  it("closes after the cap when the target never paints", async () => {
    openNavigationWindow("t1");
    const released = vi.fn();
    void waitForNavigationSettled().then(released);
    await vi.advanceTimersByTimeAsync(NAVIGATION_WINDOW_MAX_MS - 1);
    expect(isNavigationWindowOpen()).toBe(true);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(isNavigationWindowOpen()).toBe(false);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("closes when the target bootstrap fails", async () => {
    openNavigationWindow("t1");
    await queryClient
      .fetchQuery({
        queryKey: threadDetailBootstrapQueryKey("t1"),
        queryFn: () => Promise.reject(new Error("boom")),
        retry: false,
      })
      .catch(() => undefined);
    expect(isNavigationWindowOpen()).toBe(false);
  });

  it("does not open for a target whose timeline is already loaded", () => {
    queryClient.setQueryData(threadTimelineQueryKey("t1"), timeline(4));
    openNavigationWindow("t1");
    expect(isNavigationWindowOpen()).toBe(false);
  });

  it("retargets and restarts the cap on a nested navigation", async () => {
    openNavigationWindow("t1");
    await vi.advanceTimersByTimeAsync(700);
    openNavigationWindow("t2");
    await vi.advanceTimersByTimeAsync(700);
    expect(isNavigationWindowOpen()).toBe(true);

    queryClient.setQueryData(threadTimelineQueryKey("t1"), timeline(2));
    expect(isNavigationWindowOpen()).toBe(true);

    queryClient.setQueryData(threadTimelineQueryKey("t2"), timeline(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(isNavigationWindowOpen()).toBe(false);
  });

  it("caps a waiter at one second even when the window is retargeted", async () => {
    openNavigationWindow("t1");
    const released = vi.fn();
    void waitForNavigationSettled().then(released);
    await vi.advanceTimersByTimeAsync(600);
    openNavigationWindow("t2");
    await vi.advanceTimersByTimeAsync(NAVIGATION_WINDOW_MAX_MS - 600);
    expect(released).toHaveBeenCalledTimes(1);
    expect(isNavigationWindowOpen()).toBe(true);
    closeNavigationWindow();
  });

  it("resolves at once when closed and opens nothing when unbound", async () => {
    await expect(waitForNavigationSettled()).resolves.toBeUndefined();
    unbind();
    openNavigationWindow("t1");
    expect(isNavigationWindowOpen()).toBe(false);
  });
});
