import {
  getLatestRootTurnCompletion,
  hasBackgroundWorkSettledAfterSequence,
  hasRootTurnStartedAfterSequence,
  listActiveBackgroundTaskCountsByThreadIds,
  type DbConnection,
} from "@bb/db";

/**
 * When the native child notice is sent, held or dropped. Pure reads of the
 * event log plus one in-memory cap table; nothing here writes.
 */

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
