import {
  getLatestRootTurnCompletion,
  getThread,
  hasBackgroundWorkSettledAfterSequence,
  hasRootTurnStartedAfterSequence,
  listChildNoticeRefs,
  listIdleNotifiableChildThreadIds,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  CHILD_NOTICE_EPISODE_LOOKBACK_MS,
  getChildBackgroundCounts,
} from "./child-notice-policy.js";
import { queueChildThreadTurnNotificationBestEffort } from "./child-thread-notifications.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";

/**
 * A notice lives in memory for 2 s and a settle grace for 30 s, so a restart
 * loses them. At boot, a notifiable child that finished a root turn inside the
 * lookback and whose parent has neither been sent nor queued a notice for it
 * gets one through the normal path. A notice written before notices named
 * their turn counts when it is newer than the turn, so the first boot after
 * the upgrade does not repeat what the parent already got.
 */
export async function reconcileChildThreadNoticesAtBoot(
  deps: LoggedPendingInteractionWorkSessionDeps,
): Promise<void> {
  const since = Date.now() - CHILD_NOTICE_EPISODE_LOOKBACK_MS;
  for (const childThreadId of listIdleNotifiableChildThreadIds(deps.db, {
    sinceMs: since,
  })) {
    try {
      await reconcileChildThreadNotice(deps, childThreadId, since);
    } catch (error) {
      deps.logger.error(
        { err: error, childThreadId },
        "Failed to reconcile a child thread notice at boot",
      );
    }
  }
}

async function reconcileChildThreadNotice(
  deps: LoggedPendingInteractionWorkSessionDeps,
  childThreadId: string,
  since: number,
): Promise<void> {
  const child = getThread(deps.db, childThreadId);
  const parent = child?.parentThreadId
    ? getThread(deps.db, child.parentThreadId)
    : null;
  if (
    !child ||
    !isParentNotifiableChildThread(child, "completed") ||
    !parent ||
    parent.archivedAt !== null ||
    parent.deletedAt !== null
  ) {
    return;
  }
  const completion = getLatestRootTurnCompletion(deps.db, {
    threadId: childThreadId,
  });
  if (completion?.status !== "completed" || completion.createdAt < since)
    return;
  const counts = getChildBackgroundCounts(deps.db, childThreadId);
  if (counts.commands + counts.agents > 0) return;
  const delivered = listChildNoticeRefs(deps.db, {
    childThreadId,
    parentThreadId: parent.id,
    sinceCreatedAt: completion.createdAt,
  }).some((ref) => ref.turnId === completion.turnId || ref.turnId === null);
  if (delivered) return;
  const lookup = { threadId: childThreadId, sequence: completion.sequence };
  await queueChildThreadTurnNotificationBestEffort(deps, {
    afterBackgroundSettle:
      hasBackgroundWorkSettledAfterSequence(deps.db, lookup) &&
      !hasRootTurnStartedAfterSequence(deps.db, lookup),
    childThread: {
      id: child.id,
      projectId: child.projectId,
      title: child.title,
    },
    parentThreadId: parent.id,
    turnId: completion.turnId,
    turnStatus: "completed",
  });
}
