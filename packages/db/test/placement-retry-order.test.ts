import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { threadScope, type TurnRequestEventData } from "@bb/domain";
import * as data from "../src/index.js";
import {
  events,
  threads,
  placementRetryTargets,
  queuedThreadMessages as queue,
} from "../src/schema.js";
import { appendStoredThreadEventInTransaction } from "../src/data/events.js";
import {
  setupPlacement,
  acceptPrepared,
  attachAndQueue,
  fixtureAuthority,
  candidate,
  observation,
  purpose,
} from "./helpers/placement.js";
import {
  failFixture,
  claimFixture,
  appendFixture,
  fixtureCommand,
} from "./helpers/placement-dispatch.js";

const worker = { ownerPluginId: "workers", workerId: "worker" };
const retryRequest = "creq_3333333333";
const independentRequest = "creq_4444444444";
let dir: string, db: data.DbConnection;
function reopen() {
  db.$client.close();
  db = data.createConnection(join(dir, "fixture.db"));
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "placement-retry-order-"));
  db = data.createConnection(join(dir, "fixture.db"));
  data.migrate(db);
  setupPlacement(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
function observedIdle(
  operationId: string,
  threadId: string,
  fence: number,
  revision: number,
) {
  return data.recordPlacementRuntimeState(db, {
    ...worker,
    operationId,
    fence,
    activity: "idle",
    backgroundWork: false,
    pendingInteraction: false,
    custody: {
      ...observation().custody,
      status: "held",
      revision,
      holder: {
        threadId,
        fence,
        bootId: "boot",
        processStart: "process-" + fence,
      },
    },
  });
}
function setup(compatible: boolean) {
  const attached = attachAndQueue(db, acceptPrepared(db, "head").id);
  if (attached.kind !== "recorded") throw new Error("head not queued");
  const owner = attached.operation,
    failed = failFixture(db, owner.id);
  expect(observedIdle(owner.id, owner.threadId!, 1, 2)).toMatchObject({
    state: "resident",
  });
  const earlier = acceptPrepared(
    db,
    "earlier",
    compatible ? {} : { workspaceBindingId: "other" },
  );
  const grant = data.grantPlacementRetryConsent(db, {
    principalScope: "owner",
    submissionKey: "grant",
    failedOperationId: owner.id,
    failedRequestId: failed,
    permissionProvenance: {
      identity: "local-unverified",
      authority: "local-input-parity",
      actionId: "click",
    },
  });
  if (grant.kind !== "granted") throw new Error("grant failed");
  const accepted = data.acceptPlacementOperation(db, {
    principalScope: "owner",
    ownerPluginId: "workers",
    providerId: "claude",
    authority: fixtureAuthority,
    submissionKey: "retry",
    request: {
      schemaVersion: 1,
      intent: {
        kind: "retry",
        consentId: grant.consent.id,
        failedOperationId: owner.id,
      },
    },
  });
  if (accepted.kind !== "accepted") throw new Error("accept failed");
  const retry = accepted.operation,
    schedule = {
      scheduler: "provider-retry",
      operationId: retry.id,
      sendAt: Date.now() - 20,
    };
  const qid = data.schedulePlacementRetry(db, schedule);
  if (!qid) throw new Error("schedule failed");
  reopen();
  const env = data.readPlacementOperationRecord(db, retry.id)!.retryDerivation!;
  const body: Partial<TurnRequestEventData> = {
    initiator: "system",
    input: env.input as TurnRequestEventData["input"],
    inputGroups: env.groups as TurnRequestEventData["inputGroups"],
    clientSubmissions:
      env.membership as TurnRequestEventData["clientSubmissions"],
    retryOfRequestId: failed,
    retryAttempt: 2,
  };
  return {
    owner,
    earlier,
    retry,
    qid,
    schedule,
    body,
    consent: grant.consent.id,
  };
}
function dispatchRetry(
  ownerId: string,
  fence: number,
  claims: ReturnType<typeof claimFixture>,
  body: Partial<TurnRequestEventData>,
) {
  return db.transaction(
    (tx) => appendFixture(tx, ownerId, claims, retryRequest, body, fence),
    { behavior: "immediate" },
  );
}
function reclaim(target: string, source: string, fence: number) {
  return data.beginPlacementReclaim(db, {
    ...candidate(db, target),
    expectedSourceOperationId: source,
    expectedSourceFence: fence,
  });
}
function close(
  target: string,
  source: string,
  fence: number,
  revision: number,
  processClosed = true,
) {
  return data.finishPlacementReclaim(db, {
    ...worker,
    operationId: target,
    closedSourceOperationId: source,
    fence,
    processClosed,
    observation: { ...observation().custody, revision },
  });
}
function winningCommand(guard: ReturnType<typeof appendFixture>["guard"]) {
  const cmd = {
    ...guard,
    ...fixtureCommand,
    commandId: guard.requestId + "-command",
    nativeExecutionId: guard.requestId + "-execution",
    currentAgentSessionId: fixtureCommand.agentSessionId,
  };
  expect(data.preparePlacementExecutionCommand(db, cmd).kind).toBe("prepared");
  expect(data.claimPlacementExecutionCommand(db, cmd).kind).toBe("won");
  return cmd;
}
it("refuses a retry grant after reopen when a thread reports error without a terminal command outcome", () => {
  const head = attachAndQueue(db, acceptPrepared(db, "uncertain").id);
  if (head.kind !== "recorded") throw new Error("head not queued");
  const rows = claimFixture(db, head.operation.queueReceipt!.queuedMessageId);
  const { guard } = db.transaction((tx) =>
    appendFixture(tx, head.operation.id, rows, independentRequest),
  );
  winningCommand(guard);
  db.update(threads)
    .set({ status: "error" })
    .where(eq(threads.id, guard.threadId))
    .run();
  reopen();
  expect(data.readPlacementDispatchReceipt(db, guard)?.state).toBe(
    "possibly_sent",
  );
  expect(
    data.grantPlacementRetryConsent(db, {
      principalScope: "owner",
      submissionKey: "retry",
      failedOperationId: head.operation.id,
      failedRequestId: guard.requestId,
      permissionProvenance: {
        identity: "local-unverified",
        authority: "local-input-parity",
        actionId: "click",
      },
    }).kind,
  ).toBe("refused");
  expect(db.select().from(placementRetryTargets).all()).toHaveLength(0);
});
it("admits a due retry on its original resident when the earlier workspace is incompatible", () => {
  const { owner, earlier, retry, qid, body } = setup(false);
  expect(reclaim(earlier.id, owner.id, 1).kind).toBe("wait");
  const { receipt } = dispatchRetry(owner.id, 1, claimFixture(db, qid), body);
  expect(receipt.members.map((m) => m.op)).toEqual([retry.id]);
  expect(receipt.binding).toEqual(owner.binding);
  expect(data.readPlacementOperation(db, earlier.id)?.phase).toBe("pending");
});

it.each(["due", "early", "revoked", "superseded"] as const)(
  "returns to the same retry after earlier compatible work (%s)",
  (mode) => {
    const { owner, earlier, retry, qid, body, consent, schedule } = setup(true);
    const claimed = claimFixture(db, qid);
    const target = () =>
      db
        .select()
        .from(placementRetryTargets)
        .where(eq(placementRetryTargets.consent, consent))
        .get()!;
    const native = () => db.select().from(queue).where(eq(queue.id, qid)).get();
    expect(() => dispatchRetry(owner.id, 1, claimed, body)).toThrow(
      expect.objectContaining({
        name: "PlacementGroupFairnessError",
        retainedHead: null,
        blockedMemberOperationId: retry.id,
        earlierOperationId: earlier.id,
      }),
    );
    expect(
      data.readPlacementDispatchReceipt(db, {
        threadId: owner.threadId!,
        requestId: retryRequest,
      }),
    ).toBeNull();
    expect(
      db
        .select()
        .from(events)
        .where(eq(events.threadId, owner.threadId!))
        .all()
        .map((e) => JSON.parse(e.data).requestId),
    ).not.toContain(retryRequest);
    expect(target().state).toBe("scheduled");
    expect(native()).toMatchObject({
      placementFence: null,
      claimToken: claimed[0]!.claimToken,
    });
    expect(
      data.releaseQueuedMessageClaim(db, data.noopNotifier, claimed[0]!),
    ).toBe(true);
    expect(reclaim(earlier.id, owner.id, 1).kind).toBe("reclaiming");
    expect(close(earlier.id, owner.id, 1, 3).kind).toBe("released");
    const queued = attachAndQueue(db, earlier.id);
    if (queued.kind !== "recorded") throw new Error("earlier not queued");
    const rows = claimFixture(
      db,
      queued.operation.queueReceipt!.queuedMessageId,
    );
    const { guard, body: independentBody } = db.transaction(
      (tx) => appendFixture(tx, earlier.id, rows, independentRequest, {}, 2),
      { behavior: "immediate" },
    );
    const command = winningCommand(guard);
    expect(observedIdle(earlier.id, guard.threadId, 2, 4)).toMatchObject({
      state: "active",
    });
    expect(reclaim(retry.id, earlier.id, 2).kind).toBe("wait");
    expect(
      db.transaction((tx) =>
        data.settlePlacementExecutionCommand(tx, {
          ...command,
          outcome: "succeeded",
        }),
      ),
    ).toBe(true);
    expect(observedIdle(earlier.id, guard.threadId, 2, 5)).toMatchObject({
      state: "resident",
    });
    reopen();
    const invalidate = () => {
      if (mode === "early")
        vi.spyOn(Date, "now").mockReturnValue(schedule.sendAt - 1);
      if (mode === "revoked")
        expect(data.revokePlacementRetryConsent(db, consent)).toBe(true);
      if (mode === "superseded")
        db.transaction((tx) =>
          appendStoredThreadEventInTransaction(tx, {
            threadId: owner.threadId!,
            scope: threadScope(),
            type: "client/turn/requested",
            data: { ...independentBody, requestId: "creq_5555555555" },
          }),
        );
    };
    if (mode !== "due") {
      const original = db,
        control = join(dir, "eligibility-control.db");
      writeFileSync(control, original.$client.serialize());
      db = data.createConnection(control);
      try {
        invalidate();
        expect(reclaim(retry.id, earlier.id, 2).kind).toBe("wait");
      } finally {
        db.$client.close();
        db = original;
        vi.restoreAllMocks();
      }
    }
    expect(reclaim(retry.id, earlier.id, 2).kind).toBe("reclaiming");
    expect(close(retry.id, earlier.id, 2, 6, false).kind).toBe("wait");
    expect(data.reservePlacementWorker(db, candidate(db, retry.id)).kind).toBe(
      "wait",
    );
    expect(close(retry.id, earlier.id, 2, 6).kind).toBe("released");
    invalidate();
    const reservation = data.reservePlacementWorker(
      db,
      candidate(db, retry.id),
    );
    if (mode !== "due") {
      expect(reservation.kind).toBe("wait");
      expect(target().state).toBe(mode === "revoked" ? "revoked" : "scheduled");
      expect(data.readPlacementQueueAttempts(db, qid)[0]?.request).toBeNull();
      return;
    }
    expect(reservation).toMatchObject({
      kind: "reserved",
      fence: 3,
      operation: { id: retry.id, binding: owner.binding },
    });
    expect(native()).toMatchObject({
      id: qid,
      placementFence: null,
      claimToken: null,
      sendAt: schedule.sendAt,
    });
    expect(target().state).toBe("scheduled");
    reopen();
    expect(data.reservePlacementWorker(db, candidate(db, retry.id))).toEqual({
      kind: "wait",
      reason: "reconciliation_required",
    });
    expect(
      data.readPlacementResidentGuard(db, owner.threadId!, purpose),
    ).toMatchObject({ executionOwnerOperationId: retry.id, fence: 3 });
    const same = claimFixture(db, qid);
    expect(() => dispatchRetry(owner.id, 1, same, body)).toThrow(
      data.PlacementDispatchConflictError,
    );
    const admitted = dispatchRetry(retry.id, 3, same, body);
    expect(admitted.receipt).toMatchObject({
      binding: owner.binding,
      executionOwnerOperationId: retry.id,
      fence: 3,
      members: [{ op: retry.id, queueId: qid }],
    });
    const final = winningCommand(admitted.guard);
    reopen();
    expect(data.claimPlacementExecutionCommand(db, final).kind).toBe("held");
    expect(target().state).toBe("spent");
    expect(data.schedulePlacementRetry(db, schedule)).toBe(qid);
    expect(
      data.readPlacementQueueAttempts(db, qid).map((m) => m.request),
    ).toEqual([retryRequest]);
    expect(native()).toBeUndefined();
    const requested = db
      .select()
      .from(events)
      .where(eq(events.type, "client/turn/requested"))
      .all();
    expect(requested).toHaveLength(3);
    expect(
      requested.filter((e) => JSON.parse(e.data).requestId === retryRequest),
    ).toHaveLength(1);
  },
);
