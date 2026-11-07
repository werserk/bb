import {
  listLatestTurnRequestEventRows,
  getLatestTurnRequestEventRow,
  listStoredTurnRequestEventsForTurn,
  type DbQueryConnection,
} from "@bb/db";
import { parseStoredTurnRequestEvent } from "./thread-events.js";

export function latestServiceTurn(db: DbQueryConnection, threadId: string) {
  const row = getLatestTurnRequestEventRow(db, threadId);
  return row ? parseStoredTurnRequestEvent(row).serviceTurn : undefined;
}

export function isServiceTurn(
  db: DbQueryConnection,
  threadId: string,
  turnId: string,
): boolean {
  const requests = listStoredTurnRequestEventsForTurn(db, { threadId, turnId });
  return (
    requests.length > 0 &&
    requests.every(
      (row) => parseStoredTurnRequestEvent(row).serviceTurn !== undefined,
    )
  );
}

export function latestServiceTurns(
  db: DbQueryConnection,
  threadIds: readonly string[],
) {
  return new Map(
    listLatestTurnRequestEventRows(db, threadIds).map((row) => [
      row.threadId,
      parseStoredTurnRequestEvent(row).serviceTurn,
    ]),
  );
}
