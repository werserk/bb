// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  bindNavigationWindowQueryClient,
  closeNavigationWindow,
  openNavigationWindow,
} from "./navigation-window";
import { useNavigationSettled } from "./use-navigation-settled";

describe("useNavigationSettled", () => {
  afterEach(() => {
    closeNavigationWindow();
  });

  it("is false while a navigation window is open and true after it closes", () => {
    const unbind = bindNavigationWindowQueryClient(new QueryClient());
    const { result } = renderHook(() => useNavigationSettled());
    expect(result.current).toBe(true);
    act(() => openNavigationWindow("t1"));
    expect(result.current).toBe(false);
    act(() => closeNavigationWindow());
    expect(result.current).toBe(true);
    unbind();
  });
});
