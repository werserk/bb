import {
  getLatestRootTurnCompletion,
  getThread,
  hasRootTurnStartedAfterSequence,
} from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { queueChildThreadTurnNotificationBestEffort } from "./child-thread-notifications.js";
import { getChildBackgroundCounts } from "./child-notice-policy.js";
import { isParentNotifiableChildThread } from "./thread-parent.js";

/**
 * A completed notice held for running background work is released here once
 * that work settles and the provider does not start a follow-up turn within the
 * grace. A follow-up turn that does start sends its own notice instead.
 */
const CHILD_NOTICE_SETTLE_GRACE_MS = 30_000;
const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function armChildNoticeSettleGrace(
  deps: LoggedPendingInteractionWorkSessionDeps,
  childThreadId: string,
): void {
  const child = getThread(deps.db, childThreadId);
  if (
    !child ||
    child.status !== "idle" ||
    !isParentNotifiableChildThread(child, "completed")
  ) {
    return;
  }
  const counts = getChildBackgroundCounts(deps.db, childThreadId);
  if (counts.commands + counts.agents > 0) return;
  const completion = getLatestRootTurnCompletion(deps.db, {
    threadId: childThreadId,
  });
  if (completion?.status !== "completed") return;
  clearTimeout(settleTimers.get(childThreadId));
  settleTimers.set(
    childThreadId,
    setTimeout(() => {
      settleTimers.delete(childThreadId);
      void releaseSettledChildNotice(deps, childThreadId, completion);
    }, CHILD_NOTICE_SETTLE_GRACE_MS),
  );
}

async function releaseSettledChildNotice(
  deps: LoggedPendingInteractionWorkSessionDeps,
  childThreadId: string,
  completion: NonNullable<ReturnType<typeof getLatestRootTurnCompletion>>,
): Promise<void> {
  const child = getThread(deps.db, childThreadId);
  if (
    !child ||
    !isParentNotifiableChildThread(child, "completed") ||
    hasRootTurnStartedAfterSequence(deps.db, {
      threadId: childThreadId,
      sequence: completion.sequence,
    })
  ) {
    return;
  }
  const counts = getChildBackgroundCounts(deps.db, childThreadId);
  if (counts.commands + counts.agents > 0) return;
  await queueChildThreadTurnNotificationBestEffort(deps, {
    afterBackgroundSettle: true,
    childThread: {
      id: child.id,
      projectId: child.projectId,
      title: child.title,
    },
    parentThreadId: child.parentThreadId,
    turnId: completion.turnId,
    turnStatus: "completed",
  });
}
