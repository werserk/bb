// @vitest-environment jsdom

import { LazyPluginThreadChat } from "./LazyPluginThreadChat";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sdk } from "@/lib/sdk";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { ThreadTimelineNavigationProvider } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import type { ThreadTimelineLocalFileLinkHandler } from "@/components/thread/timeline/types";
import { AppNavigationHostProvider } from "@/lib/app-navigation-host";
import { PluginSlotMount } from "./PluginSlotMount";

await LazyPluginThreadChat.preload();

const mocks = vi.hoisted(() => ({
  nativeContent: null as string | null,
  modal: vi.fn(),
  threadScreenProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/modal-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modal-host")>()),
  openCoreModal: mocks.modal,
}));
vi.mock("@/hooks/queries/thread-panel-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/thread-panel-queries")
  >()),
  useThreadStorageLocation: (id: string) => ({
    data: { storageRootPath: `/home/me/.bb/thread-storage/${id}` },
  }),
}));

vi.mock("@/lib/sdk", () => ({
  sdk: {
    threads: { get: vi.fn() },
    environments: { get: vi.fn() },
    hosts: { list: vi.fn(async () => []) },
    providers: { list: vi.fn(async () => []) },
  },
  BbHttpError: class BbHttpError extends Error {
    status: number;
    constructor(status: number) {
      super(`http ${status}`);
      this.status = status;
    }
  },
}));

vi.mock("@/hooks/useRealtimeSubscription", () => ({
  useHostListRealtimeSubscription: vi.fn(),
  useThreadDetailRealtimeSubscription: vi.fn(),
  useThreadTimelineRealtimeSubscription: vi.fn(),
  useThreadListRealtimeSubscription: vi.fn(),
  useEnvironmentDetailRealtimeSubscription: vi.fn(),
  useSystemRealtimeSubscription: vi.fn(),
}));

vi.mock("@/hooks/useHostDaemon", () => ({
  useHostDaemon: () => ({ isLocalDaemonHost: () => true }),
}));

vi.mock("@/views/thread-detail/ThreadScreen", async () => {
  const { useThreadTimelineNavigation } =
    await import("@/components/thread/timeline/ThreadTimelineNavigationContext");
  return {
    ThreadScreen: function ThreadScreen(props: Record<string, unknown>) {
      const navigation = useThreadTimelineNavigation();
      mocks.threadScreenProps.push({
        ...props,
        navigation,
      });
      return (
        <div data-testid="thread-screen">
          {mocks.nativeContent === null ? null : (
            <MarkdownPreview
              content={mocks.nativeContent}
              linkRouting={{
                localFile: {
                  hostId: navigation?.hostId ?? null,
                  absoluteLinks: { kind: "trusted-host" },
                  onOpenLink: navigation!.onOpenLocalFileLink,
                },
              }}
            />
          )}
        </div>
      );
    },
  };
});

vi.mock("@/components/thread/timeline", () => ({
  useThreadTimelineController: () => ({ timelineRows: [] }),
}));

const THREAD_FIXTURE = {
  id: "thr_demo",
  projectId: "proj_demo",
  providerId: "provider_demo",
  environmentId: null,
  status: "active",
  runtime: { displayStatus: "idle" },
};

function DemoPluginPage({ threadId }: { threadId: string }) {
  const ThreadChat = pluginSdkAppImplementation.ThreadChat;
  return <ThreadChat threadId={threadId} variant="compact" />;
}

function DemoPluginPageWithExtensions({
  threadId,
  run,
}: {
  threadId: string;
  run: () => void;
}) {
  const ThreadChat = pluginSdkAppImplementation.ThreadChat;
  return (
    <ThreadChat
      threadId={threadId}
      variant="compact"
      leadingContent={<div data-testid="replying-to">Replying to</div>}
      messageActions={[
        {
          id: "send-to-main",
          title: "Send to main thread",
          icon: "ArrowTurnBackward",
          roles: ["assistant"],
          run,
        },
      ]}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  mocks.nativeContent = null;
  mocks.threadScreenProps = [];
  vi.mocked(sdk.threads.get).mockResolvedValue(THREAD_FIXTURE as never);
});

describe("PluginThreadChat", () => {
  it.each([false, true])(
    "preserves actual embedded ThreadChat activation and editor fallback (same environment=%s)",
    async (same) => {
      const path = "/home/me/.bb/thread-storage/thr_demo/report.md";
      mocks.nativeContent = `[report](${path}) [editor](vscode://file${path}:7)`;
      const onOpenLocalFileLink = vi.fn(() => true);
      const { wrapper: Wrapper } = createQueryClientTestHarness();
      render(
        <Wrapper>
          <MemoryRouter>
            <ThreadTimelineNavigationProvider
              environmentId={same ? null : "env_outer"}
              workspaceRootPath="/outer"
              hostId="host_demo"
              onOpenLocalFileLink={onOpenLocalFileLink}
              resolveMentionLink={() => null}
            >
              <DemoPluginPage threadId="thr_demo" />
            </ThreadTimelineNavigationProvider>
          </MemoryRouter>
        </Wrapper>,
      );
      const link = await screen.findByRole("link", { name: "report" });
      expect(fireEvent.click(link)).toBe(false);
      expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
        kind: "thread-storage",
        threadId: "thr_demo",
        relativePath: "report.md",
      });
      expect(onOpenLocalFileLink).not.toHaveBeenCalled();
      mocks.modal.mockClear();
      fireEvent.click(link, { metaKey: true });
      expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
        path,
        threadId: "thr_demo",
      });
      expect(onOpenLocalFileLink).not.toHaveBeenCalled();
      mocks.modal.mockClear();
      expect(
        fireEvent.click(screen.getByRole("link", { name: "editor" })),
      ).toBe(false);
      expect(mocks.modal.mock.calls[0]![1].params).toMatchObject({
        path,
        lineRange: { startLineNumber: 7, endLineNumber: 7 },
      });
      expect(onOpenLocalFileLink).not.toHaveBeenCalled();
    },
  );

  it("gives a plugin page a working query client and sdk-backed thread context", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    render(
      <Wrapper>
        <MemoryRouter>
          <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="page">
            <DemoPluginPage threadId="thr_demo" />
          </PluginSlotMount>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("thread-screen")).toBeTruthy(),
    );
    expect(sdk.threads.get).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thr_demo" }),
    );
    const props = mocks.threadScreenProps.at(-1)!;
    expect(props.projectId).toBe("proj_demo");
    expect(props.thread).toEqual(
      expect.objectContaining({ id: "thr_demo", providerId: "provider_demo" }),
    );
    expect(props.presentation).toEqual({
      kind: "panel",
      layout: "contained",
      measure: "panel",
      tone: "sidebar",
    });
    expect(props.composer).toEqual(
      expect.objectContaining({
        contextEnvironmentId: null,
        permissionPolicy: "snapshot",
      }),
    );
  });

  it("hands the permission picker to the user only when asked", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const ThreadChat = pluginSdkAppImplementation.ThreadChat;
    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadChat threadId="thr_demo" permissionPolicy="editable" />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("thread-screen")).toBeTruthy(),
    );
    expect(mocks.threadScreenProps.at(-1)!.composer).toEqual(
      expect.objectContaining({ permissionPolicy: "editable" }),
    );
  });

  it("uses the surrounding thread detail navigation for timeline links", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const onOpenLocalFileLink = vi.fn(() => true);
    const workspaceMentionHandler = vi.fn();
    const resolveMentionLink = vi.fn(() => workspaceMentionHandler);

    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadTimelineNavigationProvider
            environmentId={null}
            hostId={null}
            onOpenLocalFileLink={onOpenLocalFileLink}
            resolveMentionLink={resolveMentionLink}
            workspaceRootPath="/workspace"
          >
            <DemoPluginPage threadId="thr_demo" />
          </ThreadTimelineNavigationProvider>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("thread-screen")).toBeTruthy(),
    );
    const props = mocks.threadScreenProps.at(-1)!;
    expect(props.navigation).toEqual(
      expect.objectContaining({ workspaceRootPath: "/workspace" }),
    );

    const embeddedResolveMentionLink = props.resolveMentionLink as (resource: {
      kind: "path";
      source: "workspace";
      entryKind: "file";
      path: string;
      label: string;
    }) => (() => void) | null;
    const workspaceMention = {
      kind: "path" as const,
      source: "workspace" as const,
      entryKind: "file" as const,
      path: "README.md",
      label: "README.md",
    };
    expect(embeddedResolveMentionLink(workspaceMention)).toBe(
      workspaceMentionHandler,
    );
    expect(resolveMentionLink).toHaveBeenCalledWith(workspaceMention);
  });

  it("opens file links through app navigation outside the thread detail view", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    vi.mocked(sdk.threads.get).mockResolvedValue({
      ...THREAD_FIXTURE,
      environmentId: "env_demo",
    } as never);
    vi.mocked(sdk.environments.get).mockResolvedValue({
      id: "env_demo",
      hostId: "host_demo",
      path: "/workspace",
      updatedAt: 1,
    } as never);
    const openFilePreview = vi.fn(() => true);

    render(
      <Wrapper>
        <MemoryRouter>
          <AppNavigationHostProvider capabilities={{ openFilePreview }}>
            <DemoPluginPage threadId="thr_demo" />
          </AppNavigationHostProvider>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(mocks.threadScreenProps.at(-1)?.navigation).toEqual(
        expect.objectContaining({ workspaceRootPath: "/workspace" }),
      ),
    );
    const timelineHost = mocks.threadScreenProps.at(-1)!.navigation as {
      onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler;
    };
    const lineRange = { startLineNumber: 3, endLineNumber: 5 };

    timelineHost.onOpenLocalFileLink({
      lineRange,
      openTargetId: null,
      path: "/workspace/docs/erd.mmd",
    });
    timelineHost.onOpenLocalFileLink({
      lineRange: null,
      openTargetId: null,
      path: "/workspace-sibling/notes.md",
    });
    timelineHost.onOpenLocalFileLink({
      lineRange: null,
      openTargetId: "cursor",
      path: "/workspace/src/index.ts",
    });

    expect(openFilePreview.mock.calls).toEqual([
      [
        {
          target: {
            kind: "workspace",
            environmentId: "env_demo",
            path: "docs/erd.mmd",
          },
          location: { kind: "range", startLine: 3, endLine: 5 },
        },
      ],
      [
        {
          target: {
            kind: "host",
            hostId: "host_demo",
            path: "/workspace-sibling/notes.md",
          },
          location: null,
        },
      ],
      [
        {
          target: {
            kind: "workspace",
            environmentId: "env_demo",
            path: "src/index.ts",
          },
          location: null,
        },
      ],
    ]);
  });

  it("maps variant timeline to a composer-less transcript", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const ThreadChat = pluginSdkAppImplementation.ThreadChat;
    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadChat threadId="thr_demo" variant="timeline" />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("thread-screen")).toBeTruthy(),
    );
    const props = mocks.threadScreenProps.at(-1)!;
    expect(props.composer).toBeNull();
    expect(props.presentation).toEqual({
      kind: "transcript",
      layout: "contained",
    });
  });

  it("forwards leadingContent and maps messageActions to consumer actions", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const run = vi.fn();
    render(
      <Wrapper>
        <MemoryRouter>
          <PluginSlotMount pluginId="demo" slotKind="navPanel" slotId="page">
            <DemoPluginPageWithExtensions threadId="thr_demo" run={run} />
          </PluginSlotMount>
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("thread-screen")).toBeTruthy(),
    );
    const timelineHost = mocks.threadScreenProps.at(-1)!.timelineHost as Record<
      string,
      unknown
    >;
    expect(timelineHost.leadingContent).toBeTruthy();
    expect(timelineHost.includePluginMessageActions).toBe(false);
    const actions = timelineHost.consumerMessageActions as Array<
      Record<string, unknown>
    >;
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(
      expect.objectContaining({
        id: "send-to-main",
        pluginId: null,
        icon: "ArrowTurnBackward",
        label: "Send to main thread",
        roles: ["assistant"],
        run,
      }),
    );
  });

  it("maps variant full to the page measure and forwards focus requests", async () => {
    const { wrapper: Wrapper } = createQueryClientTestHarness();
    const ThreadChat = pluginSdkAppImplementation.ThreadChat;
    render(
      <Wrapper>
        <MemoryRouter>
          <ThreadChat threadId="thr_demo" layout="document" focusRequest={3} />
        </MemoryRouter>
      </Wrapper>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("thread-screen")).toBeTruthy(),
    );
    const props = mocks.threadScreenProps.at(-1)!;
    expect(props.presentation).toEqual({
      kind: "panel",
      layout: "document",
      measure: "page",
      tone: "background",
    });
    expect(props.composer).toEqual(
      expect.objectContaining({ focusRequest: 3 }),
    );
  });
});
