import { preloadThreadSecondaryPanel } from "@/components/secondary-panel/lazySecondaryPanelComponents";
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Button } from "@bb/shared-ui/button";
import { useAtomValue } from "jotai";
import type {
  PluginThreadActionEntry,
  PluginThreadActionTarget,
} from "@get-bb/plugin-sdk";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@bb/shared-ui/coarse-pointer-sizing";
import { Icon } from "@bb/shared-ui/icon";
import { useAtom } from "jotai";
import { usePluginSlots } from "@/lib/plugin-slots";
import { usePluginList } from "@/hooks/queries/plugin-settings-queries";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import {
  threadHeaderPinnedAtom,
  toggleHeaderPin,
  partitionHeaderContributions,
  activateHeaderComponent,
} from "./threadHeaderPreferences";
import {
  ThreadHeaderContributionsMenu,
  type HeaderContribution,
} from "./ThreadHeaderContributionsMenu";
import {
  AppPageHeader,
  HEADER_ICON_BUTTON_CLASS,
  HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
} from "@/components/layout/AppPageHeader";
import {
  getBbDesktopInfo,
  MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
  MACOS_WINDOW_NO_DRAG_CLASS,
  shouldUseMacosDesktopChrome,
} from "@/lib/bb-desktop";
import { useIsSidebarFramed } from "@/components/ui/sidebar.js";
import { cn } from "@bb/shared-ui/lib/utils";
import {
  useAppCommandHandler,
  useAppCommandShortcut,
} from "@/components/commands/AppCommandProvider";
import { useSidebarRename } from "@/components/sidebar/SidebarInlineRename";
import { useThreadActions } from "@/components/thread/ThreadActionsProvider";
import { ThreadTitle } from "@/components/thread/ThreadTitleMentions";
import {
  useDefaultRequestRename,
  useThreadHeaderActionEntries,
} from "@/lib/thread-actions/thread-action-registry";
import { SecondaryPanelHostLayoutContext } from "@/components/secondary-panel/SecondaryPanelHostLayoutContext";
import {
  RIGHT_PANEL_TOGGLE_ICON_NAME,
  RIGHT_PANEL_TOGGLE_SHORTCUT_HINT_CLASS,
} from "@/components/secondary-panel/panelToggleControlState";
import { AppCommandShortcutHint } from "@/components/commands/AppCommandShortcutHint";
import { CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS } from "@bb/shared-ui/chrome-style-tokens";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import { usePointerCoarse } from "@bb/shared-ui/hooks/use-pointer-coarse";
import { dimInactiveSplitsAtom } from "@/lib/split-layout/atoms";
import {
  CONTEXT_INACTIVE_TEXT_CLASS,
  CONTEXT_SELECTION_SURFACE_CLASS,
} from "@bb/shared-ui/context-selection";
import { usePaneContext } from "./PaneContext";
import { PaneMaximizeButton } from "./PaneMaximizeButton";

const THREAD_HEADER_ACTION_BUTTON_CLASS = cn(
  COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
  "border-border/70 bg-transparent font-normal hover:bg-state-hover",
);
const NARROW_SPLIT_HEADER_MAX_WIDTH = 560;

export interface ThreadDetailHeaderActionsMenuArgs {
  headerContributions: ReactNode;
  includeResponsiveActions: boolean;
  headerActions: readonly PluginThreadActionEntry[];
  requestRename: (threadId: string) => void;
  onCloseAutoFocus: (event: Event) => void;
}

interface ThreadDetailHeaderProps {
  actionsMenu: ((args: ThreadDetailHeaderActionsMenuArgs) => ReactNode) | null;
  contextCardButton?: ReactNode;
  isSecondaryPanelOpen: boolean;
  onClosePane?: () => void;
  onToggleSecondaryPanel: () => void;
  thread: PluginThreadActionTarget;
  threadTitle: string;
  workspaceOpenButton?: ReactNode;
  workspaceOpenAction?: { label: string; run: () => void | Promise<unknown> };
}

export function ThreadDetailHeader({
  actionsMenu,
  isSecondaryPanelOpen,
  onClosePane,
  onToggleSecondaryPanel,
  thread,
  threadTitle,
  workspaceOpenButton,
  workspaceOpenAction,
  contextCardButton,
}: ThreadDetailHeaderProps) {
  const isCompactViewport = useIsCompactViewport();
  const isPointerCoarse = usePointerCoarse();
  const threadId = thread.id;
  const headerActions = useThreadHeaderActionEntries(thread);
  const { threadHeaderActions: componentSlots } = usePluginSlots();
  const plugins = usePluginList({ enabled: true }).data?.plugins ?? [];
  const [pinnedKeys, setPinnedKeys] = useAtom(threadHeaderPinnedAtom);
  const componentHosts = useRef(new Map<string, HTMLElement>());
  const pluginLabel = (pluginId: string, label: string) =>
    pluginId === "bb--core"
      ? label
      : `${label} · ${plugins.find((plugin) => plugin.id === pluginId)?.name ?? pluginId}`;
  const contributions: HeaderContribution[] = [
    ...componentSlots.map((slot) => {
      const key = `${slot.pluginId}/${slot.id}`;
      return {
        key,
        label: pluginLabel(slot.pluginId, slot.title),
        action: {
          label: slot.title,
          icon: "LayoutGrid" as const,
          run: async () =>
            activateHeaderComponent(componentHosts.current.get(key)),
        },
      };
    }),
    ...headerActions.map((entry) => ({
      ...entry,
      label: pluginLabel(entry.pluginId, entry.action.label),
    })),
    ...(workspaceOpenButton
      ? [
          {
            key: "bb--core/open",
            label: workspaceOpenAction?.label ?? "Open workspace",
            action: {
              label: workspaceOpenAction?.label ?? "Open workspace",
              icon: "FolderOpen" as const,
              run: async () => {
                if (workspaceOpenAction) await workspaceOpenAction.run();
              },
            },
          },
        ]
      : []),
  ];
  const { pinned, more } = partitionHeaderContributions(
    contributions,
    pinnedKeys,
  );
  const { renameThreadAsync } = useThreadActions();
  const handleRename = useCallback(
    (nextTitle: string) => renameThreadAsync(threadId, nextTitle),
    [renameThreadAsync, threadId],
  );
  const { editor, isEditing, startEditing } = useSidebarRename({
    kind: "thread",
    id: threadId,
    name: threadTitle,
    label: "Thread name",
    onSave: handleRename,
  });
  const requestRenameDialog = useDefaultRequestRename();
  const pendingMenuRename = useRef(false);
  const requestRename = (id: string) => {
    if (isCompactViewport || isPointerCoarse) requestRenameDialog(id);
    else startEditing();
  };
  const requestRenameFromMenu = (id: string) => {
    if (isCompactViewport || isPointerCoarse) requestRenameDialog(id);
    else pendingMenuRename.current = true;
  };
  const handleActionsMenuCloseAutoFocus = (event: Event) => {
    if (!pendingMenuRename.current) return;
    pendingMenuRename.current = false;
    event.preventDefault();
    startEditing();
  };
  const [desktopInfo] = useState(getBbDesktopInfo);
  const dimsInactiveSplits = useAtomValue(dimInactiveSplitsAtom);
  const panelShortcut = useAppCommandShortcut("panel.toggle");
  const usesDesktopChrome = shouldUseMacosDesktopChrome(desktopInfo);
  const isSidebarFramed = useIsSidebarFramed();
  const headerRef = useRef<HTMLElement>(null!);
  const {
    beginPaneDrag,
    isFocused,
    isTopRow,
    ownsWindowTopLeft,
    reservesWindowPanelToggle,
    secondaryPanelHost,
  } = usePaneContext();
  useAppCommandHandler("thread.rename", () => {
    if (!isFocused) return false;
    requestRename(threadId);
    return true;
  });
  const isWindowPanelOpen =
    useContext(SecondaryPanelHostLayoutContext)?.isOpen === true;
  const isSplitPaneHeader = beginPaneDrag !== undefined;
  const [measuredPaneWidth, setMeasuredPaneWidth] = useState(0);
  const usesResponsiveActionOverflow =
    isCompactViewport ||
    (isSplitPaneHeader &&
      measuredPaneWidth > 0 &&
      measuredPaneWidth < NARROW_SPLIT_HEADER_MAX_WIDTH);
  useLayoutEffect(() => {
    if (!isSplitPaneHeader) {
      return;
    }

    const header = headerRef.current;
    const pane = header.closest<HTMLElement>("[data-split-pane-id]");
    const measuredElement = pane ?? header;
    const measure = () => {
      const width = measuredElement.getBoundingClientRect().width;
      if (width > 0) {
        setMeasuredPaneWidth(width);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(measuredElement);
    return () => {
      observer.disconnect();
    };
  }, [isSplitPaneHeader]);
  const handleTitlePointerDown = (event: ReactPointerEvent) => {
    if (isEditing || !beginPaneDrag || event.button !== 0) {
      return;
    }
    beginPaneDrag(event, threadTitle);
  };
  const handleTitleDoubleClick = () => {
    if (isEditing || isPointerCoarse) {
      return;
    }
    startEditing();
  };
  const rightPanelIconName = RIGHT_PANEL_TOGGLE_ICON_NAME;
  const mountRightPanelToggle = secondaryPanelHost === null;
  const showRightPanelToggle =
    mountRightPanelToggle && (!isSecondaryPanelOpen || isCompactViewport);
  const rightPanelLabel =
    isSecondaryPanelOpen && showRightPanelToggle
      ? "Hide right panel"
      : "Show right panel";

  const center = (
    <>
      <div
        data-pane-header-focus-tab={
          isSplitPaneHeader && isFocused ? "" : undefined
        }
        className={cn(
          "relative min-w-0",
          isSplitPaneHeader && "-my-1 -ml-2 rounded-md px-2 py-1",
          isSplitPaneHeader && isFocused && CONTEXT_SELECTION_SURFACE_CLASS,
        )}
      >
        <p
          className={cn(
            "relative min-w-0 text-sm font-normal transition-colors",
            isEditing && "overflow-visible",
            isSplitPaneHeader &&
              !isFocused &&
              dimsInactiveSplits &&
              CONTEXT_INACTIVE_TEXT_CLASS,
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
            beginPaneDrag && !isEditing && "cursor-grab touch-none select-none",
          )}
          onDoubleClick={handleTitleDoubleClick}
          onPointerDown={beginPaneDrag ? handleTitlePointerDown : undefined}
        >
          {isEditing ? editor : <ThreadTitle title={threadTitle} />}
        </p>
      </div>
      {actionsMenu == null ? null : (
        <span
          className={cn(
            "flex items-center",
            usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
          )}
        >
          {actionsMenu({
            headerContributions: (
              <ThreadHeaderContributionsMenu
                pinned={pinned}
                more={more}
                onToggle={(key) =>
                  setPinnedKeys((previous) => toggleHeaderPin(previous, key))
                }
              />
            ),
            includeResponsiveActions: usesResponsiveActionOverflow,
            headerActions,
            requestRename: requestRenameFromMenu,
            onCloseAutoFocus: handleActionsMenuCloseAutoFocus,
          })}
        </span>
      )}
    </>
  );

  const actions = (
    <>
      <div
        className="flex items-center gap-1"
        data-thread-header-workflow-actions=""
      >
        {componentSlots.map((slot) => {
          const key = `${slot.pluginId}/${slot.id}`;
          const Component = slot.component;
          const visible =
            !usesResponsiveActionOverflow && pinnedKeys.includes(key);
          return (
            <div
              key={`${key}/${slot.generation}/${threadId}`}
              ref={(host) => {
                if (host) componentHosts.current.set(key, host);
                else componentHosts.current.delete(key);
              }}
              hidden={!visible}
              style={{
                display: visible ? "flex" : "none",
                order: pinned.findIndex((item) => item.key === key),
              }}
              className="max-h-7 max-w-64 shrink-0 items-center"
              data-thread-header-component={key}
            >
              <PluginSlotMount
                pluginId={slot.pluginId}
                slotKind="threadHeaderAction"
                slotId={slot.id}
                instanceId={threadId}
                crashFallback={null}
              >
                <Component
                  threadId={threadId}
                  projectId={thread.projectId}
                  isCompactViewport={isCompactViewport}
                />
              </PluginSlotMount>
            </div>
          );
        })}
        {!usesResponsiveActionOverflow
          ? pinned.map((item, order) => {
              if (
                componentSlots.some(
                  (slot) => `${slot.pluginId}/${slot.id}` === item.key,
                )
              )
                return null;
              return (
                <span
                  key={item.key}
                  style={{ order }}
                  className="inline-flex shrink-0"
                  data-thread-header-responsive-action=""
                >
                  {item.key === "bb--core/open" ? (
                    workspaceOpenButton
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className={THREAD_HEADER_ACTION_BUTTON_CLASS}
                      disabled={item.action.disabled}
                      onClick={() => void item.action.run()}
                    >
                      {item.action.label}
                    </Button>
                  )}
                </span>
              );
            })
          : null}
      </div>
      <div
        className="ml-1 flex items-center gap-0.5"
        data-thread-header-pane-actions=""
      >
        <PaneMaximizeButton />
        {onClosePane ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_PANE_ACTION_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
            )}
            aria-label="Close pane"
            onClick={onClosePane}
          >
            <Icon name="CloseThreadPane" />
          </Button>
        ) : null}
        {contextCardButton}
        {mountRightPanelToggle ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              CHROME_SUBTLE_ICON_BUTTON_FOREGROUND_CLASS,
              "relative",
              usesDesktopChrome && MACOS_WINDOW_NO_DRAG_CLASS,
              isTopRow &&
                isSidebarFramed &&
                MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
              !showRightPanelToggle && "hidden",
            )}
            inert={!showRightPanelToggle}
            aria-label={
              panelShortcut
                ? `${rightPanelLabel} (${panelShortcut.label})`
                : rightPanelLabel
            }
            aria-keyshortcuts={panelShortcut?.ariaKeyshortcuts}
            aria-expanded={isSecondaryPanelOpen}
            onPointerEnter={preloadThreadSecondaryPanel}
            onFocus={preloadThreadSecondaryPanel}
            onPointerDown={preloadThreadSecondaryPanel}
            onClick={onToggleSecondaryPanel}
          >
            <Icon name={rightPanelIconName} />
            <AppCommandShortcutHint
              shortcut={panelShortcut}
              className={RIGHT_PANEL_TOGGLE_SHORTCUT_HINT_CLASS}
            />
          </Button>
        ) : null}
        {reservesWindowPanelToggle && !isWindowPanelOpen ? (
          <span
            aria-hidden
            className={cn(
              HEADER_ICON_BUTTON_CLASS,
              isTopRow &&
                isSidebarFramed &&
                MACOS_TITLE_BAR_TRAILING_TOGGLE_CLASS,
            )}
          />
        ) : null}
      </div>
    </>
  );

  return (
    <AppPageHeader
      headerRef={headerRef}
      center={center}
      actions={actions}
      isWindowDragRegion={isTopRow}
      ownsWindowTopLeft={ownsWindowTopLeft}
      className={beginPaneDrag ? "z-[21]" : undefined}
    />
  );
}
