import { useContext, useMemo, type ReactNode } from "react";
import {
  AppNavigationHostProvider,
  useAppNavigationHost,
} from "@/lib/app-navigation-host";
import { UNAVAILABLE_APP_PANEL_CONTROLLER } from "@/lib/app-fixed-tab-navigation";
import {
  MarkdownLocalFileContextMenuContext,
  MarkdownLocalFileOpenTargetsContext,
} from "@/components/ui/markdown-link-routing";
import { AttachmentOpenerContext } from "@/components/secondary-panel/AttachmentOpenerContext";
import { SelectionAddToChatContext } from "@/components/thread/SelectionAddToChatContext";
import { InAppBrowserUrlOpenContext } from "@/lib/url-open-routing";
import { ThreadTimelineNavigationContext } from "@/components/thread/timeline/ThreadTimelineNavigationContext";
import type { MarkdownLocalFileContextMenuItem } from "@/components/ui/markdown-link-routing";
import { ThreadProviderContext } from "@/components/thread/thread-provider-context";

export function useRetainedThreadTabFrame() {
  const host = useAppNavigationHost();
  const openInAppBrowser = useContext(InAppBrowserUrlOpenContext);
  const timeline = useContext(ThreadTimelineNavigationContext);
  const menu = useContext(MarkdownLocalFileContextMenuContext);
  const targets = useContext(MarkdownLocalFileOpenTargetsContext);
  const attachment = useContext(AttachmentOpenerContext);
  const selection = useContext(SelectionAddToChatContext);
  const provider = useContext(ThreadProviderContext);
  return useMemo(
    () => (children: ReactNode, allowed: () => boolean) => {
      const panel = {
        ...host.panel,
        getTabs: () =>
          allowed()
            ? host.panel.getTabs()
            : UNAVAILABLE_APP_PANEL_CONTROLLER.getTabs(),
        subscribeTabs: (listener: () => void) =>
          host.panel.subscribeTabs(() => {
            if (allowed()) listener();
          }),
        renderTabIcon: (key: string) =>
          allowed() ? host.panel.renderTabIcon(key) : null,
        openTab: (intent: Parameters<typeof host.panel.openTab>[0]) =>
          allowed() && host.panel.openTab(intent),
        toggleTab: (intent: Parameters<typeof host.panel.toggleTab>[0]) =>
          allowed() && host.panel.toggleTab(intent),
        close: () => allowed() && host.panel.close(),
        selectTab: (key: string) => allowed() && host.panel.selectTab(key),
        closeTab: (key: string) => allowed() && host.panel.closeTab(key),
        publishTabs: UNAVAILABLE_APP_PANEL_CONTROLLER.publishTabs,
      };
      const capabilities = {
        panel,
        openFilePreview: (intent: Parameters<typeof host.openFilePreview>[0]) =>
          allowed() && host.openFilePreview(intent),
        openFileExternally: (
          intent: Parameters<typeof host.openFileExternally>[0],
        ) => allowed() && host.openFileExternally(intent),
        openTerminal: (intent: Parameters<typeof host.openTerminal>[0]) =>
          allowed() && host.openTerminal(intent),
        openUrl: (intent: Parameters<typeof host.openUrl>[0]) =>
          allowed() && host.openUrl(intent),
      };
      const guardMenuItem = (
        item: MarkdownLocalFileContextMenuItem,
      ): MarkdownLocalFileContextMenuItem => {
        if (item.type === "separator") return item;
        if (item.type === "submenu")
          return {
            ...item,
            items: item.items.map((child) =>
              child.type === "separator"
                ? child
                : {
                    ...child,
                    onSelect: () => {
                      if (allowed()) child.onSelect();
                    },
                  },
            ),
          };
        return {
          ...item,
          onSelect: () => {
            if (allowed()) item.onSelect();
          },
        };
      };
      const guardedMenu = menu
        ? (link: Parameters<typeof menu>[0]) =>
            allowed() ? (menu(link)?.map(guardMenuItem) ?? null) : null
        : null;
      const guardedTimeline = timeline
        ? {
            ...timeline,
            onOpenLocalFileLink: (
              ...args: Parameters<typeof timeline.onOpenLocalFileLink>
            ) => {
              return allowed() && timeline.onOpenLocalFileLink(...args);
            },
          }
        : null;
      return (
        <InAppBrowserUrlOpenContext.Provider
          value={
            openInAppBrowser
              ? (url) => {
                  if (allowed()) openInAppBrowser(url);
                }
              : null
          }
        >
          <ThreadTimelineNavigationContext.Provider
            value={allowed() ? guardedTimeline : null}
          >
            <AppNavigationHostProvider capabilities={capabilities}>
              <ThreadProviderContext.Provider value={provider}>
                <MarkdownLocalFileOpenTargetsContext.Provider
                  value={allowed() ? targets : []}
                >
                  <MarkdownLocalFileContextMenuContext.Provider
                    value={guardedMenu}
                  >
                    <AttachmentOpenerContext.Provider
                      value={
                        attachment
                          ? (request) => {
                              if (allowed()) attachment(request);
                            }
                          : null
                      }
                    >
                      <SelectionAddToChatContext.Provider
                        value={
                          selection
                            ? (text) => {
                                if (allowed()) selection(text);
                              }
                            : undefined
                        }
                      >
                        {children}
                      </SelectionAddToChatContext.Provider>
                    </AttachmentOpenerContext.Provider>
                  </MarkdownLocalFileContextMenuContext.Provider>
                </MarkdownLocalFileOpenTargetsContext.Provider>
              </ThreadProviderContext.Provider>
            </AppNavigationHostProvider>
          </ThreadTimelineNavigationContext.Provider>
        </InAppBrowserUrlOpenContext.Provider>
      );
    },
    [
      host,
      menu,
      targets,
      attachment,
      selection,
      provider,
      openInAppBrowser,
      timeline,
    ],
  );
}
