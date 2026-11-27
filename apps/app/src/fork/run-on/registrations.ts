import { useMemo } from "react";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { useSystemEnvironmentProviders } from "@/hooks/queries/environment-provider-queries";
import {
  usePluginSlotKind,
  type PluginRunOnProviderSlot,
} from "@/lib/plugin-slots";

export interface AcceptedRunOnProvider {
  slot: PluginRunOnProviderSlot;

  provider: SystemEnvironmentProvider;
}

export type RunOnRejection =
  | "owned-by-another-plugin"
  | "second-registration"
  | "composed-only";

type Warn = (slot: PluginRunOnProviderSlot, reason: RunOnRejection) => void;

function byOrder(
  left: PluginRunOnProviderSlot,
  right: PluginRunOnProviderSlot,
): number {
  return (
    (left.order ?? 0) - (right.order ?? 0) ||
    left.pluginId.localeCompare(right.pluginId) ||
    left.environmentProviderId.localeCompare(right.environmentProviderId)
  );
}

export function acceptRunOnRegistrations(
  slots: readonly PluginRunOnProviderSlot[],
  providers: readonly SystemEnvironmentProvider[],
  warn: Warn,
): AcceptedRunOnProvider[] {
  const accepted: AcceptedRunOnProvider[] = [];
  const taken = new Set<string>();
  for (const slot of [...slots].sort(byOrder)) {
    const id = slot.environmentProviderId;
    const entries = providers.filter(
      (provider) => (provider.environmentProviderId ?? provider.id) === id,
    );
    if (entries.length === 0) continue;
    if (entries.some((provider) => provider.pluginId !== slot.pluginId)) {
      warn(slot, "owned-by-another-plugin");
      continue;
    }
    const selectable = entries.find(
      (provider) => provider.id === id && !provider.machineProviderId,
    );
    if (selectable === undefined) {
      warn(slot, "composed-only");
      continue;
    }
    if (taken.has(id)) {
      warn(slot, "second-registration");
      continue;
    }
    taken.add(id);
    accepted.push({ slot, provider: selectable });
  }
  return accepted;
}

const REJECTION_MESSAGES: Record<RunOnRejection, string> = {
  "owned-by-another-plugin":
    "the environment provider belongs to another plugin; ignored",
  "second-registration":
    "another plugin already presents this environment provider; ignored",
  "composed-only":
    "the environment provider is only listed inside a machine composition; ignored",
};

const warned = new Set<string>();

export function warnRunOnRejectionOnce(
  slot: PluginRunOnProviderSlot,
  reason: RunOnRejection,
): void {
  const key = `${slot.pluginId}\0${slot.environmentProviderId}\0${reason}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[plugin:${slot.pluginId}] slots.experimental_runOnProvider "${slot.environmentProviderId}": ${REJECTION_MESSAGES[reason]}`,
  );
}

export function resetRunOnWarningsForTest(): void {
  warned.clear();
}

const NONE: readonly AcceptedRunOnProvider[] = [];

export function useAcceptedRunOnProviders():
  | readonly AcceptedRunOnProvider[]
  | null {
  const slots = usePluginSlotKind("runOnProviders");
  const { providers } = useSystemEnvironmentProviders();
  return useMemo(
    () =>
      providers === undefined
        ? null
        : slots.length === 0
          ? NONE
          : acceptRunOnRegistrations(slots, providers, warnRunOnRejectionOnce),
    [providers, slots],
  );
}
