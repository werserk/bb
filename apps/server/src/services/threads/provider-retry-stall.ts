import {
  getStoredProviderRetryStall,
  listProviderRetryStallCandidates,
  type ProviderRetryStallCandidate,
  type StoredProviderRetryStall,
} from "@bb/db";
import { providerErrorInfoSchema } from "@bb/domain";
import { z } from "zod";
import type { CommandResultSideEffectsDeps } from "../../internal/command-result-side-effects.js";
import { NotificationBuffer } from "../lib/notification-buffer.js";
import { defineItemSweep, type ItemSweep } from "../system/item-sweep.js";
import { finishThreadLifecycle } from "./lifecycle/finish.js";
import { runThreadLifecycleInTransaction } from "./lifecycle/run.js";
import { TURN_START_DEADLINE_RECONNECT_GRACE_MS } from "./thread-lifecycle.js";

export const PROVIDER_RETRY_STALL_MS = 8 * 60_000;

const storedProviderErrorSchema = z.object({
  detail: z.string().optional(),
  errorInfo: providerErrorInfoSchema.optional(),
  message: z.string().optional(),
});

interface DescribedStall {
  detail: string | null;
  reason: string;
}

export function describeProviderRetryStall(
  stall: StoredProviderRetryStall,
): DescribedStall {
  let parsed: z.infer<typeof storedProviderErrorSchema> = {};
  try {
    parsed =
      storedProviderErrorSchema.safeParse(JSON.parse(stall.data)).data ?? {};
  } catch {
    parsed = {};
  }
  const status = parsed.errorInfo?.httpStatusCode;
  const category = parsed.errorInfo?.category;
  const reason =
    [status != null ? `HTTP ${status}` : null, category ?? null]
      .filter((part): part is string => part !== null)
      .join(" ") ||
    parsed.message ||
    "provider error";
  const detail = parsed.detail?.trim() || parsed.message?.trim() || null;
  return { detail, reason };
}

export function providerRetryStallSweep(
  deps: CommandResultSideEffectsDeps,
  now: number,
): ItemSweep {
  const deadline = now - PROVIDER_RETRY_STALL_MS;
  return defineItemSweep({
    name: "provider-retry-stall",
    concurrency: 1,
    list: (): ProviderRetryStallCandidate[] =>
      listProviderRetryStallCandidates(deps.db).filter(
        (candidate) =>
          getStoredProviderRetryStall(deps.db, {
            deadline,
            threadId: candidate.threadId,
          }) !== null,
      ),
    key: (candidate) => candidate.threadId,
    process: async (candidate) => {
      const daemonConnectedAt = deps.hub.getDaemonConnectedAtForHost(
        candidate.hostId,
      );
      if (
        daemonConnectedAt === null ||
        now - daemonConnectedAt < TURN_START_DEADLINE_RECONNECT_GRACE_MS
      ) {
        return;
      }
      const notifications = new NotificationBuffer();
      const outcome = deps.db.transaction(
        (tx) => {
          const stall = getStoredProviderRetryStall(tx, {
            deadline,
            threadId: candidate.threadId,
          });
          if (stall === null) return null;
          const { detail, reason } = describeProviderRetryStall(stall);
          return runThreadLifecycleInTransaction(
            { ...deps, db: tx, hub: notifications },
            candidate.threadId,
            {
              type: "provider-retry.stalled",
              detail,
              now,
              quietMinutes: Math.floor((now - stall.createdAt) / 60_000),
              reason,
              turnId: stall.turnId,
            },
          );
        },
        { behavior: "immediate" },
      );
      notifications.flushInto(deps.hub);
      if (outcome === null || !outcome.statusChanged) return;
      deps.logger.warn(
        { threadId: candidate.threadId },
        "Stopping a turn whose provider went silent after a retryable error",
      );
      await finishThreadLifecycle(deps, outcome);
    },
  });
}
