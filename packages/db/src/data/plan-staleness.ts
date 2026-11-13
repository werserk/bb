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
  placeholder,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  prepareCachedQuery,
  type DbQueryConnection,
  type DbConnection,
} from "../connection.js";
import { events } from "../schema.js";
import type { StoredEventRow } from "./events.js";

function prepareStalenessQueries(
  db: DbQueryConnection,
  hasPlanTurn: boolean,
  interrupted: boolean,
) {
  const started = alias(events, "plan_started_turn");
  const earlier = alias(events, "plan_earlier_start");
  const rootAfterPlan = and(
    eq(started.threadId, placeholder("threadId")),
    eq(started.type, "turn/started"),
    isNull(started.parentToolCallId),
    gt(started.sequence, placeholder("planSequence")),
    hasPlanTurn ? ne(started.turnId, placeholder("planTurnId")) : undefined,
    notExists(
      db
        .select({ id: earlier.id })
        .from(earlier)
        .where(
          and(
            eq(earlier.threadId, started.threadId),
            eq(earlier.turnId, started.turnId),
            eq(earlier.type, "turn/started"),
            lte(earlier.sequence, placeholder("planSequence")),
          ),
        ),
    ),
  );
  const end = db
    .select()
    .from(events)
    .where(
      and(
        eq(events.threadId, placeholder("threadId")),
        inArray(events.type, ["turn/completed", "system/thread/interrupted"]),
        gt(events.sequence, placeholder("planSequence")),
        lte(events.sequence, placeholder("maxSeq")),
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
    .prepare();
  const start = db
    .select()
    .from(started)
    .where(
      and(
        rootAfterPlan,
        lt(started.sequence, placeholder("endSequence")),
        interrupted ? undefined : eq(started.turnId, placeholder("endTurnId")),
      ),
    )
    .orderBy(asc(started.sequence))
    .limit(1)
    .prepare();
  return { start, end };
}

const prepareWithTurn = (db: DbQueryConnection) =>
  prepareStalenessQueries(db, true, false);
const prepareWithoutTurn = (db: DbQueryConnection) =>
  prepareStalenessQueries(db, false, false);
const prepareInterruptedWithTurn = (db: DbQueryConnection) =>
  prepareStalenessQueries(db, true, true);
const prepareInterruptedWithoutTurn = (db: DbQueryConnection) =>
  prepareStalenessQueries(db, false, true);

export function listPlanStalenessEventRows(
  db: DbConnection,
  plan: StoredEventRow,
  maxSeq: number,
): StoredEventRow[] {
  const hasTurn = plan.turnId !== null;
  const params = {
    threadId: plan.threadId,
    planSequence: plan.sequence,
    planTurnId: plan.turnId,
    maxSeq,
  };
  const queries = prepareCachedQuery(
    db,
    hasTurn ? prepareWithTurn : prepareWithoutTurn,
  );
  const ended = queries.end.get(params);
  if (!ended) return [];
  const startQuery =
    ended.type === "system/thread/interrupted"
      ? prepareCachedQuery(
          db,
          hasTurn ? prepareInterruptedWithTurn : prepareInterruptedWithoutTurn,
        ).start
      : queries.start;
  const start = startQuery.get({
    ...params,
    endSequence: ended.sequence,
    endTurnId: ended.turnId,
  });
  return start ? [start, ended] : [];
}
