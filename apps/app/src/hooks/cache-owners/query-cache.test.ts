import type { QueryKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import {
  ARCHIVED_THREADS_LIST_KIND,
  THREADS_QUERY_KEY,
  archivedThreadsListQueryKey,
  threadListQueryKey,
} from "../queries/query-keys";
import { PERSONAL_PROJECT_ID, type ThreadListEntry } from "@bb/domain";
import {
  makeProjectWithThreadsResponse,
  makeSidebarBootstrapResponse,
} from "@/test/fixtures/projects";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import {
  getCachedGlobalThreadListInvalidationQueryKeys,
  getCachedProjectThreadListInvalidationQueryKeys,
  listSidebarNavigationThreads,
} from "./query-cache";

describe("query cache thread list invalidation keys", () => {
  it("includes global archived lists in global invalidation", () => {
    const { queryClient } = createQueryClientTestHarness();
    const projectArchivedKey = archivedThreadsListQueryKey({
      projectId: "proj_1",
    });
    const globalArchivedKey = archivedThreadsListQueryKey({});
    const globalChildArchivedKey = archivedThreadsListQueryKey({
      kind: "child",
    });

    queryClient.setQueryData(projectArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(globalArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(globalChildArchivedKey, {
      pages: [],
      pageParams: [],
    });

    const queryKeys = getCachedGlobalThreadListInvalidationQueryKeys({
      queryClient,
    });

    expect(queryKeys).toContainEqual(globalArchivedKey);
    expect(queryKeys).toContainEqual(globalChildArchivedKey);
    expect(queryKeys).not.toContainEqual(projectArchivedKey);
  });

  it("excludes archived list keys with unsupported scope filters", () => {
    const { queryClient } = createQueryClientTestHarness();
    const sectionArchivedKey: QueryKey = [
      THREADS_QUERY_KEY,
      ARCHIVED_THREADS_LIST_KIND,
      { sectionId: "sec_work" },
    ];
    const unsectionedArchivedKey: QueryKey = [
      THREADS_QUERY_KEY,
      ARCHIVED_THREADS_LIST_KIND,
      { unsectioned: true },
    ];

    queryClient.setQueryData(sectionArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(unsectionedArchivedKey, {
      pages: [],
      pageParams: [],
    });

    const queryKeys = getCachedGlobalThreadListInvalidationQueryKeys({
      queryClient,
    });

    expect(queryKeys).not.toContainEqual(sectionArchivedKey);
    expect(queryKeys).not.toContainEqual(unsectionedArchivedKey);
  });

  it("includes archived project lists in project invalidation", () => {
    const { queryClient } = createQueryClientTestHarness();
    const projectArchivedKey = archivedThreadsListQueryKey({
      projectId: "proj_1",
    });
    const projectThreadListKey = threadListQueryKey({
      archived: false,
      projectId: "proj_1",
    });
    const otherProjectArchivedKey = archivedThreadsListQueryKey({
      projectId: "proj_2",
    });

    queryClient.setQueryData(projectArchivedKey, { pages: [], pageParams: [] });
    queryClient.setQueryData(projectThreadListKey, []);
    queryClient.setQueryData(otherProjectArchivedKey, {
      pages: [],
      pageParams: [],
    });

    const queryKeys = getCachedProjectThreadListInvalidationQueryKeys({
      projectId: "proj_1",
      queryClient,
    });

    expect(queryKeys).toContainEqual(projectArchivedKey);
    expect(queryKeys).toContainEqual(projectThreadListKey);
    expect(queryKeys).not.toContainEqual(otherProjectArchivedKey);
  });
});

describe("listSidebarNavigationThreads", () => {
  function navigation(
    threads: ThreadListEntry[],
    personal: ThreadListEntry[] = [],
  ) {
    return makeSidebarBootstrapResponse({
      projects: [makeProjectWithThreadsResponse({ id: "proj_app", threads })],
      personalProject: makeProjectWithThreadsResponse({
        id: PERSONAL_PROJECT_ID,
        kind: "personal",
        threads: personal,
      }),
    });
  }

  it("returns the same array for the same navigation object", () => {
    const nav = navigation([makeThreadListEntry({ id: "thr_a" })]);
    expect(listSidebarNavigationThreads(nav)).toBe(
      listSidebarNavigationThreads(nav),
    );
  });

  it("returns the previous array when a new navigation lists the same entries", () => {
    const a = makeThreadListEntry({ id: "thr_a" });
    const b = makeThreadListEntry({ id: "thr_b" });
    const before = listSidebarNavigationThreads(navigation([a], [b]));
    const after = listSidebarNavigationThreads(navigation([a], [b]));
    expect(after).toBe(before);
    expect(after).toEqual([a, b]);
  });

  it("returns a new array when an entry changes or the order differs", () => {
    const a = makeThreadListEntry({ id: "thr_a", title: "One" });
    const b = makeThreadListEntry({ id: "thr_b" });
    const before = listSidebarNavigationThreads(navigation([a, b]));
    const changed = listSidebarNavigationThreads(
      navigation([makeThreadListEntry({ id: "thr_a", title: "Two" }), b]),
    );
    expect(changed).not.toBe(before);
    expect(changed[1]).toBe(b);
    const reordered = listSidebarNavigationThreads(navigation([b, a]));
    expect(reordered).not.toBe(changed);
  });
});
