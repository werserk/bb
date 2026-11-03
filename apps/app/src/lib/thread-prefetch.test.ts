import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadWithIncludesResponse } from "@bb/server-contract";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  threadDetailBootstrapQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import {
  makeThreadResponse,
  makeThreadTimelineResponse,
} from "@/test/fixtures/thread-responses";
import {
  createThreadPrefetch,
  THREAD_PREFETCH_MAX_PER_WINDOW,
  THREAD_PREFETCH_WINDOW_MS,
} from "./thread-prefetch";

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: {
      get: vi.fn(),
      timeline: vi.fn(),
      markRead: vi.fn(),
      markUnread: vi.fn(),
      update: vi.fn(),
    },
  },
}));

function threadWithIncludes(id: string): ThreadWithIncludesResponse {
  return {
    ...makeThreadResponse({
      id,
      projectId: "project-1",
      environmentId: null,
      title: id,
      titleFallback: id,
      latestAttentionAt: 1,
      createdAt: 1,
      updatedAt: 1,
    }),
    environment: null,
    host: null,
  };
}

interface FakeEnvironment {
  now: number;
  hidden: boolean;
  saveData: boolean;
}

function setup() {
  const { queryClient } = createQueryClientTestHarness();
  const env: FakeEnvironment = { now: 1_000_000, hidden: false, saveData: false };
  const prefetch = createThreadPrefetch(queryClient, {
    now: () => env.now,
    isDocumentHidden: () => env.hidden,
    isDataSaverOn: () => env.saveData,
  });
  return { queryClient, env, prefetch };
}


beforeEach(() => {
  vi.mocked(sdk.threads.get).mockImplementation(async ({ threadId }) =>
    threadWithIncludes(threadId),
  );
  vi.mocked(sdk.threads.timeline).mockResolvedValue(
    makeThreadTimelineResponse({
      timelinePage: {
        returnedSegmentCount: 0,
        olderCursor: null,
        historySnapshot: "snapshot-1",
        olderRowsSourceSeqEnd: null,
      },
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createThreadPrefetch", () => {
  it("loads the bootstrap and the first timeline page into the cache", async () => {
    const { queryClient, prefetch } = setup();
    prefetch("thr_a");
    await vi.waitFor(() => {
      expect(
        queryClient.getQueryData(threadDetailBootstrapQueryKey("thr_a")),
      ).toBeDefined();
      expect(
        queryClient.getQueryData(threadTimelineQueryKey("thr_a")),
      ).toBeDefined();
    });
    expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    expect(sdk.threads.timeline).toHaveBeenCalledTimes(1);
  });

  it("has no side effects beyond the two reads: no read marking, no mutation", async () => {
    const { queryClient, prefetch } = setup();
    prefetch("thr_a");
    await vi.waitFor(() => {
      expect(
        queryClient.getQueryData(threadDetailBootstrapQueryKey("thr_a")),
      ).toBeDefined();
    });
    expect(sdk.threads.markRead).not.toHaveBeenCalled();
    expect(sdk.threads.markUnread).not.toHaveBeenCalled();
    expect(sdk.threads.update).not.toHaveBeenCalled();
    expect(queryClient.isMutating()).toBe(0);
  });

  it("skips a thread whose bootstrap is cached and fresh", async () => {
    const { queryClient, env, prefetch } = setup();
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thr_a"),
      threadWithIncludes("thr_a"),
      { updatedAt: env.now - 1_000 },
    );
    prefetch("thr_a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("refetches a cached bootstrap that went stale", async () => {
    const { queryClient, env, prefetch } = setup();
    queryClient.setQueryData(
      threadDetailBootstrapQueryKey("thr_a"),
      threadWithIncludes("thr_a"),
      { updatedAt: env.now - 60_000 },
    );
    prefetch("thr_a");
    await vi.waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    });
  });

  it("skips a thread already loading, and allows only one prefetch in flight", async () => {
    let release: (() => void) | undefined;
    vi.mocked(sdk.threads.get).mockImplementation(
      ({ threadId }) =>
        new Promise((resolve) => {
          release = () => resolve(threadWithIncludes(threadId));
        }),
    );
    const { prefetch } = setup();
    prefetch("thr_a");
    prefetch("thr_a");
    prefetch("thr_b");
    await vi.waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    });
    release?.();
    await vi.waitFor(() => {
      prefetch("thr_b");
      expect(sdk.threads.get).toHaveBeenCalledTimes(2);
    });
  });

  it("drops the fifth distinct thread inside the window and admits it after", async () => {
    const { queryClient, env, prefetch } = setup();
    const ids = ["thr_1", "thr_2", "thr_3", "thr_4", "thr_5"];
    for (const id of ids.slice(0, THREAD_PREFETCH_MAX_PER_WINDOW)) {
      prefetch(id);
      await vi.waitFor(() => {
        expect(
          queryClient.getQueryData(threadDetailBootstrapQueryKey(id)),
        ).toBeDefined();
      });
      env.now += 100;
    }
    prefetch("thr_5");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdk.threads.get).toHaveBeenCalledTimes(THREAD_PREFETCH_MAX_PER_WINDOW);

    env.now += THREAD_PREFETCH_WINDOW_MS;
    prefetch("thr_5");
    await vi.waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(
        THREAD_PREFETCH_MAX_PER_WINDOW + 1,
      );
    });
  });

  it("does nothing while the document is hidden", async () => {
    const { env, prefetch } = setup();
    env.hidden = true;
    prefetch("thr_a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdk.threads.get).not.toHaveBeenCalled();
    expect(sdk.threads.timeline).not.toHaveBeenCalled();
  });

  it("does nothing when the user asked for reduced data", async () => {
    const { env, prefetch } = setup();
    env.saveData = true;
    prefetch("thr_a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdk.threads.get).not.toHaveBeenCalled();
  });

  it("ignores an empty id and survives a failed read", async () => {
    vi.mocked(sdk.threads.get).mockRejectedValue(new Error("offline"));
    const { prefetch } = setup();
    prefetch("");
    expect(sdk.threads.get).not.toHaveBeenCalled();
    prefetch("thr_a");
    await vi.waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    prefetch("thr_b");
    await vi.waitFor(() => {
      expect(sdk.threads.get).toHaveBeenCalledTimes(2);
    });
  });
});
