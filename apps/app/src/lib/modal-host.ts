import { useSyncExternalStore, type ComponentType } from "react";
import type { Location, NavigateFunction } from "react-router-dom";
import type {
  ExperimentalModalOpenOptions,
  ExperimentalModalParams,
  ExperimentalModalProps,
} from "@get-bb/plugin-sdk";
import {
  installModalDriver,
  type ModalDriver,
} from "@get-bb/plugin-sdk/internal/plugin-app-collector";

export const CORE_MODAL_PREFIX = "core/";
export const MODAL_TEXT_LIMIT = 200;
export const MODAL_STATE_LIMIT_BYTES = 16 * 1024;
const DISMISS_FALLBACK_MS = 1000;
const DISMISS_GIVE_UP_MS = 5000;

export type BbModalTarget =
  | { kind: "plugin"; pluginId: string; modalId: string }
  | { kind: "core"; modalId: string };

export type BbModalState = BbModalTarget & {
  v: 1;
  token: string;
  title: string;
  context?: string;
  params: ExperimentalModalParams;
};

interface QueuedOpen {
  target: BbModalTarget;
  options: ExperimentalModalOpenOptions;
}

const coreModals = new Map<string, ComponentType<ExperimentalModalProps>>();
const knownTokens = new Set<string>();
const openers = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
let navigateRef: NavigateFunction | null = null;
let dismissing: string | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let queued: QueuedOpen | null = null;
let shown: BbModalState | null = null;
let version = 0;
let warnedUnbound = false;

function notify(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseModalState(value: unknown): BbModalState | null {
  if (!isRecord(value) || value.v !== 1) return null;
  const { token, kind, modalId, title, context, params, pluginId } = value;
  if (
    typeof token !== "string" ||
    typeof modalId !== "string" ||
    typeof title !== "string" ||
    (context !== undefined && typeof context !== "string") ||
    params === undefined
  ) {
    return null;
  }
  const base = {
    v: 1 as const,
    token,
    modalId,
    title,
    ...(context === undefined ? {} : { context }),
    params: params as ExperimentalModalParams,
  };
  if (kind === "core") return { ...base, kind };
  if (kind === "plugin" && typeof pluginId === "string") {
    return { ...base, kind, pluginId };
  }
  return null;
}

export function readModalFromState(state: unknown): BbModalState | null {
  if (!isRecord(state)) return null;
  const usr = state.usr;
  if (!isRecord(usr)) return null;
  return parseModalState(usr.bbModal);
}

export function readModalFromLocationState(
  locationState: unknown,
): BbModalState | null {
  if (!isRecord(locationState)) return null;
  return parseModalState(locationState.bbModal);
}

export function stripModalFromLocationState(locationState: unknown): unknown {
  if (!isRecord(locationState)) return locationState ?? null;
  const rest = { ...locationState };
  delete rest.bbModal;
  return Object.keys(rest).length === 0 ? null : rest;
}

export function isModalOnlyTransition(
  previous: Location,
  next: Location,
): boolean {
  return (
    previous.pathname === next.pathname &&
    previous.search === next.search &&
    previous.hash === next.hash &&
    (readModalFromLocationState(previous.state)?.token ?? null) !==
      (readModalFromLocationState(next.state)?.token ?? null)
  );
}

function readHistoryModal(): BbModalState | null {
  return readModalFromState(window.history.state);
}

export function isKnownModalToken(token: string): boolean {
  return knownTokens.has(token);
}

export function isDismissingModal(token: string): boolean {
  return dismissing === token;
}

export function getModalOpener(token: string): HTMLElement | null {
  return openers.get(token) ?? null;
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`experimental_modal: ${path} is not a finite number`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new Error(
      `experimental_modal: ${path} is not JSON (${typeof value})`,
    );
  }
  if (ancestors.has(value)) {
    throw new Error(`experimental_modal: ${path} contains a cycle`);
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new Error(`experimental_modal: ${path} is not a plain object`);
  }
  ancestors.add(value);
  if (isArray) {
    value.forEach((item, index) =>
      assertJsonValue(item, `${path}[${index}]`, ancestors),
    );
  } else {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertText(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`experimental_modal: ${name} must be a string`);
  }
  if (value.length > MODAL_TEXT_LIMIT) {
    throw new Error(
      `experimental_modal: ${name} is longer than ${MODAL_TEXT_LIMIT} characters`,
    );
  }
}

function newToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

function buildState(
  target: BbModalTarget,
  options: ExperimentalModalOpenOptions,
): BbModalState {
  assertText("title", options?.title);
  if (options.context !== undefined) assertText("context", options.context);
  const params = options.params ?? null;
  assertJsonValue(params, "params", new Set());
  const state: BbModalState = {
    ...target,
    v: 1,
    token: newToken(),
    title: options.title,
    ...(options.context === undefined ? {} : { context: options.context }),
    params,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(state)).length;
  if (bytes > MODAL_STATE_LIMIT_BYTES) {
    throw new Error(
      `experimental_modal: the modal state is ${bytes} bytes, over the ${MODAL_STATE_LIMIT_BYTES} byte limit; keep an id in params and the data in the plugin's own store`,
    );
  }
  return state;
}

function currentUrl(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}

function openNow(target: BbModalTarget, options: ExperimentalModalOpenOptions) {
  const navigate = navigateRef;
  if (navigate === null) {
    throw new Error("experimental_modal: the modal host is not mounted");
  }
  const state = buildState(target, options);
  const showing = readHistoryModal();
  const active = document.activeElement;
  const opener =
    (showing !== null ? openers.get(showing.token) : undefined) ??
    (active instanceof HTMLElement && active !== document.body ? active : null);
  if (showing !== null) {
    knownTokens.delete(showing.token);
    openers.delete(showing.token);
  }
  knownTokens.add(state.token);
  if (opener !== null) openers.set(state.token, opener);
  void navigate(currentUrl(), {
    replace: showing !== null,
    state: { bbModal: state },
  });
}

function openTarget(
  target: BbModalTarget,
  options: ExperimentalModalOpenOptions,
): void {
  if (dismissing !== null) {
    buildState(target, options);
    queued = { target, options };
    return;
  }
  openNow(target, options);
}

function finishDismiss(): void {
  if (dismissTimer !== null) clearTimeout(dismissTimer);
  dismissTimer = null;
  dismissing = null;
  const next = queued;
  queued = null;
  notify();
  if (next !== null) openNow(next.target, next.options);
}

function onPopState(): void {
  if (dismissing !== null) finishDismiss();
}

export function closeModal(): void {
  const navigate = navigateRef;
  const showing = readHistoryModal();
  if (
    navigate === null ||
    showing === null ||
    dismissing !== null ||
    !knownTokens.has(showing.token)
  ) {
    return;
  }
  dismissing = showing.token;
  const token = showing.token;
  const startedAt = Date.now();
  const arm = () => {
    dismissTimer = setTimeout(() => {
      if (dismissing !== token) return;
      const stillShowing = readHistoryModal()?.token === token;
      if (stillShowing && Date.now() - startedAt < DISMISS_GIVE_UP_MS) {
        arm();
        return;
      }
      finishDismiss();
    }, DISMISS_FALLBACK_MS);
  };
  arm();
  notify();
  void navigate(-1);
}

export function openCoreModal(
  modalId: string,
  options: ExperimentalModalOpenOptions,
): void {
  if (!coreModals.has(modalId)) {
    throw new Error(`experimental_modal: "${modalId}" is not a core modal`);
  }
  openTarget({ kind: "core", modalId }, options);
}

export function registerCoreModal(
  modalId: string,
  component: ComponentType<ExperimentalModalProps>,
): () => void {
  if (!modalId.startsWith(CORE_MODAL_PREFIX)) {
    throw new Error(
      `registerCoreModal: id "${modalId}" must start with "${CORE_MODAL_PREFIX}"`,
    );
  }
  if (coreModals.has(modalId)) {
    throw new Error(`registerCoreModal: "${modalId}" is already registered`);
  }
  coreModals.set(modalId, component);
  notify();
  return () => {
    if (coreModals.get(modalId) === component) {
      coreModals.delete(modalId);
      notify();
    }
  };
}

export function getCoreModal(
  modalId: string,
): ComponentType<ExperimentalModalProps> | null {
  return coreModals.get(modalId) ?? null;
}

export function bindModalRouter(navigate: NavigateFunction): () => void {
  navigateRef = navigate;
  window.addEventListener("popstate", onPopState);
  return () => {
    if (navigateRef === navigate) navigateRef = null;
    window.removeEventListener("popstate", onPopState);
  };
}

export function publishShownModal(next: BbModalState | null): void {
  if (shown?.token === next?.token) return;
  shown = next;
  notify();
}

export function useModalVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => version,
  );
}

const hostDriver: ModalDriver = {
  open(pluginId, modalId, options) {
    if (pluginId === null) {
      const message =
        "experimental_modal: this handle is not bound to a plugin, so it cannot open a modal";
      if (import.meta.env.DEV) throw new Error(message);
      if (!warnedUnbound) {
        warnedUnbound = true;
        console.warn(message);
      }
      return;
    }
    openTarget({ kind: "plugin", pluginId, modalId }, options);
  },
  close: closeModal,
  subscribe,
  getOpenId(pluginId) {
    if (pluginId === null || shown === null) return null;
    return shown.kind === "plugin" && shown.pluginId === pluginId
      ? shown.modalId
      : null;
  },
};

installModalDriver(hostDriver);

export function resetModalHostForTest(): void {
  if (dismissTimer !== null) clearTimeout(dismissTimer);
  dismissTimer = null;
  dismissing = null;
  queued = null;
  shown = null;
  navigateRef = null;
  warnedUnbound = false;
  knownTokens.clear();
  openers.clear();
  coreModals.clear();
  notify();
}
