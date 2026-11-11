import { latestServiceTurn } from "./service-turns.js";
import {
  listQueuedThreadMessageCountsByThreadIds,
  getLatestCompletedThreadContextClearSequence,
  getLatestThreadSequence,
  listPlanHistoryEventRows,
  getPlanInteractionCreationRow,
  listPlanStalenessEventRows,
  hasOpenConversationQuestion,
} from "@bb/db";
import { projectThreadPlan } from "@bb/thread-view";
import type { Thread, ThreadPlanView } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { toThreadEventWithMeta } from "./timeline.js";

export function readThreadPlan(
  deps: Pick<AppDeps, "db" | "pendingInteractions">,
  thread: Thread,
): ThreadPlanView {
  return deps.db.transaction(() => {
    const revision = getLatestThreadSequence(deps.db, { threadId: thread.id });
    const boundary =
      getLatestCompletedThreadContextClearSequence(deps.db, {
        threadId: thread.id,
      }) ?? 0;
    const rows = listPlanHistoryEventRows(deps.db, {
      threadId: thread.id,
      boundary,
      limit: 32,
    });
    const oldest = rows.at(-1);
    const historyTruncated =
      oldest !== undefined &&
      listPlanHistoryEventRows(deps.db, {
        threadId: thread.id,
        boundary,
        atOrBeforeSequence: oldest.sequence - 1,
        limit: 1,
      }).length > 0;
    const interactions = deps.pendingInteractions.listPendingThreadInteractions(
      thread.id,
    );
    const anchors = interactions
      .filter((i) => i.payload.kind === "user_question")
      .map((interaction) => {
        const creation = getPlanInteractionCreationRow(
          deps.db,
          thread.id,
          interaction.id,
          { turnId: interaction.turnId, boundary },
        );
        const plan =
          creation && creation.sequence >= boundary
            ? listPlanHistoryEventRows(deps.db, {
                threadId: thread.id,
                boundary,
                atOrBeforeSequence: creation.sequence,
                limit: 1,
              })[0]
            : null;
        return {
          interactionId: interaction.id,
          turnId: interaction.turnId,
          event: plan ? toThreadEventWithMeta(plan) : null,
        };
      });
    return projectThreadPlan({
      threadId: thread.id,
      revision,
      status:
        thread.status === "error" && latestServiceTurn(deps.db, thread.id)
          ? "idle"
          : thread.status,
      events: rows.map(toThreadEventWithMeta),
      turnEvents: rows[0]
        ? listPlanStalenessEventRows(deps.db, rows[0], revision).map(
            toThreadEventWithMeta,
          )
        : [],
      sendFailed:
        thread.status !== "active" &&
        thread.status !== "starting" &&
        (listQueuedThreadMessageCountsByThreadIds(deps.db, {
          threadIds: [thread.id],
          includeService: false,
        })[0]?.failedQueuedMessageCount ?? 0) > 0,
      ownInputRequired:
        thread.archivedAt === null &&
        hasOpenConversationQuestion(deps.db, thread.id),
      anchors,
      attentionInteractionIds: interactions.map((i) => i.id),
      historyTruncated,
    });
  });
}
