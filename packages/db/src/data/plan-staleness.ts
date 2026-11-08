import {
  and,
  asc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbConnection } from "../connection.js";
import { events } from "../schema.js";
import type { StoredEventRow } from "./events.js";

export function listPlanStalenessEventRows(
  db: DbConnection,
  plan: StoredEventRow,
  maxSeq: number,
): StoredEventRow[] {
  const started = alias(events, "plan_started_turn");
  const earlier = alias(events, "plan_earlier_start");
  const rootAfterPlan = and(
    eq(started.threadId, plan.threadId),
    eq(started.type, "turn/started"),
    isNull(started.parentToolCallId),
    gt(started.sequence, plan.sequence),
    plan.turnId === null ? undefined : ne(started.turnId, plan.turnId),
    notExists(
      db
        .select({ id: earlier.id })
        .from(earlier)
        .where(
          and(
            eq(earlier.threadId, started.threadId),
            eq(earlier.turnId, started.turnId),
            eq(earlier.type, "turn/started"),
            lte(earlier.sequence, plan.sequence),
          ),
        ),
    ),
  );
  const ended = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, plan.threadId),
        inArray(events.type, ["turn/completed", "system/thread/interrupted"]),
        gt(events.sequence, plan.sequence),
        lte(events.sequence, maxSeq),
        exists(
          db
            .select({ id: started.id })
            .from(started)
            .where(
              and(
                rootAfterPlan,
                lt(started.sequence, events.sequence),
                or(
                  eq(events.type, "system/thread/interrupted"),
                  eq(started.turnId, events.turnId),
                ),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(events.sequence))
    .limit(1)
    .get();
  if (!ended) return [];
  const start = db
    .select()
    .from(started)
    .where(
      and(
        rootAfterPlan,
        lt(started.sequence, ended.sequence),
        ended.type === "system/thread/interrupted"
          ? undefined
          : eq(started.turnId, sql`${ended.turnId}`),
      ),
    )
    .orderBy(asc(started.sequence))
    .limit(1)
    .get();
  return start ? [start, ended] : [];
}
