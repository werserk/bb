import { getLastThreadOutput, getRootAgentOutput } from "./thread-data.js";
import {
  getLatestRootTurnCompletion,
  hasBackgroundWorkSettledAfterSequence,
  hasRootTurnStartedAfterSequence,
  listActiveBackgroundTaskCountsByThreadIds,
  listChildNoticeRefs,
  type DbConnection,
} from "@bb/db";

/**
 * When the native child notice is sent, held or dropped. Pure reads of the
 * event log plus one in-memory cap table; nothing here writes.
 */

/** How far back "the child's episode" and "already delivered" look. */
export const CHILD_NOTICE_EPISODE_LOOKBACK_MS = 6 * 60 * 60 * 1000;
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

/**
 * True when a "completed" notice for this turn would be a false "done": a
 * background command or agent still runs, or one settled after the turn ended
 * and the provider has not started the resume turn that reads its result.
 */
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
    hasBackgroundWorkSettledAfterSequence(db, lookup) &&
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

/**
 * The text a completed notice carries. The turn's own final root message wins.
 * A turn with none reports the newest root message since the last notice the
 * parent got ("earlier in this episode"); with nothing new after a notice that
 * was already delivered, the turn is silent noise and sends nothing.
 */
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
  const lastNoticeAt = Math.max(since, ...refs.map((ref) => ref.createdAt));
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
  return refs.length > 0 ? { kind: "skip" } : { kind: "text", output: null };
}

/** Text for a notice built without a turn id (legacy callers). */
export function resolveUnscopedChildNoticeText(
  db: DbConnection,
  childThreadId: string,
): string | null {
  return getLastThreadOutput(db, childThreadId)?.trim() || null;
}
