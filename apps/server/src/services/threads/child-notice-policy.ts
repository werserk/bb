import { getRootAgentOutput } from "./thread-data.js";
import {
  getLatestRootTurnCompletion,
  getBackgroundWorkSettledAtAfterSequence,
  hasRootTurnStartedAfterSequence,
  listActiveBackgroundTaskCountsByThreadIds,
  listChildNoticeRefs,
  type DbConnection,
} from "@bb/db";

export const CHILD_NOTICE_EPISODE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
export const CHILD_NOTICE_MAX_HOLD_MS = 3 * 60 * 60 * 1000;
const EARLIER_IN_EPISODE_LABEL = "(Earlier in this episode:)";

interface ChildTurnArgs {
  childThreadId: string;
  turnId: string;
}

export interface ChildBackgroundCounts {
  agents: number;
  commands: number;
  workflows: number;
}

export function getChildBackgroundCounts(
  db: DbConnection,
  childThreadId: string,
): ChildBackgroundCounts {
  const [row] = listActiveBackgroundTaskCountsByThreadIds(db, {
    threadIds: [childThreadId],
  });
  return {
    agents: row?.activeBackgroundAgentCount ?? 0,
    commands: row?.activeBackgroundCommandCount ?? 0,
    workflows: row?.activeWorkflowCount ?? 0,
  };
}

export function isChildNoticeHeld(
  db: DbConnection,
  args: ChildTurnArgs,
): boolean {
  const counts = getChildBackgroundCounts(db, args.childThreadId);
  if (counts.commands + counts.agents > 0) return true;
  const completion = getLatestRootTurnCompletion(db, {
    threadId: args.childThreadId,
  });
  if (completion?.turnId !== args.turnId) return false;
  const lookup = {
    threadId: args.childThreadId,
    sequence: completion.sequence,
  };
  return (
    getBackgroundWorkSettledAtAfterSequence(db, lookup) !== null &&
    !hasRootTurnStartedAfterSequence(db, lookup)
  );
}

export type ChildNoticeText =
  | { kind: "skip" }
  | { kind: "text"; output: string | null };

interface ResolveChildNoticeTextArgs extends ChildTurnArgs {
  now: number;
  parentThreadId: string;
}

export function resolveChildNoticeText(
  db: DbConnection,
  args: ResolveChildNoticeTextArgs,
): ChildNoticeText {
  const since = args.now - CHILD_NOTICE_EPISODE_LOOKBACK_MS;
  const refs = listChildNoticeRefs(db, {
    childThreadId: args.childThreadId,
    parentThreadId: args.parentThreadId,
    sinceCreatedAt: since,
  });
  if (refs.some((ref) => ref.turnId === args.turnId)) return { kind: "skip" };
  const own = getRootAgentOutput(db, {
    threadId: args.childThreadId,
    turnId: args.turnId,
  });
  if (own) return { kind: "text", output: own };
  const completed = refs.filter((ref) => ref.status === "completed");
  const lastNoticeAt = Math.max(
    since,
    ...completed.map((ref) => ref.createdAt),
  );
  const episode = getRootAgentOutput(db, {
    threadId: args.childThreadId,
    sinceCreatedAt: lastNoticeAt,
  });
  if (episode) {
    return {
      kind: "text",
      output: `${EARLIER_IN_EPISODE_LABEL}\n\n${episode}`,
    };
  }
  return completed.length > 0
    ? { kind: "skip" }
    : { kind: "text", output: null };
}
