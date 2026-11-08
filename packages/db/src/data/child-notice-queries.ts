import { sql } from "drizzle-orm";
import {
  LOCAL_AGENT_TASK_TYPE,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_SUBAGENT_TASK_TYPE,
} from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";

/**
 * Read-only lookups behind the native child notice: which root turn a child
 * finished last, whether work is owed a resume, and which child turns a parent
 * was already told about. They never write.
 */

interface ChildThreadArgs {
  threadId: string;
}

export interface RootTurnCompletionRow {
  createdAt: number;
  sequence: number;
  status: string;
  turnId: string;
}

/** The child's newest root `turn/completed` (a turn with a root `turn/started`). */
export function getLatestRootTurnCompletion(
  db: DbQueryConnection,
  args: ChildThreadArgs,
): RootTurnCompletionRow | null {
  return (
    db.all<RootTurnCompletionRow>(sql`
      SELECT c.turn_id AS turnId, c.sequence AS sequence,
        c.created_at AS createdAt, json_extract(c.data, '$.status') AS status
      FROM events c
      WHERE c.thread_id = ${args.threadId} AND c.type = 'turn/completed'
        AND c.turn_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM events s
          WHERE s.thread_id = c.thread_id AND s.turn_id = c.turn_id
            AND s.type = 'turn/started' AND s.parent_tool_call_id IS NULL)
      ORDER BY c.sequence DESC LIMIT 1`)[0] ?? null
  );
}

export function hasRootTurnStartedAfterSequence(
  db: DbQueryConnection,
  args: ChildThreadArgs & { sequence: number },
): boolean {
  return (
    db.all<{ n: number }>(sql`
      SELECT 1 AS n FROM events
      WHERE thread_id = ${args.threadId} AND type = 'turn/started'
        AND parent_tool_call_id IS NULL AND sequence > ${args.sequence}
      LIMIT 1`).length > 0
  );
}

/** A background command or agent (not a workflow) settled after `sequence`. */
export function hasBackgroundWorkSettledAfterSequence(
  db: DbQueryConnection,
  args: ChildThreadArgs & { sequence: number },
): boolean {
  return (
    db.all<{ n: number }>(sql`
      SELECT 1 AS n FROM events
      WHERE thread_id = ${args.threadId} AND type = 'item/backgroundTask/completed'
        AND item_kind = 'backgroundTask' AND sequence > ${args.sequence}
        AND json_extract(data, '$.item.taskType') IN (
          ${LOCAL_BASH_TASK_TYPE}, ${LOCAL_AGENT_TASK_TYPE}, ${LOCAL_SUBAGENT_TASK_TYPE})
      LIMIT 1`).length > 0
  );
}

export interface ChildNoticeRef {
  createdAt: number;
  /** Null for a notice written before notices named the child turn. */
  turnId: string | null;
}

/**
 * Notices a parent got, or has queued, about one child since `sinceCreatedAt`:
 * sent `client/turn/requested` system turns and pending queued rows alike.
 */
export function listChildNoticeRefs(
  db: DbQueryConnection,
  args: {
    childThreadId: string;
    parentThreadId: string;
    sinceCreatedAt: number;
  },
): ChildNoticeRef[] {
  return db.all<ChildNoticeRef>(sql`
    SELECT json_extract(o.value, '$.turnId') AS turnId, e.created_at AS createdAt
    FROM events e,
      json_each(COALESCE(json_extract(e.data, '$.systemMessageSubject.outcomes'), '[]')) o
    WHERE e.thread_id = ${args.parentThreadId} AND e.type = 'client/turn/requested'
      AND e.created_at >= ${args.sinceCreatedAt}
      AND json_extract(o.value, '$.threadId') = ${args.childThreadId}
    UNION ALL
    SELECT json_extract(o.value, '$.turnId') AS turnId, q.created_at AS createdAt
    FROM queued_thread_messages q,
      json_each(COALESCE(json_extract(q.system_notice, '$.childOutcomeSnapshots'), '[]')) o
    WHERE q.thread_id = ${args.parentThreadId} AND q.system_notice IS NOT NULL
      AND q.created_at >= ${args.sinceCreatedAt}
      AND json_extract(o.value, '$.childThread.id') = ${args.childThreadId}`);
}
