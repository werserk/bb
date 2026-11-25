import {
  appendFixture,
  claimFixture,
  fixtureCommand,
} from "../../../packages/db/test/helpers/placement-dispatch.js";
import {
  readPlacementDispatchReceipt,
  preparePlacementExecutionCommand,
  claimPlacementExecutionCommand,
  events,
} from "@bb/db";
import { NotificationHub } from "../../../apps/server/src/ws/hub.js";
import { threadScope, turnScope } from "@bb/domain";
import { appendThreadEventInTransaction } from "../../../apps/server/src/services/threads/thread-events.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  acceptPlacementOperation,
  admitPlacementDispatch,
  createConnection,
  environments,
  hosts,
  migrate,
  preparePlacementOperation,
  readPlacementOperation,
  recordPlacementRuntimeState,
  placementWorkers,
  type DbConnection,
} from "@bb/db";
import {
  acceptPrepared,
  attachAndQueue,
  candidate,
  observation,
  setupPlacement,
  fixtureAuthority,
  purpose,
  workspace,
} from "../../../packages/db/test/helpers/placement.js";
import {
  assertNativeThreadExecution,
  assertThreadToolSession,
  dispatchManagedOrdinaryTurn,
  readManagedExecutionPlacement,
} from "../../../apps/server/src/services/threads/managed-execution.js";

let db: DbConnection;
let operationId: string;
let threadId: string;
const requestId = "creq_23456789ab";
beforeEach(() => {
  db = createConnection(":memory:");
  migrate(db);
  setupPlacement(db);
  operationId = acceptPrepared(db, "ordinary").id;
  attachAndQueue(db, operationId);
  threadId = readPlacementOperation(db, operationId)!.threadId!;
});
afterEach(() => db.$client.close());
function admit(id: string) {
  expect(
    db.transaction((tx) =>
      admitPlacementDispatch(tx, {
        ...candidate(db, id),
        queuedMessageId: readPlacementOperation(db, id)!.queueReceipt!
          .queuedMessageId,
        fence: 1,
      }),
    ),
  ).toMatchObject({ kind: "admitted" });
}
it("derives both placement destinations and operation identity from the database", () => {
  expect(readManagedExecutionPlacement(db, threadId)).toMatchObject({
    binding: { agentHostId: "agent-host", generation: "gen" },
    workspace: { hostId: "workspace-host", canonicalRoot: "/scratch" },
    executionOwnerOperationId: operationId,
    fence: 1,
  });
});
it("a new operation on the same physical fence supersedes the resident owner", () => {
  admit(operationId);
  const held = {
    ...observation().custody,
    status: "held" as const,
    revision: 2,
    holder: { threadId, fence: 1, processStart: "p", bootId: "b" },
  };
  expect(
    recordPlacementRuntimeState(db, {
      ownerPluginId: "workers",
      workerId: "worker",
      operationId,
      fence: 1,
      activity: "idle",
      backgroundWork: false,
      pendingInteraction: false,
      custody: held,
    }),
  ).toMatchObject({ state: "resident" });
  const next = acceptPlacementOperation(db, {
    authority: fixtureAuthority,
    ownerPluginId: "workers",
    providerId: "claude",
    principalScope: "owner",
    submissionKey: "follow",
    request: {
      schemaVersion: 1,
      intent: { kind: "continuation", threadId, request: { input: "follow" } },
    },
  });
  if (next.kind !== "accepted") throw Error("continuation failed");
  expect(
    preparePlacementOperation(db, {
      operationId: next.operation.id,
      expectedRevision: next.operation.revision,
      workspace,
      preparedExecution: {
        model: "model",
        reasoningLevel: "high",
        serviceTier: "default",
        permissionMode: "auto",
        source: "client/thread/start",
      },
      preparedRequest: { input: "follow" },
      attachmentReceipts: [],
    }),
  ).toMatchObject({ kind: "prepared" });
  attachAndQueue(db, next.operation.id);
  admit(next.operation.id);
  expect(readManagedExecutionPlacement(db, threadId)).toMatchObject({
    executionOwnerOperationId: next.operation.id,
    fence: 1,
  });
  expect(() => assertNativeThreadExecution(db, threadId)).toThrow(
    /verified command handoff/,
  );
});
it.each(["third-host", "workspace-host"])(
  "refuses a tool from %s before turn lookup",
  (sessionHostId) => {
    expect(() =>
      assertThreadToolSession(db, {
        threadId,
        environmentHostId: "workspace-host",
        sessionHostId,
        providerThreadId: "provider",
        turnId: "turn",
      }),
    ).toThrow(/bound Agent/);
  },
);
it("refuses an obsolete turn from the assigned Agent", () => {
  expect(() =>
    assertThreadToolSession(db, {
      threadId,
      environmentHostId: "workspace-host",
      sessionHostId: "agent-host",
      providerThreadId: "provider",
      turnId: "stale",
    }),
  ).toThrow(/active provider turn/);
});
it.each(["host", "root", "generation"])(
  "rejects changed %s in the stored placement",
  (field) => {
    if (field === "generation")
      db.update(placementWorkers)
        .set({ generation: "next" })
        .where(eq(placementWorkers.workerId, "worker"))
        .run();
    else if (field === "root")
      db.update(environments)
        .set({ path: "/changed" })
        .where(eq(environments.id, "env"))
        .run();
    else {
      db.insert(hosts)
        .values({
          id: "other",
          name: "Other",
          type: "persistent",
          createdAt: 1,
          updatedAt: 1,
        })
        .run();
      db.update(environments)
        .set({ hostId: "other" })
        .where(eq(environments.id, "env"))
        .run();
    }
    expect(() => readManagedExecutionPlacement(db, threadId)).toThrow(
      /placement is unavailable or has changed/,
    );
  },
);
it("a historical per-member queue receipt cannot authorize the post-commit entry", async () => {
  admit(operationId);
  await expect(
    dispatchManagedOrdinaryTurn(
      { db, hub: new NotificationHub() },
      { threadId, requestId },
    ),
  ).rejects.toMatchObject({
    status: 409,
    body: { code: "managed_request_missing" },
  });
});

it("a committed native request by itself cannot authorize dispatch", async () => {
  const {
    appendPreparedClientTurnRequestedEventWithNotificationInTransaction,
  } =
    await import("../../../apps/server/src/services/threads/thread-events.js");
  const committed = db.transaction((tx) =>
    appendPreparedClientTurnRequestedEventWithNotificationInTransaction(tx, {
      threadId,
      environmentId: workspace.environmentId,
      requestId,
      type: "client/turn/requested",
      initiator: "user",
      requestMethod: "turn/start",
      source: "tell",
      target: { kind: "new-turn" },
      input: [{ type: "text", text: "fixture", mentions: [] }],
      execution: {
        model: "model",
        permissionMode: "auto",
        serviceTier: "default",
        reasoningLevel: "high",
        source: "client/turn/requested",
      },
      originPluginId: null,
      senderThreadId: null,
    }),
  );
  expect(committed.requestId).toBe(requestId);
  await expect(
    dispatchManagedOrdinaryTurn(
      { db, hub: new NotificationHub() },
      { threadId, requestId },
    ),
  ).rejects.toMatchObject({
    status: 409,
    body: { code: "managed_receipt_missing" },
  });
});

it("refuses a matching active provider turn without authenticated command and call provenance", () => {
  const providerThreadId = "provider-own",
    turnId = "turn-live";
  db.transaction((tx) => {
    appendThreadEventInTransaction(tx, {
      threadId,
      environmentId: workspace.environmentId,
      providerThreadId,
      type: "thread/identity",
      scope: threadScope(),
      data: { providerThreadId },
    });
    appendThreadEventInTransaction(tx, {
      threadId,
      environmentId: workspace.environmentId,
      providerThreadId,
      type: "turn/started",
      scope: turnScope(turnId),
      data: { providerThreadId },
    });
  });
  expect(() =>
    assertThreadToolSession(db, {
      threadId,
      sessionHostId: "agent-host",
      environmentHostId: workspace.hostId,
      providerThreadId,
      turnId,
    }),
  ).toThrow(/verified command handoff/);
});

function commitOrdinaryFixture() {
  const op = readPlacementOperation(db, operationId)!;
  const rows = claimFixture(db, op.queueReceipt!.queuedMessageId);
  return db.transaction(
    (tx) => appendFixture(tx, operationId, rows, requestId),
    { behavior: "immediate" },
  );
}
function rejectedEvents() {
  return db
    .select()
    .from(events)
    .where(eq(events.type, "client/turn/rejected"))
    .all();
}
it("270 atomically records one native rejection and retains actual ordered membership", async () => {
  const { receipt } = commitOrdinaryFixture();
  const key = { threadId, requestId },
    deps = {
      db,
      hub: new NotificationHub(),
      placementWorkspacePurpose: purpose,
    };
  await expect(dispatchManagedOrdinaryTurn(deps, key)).rejects.toMatchObject({
    status: 409,
    body: { code: "managed_execution_unsupported" },
  });
  await expect(dispatchManagedOrdinaryTurn(deps, key)).rejects.toMatchObject({
    body: { details: { state: "refused_unsent" } },
  });
  expect(readPlacementDispatchReceipt(db, key)).toMatchObject({
    state: "refused_unsent",
    members: receipt.members,
    commandId: null,
    nativeExecutionId: null,
  });
  const rejected = rejectedEvents();
  expect(rejected).toHaveLength(1);
  expect(rejected[0]!.sequence).toBeGreaterThan(receipt.requestSequence);
  expect(JSON.parse(rejected[0]!.data)).toMatchObject({
    requestId,
    reason: "managed_execution_unsupported",
  });
});
it("rolls back the refusal when its native event cannot commit", async () => {
  commitOrdinaryFixture();
  db.$client.exec(
    "CREATE TEMP TRIGGER block_rejection BEFORE INSERT ON events WHEN NEW.type='client/turn/rejected' BEGIN SELECT RAISE(ABORT, 'synthetic event fault'); END",
  );
  const key = { threadId, requestId };
  await expect(
    dispatchManagedOrdinaryTurn(
      { db, hub: new NotificationHub(), placementWorkspacePurpose: purpose },
      key,
    ),
  ).rejects.toMatchObject({ cause: { message: "synthetic event fault" } });
  expect(readPlacementDispatchReceipt(db, key)?.state).toBe("prepared");
  expect(rejectedEvents()).toHaveLength(0);
});
it("a competing send claim cannot become a definitive rejection", async () => {
  const { guard } = commitOrdinaryFixture();
  const cmd = { ...guard, ...fixtureCommand };
  expect(preparePlacementExecutionCommand(db, cmd).kind).toBe("prepared");
  expect(
    claimPlacementExecutionCommand(db, {
      ...cmd,
      currentAgentSessionId: cmd.agentSessionId,
    }).kind,
  ).toBe("won");
  await expect(
    dispatchManagedOrdinaryTurn(
      { db, hub: new NotificationHub(), placementWorkspacePurpose: purpose },
      { threadId, requestId },
    ),
  ).rejects.toMatchObject({ body: { details: { state: "possibly_sent" } } });
  expect(readPlacementDispatchReceipt(db, { threadId, requestId })?.state).toBe(
    "possibly_sent",
  );
  expect(rejectedEvents()).toHaveLength(0);
});
it("no composition purpose records an unavailable admission with no command", async () => {
  commitOrdinaryFixture();
  await expect(
    dispatchManagedOrdinaryTurn(
      { db, hub: new NotificationHub() },
      { threadId, requestId },
    ),
  ).rejects.toMatchObject({ body: { code: "managed_admission_unavailable" } });
  expect(JSON.parse(rejectedEvents()[0]!.data).reason).toBe(
    "managed_admission_unavailable",
  );
});

it("rolls back the just-appended rejection when its refusal CAS loses", async () => {
  commitOrdinaryFixture();
  db.$client.exec(
    "CREATE TEMP TRIGGER hold_effect BEFORE UPDATE OF state ON placement_effect BEGIN SELECT RAISE(IGNORE); END",
  );
  const key = { threadId, requestId };
  await expect(
    dispatchManagedOrdinaryTurn(
      { db, hub: new NotificationHub(), placementWorkspacePurpose: purpose },
      key,
    ),
  ).rejects.toMatchObject({ body: { code: "managed_execution_recorded" } });
  expect(readPlacementDispatchReceipt(db, key)?.state).toBe("prepared");
  expect(rejectedEvents()).toHaveLength(0);
});
