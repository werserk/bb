// @vitest-environment jsdom

import { LazyMarkdownHtml } from "@/components/ui/lazy-markdown-html";
import { cleanup, render, screen } from "@testing-library/react";
import type { ThreadListEntry } from "@bb/domain";
import type { TimelineOwnerPostRow } from "@bb/thread-view";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { RouteNavigationProvider } from "@/components/ui/app-route-anchor";
import { ThreadTitleMentionResourcesProvider } from "@/components/thread/ThreadTitleMentions";
import {
  THREAD_CARD_STATUS_LABELS,
  threadCardStatus,
  type ThreadCardStatus,
} from "@/components/thread/ThreadMentionCard";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import { OwnerPostRow } from "./OwnerPostRow";

const sidebarThreads = vi.hoisted(() => ({
  entries: new Map<string, unknown>(),
}));

vi.mock("@/hooks/queries/sidebar-navigation-query", () => ({
  useSidebarNavigationThreadSelection: (
    select: (threads: unknown[]) => unknown,
  ) => ({ data: select([...sidebarThreads.entries.values()]) }),
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useThread: () => ({ data: undefined }),
}));

beforeAll(() => LazyMarkdownHtml.preload());

afterEach(() => {
  cleanup();
  sidebarThreads.entries.clear();
});

function thread(overrides: Partial<ThreadListEntry>): ThreadListEntry {
  return makeThreadListEntry({
    projectId: "proj_1",
    titleFallback: "Thread",
    ...overrides,
  });
}

function postRow(
  text: string,
  status: TimelineOwnerPostRow["status"] = "completed",
): TimelineOwnerPostRow {
  return {
    id: "post-1",
    threadId: "thr_coordinator",
    turnId: "turn-1",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    kind: "work",
    workKind: "tool",
    status,
    callId: "call-1",
    toolName: "post_to_owner",
    toolArgs: { text },
    output: "",
    completedAt: status === "pending" ? null : 2,
    approvalStatus: null,
    presentation: {
      label: { pending: "Posting", completed: "Posted" },
      icon: { glyph: "Zap" },
      ownerPost: true,
    },
  };
}

function renderPost(row: TimelineOwnerPostRow) {
  const { wrapper: QueryWrapper } = createQueryClientTestHarness();
  return render(
    <QueryWrapper>
      <MemoryRouter>
        <RouteNavigationProvider>
          <ThreadTitleMentionResourcesProvider
            sectionNamesById={new Map()}
            projectNamesById={new Map()}
            threadById={new Map()}
          >
            <OwnerPostRow
              onOpenLink={undefined}
              onOpenLocalFileLink={undefined}
              projectId="proj_1"
              row={row}
              workspaceRootPath={undefined}
            />
          </ThreadTitleMentionResourcesProvider>
        </RouteNavigationProvider>
      </MemoryRouter>
    </QueryWrapper>,
  );
}

describe("threadCardStatus", () => {
  it.each([
    [
      "archived",
      { archivedAt: 1, hasPendingInteraction: true, status: "error" },
    ],
    [
      "waiting",
      { archivedAt: null, hasPendingInteraction: true, status: "active" },
    ],
    [
      "error",
      { archivedAt: null, hasPendingInteraction: false, status: "error" },
    ],
    [
      "running",
      { archivedAt: null, hasPendingInteraction: false, status: "active" },
    ],
    [
      "running",
      { archivedAt: null, hasPendingInteraction: false, status: "starting" },
    ],
    [
      "idle",
      { archivedAt: null, hasPendingInteraction: false, status: "idle" },
    ],
  ] as const satisfies readonly [
    ThreadCardStatus,
    {
      archivedAt: number | null;
      hasPendingInteraction: boolean;
      status: ThreadListEntry["runtime"]["displayStatus"];
    },
  ][])("derives %s from the core thread state", (expected, state) => {
    expect(
      threadCardStatus({
        archivedAt: state.archivedAt,
        hasPendingInteraction: state.hasPendingInteraction,
        runtime: { displayStatus: state.status },
      }),
    ).toBe(expected);
  });
});

describe("OwnerPostRow", () => {
  it("renders the post as Markdown with a Posted marker", () => {
    const { container } = renderPost(
      postRow("## Morning report\n\nAll **4** builders are done."),
    );

    expect(
      screen.getByRole("heading", { name: "Morning report" }),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("4");
    expect(screen.getByText("Posted")).toBeTruthy();
    expect(
      container
        .querySelector("[data-owner-post]")
        ?.getAttribute("data-owner-post"),
    ).toBe("completed");
  });

  it("marks a pending post as Posting", () => {
    const { container } = renderPost(postRow("Working on it", "pending"));

    expect(screen.getByText("Posting")).toBeTruthy();
    expect(
      container
        .querySelector("[data-owner-post]")
        ?.getAttribute("data-owner-post"),
    ).toBe("pending");
  });

  it("renders thread mentions as live cards with the core status", () => {
    sidebarThreads.entries.set(
      "thr_running",
      thread({
        id: "thr_running",
        title: "Fix the flaky test",
        runtime: { displayStatus: "active" },
      }),
    );
    sidebarThreads.entries.set(
      "thr_waiting",
      thread({
        id: "thr_waiting",
        title: "Pick a database",
        hasPendingInteraction: true,
      }),
    );
    sidebarThreads.entries.set(
      "thr_long",
      thread({
        id: "thr_long",
        title: `Investigate ${"the very long thread title ".repeat(12)}`,
        runtime: { displayStatus: "error" },
      }),
    );
    const { container } = renderPost(
      postRow(
        "Done: @thread:thr_running\n\nNeeds you: @thread:thr_waiting\n\nFailed: @thread:thr_long\n\nGone: @thread:thr_missing",
      ),
    );

    const cards = Array.from(
      container.querySelectorAll<HTMLElement>("[data-thread-card-status]"),
    );
    expect(
      cards.map((card) => card.getAttribute("data-thread-card-status")),
    ).toEqual(["running", "waiting", "error", "unknown"]);
    expect(cards[0]?.textContent).toContain("Fix the flaky test");
    expect(cards[0]?.textContent).toContain(THREAD_CARD_STATUS_LABELS.running);
    expect(cards[1]?.textContent).toContain(THREAD_CARD_STATUS_LABELS.waiting);
    expect(cards[2]?.querySelector(".truncate")).toBeTruthy();
    expect(cards[0]?.getAttribute("href")).toBe(
      "/projects/proj_1/threads/thr_running",
    );
  });
});
