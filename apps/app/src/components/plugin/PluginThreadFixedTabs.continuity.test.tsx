// @vitest-environment jsdom

import {
  RetainedThreadFixedTabs,
  useRetainedThreadTabHostState,
} from "./RetainedThreadFixedTabs";
import { TabVisibleContext } from "@/components/secondary-panel/tab-visibility";
import {
  PaneContext,
  createPaneSecondaryPanelRegistry,
  type PaneContextValue,
} from "@/views/thread-detail/PaneContext";
import { createPluginFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import {
  AppNavigationHostProvider,
  useAppNavigationHost,
} from "@/lib/app-navigation-host";
import { useTabVisible } from "@/components/secondary-panel/tab-visibility";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  definePluginApp,
  collectPluginAppRegistrations,
} from "@/lib/plugin-app-definition";
import {
  removePluginSlotRegistrations,
  resetPluginSlotStoreForTest,
  setPluginSlotRegistrations,
} from "@/lib/plugin-slots";
import {
  markPluginFrontendsSettled,
  resetPluginFrontendBootStateForTest,
} from "@/lib/plugin-frontend-boot-state";
import {
  createThreadFixedTabDescriptor,
  useThreadFixedTabs,
} from "./PluginThreadFixedTabs";

import { SecondaryPanelLayout } from "@/components/secondary-panel/SecondaryPanelLayout";
import { getThreadSecondaryPanelWidthPercentAtom } from "@/components/secondary-panel/threadSecondaryPanelAtoms";
import { SplitWorkspaceSecondaryPanelHost } from "@/views/thread-detail/SplitWorkspaceSecondaryPanelHost";
vi.mock(
  "react-resizable-panels",
  () => import("@/test/react-resizable-panels-stub"),
);
const visibilityCommits: boolean[] = [];
let mounts = 0;
let disposals = 0;
let identity: string | null = "coordinator";
let visible = true;
const calls: string[] = [];
const callbacks = new Map<
  string,
  ReturnType<typeof useAppNavigationHost>["openUrl"]
>();

function Board({ threadId }: { threadId: string }) {
  const [expanded, setExpanded] = useState(false);
  const tabVisible = useTabVisible();
  useLayoutEffect(() => {
    visibilityCommits.push(tabVisible);
  });
  const host = useAppNavigationHost();
  useEffect(() => {
    callbacks.set(threadId, host.openUrl);
  }, [threadId, host]);
  useEffect(() => {
    mounts++;
    return () => {
      disposals++;
    };
  }, []);
  return (
    <div data-testid="board" style={{ overflow: "auto", height: 100 }}>
      <button onClick={() => setExpanded(!expanded)}>
        {expanded ? "Expanded" : "Collapsed"}
      </button>
      <output>{threadId}</output>
      <span data-testid="visible">{String(tabVisible)}</span>
      <div style={{ height: 1000 }} />
    </div>
  );
}

function install(optIn = true, useIdentity = () => identity) {
  setPluginSlotRegistrations(
    "example",
    collectPluginAppRegistrations(
      definePluginApp((app) => {
        app.slots.experimental_tab(
          Object.assign(
            {
              context: { kind: "thread" as const },
              availability: "fixed" as const,
              id: "tasks",
              title: "Tasks",
              icon: "Info" as const,
              component: Board,
              useVisible: () => visible,
            },
            optIn ? { experimental_useContinuityKey: useIdentity } : {},
          ),
        );
      }),
    ),
  );
}

type SurfaceProps = {
  threadId: string;
  projectId?: string;
  ready?: boolean;
  loading?: boolean;
  open?: boolean;
  selected?: boolean;
  pane?: PaneContextValue;
  hosted?: boolean;
};
function Host({
  threadId,
  ready = true,
  loading = !ready,
  open = true,
  selected = true,
  hosted = false,
}: SurfaceProps) {
  const { entries, observers, isReady } = useThreadFixedTabs({
    threadId,
    environmentId: null,
  });
  const transport = useRetainedThreadTabHostState({
    threadId,
    ready,
    loading,
    tabsReady: isReady,
    open,
    activeTabId: selected
      ? createPluginFixedPanelTab({ pluginId: "example", tabId: "tasks" }).id
      : "files",
  });

  const capabilities = useMemo(
    () => ({
      openUrl: () => {
        calls.push(threadId);
        return true;
      },
    }),
    [threadId],
  );
  const panel = (
    <TabVisibleContext.Provider value={true}>
      <section key={threadId}>
        {open && selected
          ? entries.map((entry) => (
              <div key={entry.tab.id}>
                {createThreadFixedTabDescriptor(
                  entry,
                  threadId,
                  null,
                  () => {},
                ).renderContent()}
              </div>
            ))
          : null}
      </section>
    </TabVisibleContext.Provider>
  );
  return (
    <AppNavigationHostProvider capabilities={capabilities}>
      {observers}
      {!ready ? (
        <p>Loading</p>
      ) : hosted ? (
        <SecondaryPanelLayout
          open={open}
          onToggle={() => {}}
          onClose={() => {}}
          panelGroupKey="test"
          resetKey={threadId}
          contentKey={threadId}
          drawerLabel="Panel"
          drawerFallback={null}
          composerHost={null}
          mainPanelId="timeline"
          main={<p>Timeline</p>}
          mainHeader={null}
          widthPercentAtom={getThreadSecondaryPanelWidthPercentAtom(threadId)}
          renderHostedPanel={(panel) => (
            <AppNavigationHostProvider capabilities={capabilities}>
              {transport(panel)}
            </AppNavigationHostProvider>
          )}
          renderPanel={() => panel}
        />
      ) : (
        panel
      )}
    </AppNavigationHostProvider>
  );
}

function Surface({ projectId = "project", pane, ...props }: SurfaceProps) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PaneContext.Provider value={pane ?? null}>
          <RetainedThreadFixedTabs
            projectId={projectId}
            threadId={props.threadId}
          >
            <Host {...props} />
          </RetainedThreadFixedTabs>
        </PaneContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

afterEach(() => {
  cleanup();
  client.clear();
  resetPluginSlotStoreForTest();
  resetPluginFrontendBootStateForTest();
  visibilityCommits.length = 0;
  mounts = 0;
  disposals = 0;
  identity = "coordinator";
  visible = true;
  calls.length = 0;
  callbacks.clear();
  vi.restoreAllMocks();
});

it("retains the original Tasks node, expansion and scroll across a keyed thread panel", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  const board = await screen.findByTestId("board");
  fireEvent.click(screen.getByText("Collapsed"));
  board.scrollTop = 317;
  for (const threadId of ["child", "helper", "coordinator"]) {
    await act(async () => view.rerender(<Surface threadId={threadId} />));
    expect(screen.getByTestId("board")).toBe(board);
    expect(board.isConnected).toBe(true);
    expect(board.scrollTop).toBe(317);
    expect(screen.getByText("Expanded")).toBeTruthy();
    expect(screen.getByText(threadId)).toBeTruthy();
  }
  expect({ mounts, disposals }).toEqual({ mounts: 1, disposals: 0 });
});

it.each([{ open: false }, { selected: false }])(
  "parks and restores the same body for target panel state %j",
  async (state) => {
    install();
    markPluginFrontendsSettled();
    const view = render(<Surface threadId="coordinator" />);
    const board = await screen.findByTestId("board");
    fireEvent.click(screen.getByText("Collapsed"));
    const oldOpen = callbacks.get("coordinator")!;
    expect(oldOpen({ url: "test" })).toBe(true);
    await act(async () =>
      view.rerender(<Surface threadId="child" {...state} />),
    );
    expect(screen.getByTestId("board")).toBe(board);
    expect(board.closest("[aria-hidden=true]")).not.toBeNull();
    expect(screen.getByTestId("visible").textContent).toBe("false");
    expect(oldOpen({ url: "test" })).toBe(false);
    await act(async () => view.rerender(<Surface threadId="child" />));
    expect(screen.getByTestId("board")).toBe(board);
    expect(screen.getByText("Expanded")).toBeTruthy();
    expect(screen.getByTestId("visible").textContent).toBe("true");
    expect(callbacks.get("child")!({ url: "test" })).toBe(true);
    expect(calls).toEqual(["coordinator", "child"]);
    expect({ mounts, disposals }).toEqual({ mounts: 1, disposals: 0 });
  },
);

it("keeps the connected body in a visible, inert loading bridge before the cold target resolves", async () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(40, 70, 500, 600),
  );
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  const board = await screen.findByTestId("board");
  const previousOpen = callbacks.get("coordinator")!;
  await act(async () =>
    view.rerender(<Surface threadId="child" ready={false} />),
  );
  expect(screen.getByText("Loading")).toBeTruthy();
  expect(board.isConnected).toBe(true);
  const bridge = board.closest<HTMLElement>("[data-retained-fixed-tab-body]")!;
  expect(bridge.hidden).toBe(false);
  expect(bridge.style.position).toBe("fixed");
  expect(bridge.inert).toBe(true);
  expect(bridge.getAttribute("aria-hidden")).toBe("true");
  expect(previousOpen({ url: "test" })).toBe(false);
  expect(screen.getByTestId("visible").textContent).toBe("false");
  await act(async () => view.rerender(<Surface threadId="child" />));
  expect(screen.getByTestId("board")).toBe(board);
  expect(callbacks.get("child")!({ url: "test" })).toBe(true);
  expect({ mounts, disposals }).toEqual({ mounts: 1, disposals: 0 });
});

it("parks rather than retires when visibility temporarily removes the descriptor", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  const board = await screen.findByTestId("board");
  visible = false;
  await act(async () => view.rerender(<Surface threadId="child" />));
  expect(board.isConnected).toBe(true);
  expect(board.closest("[aria-hidden=true]")).not.toBeNull();
  visible = true;
  await act(async () => view.rerender(<Surface threadId="helper" />));
  expect(screen.getByTestId("board")).toBe(board);
  expect({ mounts, disposals }).toEqual({ mounts: 1, disposals: 0 });
});

it.each(["project", "coordinator", "generation", "null", "remove"])(
  "retires the old body and callbacks on %s invalidation",
  async (kind) => {
    install();
    markPluginFrontendsSettled();
    const view = render(<Surface threadId="coordinator" />);
    const board = await screen.findByTestId("board");
    const previousOpen = callbacks.get("coordinator")!;
    if (kind === "coordinator") identity = "new-coordinator";
    if (kind === "null") identity = null;
    await act(async () => {
      if (kind === "generation") install();
      if (kind === "remove") removePluginSlotRegistrations("example");
      view.rerender(
        <Surface
          threadId="coordinator"
          projectId={kind === "project" ? "other-project" : "project"}
        />,
      );
    });
    expect(board.isConnected).toBe(false);
    expect(previousOpen({ url: "test" })).toBe(false);
    expect(disposals).toBe(1);
    if (kind !== "remove") expect(screen.getByTestId("board")).not.toBe(board);
  },
);

it("never shares a body between two panes on the same coordinator", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(
    <>
      <Surface threadId="left" />
      <Surface threadId="right" />
    </>,
  );
  expect(await screen.findAllByTestId("board")).toHaveLength(2);
  expect(mounts).toBe(2);
  view.unmount();
  expect(disposals).toBe(2);
});

it("keeps default registrations thread-scoped inside the same native host", async () => {
  install(false);
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  const board = await screen.findByTestId("board");
  await act(async () => view.rerender(<Surface threadId="child" />));
  expect(screen.getByTestId("board")).not.toBe(board);
  expect({ mounts, disposals }).toEqual({ mounts: 2, disposals: 1 });
});

it("falls back to ordinary rendering and releases the retained body for invalid identity", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  const board = await screen.findByTestId("board");
  vi.spyOn(console, "error").mockImplementation(() => {});
  identity = "";
  await act(async () => view.rerender(<Surface threadId="child" />));
  expect(board.isConnected).toBe(false);
  expect(screen.getByTestId("board")).not.toBe(board);
  expect({ mounts, disposals }).toEqual({ mounts: 2, disposals: 1 });
});

it("revokes a captured controller when a pane loses focus without changing thread", async () => {
  const pane: PaneContextValue = {
    paneId: "pane",
    isFocused: true,
    isSplitPane: true,
    secondaryPanelHost: null,
    reservesWindowPanelToggle: false,
    onRequestClose: null,
    isMaximized: false,
    onToggleMaximize: null,
    isBoundedPane: true,
    isTopRow: true,
    ownsWindowTopLeft: false,
    navigateInPane() {},
  };
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" pane={pane} />);
  const board = await screen.findByTestId("board");
  const open = callbacks.get("coordinator")!;
  expect(open({ url: "test" })).toBe(true);
  await act(async () =>
    view.rerender(
      <Surface threadId="coordinator" pane={{ ...pane, isFocused: false }} />,
    ),
  );
  expect(screen.getByTestId("board")).toBe(board);
  expect(screen.getByTestId("visible").textContent).toBe("false");
  expect(open({ url: "test" })).toBe(false);
  await act(async () =>
    view.rerender(<Surface threadId="coordinator" pane={pane} />),
  );
  expect(screen.getByTestId("visible").textContent).toBe("true");
  expect(callbacks.get("coordinator")!({ url: "test" })).toBe(true);
});

it("observes hook-driven identity changes with unchanged host props", async () => {
  let update: (next: string) => void = () => {};
  function useIdentity() {
    const [value, setValue] = useState("coordinator");
    update = setValue;
    return value;
  }
  install(true, useIdentity);
  markPluginFrontendsSettled();
  render(<Surface threadId="coordinator" />);
  const original = await screen.findByTestId("board");
  await act(async () => update("replacement"));
  expect(original.isConnected).toBe(false);
  expect(screen.getByTestId("board")).not.toBe(original);
  expect({ mounts, disposals }).toEqual({ mounts: 2, disposals: 1 });
});

it("does not toggle read visibility during warm same-coordinator navigation", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  await screen.findByTestId("board");
  visibilityCommits.length = 0;
  await act(async () => view.rerender(<Surface threadId="child" />));
  expect(visibilityCommits).not.toContain(false);
});

function HostedSurface({
  focused = "left",
  leftThread = "left",
  leftReady = true,
}: {
  focused?: string;
  leftThread?: string;
  leftReady?: boolean;
}) {
  const registry = useMemo(createPaneSecondaryPanelRegistry, []);
  const hosts = useMemo(
    () =>
      Object.fromEntries(
        ["left", "right"].map((id) => [
          id,
          {
            clear: () => registry.clear(id),
            publish: (
              model: import("@/views/thread-detail/PaneContext").PaneSecondaryPanelViewModel,
            ) => registry.publish(id, model),
          },
        ]),
      ),
    [registry],
  );
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <SplitWorkspaceSecondaryPanelHost
          registry={registry}
          focusedPaneId={focused}
          isPaneMaximized={false}
        >
          {["left", "right"].map((id) => (
            <PaneContext.Provider
              key={id}
              value={{
                paneId: id,
                isFocused: id === focused,
                isSplitPane: true,
                secondaryPanelHost: hosts[id],
                reservesWindowPanelToggle: false,
                onRequestClose: null,
                isMaximized: false,
                onToggleMaximize: null,
                isBoundedPane: true,
                isTopRow: true,
                ownsWindowTopLeft: false,
                navigateInPane() {},
              }}
            >
              <RetainedThreadFixedTabs
                projectId="project"
                threadId={id === "left" ? leftThread : "right"}
              >
                <Host
                  threadId={id === "left" ? leftThread : "right"}
                  ready={id !== "left" || leftReady}
                  hosted
                />
              </RetainedThreadFixedTabs>
            </PaneContext.Provider>
          ))}
        </SplitWorkspaceSecondaryPanelHost>
      </QueryClientProvider>
    </MemoryRouter>
  );
}
it("retains each pane through the real external split panel host", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(<HostedSurface />);
  const left = await screen.findByTestId("board");
  const old = callbacks.get("left")!;
  fireEvent.click(screen.getByText("Collapsed"));
  left.scrollTop = 317;
  await act(async () => view.rerender(<HostedSurface leftThread="child" />));
  expect(screen.getByTestId("board")).toBe(left);
  expect(left.scrollTop).toBe(317);
  expect(old({ url: "stale" })).toBe(false);
  expect(callbacks.get("child")!({ url: "current" })).toBe(true);
  await act(async () =>
    view.rerender(<HostedSurface leftThread="cold" leftReady={false} />),
  );
  expect(left.isConnected).toBe(true);
  const container = left.closest<HTMLElement>(
    "[data-retained-fixed-tab-body]",
  )!;
  expect(container.style.position).toBe("fixed");
  expect(container.inert).toBe(true);
  expect(callbacks.get("child")!({ url: "loading" })).toBe(false);
  await act(async () => view.rerender(<HostedSurface leftThread="child" />));
  expect(screen.getByTestId("board")).toBe(left);
  await act(async () =>
    view.rerender(<HostedSurface focused="right" leftThread="child" />),
  );
  const right = screen.getAllByTestId("board").find((el) => el !== left)!;
  expect(right).toBeTruthy();
  expect(left.isConnected).toBe(true);
  expect(callbacks.get("child")!({ url: "unfocused" })).toBe(false);
  await act(async () =>
    view.rerender(<HostedSurface focused="left" leftThread="child" />),
  );
  expect(screen.getAllByTestId("board")).toContain(left);
  expect(right.isConnected).toBe(true);
  expect(left.textContent).toContain("Expanded");
  expect(mounts).toBe(2);
  expect(disposals).toBe(0);
});

it("parks rather than paints stale content over a terminal thread error", async () => {
  install();
  markPluginFrontendsSettled();
  const view = render(<Surface threadId="coordinator" />);
  const board = await screen.findByTestId("board");
  await act(async () =>
    view.rerender(<Surface threadId="missing" ready={false} loading={false} />),
  );
  const container = board.closest<HTMLElement>(
    "[data-retained-fixed-tab-body]",
  )!;
  expect(board.isConnected).toBe(true);
  expect(container.style.position).not.toBe("fixed");
  expect(screen.getByTestId("visible").textContent).toBe("false");
  expect(callbacks.get("coordinator")!({ url: "error" })).toBe(false);
});
