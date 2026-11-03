// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { CompactViewportOverrideProvider } from "@bb/shared-ui/hooks/use-compact-viewport";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  threadQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { retainLoadedTimeline } from "@/components/thread/timeline/retained-loaded-timelines";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { PaneThreadKeepAlive } from "./PaneThreadKeepAlive";

const viewLog = vi.hoisted(() => ({
  mounts: [] as string[],
  unmounts: [] as string[],
  effectsLive: new Set<string>(),
  timelineEnabled: new Map<string, boolean>(),
}));

vi.mock("./LazyThreadDetailView", () => ({
  LazyThreadDetailView: ({
    threadId,
    timelineEnabled,
  }: {
    threadId: string;
    timelineEnabled: boolean;
  }) => {
    viewLog.timelineEnabled.set(threadId, timelineEnabled);
    useEffect(() => {
      viewLog.mounts.push(threadId);
      viewLog.effectsLive.add(threadId);
      return () => {
        viewLog.unmounts.push(threadId);
        viewLog.effectsLive.delete(threadId);
      };
    }, [threadId]);
    return (
      <section data-testid={`view-${threadId}`}>
        <audio data-testid={`audio-${threadId}`} />
      </section>
    );
  },
}));

const PROJECT = "p";

function seedThread(
  queryClient: ReturnType<typeof createQueryClientTestHarness>["queryClient"],
  threadId: string,
  archivedAt: number | null = null,
) {
  queryClient.setQueryData(
    threadQueryKey(threadId),
    makeThreadResponse({ id: threadId, archivedAt }),
  );
}

function setup() {
  const { queryClient, wrapper } = createQueryClientTestHarness();
  for (const id of ["a", "b", "c"]) {
    seedThread(queryClient, id);
  }
  const view = render(
    <PaneThreadKeepAlive projectId={PROJECT} threadId="a" timelineEnabled />,
    { wrapper },
  );
  const show = (threadId: string, timelineEnabled = true) =>
    view.rerender(
      <PaneThreadKeepAlive
        projectId={PROJECT}
        threadId={threadId}
        timelineEnabled={timelineEnabled}
      />,
    );
  const isHidden = (threadId: string) => {
    const node = view.queryByTestId(`view-${threadId}`);
    return node === null
      ? null
      : node.closest("[style*='display: none']") !== null;
  };
  return { queryClient, show, isHidden, view };
}

describe("PaneThreadKeepAlive", () => {
  beforeEach(() => {
    viewLog.mounts.length = 0;
    viewLog.unmounts.length = 0;
    viewLog.effectsLive.clear();
    viewLog.timelineEnabled.clear();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps the thread it left mounted but hidden, with effects off", () => {
    const { show, isHidden, view } = setup();
    const nodeA = view.getByTestId("view-a");
    show("b");
    expect(view.getByTestId("view-a")).toBe(nodeA);
    expect(isHidden("a")).toBe(true);
    expect(isHidden("b")).toBe(false);
    expect([...viewLog.effectsLive]).toEqual(["b"]);
  });

  it("reuses the same DOM node when switching back", () => {
    const { show, isHidden, view } = setup();
    const nodeA = view.getByTestId("view-a");
    show("b");
    show("a");
    expect(view.getByTestId("view-a")).toBe(nodeA);
    expect(isHidden("a")).toBe(false);
    expect(isHidden("b")).toBe(true);
    expect([...viewLog.effectsLive]).toEqual(["a"]);
  });

  it("disables the timeline of the hidden view only", () => {
    const { show } = setup();
    show("b");
    expect(viewLog.timelineEnabled.get("a")).toBe(false);
    expect(viewLog.timelineEnabled.get("b")).toBe(true);
    show("b", false);
    expect(viewLog.timelineEnabled.get("b")).toBe(false);
  });

  it("retains at most two views, evicting the older hidden one", () => {
    const { show, view } = setup();
    show("b");
    show("c");
    expect(view.queryByTestId("view-a")).toBeNull();
    expect(view.getByTestId("view-b")).toBeTruthy();
    expect(view.getByTestId("view-c")).toBeTruthy();
    expect(viewLog.unmounts).toContain("a");
  });

  it("does not retain a thread archived while it was open", () => {
    const { queryClient, show, view } = setup();
    seedThread(queryClient, "a", Date.now());
    show("b");
    expect(view.queryByTestId("view-a")).toBeNull();
  });

  it("drops a hidden view whose thread was archived in the meantime", () => {
    const { queryClient, show, view } = setup();
    show("b");
    expect(view.queryByTestId("view-a")).not.toBeNull();
    act(() => {
      seedThread(queryClient, "a", Date.now());
    });
    expect(view.queryByTestId("view-a")).toBeNull();
    expect(viewLog.unmounts).toContain("a");
  });

  it("drops a hidden view whose thread query was removed", () => {
    const { queryClient, show, view } = setup();
    show("b");
    act(() => {
      queryClient.removeQueries({ queryKey: threadQueryKey("a") });
    });
    expect(view.queryByTestId("view-a")).toBeNull();
  });

  it("does not retain a thread over the timeline row cap", () => {
    const { queryClient, show, view } = setup();
    queryClient.setQueryData(threadTimelineQueryKey("a"), {
      rows: Array.from({ length: 2001 }, (_, index) => ({ id: index })),
    });
    show("b");
    expect(view.queryByTestId("view-a")).toBeNull();
  });

  it("keeps a thread at the timeline row cap", () => {
    const { queryClient, show, view } = setup();
    queryClient.setQueryData(threadTimelineQueryKey("a"), {
      rows: Array.from({ length: 2000 }, (_, index) => ({ id: index })),
    });
    show("b");
    expect(view.queryByTestId("view-a")).not.toBeNull();
  });

  it("pauses media of a view when it is hidden", () => {
    const { show, view } = setup();
    const audio = view.getByTestId("audio-a") as HTMLAudioElement;
    const pause = vi.spyOn(audio, "pause");
    show("b");
    expect(pause).toHaveBeenCalled();
  });

  it("does not retain a thread whose loaded pages are over the row cap", () => {
    const { queryClient, show, view } = setup();
    queryClient.setQueryData(threadTimelineQueryKey("a"), { rows: [] });
    retainLoadedTimeline(queryClient, {
      historySnapshot: null,
      latestWindowEndSequence: null,
      olderCursor: null,
      rows: Array.from({ length: 2001 }, (_, index) => ({ id: index })),
      surfaceKey: "a",
    } as never);
    show("b");
    expect(view.queryByTestId("view-a")).toBeNull();
  });

  it("retains nothing on a compact viewport", () => {
    const { queryClient, wrapper: Providers } = createQueryClientTestHarness();
    seedThread(queryClient, "a");
    seedThread(queryClient, "b");
    const tree = (threadId: string) => (
      <CompactViewportOverrideProvider isCompactViewport>
        <PaneThreadKeepAlive
          projectId={PROJECT}
          threadId={threadId}
          timelineEnabled
        />
      </CompactViewportOverrideProvider>
    );
    const view = render(tree("a"), { wrapper: Providers });
    view.rerender(tree("b"));
    expect(view.queryByTestId("view-a")).toBeNull();
    expect(view.getByTestId("view-b")).toBeTruthy();
  });
});
