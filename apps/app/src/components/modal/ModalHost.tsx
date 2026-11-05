import { createElement, useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useIsCompactViewport } from "@bb/shared-ui/hooks/use-compact-viewport";
import {
  bindModalRouter,
  closeModal,
  getCoreModal,
  isDismissingModal,
  isKnownModalToken,
  publishShownModal,
  readModalFromLocationState,
  readModalFromState,
  stripModalFromLocationState,
  useModalVersion,
  type BbModalState,
} from "@/lib/modal-host";
import { usePluginSlots, type ExperimentalModalSlot } from "@/lib/plugin-slots";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import { ModalBodyBoundary, ModalBodyError } from "./ModalBodyError";
import { ModalFrame } from "./ModalFrame";

function findPluginModal(
  state: BbModalState,
  modals: readonly ExperimentalModalSlot[],
): ExperimentalModalSlot | null {
  if (state.kind !== "plugin") return null;
  return (
    modals.find(
      (slot) => slot.pluginId === state.pluginId && slot.id === state.modalId,
    ) ?? null
  );
}

function isRegistered(
  state: BbModalState,
  modals: readonly ExperimentalModalSlot[],
): boolean {
  return state.kind === "core"
    ? getCoreModal(state.modalId) !== null
    : findPluginModal(state, modals) !== null;
}

export function ModalHost() {
  const location = useLocation();
  const navigate = useNavigate();
  const { modals } = usePluginSlots();
  const compact = useIsCompactViewport();
  const [retries, setRetries] = useState<{ token: string; count: number }>({
    token: "",
    count: 0,
  });
  useModalVersion();

  useEffect(() => bindModalRouter(navigate), [navigate]);

  const located = readModalFromLocationState(location.state);
  const inHistory = readModalFromState(window.history.state);
  const agrees = located !== null && inHistory?.token === located.token;
  const known = agrees && isKnownModalToken(located.token);
  const registered = known && isRegistered(located, modals);
  const visible =
    registered && !isDismissingModal(located.token) ? located : null;
  const stale = agrees && !registered;

  useEffect(() => {
    if (!stale) return;
    void navigate(
      `${location.pathname}${location.search}${location.hash}`,
      { replace: true, state: stripModalFromLocationState(location.state) },
    );
  }, [stale, navigate, location]);

  const attempt = retries.token === visible?.token ? retries.count : 0;

  useEffect(() => {
    publishShownModal(visible);
  }, [visible]);

  const visibleToken = visible?.token ?? "";
  const retry = useCallback(
    () =>
      setRetries((value) => ({
        token: visibleToken,
        count: value.token === visibleToken ? value.count + 1 : 1,
      })),
    [visibleToken],
  );

  let body = null;
  if (visible !== null) {
    const props = { params: visible.params, compact, close: closeModal };
    const fallback = <ModalBodyError onRetry={retry} onClose={closeModal} />;
    if (visible.kind === "core") {
      const component = getCoreModal(visible.modalId);
      body =
        component === null ? null : (
          <ModalBodyBoundary
            key={`${visible.token}/${attempt}`}
            fallback={fallback}
          >
            {createElement(component, props)}
          </ModalBodyBoundary>
        );
    } else {
      const slot = findPluginModal(visible, modals);
      if (slot !== null) {
        const Component = slot.component;
        body = (
          <PluginSlotMount
            key={`${visible.token}/${attempt}/${slot.generation}`}
            pluginId={slot.pluginId}
            slotKind="modal"
            slotId={slot.id}
            crashFallback={fallback}
          >
            <Component {...props} />
          </PluginSlotMount>
        );
      }
    }
  }

  return (
    <ModalFrame
      open={visible !== null}
      title={visible?.title ?? null}
      context={visible?.context ?? null}
      onClose={closeModal}
    >
      {body}
    </ModalFrame>
  );
}
