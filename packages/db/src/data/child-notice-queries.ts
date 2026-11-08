import { sql } from "drizzle-orm";
import {
  LOCAL_AGENT_TASK_TYPE,
  LOCAL_BASH_TASK_TYPE,
  LOCAL_SUBAGENT_TASK_TYPE,
} from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";


interface ChildThreadArgs {
  threadId: string;
}

export interface RootTurnCompletionRow {
  createdAt: number;
  sequence: number;
  status: string;
  turnId: string;
}

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

export function getBackgroundWorkSettledAtAfterSequence(
  db: DbQueryConnection,
  args: ChildThreadArgs & { sequence: number },
): number | null {
  return db.all<{ at: number }>(sql`
    SELECT max(created_at) AS at FROM events
    WHERE thread_id = ${args.threadId} AND type = 'item/backgroundTask/completed'
      AND item_kind = 'backgroundTask' AND sequence > ${args.sequence}
      AND json_extract(data, '$.item.taskType') IN (
        ${LOCAL_BASH_TASK_TYPE}, ${LOCAL_AGENT_TASK_TYPE}, ${LOCAL_SUBAGENT_TASK_TYPE})
  `)[0]?.at ?? null;
}

export interface ChildNoticeRef {
  createdAt: number;
  status: string;
    turnId: string | null;
}

export function listChildNoticeRefs(
  db: DbQueryConnection,
  args: {
    childThreadId: string;
    parentThreadId: string;
    sinceCreatedAt: number;
  },
): ChildNoticeRef[] {
  return db.all<ChildNoticeRef>(sql`
    SELECT json_extract(o.value, '$.turnId') AS turnId, json_extract(o.value, '$.status') AS status, e.created_at AS createdAt
    FROM events e,
      json_each(COALESCE(json_extract(e.data, '$.systemMessageSubject.outcomes'), '[]')) o
    WHERE e.thread_id = ${args.parentThreadId} AND e.type = 'client/turn/requested'
      AND e.created_at >= ${args.sinceCreatedAt}
      AND json_extract(o.value, '$.threadId') = ${args.childThreadId}
    UNION ALL
    SELECT json_extract(o.value, '$.turnId') AS turnId, json_extract(o.value, '$.turnStatus') AS status, q.created_at AS createdAt
    FROM queued_thread_messages q,
      json_each(COALESCE(json_extract(q.system_notice, '$.childOutcomeSnapshots'), '[]')) o
    WHERE q.thread_id = ${args.parentThreadId} AND q.system_notice IS NOT NULL
      AND q.created_at >= ${args.sinceCreatedAt}
      AND json_extract(o.value, '$.childThread.id') = ${args.childThreadId}`);
}

export function listIdleNotifiableChildThreadIds(
  db: DbQueryConnection,
  args: { sinceMs: number },
): string[] {
  return db
    .all<{ id: string }>(sql`
      SELECT id FROM threads
      WHERE parent_thread_id IS NOT NULL AND origin_kind IS NULL
        AND deleted_at IS NULL AND archived_at IS NULL
        AND status = 'idle' AND parent_notifications <> 'off'
        AND updated_at >= ${args.sinceMs}`)
    .map((row) => row.id);
}

