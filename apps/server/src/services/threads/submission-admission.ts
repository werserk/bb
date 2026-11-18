import {
  getLatestThreadSequence,
  getQueuedThreadMessage,
  listStoredEventRows,
  listStoredEventRowsContaining,
  type DbQueryConnection,
} from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import { ApiError } from "../../errors.js";

export function assertSubmissionNotAdmitted(
  db: DbQueryConnection,
  threadId: string,
  id: string,
  afterSequence?: number,
) {
  const queue = getQueuedThreadMessage(db, `qsub_${id}`);
  if (queue && queue.threadId !== threadId)
    throw new ApiError(
      409,
      "submission_conflict",
      "Submission identity belongs to another thread",
    );
  if (queue)
    throw new ApiError(
      409,
      "submission_already_admitted",
      "Submission already admitted",
      { details: { queuedMessageId: queue.id, threadId: queue.threadId } },
    );
  const scan = findRequestedSubmission(db, threadId, id, afterSequence);
  if (scan.requested)
    throw new ApiError(
      409,
      "submission_already_admitted",
      "Submission already admitted",
      { details: { requested: scan.requested } },
    );
  return {
    scannedRows: scan.scannedRows,
    scannedBytes: scan.scannedBytes,
    parsedRows: scan.parsedRows,
  };
}
/**
 * The newest `client/turn/requested` event (of the last 1000) that admitted
 * submission `id`. A row whose JSON names `id` contains it literally, unless
 * the text uses a \u escape (the only other JSON spelling of [0-9A-Za-z-]),
 * so SQLite returns only rows containing either; only those are parsed.
 */
export function findRequestedSubmission(
  db: DbQueryConnection,
  threadId: string,
  id: string,
  afterSequence?: number,
) {
  const literal = /^[0-9A-Za-z-]+$/u.test(id);
  const rows = literal
    ? listStoredEventRowsContaining(db, {
        threadId,
        type: "client/turn/requested",
        window: 1000,
        needles: [id, "\\u"],
        ...(afterSequence === undefined ? {} : { afterSequence }),
      })
    : listStoredEventRows(db, {
        threadId,
        types: ["client/turn/requested"],
        limit: 1000,
        order: "desc",
        ...(afterSequence === undefined ? {} : { afterSequence }),
      });
  let scannedBytes = 0;
  let parsedRows = 0;
  for (const row of rows) {
    scannedBytes += Buffer.byteLength(row.data);
    parsedRows++;
    const request = turnRequestEventDataSchema.safeParse(JSON.parse(row.data));
    if (
      request.success &&
      request.data.clientSubmissions?.some((entry) => entry.id === id)
    )
      return {
        requested: {
          requestId: request.data.requestId,
          sequence: row.sequence,
        },
        scannedRows: rows.length,
        scannedBytes,
        parsedRows,
      };
  }
  return {
    requested: undefined,
    scannedRows: rows.length,
    scannedBytes,
    parsedRows,
  };
}
const floors = new WeakMap<object, Map<string, number>>();
export function submissionAdmissionFloor(
  db: object,
  threadId: string,
  id: string,
) {
  return floors.get(db)?.get(`${threadId}/${id}`);
}
const inflight = new WeakMap<
  object,
  Map<
    string,
    {
      payload: string;
      result: Promise<import("@bb/server-contract").SendMessageResponse>;
    }
  >
>();
export function guardSubmission(
  db: DbQueryConnection,
  threadId: string,
  id: string,
  payload: unknown,
  /** `floor`: the thread's last sequence before this submission's checks. */
  send: (
    floor: number,
  ) => Promise<import("@bb/server-contract").SendMessageResponse>,
) {
  let active = inflight.get(db);
  if (!active) {
    active = new Map();
    inflight.set(db, active);
  }
  const key = `${threadId}/${id}`;
  const encoded = JSON.stringify(payload);
  const previous = active.get(key);
  if (previous) {
    if (previous.payload !== encoded)
      throw new ApiError(
        409,
        "submission_conflict",
        "Conflicting submission identity",
      );
    return previous.result;
  }
  const sequence = getLatestThreadSequence(db, { threadId });
  assertSubmissionNotAdmitted(db, threadId, id);
  let checkpoints = floors.get(db);
  if (!checkpoints) {
    checkpoints = new Map();
    floors.set(db, checkpoints);
  }
  checkpoints.set(key, sequence);
  const result = Promise.resolve()
    .then(() => send(sequence))
    .finally(() => {
      active!.delete(key);
      checkpoints!.delete(key);
    });
  active.set(key, { payload: encoded, result });
  return result;
}
