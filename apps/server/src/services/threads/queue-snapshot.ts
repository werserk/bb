import {
  getLatestThreadSequence,
  listQueuedThreadMessages,
  listStoredEventRows,
  type DbConnection,
} from "@bb/db";
import {
  clientSubmissionIdSchema,
  turnRequestEventDataSchema,
  turnRequestRejectedEventDataSchema,
  type TurnRequestEventData,
} from "@bb/domain";
import type {
  QueueSnapshotResponse,
  QueuePlacement,
} from "@bb/server-contract";
import { toThreadQueuedMessage } from "./thread-queued-messages.js";

type Requested = { data: TurnRequestEventData; sequence: number };
export function readQueueSnapshot(
  db: DbConnection,
  threadId: string,
  known: string[],
): QueueSnapshotResponse {
  return db.transaction((tx) => {
    const start = performance.now();
    let scannedRows = 0,
      scannedBytes = 0,
      before: number | undefined,
      complete = false,
      gaps = false,
      expected: number | undefined;
    const admitsWork = () => performance.now() - start < 100;
    const eventMaxSeq = getLatestThreadSequence(tx, { threadId });
    const rows = listQueuedThreadMessages(tx, threadId).map(
      toThreadQueuedMessage,
    );
    const requests = new Map<string, Requested>();
    const byQueue = new Map<string, Requested>();
    const bySubmission = new Map<string, Requested>();
    const rejected = new Map<
      string,
      {
        data: import("zod").infer<typeof turnRequestRejectedEventDataSchema>;
        sequence: number;
      }
    >();
    while (
      scannedRows < 2000 &&
      scannedBytes < 2 * 1024 * 1024 &&
      admitsWork()
    ) {
      const batch = listStoredEventRows(tx, {
        threadId,
        order: "desc",
        limit: Math.min(100, 2000 - scannedRows),
        ...(before === undefined ? {} : { beforeSequence: before }),
      });
      if (batch.length === 0) {
        complete = true;
        break;
      }
      for (const row of batch) {
        if (expected !== undefined && row.sequence !== expected) gaps = true;
        expected = row.sequence - 1;
        scannedRows++;
        scannedBytes += Buffer.byteLength(row.data);
        before = row.sequence;
        let data: unknown;
        try {
          data = JSON.parse(row.data);
        } catch {
          gaps = true;
          continue;
        }
        if (row.type === "client/turn/requested") {
          const parsed = turnRequestEventDataSchema.safeParse(data);
          if (parsed.success) {
            const request = { data: parsed.data, sequence: row.sequence };
            requests.set(parsed.data.requestId, request);
            for (const id of parsed.data.sourceQueuedMessageIds ?? [])
              if (!byQueue.has(id)) byQueue.set(id, request);
            for (const member of parsed.data.clientSubmissions ?? [])
              if (!bySubmission.has(member.id))
                bySubmission.set(member.id, request);
          } else gaps = true;
        }
        if (row.type === "client/turn/rejected") {
          const parsed = turnRequestRejectedEventDataSchema.safeParse(data);
          if (parsed.success && !rejected.has(parsed.data.requestId))
            rejected.set(parsed.data.requestId, {
              data: parsed.data,
              sequence: row.sequence,
            });
          else if (!parsed.success) gaps = true;
        }
      }
      if (batch.length < 100) {
        complete = true;
        break;
      }
    }
    const fullCoverage =
      complete &&
      !gaps &&
      (expected === 0 || (scannedRows === 0 && eventMaxSeq === 0));
    let partial = !fullCoverage;
    for (const row of rows) {
      if (!admitsWork()) {
        partial = true;
        break;
      }
      const source =
        row.payload.kind === "deferredSteer"
          ? row.payload.sourceRequestId
          : row.payload.kind === "retry"
            ? row.payload.retryOfTurnRequestId
            : null;
      if (source) {
        const request = requests.get(source);
        if (request)
          row.clientSubmissionIds = request.data.clientSubmissions?.map(
            (entry) => entry.id,
          );
      }
    }
    const placements: QueuePlacement[] = known.map((queueId) => {
      const present = rows.find((row) => row.id === queueId);
      const derived = queueId.startsWith("qsub_")
        ? clientSubmissionIdSchema.safeParse(queueId.slice(5))
        : null;
      const submissionIds =
        present?.clientSubmissionIds ??
        (derived?.success ? [derived.data] : []);
      if (!admitsWork()) {
        partial = true;
        return {
          queueId,
          submissionIds,
          state: present ? "queued" : "unresolved",
        };
      }
      const candidates = [
        byQueue.get(queueId),
        ...submissionIds.map((id) => bySubmission.get(id)),
      ].filter((value): value is Requested => !!value);
      let request = candidates.sort((a, b) => b.sequence - a.sequence)[0];
      const visited = new Set<string>();
      while (request) {
        if (!admitsWork() || visited.has(request.data.requestId)) {
          partial = true;
          return { queueId, submissionIds, state: "unresolved" };
        }
        visited.add(request.data.requestId);
        const rejection = rejected.get(request.data.requestId);
        const deferredId = rejection?.data.deferredToQueuedMessageId;
        if (deferredId) {
          const next = byQueue.get(deferredId);
          if (next && next.sequence > rejection.sequence) {
            request = next;
            continue;
          }
          return {
            queueId,
            submissionIds,
            state: "deferred",
            requestId: request.data.requestId,
            requestSequence: rejection.sequence,
            deferredToQueuedMessageId: deferredId,
          };
        }
        return {
          queueId,
          submissionIds,
          state: rejection ? "rejected" : "requested",
          requestId: request.data.requestId,
          requestSequence: rejection?.sequence ?? request.sequence,
        };
      }
      return {
        queueId,
        submissionIds,
        state: present ? "queued" : fullCoverage ? "removed" : "unresolved",
      };
    });
    return {
      rows,
      eventMaxSeq,
      queuePresence: known.map((id) => ({
        id,
        present: rows.some((row) => row.id === id),
      })),
      coverage: partial ? "partial" : "complete",
      placements,
      diagnostics: {
        scannedRows,
        scannedBytes,
        elapsedMs: performance.now() - start,
      },
    };
  });
}
