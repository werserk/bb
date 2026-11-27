import {
  requireComponent,
  requireEnvironmentProviderId,
  requireNonEmptyString,
  requireOptionalString,
  requireSlotId,
  requireUniqueId,
} from "../internal/composer-customization-validation.js";
import type {
  ExperimentalComposerRunRowItemRegistration,
  ExperimentalRunOnProviderRegistration,
} from "./run-on-contract.js";
import type { PluginAppSlots } from "../app-contract.js";

export const RUN_ON_SLOT_VERSION = 1;

function knownVersion(
  kind: string,
  value: unknown,
  onWarning: (message: string) => void,
): boolean {
  if (value === RUN_ON_SLOT_VERSION) return true;
  onWarning(
    `${kind}: version ${JSON.stringify(value)} is not supported by this bb (supports ${RUN_ON_SLOT_VERSION}); skipped`,
  );
  return false;
}

function optionalOrder(kind: string, value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${kind}: "order" must be a finite number when set`);
  }
  return value;
}

function requireHook<T>(kind: string, field: string, value: unknown): T {
  if (typeof value !== "function") {
    throw new Error(`${kind}: "${field}" must be a function`);
  }
  return value as T;
}

export function collectRunOnProvider(
  value: unknown,
  seen: Set<string>,
  onWarning: (message: string) => void,
): ExperimentalRunOnProviderRegistration | null {
  const kind = "slots.experimental_runOnProvider";
  const registration = value as Partial<ExperimentalRunOnProviderRegistration>;
  if (!knownVersion(kind, registration?.version, onWarning)) return null;
  const environmentProviderId = requireEnvironmentProviderId(
    kind,
    registration.environmentProviderId,
  );
  requireUniqueId(kind, seen, environmentProviderId);
  const description = requireOptionalString(
    kind,
    "description",
    registration.description,
  );
  const order = optionalOrder(kind, registration.order);
  const ThreadActions = registration.ThreadActions;
  if (ThreadActions !== undefined && typeof ThreadActions !== "function") {
    throw new Error(`${kind}: "ThreadActions" must be a component when set`);
  }
  return {
    version: RUN_ON_SLOT_VERSION,
    environmentProviderId,
    title: requireNonEmptyString(kind, "title", registration.title),
    ...(description !== undefined ? { description } : {}),
    ...(order !== undefined ? { order } : {}),
    useChoices: requireHook(kind, "useChoices", registration.useChoices),
    useThreadWorkspace: requireHook(
      kind,
      "useThreadWorkspace",
      registration.useThreadWorkspace,
    ),
    ...(ThreadActions !== undefined ? { ThreadActions } : {}),
  };
}

export function collectComposerRunRowItem(
  value: unknown,
  seen: Set<string>,
  onWarning: (message: string) => void,
): ExperimentalComposerRunRowItemRegistration | null {
  const kind = "slots.experimental_composerRunRowItem";
  const registration =
    value as Partial<ExperimentalComposerRunRowItemRegistration>;
  if (!knownVersion(kind, registration?.version, onWarning)) return null;
  const id = requireSlotId(kind, registration.id);
  requireUniqueId(kind, seen, id);
  const order = optionalOrder(kind, registration.order);
  return {
    version: RUN_ON_SLOT_VERSION,
    id,
    ...(order !== undefined ? { order } : {}),
    component: requireComponent(kind, registration.component),
  };
}

export interface RunOnCollected {
  runOnProviders: ExperimentalRunOnProviderRegistration[];
  composerRunRowItems: ExperimentalComposerRunRowItemRegistration[];
}

export function emptyCollected(): RunOnCollected {
  return { runOnProviders: [], composerRunRowItems: [] };
}

export function slots(
  collected: RunOnCollected,
  onWarning: (message: string) => void,
): Pick<
  PluginAppSlots,
  "experimental_runOnProvider" | "experimental_composerRunRowItem"
> {
  const seenProviders = new Set<string>();
  const seenItems = new Set<string>();
  return {
    experimental_runOnProvider(registration) {
      const run = collectRunOnProvider(registration, seenProviders, onWarning);
      if (run !== null) collected.runOnProviders.push(run);
    },
    experimental_composerRunRowItem(registration) {
      const item = collectComposerRunRowItem(
        registration,
        seenItems,
        onWarning,
      );
      if (item !== null) collected.composerRunRowItems.push(item);
    },
  };
}
