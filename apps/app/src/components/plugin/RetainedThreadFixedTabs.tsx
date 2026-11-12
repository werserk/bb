import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { ExperimentalThreadEnvironment } from "@get-bb/plugin-sdk";
import {
  isThreadTab,
  usePluginSlots,
  type PluginThreadFixedTabSlot,
} from "@/lib/plugin-slots";
import {
  FixedTabTargetScope,
  getThreadFixedTabOwnerId,
} from "@/lib/app-fixed-tab-navigation";
import { createPluginFixedPanelTab } from "@/lib/fixed-panel-tabs-state";
import {
  TabVisibleContext,
  useTabVisible,
} from "@/components/secondary-panel/tab-visibility";
import { useOptionalPaneContext } from "@/views/thread-detail/PaneContext";
import { PluginTabScope } from "./PluginTabs";
import { useRetainedThreadTabContainer } from "./RetainedThreadTabContainer";
import { useRetainedThreadTabFrame } from "./RetainedThreadTabFrame";

type HostState = {
  threadId: string;
  ready: boolean;
  open: boolean;
  activeTabId: string | null;
  environment?: ExperimentalThreadEnvironment | null;
};
type Frame = ReturnType<typeof useRetainedThreadTabFrame>;
type Outlet = {
  element: HTMLDivElement;
  threadId: string;
  environment: ExperimentalThreadEnvironment | null;
  visible: boolean;
  frame: Frame;
};
type Entry = {
  retained: boolean;
  attach(outlet: Outlet): void;
  detach(element: HTMLDivElement): void;
};
const slotKey = (slot: PluginThreadFixedTabSlot) =>
  JSON.stringify([slot.pluginId, slot.id, slot.generation]);

function createRegistry() {
  let entries = new Map<string, Entry>();
  let state: HostState | null = null;
  const listeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => entries,
    subscribeState(listener: () => void) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    getState: () => state,
    publishState(next: HostState) {
      state = next;
      stateListeners.forEach((notify) => notify());
    },
    register(key: string, entry: Entry) {
      entries = new Map(entries).set(key, entry);
      listeners.forEach((notify) => notify());
      return () => {
        if (entries.get(key) !== entry) return;
        entries = new Map(entries);
        entries.delete(key);
        listeners.forEach((notify) => notify());
      };
    },
  };
}
type Registry = ReturnType<typeof createRegistry>;
const RetainedTabsContext = createContext<Registry | null>(null);

export function RetainedThreadFixedTabs({
  projectId,
  threadId,
  children,
}: {
  projectId: string;
  threadId: string;
  children: ReactNode;
}) {
  const fallbackId = useId();
  const pane = useOptionalPaneContext();
  const scope = JSON.stringify([pane?.paneId ?? fallbackId, projectId]);
  const registry = useMemo(createRegistry, [scope]);
  const { tabs } = usePluginSlots();
  const slots = tabs
    .filter(isThreadTab)
    .filter(
      (slot): slot is PluginThreadFixedTabSlot => slot.availability === "fixed",
    )
    .filter((slot) => slot.experimental_useContinuityKey !== undefined);
  return (
    <RetainedTabsContext.Provider value={registry}>
      {children}
      {slots.map((slot) => (
        <PluginTabScope
          key={JSON.stringify([projectId, slotKey(slot)])}
          slot={slot}
          instanceId={`${scope}/continuity-identity`}
          crashFallback={
            <OrdinaryRegistration slot={slot} registry={registry} />
          }
        >
          <Registration
            slot={slot}
            registry={registry}
            projectId={projectId}
            threadId={threadId}
            scope={scope}
          />
        </PluginTabScope>
      ))}
    </RetainedTabsContext.Provider>
  );
}

export function useRetainedThreadTabHostState(state: HostState) {
  const registry = useContext(RetainedTabsContext);
  useLayoutEffect(() => {
    registry?.publishState(state);
  }, [
    registry,
    state.threadId,
    state.ready,
    state.open,
    state.activeTabId,
    state.environment,
  ]);
}

function OrdinaryRegistration({
  slot,
  registry,
}: {
  slot: PluginThreadFixedTabSlot;
  registry: Registry;
}) {
  useLayoutEffect(
    () =>
      registry.register(slotKey(slot), {
        retained: false,
        attach() {},
        detach() {},
      }),
    [registry, slot],
  );
  return null;
}

function Registration({
  slot,
  registry,
  projectId,
  threadId,
  scope,
}: {
  slot: PluginThreadFixedTabSlot;
  registry: Registry;
  projectId: string;
  threadId: string;
  scope: string;
}) {
  const state = useSyncExternalStore(
    registry.subscribeState,
    registry.getState,
    registry.getState,
  );
  const useContinuityKey = slot.experimental_useContinuityKey!;
  const key = useContinuityKey({
    projectId,
    threadId,
    environment:
      state?.threadId === threadId ? (state.environment ?? null) : null,
  });
  if (
    key !== null &&
    (typeof key !== "string" || key.length === 0 || key.length > 256)
  )
    throw new Error("Invalid fixed-tab continuity key");
  return (
    <Instance
      key={JSON.stringify([projectId, key ?? [threadId]])}
      slot={slot}
      registry={registry}
      threadId={threadId}
      identity={key}
      scope={scope}
    />
  );
}

function Instance({
  slot,
  registry,
  threadId,
  identity,
  scope,
}: {
  slot: PluginThreadFixedTabSlot;
  registry: Registry;
  threadId: string;
  identity: string | null;
  scope: string;
}) {
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [lastOutlet, setLastOutlet] = useState<Outlet | null>(null);
  const [demanded, setDemanded] = useState(false);

  const alive = useRef(false);
  const currentOutlet = useRef<Outlet | null>(null);

  const state = useSyncExternalStore(
    registry.subscribeState,
    registry.getState,
    registry.getState,
  );
  const pane = useOptionalPaneContext();
  const currentHost = useRef({ threadId, focused: pane?.isFocused ?? true });
  currentHost.current = { threadId, focused: pane?.isFocused ?? true };
  const tabId = createPluginFixedPanelTab({
    pluginId: slot.pluginId,
    tabId: slot.id,
  }).id;
  const current = state?.threadId === threadId;
  const selected =
    current &&
    state.open &&
    state.activeTabId === tabId &&
    (pane?.isFocused ?? true);
  const attached = !!(
    selected &&
    state.ready &&
    outlet?.threadId === threadId &&
    outlet.visible
  );
  const placement = useRetainedThreadTabContainer({
    attached,
    bridge: !!(selected && !state.ready),
    outlet,
    tabId: slot.id,
  });
  const { container, parking } = placement;
  const latestPlacement = useRef(placement);
  latestPlacement.current = placement;
  const entry = useMemo<Entry>(
    () => ({
      retained: identity !== null,
      attach(next) {
        currentOutlet.current = next;
        setOutlet(next);
        setLastOutlet(next);
        setDemanded(true);
      },
      detach(element) {
        if (currentOutlet.current?.element !== element) return;
        latestPlacement.current.capture(element);
        currentOutlet.current = null;
        setOutlet(null);
        latestPlacement.current.park();
      },
    }),
    [identity],
  );
  useLayoutEffect(() => {
    alive.current = true;
    const unregister = registry.register(slotKey(slot), entry);
    return () => {
      alive.current = false;
      unregister();
      container.remove();
    };
  }, [registry, slot, entry, container]);
  const allowed = useCallback(() => {
    const latest = registry.getState();
    return (
      alive.current &&
      currentHost.current.threadId === threadId &&
      currentHost.current.focused &&
      latest?.threadId === threadId &&
      latest.ready &&
      latest.open &&
      latest.activeTabId === tabId &&
      currentOutlet.current?.threadId === threadId &&
      currentOutlet.current.visible &&
      (pane?.isFocused ?? true)
    );
  }, [registry, threadId, tabId, pane?.isFocused]);
  const Component = slot.component;
  const frame = outlet ?? lastOutlet;
  return (
    <>
      <div ref={parking} data-retained-fixed-tab={slot.id} />
      {identity !== null && demanded && frame
        ? createPortal(
            frame.frame(
              <PluginTabScope
                slot={slot}
                instanceId={JSON.stringify([scope, identity])}
              >
                <FixedTabTargetScope
                  ownerId={getThreadFixedTabOwnerId(slot.pluginId)}
                  tabId={slot.id}
                  targetKey={`${threadId}\0${getThreadFixedTabOwnerId(slot.pluginId)}\0${slot.id}`}
                >
                  <TabVisibleContext.Provider value={!!attached}>
                    <Component
                      threadId={threadId}
                      environment={
                        outlet?.threadId === threadId
                          ? outlet.environment
                          : null
                      }
                    />
                  </TabVisibleContext.Provider>
                </FixedTabTargetScope>
              </PluginTabScope>,
              allowed,
            ),
            container,
          )
        : null}
    </>
  );
}

function OutletBinding({
  entry,
  threadId,
  environment,
}: {
  entry: Entry;
  threadId: string;
  environment: ExperimentalThreadEnvironment | null;
}) {
  const element = useRef<HTMLDivElement>(null);
  const visible = useTabVisible();
  const frame = useRetainedThreadTabFrame();
  useLayoutEffect(() => {
    if (!element.current) return;
    const target = element.current;
    entry.attach({ element: target, threadId, environment, visible, frame });
    return () => entry.detach(target);
  }, [entry, threadId, environment, visible, frame]);
  return (
    <div
      ref={element}
      className="flex h-full min-h-0 min-w-0 flex-1 flex-col"
    />
  );
}

export function RetainedThreadFixedTabOutlet({
  slot,
  threadId,
  environment,
  children,
}: {
  slot: PluginThreadFixedTabSlot;
  threadId: string;
  environment: ExperimentalThreadEnvironment | null;
  children: ReactNode;
}) {
  const registry = useContext(RetainedTabsContext);
  if (!registry || slot.experimental_useContinuityKey === undefined)
    return children;
  return (
    <ResolvedOutlet
      registry={registry}
      slot={slot}
      threadId={threadId}
      environment={environment}
    >
      {children}
    </ResolvedOutlet>
  );
}

function ResolvedOutlet({
  registry,
  slot,
  threadId,
  environment,
  children,
}: {
  registry: Registry;
  slot: PluginThreadFixedTabSlot;
  threadId: string;
  environment: ExperimentalThreadEnvironment | null;
  children: ReactNode;
}) {
  const entries = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot,
  );
  const entry = entries.get(slotKey(slot));
  if (!entry) return null;
  if (!entry.retained) return children;
  return (
    <OutletBinding
      entry={entry}
      threadId={threadId}
      environment={environment}
    />
  );
}
