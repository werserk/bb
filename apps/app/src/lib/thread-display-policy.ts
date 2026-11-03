import type { ExperimentalThreadDisplayPolicy } from "@get-bb/plugin-sdk";
import { useMemo, useSyncExternalStore } from "react";
import { resolveThreadDisplayPolicy } from "./plugin-slot-resolvers";
import {
  EMPTY_PLUGIN_SLOT_SNAPSHOT,
  getPluginSlotSnapshot,
  subscribePluginSlots,
  type PluginThreadDisplayPolicySlot,
} from "./plugin-slots";

function useThreadDisplayPolicySlots(): readonly PluginThreadDisplayPolicySlot[] {
  return useSyncExternalStore(
    subscribePluginSlots,
    () => getPluginSlotSnapshot().threadDisplayPolicies,
    () => EMPTY_PLUGIN_SLOT_SNAPSHOT.threadDisplayPolicies,
  );
}

export function useThreadDisplayPolicy(
  threadId: string | undefined,
  projectId: string | undefined,
): ExperimentalThreadDisplayPolicy | null {
  const slots = useThreadDisplayPolicySlots();
  return useMemo(() => {
    if (threadId === undefined || slots.length === 0) return null;
    return resolveThreadDisplayPolicy(slots, {
      threadId,
      projectId: projectId ?? null,
    });
  }, [projectId, slots, threadId]);
}
