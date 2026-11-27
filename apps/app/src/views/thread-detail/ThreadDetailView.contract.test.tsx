// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Provider } from "jotai";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExperimentalThreadHeaderRowProps } from "@get-bb/plugin-sdk";
import { pluginSdkAppImplementation } from "@/lib/plugin-sdk-app-impl";
import { getProjectComposeRoutePath } from "@/lib/route-paths";
import { MarkdownPreview } from "@/components/ui/markdown-preview";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { makeEnvironment } from "@bb/test-helpers/domain-fixtures";
import { makeThreadResponse } from "@/test/fixtures/thread-responses";
import { resetFixedPanelTabsStateForTest } from "@/lib/fixed-panel-tabs";
import {
  createPluginFixedPanelTab,
  createThreadInfoFixedPanelTab,
} from "@/lib/fixed-panel-tabs-state";
import {
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  collectPluginAppRegistrations,
  definePluginApp,
} from "@/lib/plugin-app-definition";
import { resetFocusedAppPanelControllersForTest } from "@/lib/app-fixed-tab-navigation";
import { markPluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import {
  CONTRACT_PLUGIN_ID,
  ContractActionTab,
  ContractPanelProbe,
  ContractStateProbe,
  ContractTargetedFixedTab,
  contractActionPanelTabId,
  contractTarget,
  describePanelControllerContract,
  readContractPanel,
  readContractTabs,
  snapshotFromState,
  type ContractStateSink,
  type PanelContractSurface,
} from "@/test/panel-controller-contract";
import { DefaultPaneContextProvider } from "./PaneContext";
import { ThreadDetailView } from "./ThreadDetailView";

const appCommandHandlers = vi.hoisted(
  () => new Map<string, () => boolean | void>(),
);
const fixtures = vi.hoisted(() => ({
  nativeContent: null as string | null,
  nativeHandler: null as
    | import("@/components/ui/markdown-local-file-link").MarkdownPreviewLocalFileLinkHandler
    | null,
  modal: vi.fn(),
  editor: vi.fn(),
  probe: {
    current: null,
  } as import("@/test/panel-controller-contract").ContractPanelRef,
  probeHost: "prompt" as "prompt" | "headerRow",
  sink: {
    current: null,
  } as import("@/test/panel-controller-contract").ContractStateSink,
  router: null as ReturnType<
    typeof import("react-router-dom").createMemoryRouter
  > | null,
}));

vi.mock("@/lib/modal-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/modal-host")>()),
  openCoreModal: fixtures.modal,
}));
vi.mock("@/hooks/queries/thread-panel-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/thread-panel-queries")
  >()),
  useThreadStorageLocation: () => ({
    data: { storageRootPath: "/storage/thr_contract" },
  }),
}));
vi.mock("./ThreadScreen", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ThreadScreen")>();
  const { useThreadTimelineNavigation } =
    await import("@/components/thread/timeline/ThreadTimelineNavigationContext");
  return {
    ...original,
    ThreadScreen: (props: Parameters<typeof original.ThreadScreen>[0]) => {
      const navigation = useThreadTimelineNavigation();
      fixtures.nativeHandler = navigation?.onOpenLocalFileLink ?? null;
      return (
        <>
          {fixtures.nativeContent === null ? null : (
            <MarkdownPreview
              content={fixtures.nativeContent}
              linkRouting={{
                localFile: {
                  absoluteLinks: { kind: "trusted-host" },
                  hostId: navigation?.hostId ?? null,
                  onOpenLink: navigation!.onOpenLocalFileLink,
                },
              }}
            />
          )}
          <original.ThreadScreen {...props} />
        </>
      );
    },
  };
});
vi.mock("@/hooks/useLocalOpenTargets", () => ({
  useLocalOpenTargets: () => ({
    fileOpenTargets: [{ id: "vscode", label: "VS Code" }],
    directoryOpenTargets: [],
    openPathInFileTarget: fixtures.editor,
    openPathInDirectoryTarget: vi.fn(),
    openPathInPreferredDirectoryTarget: vi.fn(),
    preferredDirectoryTarget: null,
    canOpenPreferredDirectoryTarget: false,
  }),
}));

const THREAD = makeThreadResponse({
  id: "thr_contract",
  projectId: "proj_contract",
  environmentId: "env_contract",
});
const ENVIRONMENT = makeEnvironment({
  id: "env_contract",
  projectId: "proj_contract",
});

vi.mock("@/components/commands/AppCommandProvider", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/commands/AppCommandProvider")
  >()),
  useAppCommandHandler: (command: string, handler: () => boolean | void) => {
    appCommandHandlers.set(command, handler);
  },
  useAppCommandShortcut: () => null,
}));
vi.mock("@bb/shared-ui/hooks/use-compact-viewport", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@bb/shared-ui/hooks/use-compact-viewport")
  >()),
  useIsCompactViewport: () => false,
}));
vi.mock("./ThreadDetailSecondaryContent", async () => {
  const { ContractSecondaryPanel } =
    await import("@/test/panel-controller-contract");
  return {
    ThreadDetailSecondaryContent: ({
      header,
      main,
      secondaryPanel,
    }: {
      header: ReactNode;
      main: ReactNode;
      secondaryPanel: Parameters<typeof ContractSecondaryPanel>[0];
    }) => (
      <>
        {header}
        <div data-testid="thread-main">{main}</div>
        <ContractSecondaryPanel {...secondaryPanel} />
      </>
    ),
  };
});
vi.mock("./ThreadDetailHeader", () => ({
  ThreadDetailHeader: () => <header data-testid="thread-header" />,
}));
vi.mock("./ThreadDetailPromptArea", async () => {
  const { PluginContext } = await import("@/components/plugin/plugin-context");
  const { ContractPanelProbe } =
    await import("@/test/panel-controller-contract");
  return {
    ThreadDetailPromptArea: () =>
      fixtures.probeHost === "prompt" ? (
        <PluginContext.Provider value={CONTRACT_PLUGIN_ID}>
          <ContractPanelProbe probe={fixtures.probe} />
        </PluginContext.Provider>
      ) : null,
  };
});
vi.mock("./useThreadDetailThread", () => ({
  useThreadDetailThread: () => ({
    hasThreadDetailBootstrapSettled: true,
    threadDetailBootstrapQuery: { isFetching: false },
    threadQuery: {
      data: THREAD,
      isFetching: false,
      isLoadingError: false,
      error: null,
    },
    unreadDividerState: { ready: true, anchor: null },
  }),
}));
vi.mock("@/hooks/queries/environment-queries", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/queries/environment-queries")
  >()),
  useEnvironment: () => ({
    data: ENVIRONMENT,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
}));

async function mountThreadView(
  probeHost: typeof fixtures.probeHost,
): Promise<PanelContractSurface> {
  fixtures.probeHost = probeHost;
  const probe = fixtures.probe;
  probe.current = null;
  const sink: ContractStateSink = { current: null };
  fixtures.sink = sink;
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <DefaultPaneContextProvider
            paneId="main"
            onRequestClose={null}
            navigateInPane={() => {}}
          >
            <ContractStateProbe
              panelStateId={THREAD.id}
              syncThreadId={THREAD.id}
              sink={sink}
            />
            <ThreadDetailView
              surface="pane"
              projectId={THREAD.projectId}
              threadId={THREAD.id}
              timelineEnabled={false}
            />
          </DefaultPaneContextProvider>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  fixtures.router = router;
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Provider>
        <RouterProvider router={router} />
      </Provider>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(snapshotFromState(sink).tabIds).toEqual(
      expect.arrayContaining([
        createThreadInfoFixedPanelTab().id,
        pluginFixedTabId("summary"),
      ]),
    ),
  );
  return {
    panel: () => readContractPanel(probe),
    snapshot: () => snapshotFromState(sink),
    tabs: () => readContractTabs(probe),
    renderedTabVisible: () =>
      screen.queryByTestId("contract-tab-visible")?.textContent ?? null,
    renderedTarget: () =>
      screen.queryByTestId("contract-target")?.textContent ?? null,
    command: (id) => appCommandHandlers.get(id)?.() !== false,
    action: { tab: actionTab, panelTabId: contractActionPanelTabId("chat") },
    fixed: {
      targeted: { tab: targetedTab, panelTabId: pluginFixedTabId("summary") },
      untargeted: {
        tab: untargetedTab,
        panelTabId: pluginFixedTabId("notes"),
      },
    },
    foreignTab: {
      id: "chat",
      context: { kind: "nav-panel", panelId: "board" },
      availability: "action",
    },
    toggleRestoresActiveTab: true,
  };
}

describePanelControllerContract("thread view", { fixedTabs: true }, () =>
  mountThreadView("prompt"),
);

describePanelControllerContract("thread header row", { fixedTabs: true }, () =>
  mountThreadView("headerRow"),
);

function HeaderRowProbe() {
  return fixtures.probeHost === "headerRow" ? (
    <ContractPanelProbe probe={fixtures.probe} />
  ) : null;
}

const targetedTab = {
  id: "summary",
  context: { kind: "thread" },
  availability: "fixed",
} as const;
const untargetedTab = { ...targetedTab, id: "notes" } as const;
const actionTab = {
  id: "chat",
  context: { kind: "thread" },
  availability: "action",
} as const;

function pluginFixedTabId(tabId: string) {
  return createPluginFixedPanelTab({ pluginId: CONTRACT_PLUGIN_ID, tabId }).id;
}

beforeEach(() => {
  fixtures.nativeContent = null;
  fixtures.nativeHandler = null;
  fixtures.modal.mockClear();
  fixtures.editor.mockClear();
  markPluginFrontendsSettled();
  appCommandHandlers.clear();
  window.localStorage.clear();
  resetFixedPanelTabsStateForTest();
  resetPluginSlotStoreForTest();
  setPluginSlotRegistrations(
    CONTRACT_PLUGIN_ID,
    collectPluginAppRegistrations(
      definePluginApp((app) => {
        app.slots.experimental_tab({
          ...targetedTab,
          title: "Summary",
          icon: "Info",
          component: () => <ContractTargetedFixedTab tab={targetedTab} />,
          experimental_target: contractTarget,
        });
        app.slots.experimental_tab({
          ...untargetedTab,
          title: "Notes",
          icon: "Note",
          component: () => <div>Notes</div>,
        });
        app.slots.experimental_tab({
          ...actionTab,
          title: "Chat",
          icon: "Chat",
          component: ContractActionTab,
        });
        app.slots.experimental_threadHeaderRow({
          id: "probe",
          component: HeaderRowProbe,
        });
      }),
    ),
  );
});

async function mountNative(content: string) {
  fixtures.nativeContent = content;
  const sink: ContractStateSink = { current: null };
  const router = createMemoryRouter([
    {
      path: "/",
      element: (
        <DefaultPaneContextProvider
          paneId="main"
          onRequestClose={null}
          navigateInPane={() => {}}
        >
          <ContractStateProbe
            panelStateId={THREAD.id}
            syncThreadId={THREAD.id}
            sink={sink}
          />
          <ThreadDetailView
            surface="pane"
            projectId={THREAD.projectId}
            threadId={THREAD.id}
            timelineEnabled={false}
          />
        </DefaultPaneContextProvider>
      ),
    },
  ]);
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <Provider>
        <RouterProvider router={router} />
      </Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole("link", { name: "native report" });
  return sink;
}

it.each(["/workspace/report.md", "/outside/report.md"])(
  "opens an ordinary native artifact with exact custody: %s",
  async (path) => {
    await mountNative(`[native report](${path})`);
    expect(
      fireEvent.click(screen.getByRole("link", { name: "native report" }), {
        detail: 0,
      }),
    ).toBe(false);
    expect(fixtures.modal).toHaveBeenCalledTimes(1);
    expect(fixtures.modal.mock.calls[0]![1].params).toMatchObject(
      path.startsWith("/workspace/")
        ? {
            kind: "workspace",
            environmentId: ENVIRONMENT.id,
            relativePath: "report.md",
          }
        : { kind: "host", hostId: ENVIRONMENT.hostId, path },
    );
  },
);

it("uses native owning-thread storage only for ordinary activation and preserves modified fallback", async () => {
  const path = "/storage/thr_contract/report.md";
  const sink = await mountNative(`[native report](${path})`);
  const link = screen.getByRole("link", { name: "native report" });
  expect(fireEvent.click(link)).toBe(false);
  expect(fixtures.modal.mock.calls[0]![1].params).toMatchObject({
    kind: "thread-storage",
    threadId: THREAD.id,
    relativePath: "report.md",
  });
  fixtures.modal.mockClear();
  expect(fireEvent.click(link, { metaKey: true })).toBe(false);
  expect(fixtures.modal).not.toHaveBeenCalled();
  expect(sink.current?.secondary.tabs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "thread-storage-file-preview",
        threadId: THREAD.id,
        path: "report.md",
      }),
    ]),
  );
});

it.each(["/workspace/report.md", "/outside/report.md"])(
  "retains native panel fallback without activation metadata: %s",
  async (path) => {
    const sink = await mountNative(`[native report](${path})`);
    act(() =>
      expect(
        fixtures.nativeHandler?.({ path, lineRange: null, openTargetId: null }),
      ).toBe(true),
    );
    expect(fixtures.modal).not.toHaveBeenCalled();
    expect(sink.current?.secondary.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.startsWith("/workspace/") ? "report.md" : path,
        }),
      ]),
    );
  },
);

it.each(["/workspace/report.md", "/outside/report.md"])(
  "keeps native modified/code/location/editor dispatch: %s",
  async (path) => {
    const sink = await mountNative(
      `[native report](${path}) [code](${path.replace(".md", ".ts")}) [lines](${path}#L3-L5) [editor](vscode://file${path}:7)`,
    );
    for (const event of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ]) {
      expect(
        fireEvent.click(
          screen.getByRole("link", { name: "native report" }),
          event,
        ),
      ).toBe(false);
      expect(fixtures.modal).not.toHaveBeenCalled();
    }
    fireEvent.click(screen.getByRole("link", { name: "code" }));
    fireEvent.click(screen.getByRole("link", { name: "lines" }));
    expect(fixtures.modal).not.toHaveBeenCalled();
    expect(sink.current?.secondary.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lineRange: { startLineNumber: 3, endLineNumber: 5 },
        }),
      ]),
    );
    fireEvent.click(screen.getByRole("link", { name: "editor" }));
    expect(fixtures.editor).toHaveBeenCalledWith({
      path,
      targetId: "vscode",
      lineNumber: 7,
      rememberTarget: false,
    });
    expect(fixtures.modal).not.toHaveBeenCalled();
  },
);

afterEach(() => {
  cleanup();
  resetPluginSlotStoreForTest();
  resetFocusedAppPanelControllersForTest();
});

describe("experimental_threadHeaderRow", () => {
  const ROWS_PLUGIN_ID = "rows";
  function Labelled(label: string) {
    return function Row(props: ExperimentalThreadHeaderRowProps) {
      return (
        <div data-testid="header-row" data-props={JSON.stringify(props)}>
          {label}
        </div>
      );
    };
  }

  const {
    experimental_useAppPanel: useAppPanel,
    experimental_usePanelTabs: usePanelTabs,
    experimental_useSidebarThreads: useSidebarThreads,
    useBbNavigate,
    useSdk,
  } = pluginSdkAppImplementation;

  function HooksRow() {
    const panel = useAppPanel();
    const tabs = usePanelTabs();
    const sdk = useSdk();
    const sidebar = useSidebarThreads();
    const navigate = useBbNavigate();
    return (
      <div
        data-testid="header-row"
        data-tab-keys={tabs.tabs.map((tab) => tab.key).join(" ")}
        data-has-sdk={String(typeof sdk.threads.get === "function")}
        data-sidebar-status={sidebar.status}
      >
        <button
          type="button"
          onClick={() => {
            const summary = panel
              .getTabs()
              .tabs.find((tab) => tab.title === "Summary");
            if (summary) panel.selectTab(summary.key);
          }}
        >
          Show summary
        </button>
        <button type="button" onClick={() => navigate.toProject("proj_next")}>
          Go
        </button>
      </div>
    );
  }

  function Crashes(): never {
    throw new Error("row crashed");
  }

  function registerRows(setup: Parameters<typeof definePluginApp>[0]) {
    setPluginSlotRegistrations(
      ROWS_PLUGIN_ID,
      collectPluginAppRegistrations(definePluginApp(setup)),
    );
  }

  it("stacks rows by order between the thread header and the timeline", async () => {
    registerRows((app) => {
      app.slots.experimental_threadHeaderRow({
        id: "unordered",
        component: Labelled("Unordered"),
      });
      app.slots.experimental_threadHeaderRow({
        id: "second",
        order: 20,
        component: Labelled("Second"),
      });
      app.slots.experimental_threadHeaderRow({
        id: "empty",
        order: 0,
        component: () => null,
      });
      app.slots.experimental_threadHeaderRow({
        id: "first",
        order: 10,
        component: Labelled("First"),
      });
    });
    await mountThreadView("prompt");

    const rows = screen.getAllByTestId("header-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      "First",
      "Second",
      "Unordered",
    ]);
    const header = screen.getByTestId("thread-header");
    const main = screen.getByTestId("thread-main");
    for (const row of rows) {
      expect(
        header.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(
        row.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      expect(main.contains(row)).toBe(false);
    }
    expect(JSON.parse(rows[0]?.dataset.props ?? "null")).toEqual({
      threadId: THREAD.id,
      projectId: THREAD.projectId,
      environment: { id: "env_contract" },
    });
  });

  it("drops only a crashing row and keeps the thread view", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerRows((app) => {
      app.slots.experimental_threadHeaderRow({
        id: "broken",
        order: 0,
        component: Crashes,
      });
      app.slots.experimental_threadHeaderRow({
        id: "kept",
        component: Labelled("Kept"),
      });
    });
    await mountThreadView("prompt");

    expect(
      screen.getAllByTestId("header-row").map((row) => row.textContent),
    ).toEqual(["Kept"]);
    expect(screen.getByTestId("thread-header")).toBeTruthy();
    expect(screen.getByTestId("thread-main")).toBeTruthy();
    vi.mocked(console.error).mockRestore();
  });

  it("gives a row the thread's panel, navigation, sidebar threads and sdk", async () => {
    registerRows((app) => {
      app.slots.experimental_threadHeaderRow({
        id: "hooks",
        component: HooksRow,
      });
    });
    await mountThreadView("prompt");

    const row = screen.getByTestId("header-row");
    expect(row.dataset.hasSdk).toBe("true");
    expect(["loading", "ready", "error"]).toContain(row.dataset.sidebarStatus);
    expect(row.dataset.tabKeys?.split(" ")).toEqual(
      expect.arrayContaining([
        createThreadInfoFixedPanelTab().id,
        pluginFixedTabId("summary"),
      ]),
    );

    expect(snapshotFromState(fixtures.sink).activeTabId).not.toBe(
      pluginFixedTabId("summary"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show summary" }));
    await waitFor(() =>
      expect(snapshotFromState(fixtures.sink).activeTabId).toBe(
        pluginFixedTabId("summary"),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() =>
      expect(fixtures.router?.state.location.pathname).toBe(
        getProjectComposeRoutePath("proj_next"),
      ),
    );
  });
});
