import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { fetchWithAppSurface, withFetchPriority } from "./app-surface";
import {
  bindNavigationWindowQueryClient,
  closeNavigationWindow,
  openNavigationWindow,
} from "./navigation-window";

describe("fetchWithAppSurface priority", () => {
  const fetchMock = vi.fn();
  let unbind: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    unbind = bindNavigationWindowQueryClient(new QueryClient());
  });

  afterEach(() => {
    closeNavigationWindow();
    unbind();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sent = () => fetchMock.mock.calls.map(([url]) => String(url));

  it("sends a high-priority tagged request at once and with the hint", async () => {
    openNavigationWindow("t1");
    const signal = withFetchPriority(new AbortController().signal, "high");
    await fetchWithAppSurface("/high", { signal });
    expect(sent()).toEqual(["/high"]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ priority: "high" });
  });

  it("holds a low-priority tagged request until the window closes", async () => {
    openNavigationWindow("t1");
    const signal = withFetchPriority(new AbortController().signal, "low");
    const pending = fetchWithAppSurface("/low", { signal });
    await vi.advanceTimersByTimeAsync(500);
    expect(sent()).toEqual([]);
    closeNavigationWindow();
    await pending;
    expect(sent()).toEqual(["/low"]);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ priority: "low" });
  });

  it("releases a held low-priority request after the cap", async () => {
    openNavigationWindow("t1");
    const pending = fetchWithAppSurface("/low", { priority: "low" });
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(sent()).toEqual(["/low"]);
  });

  it("does not hold low priority requests while no window is open", async () => {
    await fetchWithAppSurface("/low", { priority: "low" });
    expect(sent()).toEqual(["/low"]);
  });

  it("does not hold or tag untagged requests", async () => {
    openNavigationWindow("t1");
    await fetchWithAppSurface("/plain");
    expect(sent()).toEqual(["/plain"]);
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("priority");
  });
});

describe("priority through the SDK client", () => {
  afterEach(() => {
    closeNavigationWindow();
    vi.unstubAllGlobals();
  });

  it("carries the signal tag from sdk.threads.get to the fetch hint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { sdk } = await import("./sdk");
    const signal = withFetchPriority(new AbortController().signal, "high");
    await sdk.threads.get({ threadId: "t1", signal }).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ priority: "high" });
  });
});
