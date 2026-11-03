import {
  listStoredTurnRequestEventsForTurn,
  type DbQueryConnection,
} from "@bb/db";
import { parseStoredTurnRequestEvent } from "./thread-events.js";

/**
 * Per-thread attention policy a plugin sets through
 * `bb.experimental_threads.setAttentionPolicy`. Held in server memory only (no
 * migration, nothing to roll back): the plugin re-asserts it when it starts,
 * and until it does attention is raised as on stock bb.
 */
export interface ThreadAttentionPolicy {
  backgroundTurns: "silent";
}

interface PolicyEntry {
  pluginId: string;
  policy: ThreadAttentionPolicy;
}

const policiesByThreadId = new Map<string, PolicyEntry>();

export function setThreadAttentionPolicy(args: {
  pluginId: string;
  policy: ThreadAttentionPolicy | null;
  threadId: string;
}): void {
  if (args.policy === null) {
    if (policiesByThreadId.get(args.threadId)?.pluginId === args.pluginId) {
      policiesByThreadId.delete(args.threadId);
    }
    return;
  }
  policiesByThreadId.set(args.threadId, {
    pluginId: args.pluginId,
    policy: { backgroundTurns: args.policy.backgroundTurns },
  });
}

export function getThreadAttentionPolicy(
  threadId: string,
): ThreadAttentionPolicy | null {
  return policiesByThreadId.get(threadId)?.policy ?? null;
}

/** Drops every policy the plugin set; run when the plugin is unloaded. */
export function clearThreadAttentionPoliciesOfPlugin(pluginId: string): void {
  for (const [threadId, entry] of policiesByThreadId) {
    if (entry.pluginId === pluginId) policiesByThreadId.delete(threadId);
  }
}

export function resetThreadAttentionPolicies(): void {
  policiesByThreadId.clear();
}

/**
 * True when the finishing root turn must not raise the thread's attention
 * marker: the thread has a silent background policy and no input the turn
 * accepted came from the user. A later system or agent steer never makes an
 * owner turn background, and an owner steer into a background turn keeps its
 * attention. Anything unreadable answers false, so attention is raised (fail
 * visible).
 */
export function shouldSilenceBackgroundTurnAttention(
  db: DbQueryConnection,
  args: { threadId: string; turnId: string },
): boolean {
  if (
    policiesByThreadId.get(args.threadId)?.policy.backgroundTurns !== "silent"
  ) {
    return false;
  }
  try {
    const rows = listStoredTurnRequestEventsForTurn(db, args);
    if (rows.length === 0) return false;
    return rows.every(
      (row) => parseStoredTurnRequestEvent(row).initiator !== "user",
    );
  } catch {
    return false;
  }
}
