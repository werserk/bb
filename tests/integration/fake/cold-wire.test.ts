// The earlier transport diagnostic manually appended a first-looking event. On the
// composed tree that input cannot be admitted. cold-sdk-first uses real native admission.
import { expect, it } from "vitest";
import { createTestDb } from "../../../apps/server/test/helpers/test-app.js";
import {
  setupPlacement,
  acceptPrepared,
  attachAndQueue,
} from "../../../packages/db/test/helpers/placement.js";
import {
  appendFixture,
  claimFixture,
} from "../../../packages/db/test/helpers/placement-dispatch.js";
import {
  readPlacementOperation,
  readPlacementDispatchReceipt,
  listEvents,
  PlacementDispatchConflictError,
} from "@bb/db";

it("rolls back the hand-built first request before transport", () => {
  const db = createTestDb();
  try {
    setupPlacement(db);
    const op = acceptPrepared(db, "cold-wire-fixture");
    attachAndQueue(db, op.id);
    const attached = readPlacementOperation(db, op.id)!;
    const rows = claimFixture(db, attached.queueReceipt!.queuedMessageId);
    const requestId = "creq_2222222222",
      threadId = rows[0]!.threadId;
    expect(() =>
      db.transaction(
        (tx) =>
          appendFixture(tx, op.id, rows, requestId, {
            source: "spawn",
            target: { kind: "thread-start" },
            request: { method: "thread/start", params: {} },
          }),
        { behavior: "immediate" },
      ),
    ).toThrow(PlacementDispatchConflictError);
    expect(
      readPlacementDispatchReceipt(db, { threadId, requestId }),
    ).toBeNull();
    expect(
      listEvents(db, { threadId }).filter(
        (e) => e.type === "client/turn/requested",
      ),
    ).toHaveLength(0);
  } finally {
    db.$client.close();
  }
});
