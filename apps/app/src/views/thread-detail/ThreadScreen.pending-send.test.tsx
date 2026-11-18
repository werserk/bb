// @vitest-environment jsdom

import { act, fireEvent, render, within } from "@testing-library/react";
import {
  pendingSendOwner,
  composePendingSends,
  clearPendingSendScope,
} from "@/hooks/cache-owners/pending-send-owner";
import { beginSendThreadMessageTransaction } from "@/hooks/cache-owners/thread-runtime-cache-owner";
import type { SendThreadMessageMutationRequest } from "@/hooks/mutations/mutation-request-types";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";
import type { UseThreadTimelineControllerResult } from "@/components/thread/timeline";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadScreen, type ThreadScreenPresentation } from "./ThreadScreen";

vi.mock("@/hooks/queries/thread-queries", () => ({
  useChildThreads: () => ({ data: [] }),
  useThread: () => ({ data: undefined }),
  useThreadPendingInteractions: () => ({ data: [] }),
}));

vi.mock("@/hooks/queries/system-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries/system-queries")>()),
  useSystemConfig: () => ({ data: undefined }),
}));

const { mutateAsync } = vi.hoisted(() => ({
  mutateAsync: vi.fn((_request?: unknown) => Promise.resolve()),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => {
  const mutation = () => ({ isPending: false, mutateAsync });
  return {
    useEditThreadMessage: mutation,
    useSendThreadMessage: mutation,
  };
});

const THREAD = makeThreadResponse({
  id: "thr_screen",
  projectId: "proj_screen",
  status: "pending",
  runtime: { displayStatus: "idle" },
});

const TIMELINE = {
  activeBackgroundCommands: [],
  activePromptMode: null,
  activeThinking: null,
  activeWorkflows: [],
  contextBoundarySeq: null,
  contextWindowUsage: undefined,
  hasOlderTimelineRows: false,
  isCatchingUpTimeline: false,
  isLoadingOlderTimelineRows: false,
  loadOlderTimelineRows: async () => {},
  modelFallback: null,
  pendingTodos: null,
  providerCommands: null,
  sessionOptions: null,
  timelineError: null,
  timelineLoading: false,
  timelineRows: [],
} satisfies UseThreadTimelineControllerResult;

const SIDE_CHAT_PRESENTATION: ThreadScreenPresentation = {
  kind: "panel",
  layout: "contained",
  measure: "panel",
  tone: "sidebar",
};

it("keeps pending send controls on the full ThreadScreen while a send is unresolved", async () => {
  const { queryClient: client, wrapper: Wrapper } =
    createQueryClientTestHarness();
  const owner = pendingSendOwner(client);
  const submissionId = "00000000-0000-4000-8000-000000000001";
  function Screen({
    timelineRows,
  }: {
    timelineRows: UseThreadTimelineControllerResult["timelineRows"];
  }) {
    return (
      <ThreadScreen
        composer={null}
        environment={null}
        presentation={SIDE_CHAT_PRESENTATION}
        projectId={THREAD.projectId}
        resolveMentionLink={() => null}
        thread={THREAD}
        timeline={{ ...TIMELINE, timelineRows }}
        timelineHost={{
          environmentHostName: null,
          includePluginMessageActions: false,
          unreadDividerAutoScroll: false,
          unreadDividerPlacement: null,
        }}
      />
    );
  }
  const screenTree = () => (
    <MemoryRouter>
      <Wrapper>
        <Screen
          timelineRows={composePendingSends(client, THREAD.id, [], []).rows}
        />
      </Wrapper>
    </MemoryRouter>
  );
  const view = render(screenTree());
  try {
    await act(async () => {
      await beginSendThreadMessageTransaction({
        queryClient: client,
        request: {
          id: THREAD.id,
          clientSubmissionId: submissionId,
          input: [{ type: "text", text: "kept send", mentions: [] }],
          mode: "auto",
        },
      });
    });
    view.rerender(screenTree());
    const pending = () =>
      view.container.querySelector<HTMLElement>(
        `[data-pending-send-id="${submissionId}"]`,
      );
    expect(
      view.container.querySelector(
        `[data-timeline-row-id="pending-send-${submissionId}"]`,
      ),
    ).toBeTruthy();
    expect(pending()?.textContent).toContain("Sending…");
    await act(async () => {
      owner.fail(THREAD.id, submissionId, true, "response lost");
    });
    expect(pending()?.textContent).toContain("Not sent");
    expect(
      within(pending()!).getByRole("button", { name: "Retry" }),
    ).toBeTruthy();
    fireEvent.click(within(pending()!).getByRole("button", { name: "Hide" }));
    expect(pending()).toBeNull();
  } finally {
    view.unmount();
    clearPendingSendScope(client);
    client.clear();
    vi.restoreAllMocks();
  }
});

it("resends an unconfirmed send with the same submission id", async () => {
  mutateAsync.mockClear();
  const { queryClient: client, wrapper: Wrapper } =
    createQueryClientTestHarness();
  const owner = pendingSendOwner(client);
  const submissionId = "00000000-0000-4000-8000-000000000002";
  function Screen({
    timelineRows,
  }: {
    timelineRows: UseThreadTimelineControllerResult["timelineRows"];
  }) {
    return (
      <ThreadScreen
        composer={null}
        environment={null}
        presentation={SIDE_CHAT_PRESENTATION}
        projectId={THREAD.projectId}
        resolveMentionLink={() => null}
        thread={THREAD}
        timeline={{ ...TIMELINE, timelineRows }}
        timelineHost={{
          environmentHostName: null,
          includePluginMessageActions: false,
          unreadDividerAutoScroll: false,
          unreadDividerPlacement: null,
        }}
      />
    );
  }
  const screenTree = () => (
    <MemoryRouter>
      <Wrapper>
        <Screen
          timelineRows={composePendingSends(client, THREAD.id, [], []).rows}
        />
      </Wrapper>
    </MemoryRouter>
  );
  const view = render(screenTree());
  try {
    await act(async () => {
      await beginSendThreadMessageTransaction({
        queryClient: client,
        request: {
          id: THREAD.id,
          clientSubmissionId: submissionId,
          input: [{ type: "text", text: "unsure send", mentions: [] }],
          mode: "auto",
        },
      });
    });
    view.rerender(screenTree());
    await act(async () => {
      owner.fail(THREAD.id, submissionId, false, "Delivery unconfirmed");
    });
    const pending = () =>
      view.container.querySelector<HTMLElement>(
        `[data-pending-send-id="${submissionId}"]`,
      );
    expect(pending()?.textContent).toContain("Delivery unconfirmed");
    mutateAsync.mockImplementationOnce(async (request: unknown) => {
      await beginSendThreadMessageTransaction({
        queryClient: client,
        request: request as SendThreadMessageMutationRequest,
      });
    });
    await act(async () => {
      fireEvent.click(
        within(pending()!).getByRole("button", { name: "Resend" }),
      );
    });
    expect(owner.list(THREAD.id)).toHaveLength(1);
    expect(owner.list(THREAD.id)[0]?.id).toBe(submissionId);
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        id: THREAD.id,
        clientSubmissionId: submissionId,
      }),
    );
    expect(pending()?.textContent).toContain("Sending…");
  } finally {
    view.unmount();
    clearPendingSendScope(client);
    client.clear();
    vi.restoreAllMocks();
  }
});
