import {
  getStoredTurnRequestEventByRequestId,
  type DbQueryConnection,
} from "@bb/db";
import {
  turnRequestEventDataSchema,
  clientTurnRequestIdSchema,
  type ThreadQueuedMessage,
  type TurnRequestEventData,
  type PromptInput,
} from "@bb/domain";
export function queuedSubmissionMembership(
  db: DbQueryConnection,
  rows: readonly ThreadQueuedMessage[],
): NonNullable<TurnRequestEventData["clientSubmissions"]> {
  const result: NonNullable<TurnRequestEventData["clientSubmissions"]> = [];
  let offset = 0;
  for (const row of rows) {
    const source =
      row.payload.kind === "deferredSteer"
        ? row.payload.sourceRequestId
        : row.payload.kind === "retry"
          ? row.payload.retryOfTurnRequestId
          : null;
    if (source !== null && source !== undefined) {
      const stored = getStoredTurnRequestEventByRequestId(db, {
        threadId: row.threadId,
        requestId: clientTurnRequestIdSchema.parse(source),
      });
      const request =
        stored === null
          ? null
          : turnRequestEventDataSchema.safeParse(JSON.parse(stored.data));
      if (request?.success) {
        const groupCount = queuedInputGroups(db, [row]).length;
        for (const entry of request.data.clientSubmissions ?? [])
          result.push({
            ...entry,
            inputGroupIndex:
              (row.payload.kind === "retry" && groupCount === 1
                ? 0
                : entry.inputGroupIndex) + offset,
          });
        offset += groupCount;
        continue;
      }
    }
    for (const id of row.clientSubmissionIds ?? [])
      result.push({ id, inputGroupIndex: offset });
    offset++;
  }
  return result;
}

export function queuedInputGroups(
  db: DbQueryConnection,
  rows: readonly ThreadQueuedMessage[],
): PromptInput[][] {
  return rows.flatMap((row) => {
    const source =
      row.payload.kind === "deferredSteer"
        ? row.payload.sourceRequestId
        : row.payload.kind === "retry"
          ? row.payload.retryOfTurnRequestId
          : null;
    if (!source) return [row.content];
    const stored = getStoredTurnRequestEventByRequestId(db, {
      threadId: row.threadId,
      requestId: source,
    });
    if (!stored) {
      if (row.payload.kind === "retry") return [row.content];
      throw new Error("Queued source request is missing");
    }
    const request = turnRequestEventDataSchema.parse(JSON.parse(stored.data));
    if (row.payload.kind === "retry") {
      const groups = request.inputGroups;
      if (
        !groups ||
        groups.reduce((count, group) => count + group.length, 0) !==
          row.content.length
      )
        return [row.content];
      let offset = 0;
      return groups.map((group) => {
        const input = row.content.slice(offset, offset + group.length);
        offset += group.length;
        return input;
      });
    }
    return request.inputGroups ?? [request.input];
  });
}
