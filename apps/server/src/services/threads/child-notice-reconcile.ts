import {
  getLatestRootTurnCompletion,
  getThread,
  getBackgroundWorkSettledAtAfterSequence,
  hasRootTurnStartedAfterSequence,
  listChildNoticeRefs,
  listIdleNotifiableChildThreadIds,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  CHILD_NOTICE_EPISODE_LOOKBACK_MS,
  CHILD_NOTICE_MAX_HOLD_MS,
  getChildBackgroundCounts,
} from "./child-notice-policy.js";
import { queueChildThreadTurnNotificationBestEffort } from "./child-thread-notifications.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";

const SETTLE_GRACE_MS = 30_000;
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function armChildNoticeSettleGrace(
  deps: LoggedPendingInteractionWorkSessionDeps,
  childThreadId: string,
): void {
  clearTimeout(settleTimers.get(childThreadId));
  const timer = setTimeout(() => {
    settleTimers.delete(childThreadId);
    void releaseChildNoticeIfOwed(deps, childThreadId);
  }, SETTLE_GRACE_MS);
  timer.unref?.();
  settleTimers.set(childThreadId, timer);
}

export async function reconcileChildThreadNotices(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  for (const id of listIdleNotifiableChildThreadIds(deps.db, {
    sinceMs: Date.now() - CHILD_NOTICE_EPISODE_LOOKBACK_MS,
  })) {
    await releaseChildNoticeIfOwed(deps, id);
  }
}

export async function releaseChildNoticeIfOwed(
  deps: LoggedPendingInteractionWorkSessionDeps,
  childThreadId: string,
): Promise<void> {
  try {
    const child = getThread(deps.db, childThreadId);
    const parent = child?.parentThreadId
      ? getThread(deps.db, child.parentThreadId)
      : null;
    if (
      !child ||
      child.status !== "idle" ||
      !isParentNotifiableChildThread(child, "completed") ||
      !parent ||
      parent.archivedAt !== null ||
      parent.deletedAt !== null
    )
      return;
    const completion = getLatestRootTurnCompletion(deps.db, {
      threadId: childThreadId,
    });
    if (completion?.status !== "completed") return;
    const lookup = { threadId: childThreadId, sequence: completion.sequence };
    if (hasRootTurnStartedAfterSequence(deps.db, lookup)) return;
    if (
      listChildNoticeRefs(deps.db, {
        childThreadId,
        parentThreadId: parent.id,
        sinceCreatedAt: completion.createdAt,
      }).some((ref) => ref.turnId === completion.turnId || ref.turnId === null)
    )
      return;
    const counts = getChildBackgroundCounts(deps.db, childThreadId);
    const running = counts.commands + counts.agents > 0;
    const expired =
      Date.now() - completion.createdAt >= CHILD_NOTICE_MAX_HOLD_MS;
    if (running && !expired) return;
    const settledAt = getBackgroundWorkSettledAtAfterSequence(deps.db, lookup);
    if (
      !running &&
      settledAt !== null &&
      Date.now() - settledAt < SETTLE_GRACE_MS
    ) {
      armChildNoticeSettleGrace(deps, childThreadId);
      return;
    }
    await queueChildThreadTurnNotificationBestEffort(deps, {
      afterBackgroundSettle: running
        ? "expired"
        : settledAt !== null
          ? "settled"
          : undefined,
      childThread: {
        id: child.id,
        projectId: child.projectId,
        title: child.title,
      },
      parentThreadId: parent.id,
      turnId: completion.turnId,
      turnStatus: "completed",
    });
  } catch (error) {
    deps.logger.error(
      { err: error, childThreadId },
      "Failed to release a child thread notice",
    );
  }
}
