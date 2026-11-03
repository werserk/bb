// @vitest-environment jsdom

import { focusManager } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAppQueryClient,
  installAppQueryClientBrowserEvents,
} from "./query-client";
import {
  closeNavigationWindow,
  openNavigationWindow,
} from "./navigation-window";

describe("window-focus refetch during a navigation", () => {
  let cleanup: () => void;
  const queryClient = createAppQueryClient({ showMutationErrorToasts: false });

  let unsubscribe: () => void;
  const onFocus = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    onFocus.mockReset();
    unsubscribe = focusManager.subscribe(onFocus);
    focusManager.setFocused(true);
    onFocus.mockReset();
    cleanup = installAppQueryClientBrowserEvents(queryClient).cleanup;
  });

  afterEach(() => {
    closeNavigationWindow();
    cleanup();
    unsubscribe();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("holds the focus refetch until the window closes, then runs it", async () => {
    openNavigationWindow("t1");
    window.dispatchEvent(new Event("pageshow"));
    await vi.advanceTimersByTimeAsync(300);
    expect(onFocus).not.toHaveBeenCalled();
    closeNavigationWindow();
    await vi.advanceTimersByTimeAsync(0);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("does not delay a focus event while no window is open", () => {
    window.dispatchEvent(new Event("pageshow"));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
