import { describe, expect, it } from "vitest";
import { listStoredServiceTurnContextRows } from "../src/data/events.js";
import { buildHistoryFixture } from "../src/history-fixture.js";
import { createMigratedConnection } from "../src/testing.js";

interface Row {
  rowid: number;
  sequence: number;
  type: string;
  data: string;
}

function seed(hiddenRequestIndexes: readonly number[]) {
  const db = createMigratedConnection();
  const fixture = buildHistoryFixture(db, {
    historyTurns: 40,
    longTurnSteps: 10,
    neighborThreads: 1,
    neighborTurns: 5,
    providerId: "test",
  });
  const requests = db.$client
    .prepare(
      "SELECT rowid FROM events WHERE thread_id = ? AND type = 'client/turn/requested' ORDER BY sequence",
    )
    .all(fixture.threadId) as { rowid: number }[];
  const hide = db.$client.prepare(
    `UPDATE events SET data = json_set(data, '$.serviceTurn', json('{"visibility":"hidden","kind":"test"}')) WHERE rowid = ?`,
  );
  for (const index of hiddenRequestIndexes) hide.run(requests[index]!.rowid);
  return { db, threadId: fixture.threadId };
}

function expectedSequences(rows: readonly Row[]): number[] {
  const requests = rows.filter((row) => row.type === "client/turn/requested");
  const hidden = requests.filter(
    (row) =>
      (JSON.parse(row.data) as { serviceTurn?: { visibility?: string } })
        .serviceTurn?.visibility === "hidden",
  );
  const hiddenIds = new Set(
    hidden.map(
      (row) => (JSON.parse(row.data) as { requestId: string }).requestId,
    ),
  );
  const next = hidden.flatMap((row) => {
    const after = requests.find((request) => request.sequence > row.sequence);
    return after === undefined ? [] : [after];
  });
  const accepted = rows.filter(
    (row) =>
      row.type === "turn/input/accepted" &&
      hiddenIds.has(
        (JSON.parse(row.data) as { clientRequestId: string }).clientRequestId,
      ),
  );
  return [
    ...new Set([...hidden, ...next, ...accepted].map((row) => row.sequence)),
  ].sort((a, b) => a - b);
}

describe("listStoredServiceTurnContextRows", () => {
  it.each([
    ["no hidden requests", [], 0],
    ["hidden requests in the middle", [3, 4, 17], 3],
    ["the first and the pending latest request hidden", [0, 40], 1],
  ] as const)(
    "returns each hidden request, the request after it and its acceptance: %s",
    (_name, hiddenIndexes, acceptedHidden) => {
      const { db, threadId } = seed(hiddenIndexes);
      try {
        const rows = db.$client
          .prepare(
            "SELECT rowid, sequence, type, data FROM events WHERE thread_id = ? ORDER BY sequence",
          )
          .all(threadId) as Row[];
        const actual = listStoredServiceTurnContextRows(db, threadId)
          .map((row) => row.sequence)
          .sort((a, b) => a - b);
        const expected = expectedSequences(rows);
        expect(actual).toEqual(expected);
        const acceptedCount = rows.filter(
          (row) =>
            row.type === "turn/input/accepted" &&
            expected.includes(row.sequence),
        ).length;
        expect(acceptedCount).toBe(acceptedHidden);
      } finally {
        db.$client.close();
      }
    },
  );
});
