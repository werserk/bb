// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingInteraction } from "@bb/domain";
import type { UseThreadTimelineControllerResult } from "@/components/thread/timeline";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { ThreadScreen, type ThreadScreenPresentation } from "./ThreadScreen";

const mocks = vi.hoisted(() => ({
  pendingInteractions: [] as PendingInteraction[],
  promptAreaProps: [] as Array<Record<string, unknown>>,
  surfaceProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/hooks/queries/thread-queries", () => ({
  useChildThreads: () => ({ data: [] }),
  useThread: () => ({ data: undefined }),
  useThreadPendingInteractions: () => ({ data: mocks.pendingInteractions }),
}));

vi.mock("@/hooks/queries/child-thread-pending-interactions", () => ({
  useChildThreadPendingAttention: () => [],
}));

vi.mock("@/hooks/queries/system-queries", () => ({
  useSystemConfig: () => ({ data: undefined }),
}));

vi.mock("@/hooks/mutations/thread-runtime-mutations", () => {
  const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
  return {
    useEditThreadMessage: mutation,
    useSendThreadMessage: mutation,
  };
});

vi.mock("@/components/thread/timeline", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/thread/timeline")>();
  return {
    ...actual,
    ThreadTimelineSurface: (props: Record<string, unknown>) => {
      mocks.surfaceProps.push(props);
      const addToChat = props.onSelectionAddToChat as
        | ((text: string) => void)
        | undefined;
      return (
        <button type="button" onClick={() => addToChat?.("Quoted line")}>
          Add selection to chat
        </button>
      );
    },
  };
});

vi.mock("./ThreadDetailPromptArea", () => ({
  ThreadDetailPromptArea: (props: Record<string, unknown>) => {
    mocks.promptAreaProps.push(props);
    return <div data-testid="prompt-area" />;
  },
}));

const THREAD = makeThreadResponse({
  id: "thr_screen",
  projectId: "proj_screen",
  status: "active",
  runtime: { displayStatus: "active" },
});

const TIMELINE = {
  activeBackgroundCommands: [],
  activePromptMode: null,
  activeThinking: null,
  activeWorkflows: [],
  contextBoundarySeq: null,
  contextWindowUsage: null,
  goal: null,
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
} as unknown as UseThreadTimelineControllerResult;

const SIDE_CHAT_PRESENTATION: ThreadScreenPresentation = {
  kind: "panel",
  layout: "contained",
  measure: "panel",
  tone: "sidebar",
};

function renderScreen(
  presentation: ThreadScreenPresentation,
  overrides: Partial<Parameters<typeof ThreadScreen>[0]> = {},
) {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  return render(
    <Wrapper>
      <ThreadScreen
        composer={{
          environmentCheckout: undefined,
          environmentChrome: undefined,
          contextEnvironmentId: null,
          permissionPolicy: "snapshot",
        }}
        environment={null}
        presentation={presentation}
        projectId={THREAD.projectId}
        resolveMentionLink={() => null}
        thread={THREAD}
        timeline={TIMELINE}
        timelineHost={{
          environmentHostName: null,
          includePluginMessageActions: false,
          unreadDividerAutoScroll: false,
          unreadDividerPlacement: null,
        }}
        workspaceRootPath={undefined}
        {...overrides}
      />
    </Wrapper>,
  );
}

function makePluginInteraction(): PendingInteraction {
  return {
    id: "int_plugin",
    threadId: THREAD.id,
    turnId: null,
    providerId: null,
    providerThreadId: null,
    providerRequestId: null,
    origin: { kind: "plugin", pluginId: "secrets" },
    payload: { kind: "plugin", pluginId: "secrets", type: "secret-request" },
    resolution: null,
    status: "pending",
    statusReason: null,
    createdAt: 1,
    resolvedAt: null,
  } as unknown as PendingInteraction;
}

beforeEach(() => {
  mocks.pendingInteractions = [];
  mocks.promptAreaProps = [];
  mocks.surfaceProps = [];
});

afterEach(() => {
  cleanup();
  getPromptDraftAccessor({
    kind: "thread",
    projectId: THREAD.projectId,
    threadId: THREAD.id,
  }).setDraft({ text: "", mentions: [], attachments: [] });
});

describe("ThreadScreen", () => {
  it("hands a plugin-rendered interaction to an embedded chat's composer", () => {
    mocks.pendingInteractions = [makePluginInteraction()];
    renderScreen(SIDE_CHAT_PRESENTATION);

    const promptArea = mocks.promptAreaProps.at(-1)!;
    expect(promptArea.pendingInteractions).toEqual(mocks.pendingInteractions);
    expect(promptArea.isPrimaryComposer).toBe(false);
    expect(promptArea.permissionPolicy).toBe("snapshot");
    expect(mocks.surfaceProps.at(-1)!.showOngoingIndicator).toBe(false);
  });

  it("quotes a timeline selection into the thread draft and focuses the composer", () => {
    renderScreen({ kind: "page" });
    const focusKeyBefore =
      mocks.promptAreaProps.at(-1)!.composerFocusRequestKey;

    fireEvent.click(
      screen.getByRole("button", { name: "Add selection to chat" }),
    );

    const draft = getPromptDraftAccessor({
      kind: "thread",
      projectId: THREAD.projectId,
      threadId: THREAD.id,
    }).getCurrent();
    expect(draft.text).toContain("Quoted line");
    expect(mocks.promptAreaProps.at(-1)!.composerFocusRequestKey).not.toBe(
      focusKeyBefore,
    );
  });
});

it.each<ThreadScreenPresentation>([
  { kind: "page" },
  SIDE_CHAT_PRESENTATION,
  { kind: "transcript", layout: "contained" },
])("places one plan outside the composer on $kind", (presentation) => {
  const timeline = {
    ...TIMELINE,
    pendingTodos: {
      sourceSeq: 1,
      updatedAt: 1,
      items: [
        { id: "one", text: "Inspect output", status: "in_progress" as const },
      ],
    },
  };
  const { container } = renderScreen(presentation, { timeline });
  expect(container.querySelectorAll("[data-thread-plan]")).toHaveLength(1);
  expect(screen.getByText("Inspect output")).toBeTruthy();
  expect(mocks.promptAreaProps.at(-1) ?? {}).not.toHaveProperty("pendingTodos");
});
it("hides the retained plan in an archived thread", () => {
  const timeline = {
    ...TIMELINE,
    pendingTodos: {
      sourceSeq: 1,
      updatedAt: 1,
      items: [
        { id: "one", text: "Inspect output", status: "pending" as const },
      ],
    },
  };
  const { container } = renderScreen(SIDE_CHAT_PRESENTATION, {
    timeline,
    thread: { ...THREAD, archivedAt: 1 },
  });
  expect(container.querySelector("[data-thread-plan]")).toBeNull();
});

const laterTurnRow: import("@bb/server-contract").TimelineUserConversationRow =
  {
    id: "later",
    threadId: THREAD.id,
    turnId: "later",
    kind: "conversation",
    role: "user",
    sourceSeqStart: 20,
    sourceSeqEnd: 20,
    startedAt: 200,
    createdAt: 200,
    messageSeq: 20,
    text: "Continue",
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    mentions: [],
    turnRequest: { kind: "message", status: "accepted", isGrouped: false },
  };
it.each([false, true])(
  "keeps an unfinished older-turn plan current, waiting=%s",
  (waiting) => {
    if (waiting) mocks.pendingInteractions = [makePluginInteraction()];
    renderScreen(SIDE_CHAT_PRESENTATION, {
      timeline: {
        ...TIMELINE,
        timelineRows: [laterTurnRow],
        pendingTodos: {
          sourceSeq: 10,
          updatedAt: 100,
          items: [
            { id: "one", text: "Continue the task", status: "in_progress" },
          ],
        },
      },
    });
    expect(
      screen
        .getByRole("button", {
          name: waiting ? /^Plan · waiting for you:/ : /^Plan:/,
        })
        .getAttribute("aria-expanded"),
    ).toBe("true");
    expect(screen.queryByText(/earlier task/)).toBeNull();
  },
);
it("collapses and reopens a completed older-turn plan through ThreadScreen", () => {
  renderScreen(
    { kind: "page" },
    {
      timeline: {
        ...TIMELINE,
        timelineRows: [laterTurnRow],
        pendingTodos: {
          sourceSeq: 10,
          updatedAt: 100,
          items: [{ id: "one", text: "Checked result", status: "completed" }],
        },
      },
    },
  );
  const toggle = screen.getByRole("button", {
    name: /^Plan completed.*1\/1/,
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText(/^Updated /).getAttribute("datetime")).toBe(
    "1970-01-01T00:00:00.100Z",
  );
  expect(screen.queryByText(/from an earlier task/)).toBeNull();
  expect(screen.getByText("Checked result")).toBeTruthy();
});
