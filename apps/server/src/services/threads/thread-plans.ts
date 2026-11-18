import { createHash } from "node:crypto";
import { latestServiceTurn } from "./service-turns.js";
import {
  listQueuedThreadMessageCountsByThreadIds,
  getLatestCompletedThreadContextClearSequence,
  getLatestThreadSequence,
  getThreadEventRewriteGeneration,
  listPlanHistoryEventRows,
  getPlanInteractionCreationRow,
  listPlanStalenessEventRows,
  getOpenConversationQuestionSummary,
} from "@bb/db";
import { projectThreadPlan } from "@bb/thread-view";
import type { Thread, ThreadPlanUnchanged, ThreadPlanView } from "@bb/domain";
import type { AppDeps } from "../../types.js";
import { toThreadEventWithMeta } from "./timeline.js";

type PlanReadDeps = Pick<AppDeps, "db" | "pendingInteractions">;

export type ThreadPlanRead =
  | { plan: ThreadPlanView; unchanged?: undefined }
  | { plan?: undefined; unchanged: ThreadPlanUnchanged };

function readPlanInputs(deps: PlanReadDeps, thread: Thread) {
  const revision = getLatestThreadSequence(deps.db, { threadId: thread.id });
  const serviceTurn =
    thread.status === "error" && Boolean(latestServiceTurn(deps.db, thread.id));
  const failedQueuedMessageCount =
    listQueuedThreadMessageCountsByThreadIds(deps.db, {
      threadIds: [thread.id],
      includeService: false,
    })[0]?.failedQueuedMessageCount ?? 0;
  const { total, firstQuestionId } = getOpenConversationQuestionSummary(
    deps.db,
    thread.id,
  );
  const questionAttention = { total, firstQuestionId };
  const interactions = deps.pendingInteractions.listPendingThreadInteractions(
    thread.id,
  );
  const readRevision = createHash("sha256")
    .update(
      JSON.stringify({
        revision,
        rewriteGeneration: getThreadEventRewriteGeneration(thread.id),
        status: thread.status,
        serviceTurn,
        sendFailed: failedQueuedMessageCount > 0,
        questionAttention,
        attentionInteractionIds: interactions.map((i) => i.id).sort(),
      }),
    )
    .digest("hex");
  return {
    revision,
    serviceTurn,
    failedQueuedMessageCount,
    questionAttention,
    interactions,
    readRevision,
  };
}

function projectPlan(
  deps: PlanReadDeps,
  thread: Thread,
  inputs: ReturnType<typeof readPlanInputs>,
): ThreadPlanView {
  const { revision, interactions, questionAttention } = inputs;
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
  return {
    ...projectThreadPlan({
      threadId: thread.id,
      revision,
      status: inputs.serviceTurn ? "idle" : thread.status,
      events: rows.map(toThreadEventWithMeta),
      turnEvents: rows[0]
        ? listPlanStalenessEventRows(deps.db, rows[0], revision).map(
            toThreadEventWithMeta,
          )
        : [],
      sendFailed:
        thread.status !== "active" &&
        thread.status !== "starting" &&
        inputs.failedQueuedMessageCount > 0,
      ownInputRequired: questionAttention.total > 0,
      anchors,
      attentionInteractionIds: interactions.map((i) => i.id),
      historyTruncated,
    }),
    questionAttention,
    readRevision: inputs.readRevision,
  };
}

export function readThreadPlanUnlessKnown(
  deps: PlanReadDeps,
  thread: Thread,
  known: string | undefined,
): ThreadPlanRead {
  return deps.db.transaction(() => {
    const inputs = readPlanInputs(deps, thread);
    if (known === inputs.readRevision)
      return {
        unchanged: {
          revision: inputs.revision,
          readRevision: inputs.readRevision,
        },
      };
    return { plan: projectPlan(deps, thread, inputs) };
  });
}

export function readThreadPlan(
  deps: PlanReadDeps,
  thread: Thread,
): ThreadPlanView {
  return deps.db.transaction(() =>
    projectPlan(deps, thread, readPlanInputs(deps, thread)),
  );
}
