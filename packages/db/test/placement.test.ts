import { failFixture } from "./helpers/placement-dispatch.js";
import { fixtureAuthority } from "./helpers/placement.js";
import { workspaceBindingRef } from "@bb/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createMigratedConnection } from "../src/testing.js";
import {
  acceptPlacementOperation,
  readPlacementOperation,
} from "../src/data/placement-operations.js";
import { registerPlacementOwner } from "../src/data/placement-workers.js";
const connections: ReturnType<typeof createMigratedConnection>[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});
const request = {
  schemaVersion: 1 as const,
  intent: {
    kind: "independent" as const,
    selection: { mode: "auto" as const },
    request: { input: "accepted original" },
  },
};
describe("durable placement acceptance", () => {
  it("replays one stable receipt and conflicting input writes nothing", async () => {
    const db = managed();
    const args = {
      authority: fixtureAuthority,
      principalScope: "owner",
      submissionKey: "key",
      providerId: "claude",
      ownerPluginId: "workers",
      request,
    };
    const results = await Promise.all([
      Promise.resolve().then(() => acceptPlacementOperation(db, args)),
      Promise.resolve().then(() => acceptPlacementOperation(db, args)),
    ]);
    expect(results[0]).toEqual(results[1]);
    if (results[0]?.kind !== "accepted") throw new Error("not accepted");
    const before = db.$client.serialize();
    expect(
      acceptPlacementOperation(db, {
        ...args,
        request: {
          ...request,
          intent: { ...request.intent, request: { input: "substitution" } },
        },
      }),
    ).toEqual({ kind: "conflict" });
    expect(db.$client.serialize()).toEqual(before);
    expect(readPlacementOperation(db, results[0].operation.id)).toEqual(
      results[0].operation,
    );
    expect(JSON.stringify(results)).not.toContain("accepted original");
  });
});

import { eq } from "drizzle-orm";
import {
  placementBindings,
  environments,
  queuedThreadMessages,
  threads,
} from "../src/schema.js";
import {
  setupPlacement,
  acceptPrepared,
  candidate,
  observation,
  attachAndQueue,
  workspace,
} from "./helpers/placement.js";
import {
  reservePlacementWorker,
  admitPlacementDispatch,
  beginPlacementReclaim,
  beginCancelledPlacementRelease,
  recordPlacementRuntimeState,
  finishPlacementReclaim,
} from "../src/data/placement-admission.js";
import {
  cancelPlacementOperation,
  grantPlacementRetryConsent,
} from "../src/data/placement-operations.js";
import {
  observePlacementWorkers,
  readPlacementWorker,
  markPlacementOwnerUnavailable,
  readPlacementOwner,
} from "../src/data/placement-workers.js";
import {
  attachPlacementThread,
  recordPlacementQueueReceipt,
  readPlacementThreadBinding,
  preparePlacementOperation,
} from "../src/data/placement-bindings.js";
function managed() {
  const db = createMigratedConnection();
  connections.push(db);
  setupPlacement(db);
  return db;
}
it("rejects stale route evidence and Agent host drift without changing an immutable pin", () => {
  const db = managed(),
    op = acceptPrepared(db, "pin");
  expect(
    reservePlacementWorker(db, {
      ...candidate(db, op.id),
      routeEvidenceRevision: 9,
    }),
  ).toEqual({ kind: "wait", reason: "unsupported_tool_route" });
  attachAndQueue(db, op.id);
  const current = readPlacementOperation(db, op.id)!;
  const binding = readPlacementThreadBinding(db, current.threadId!)!;
  expect(() =>
    db
      .update(placementBindings)
      .set({ agentHostId: "other" })
      .where(eq(placementBindings.threadId, current.threadId!))
      .run(),
  ).toThrow(/immutable/);
  const changed = observation({
    revision: 2,
    agentHostId: "other",
    custody: { ...observation().custody, revision: 2, agentHostId: "other" },
  });
  observePlacementWorkers(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedOwnerRevision: 2,
    workers: [changed],
  });
  expect(
    db.transaction(
      (tx) =>
        admitPlacementDispatch(tx, {
          ...candidate(db, op.id),
          workerRevision: 2,
          fence: 1,
          queuedMessageId: current.queueReceipt!.queuedMessageId,
        }),
      { behavior: "immediate" },
    ),
  ).toEqual({ kind: "wait", reason: "binding_changed" });
  expect(readPlacementThreadBinding(db, current.threadId!)).toEqual(binding);
});
it("keeps the accepted receipt after queue consumption and repeats no insertion", () => {
  const db = managed(),
    op = acceptPrepared(db, "receipt");
  let notified = 0;
  attachAndQueue(db, op.id, () => {
    notified++;
    expect(db.select().from(placementBindings).all()).toHaveLength(1);
  });
  expect(notified).toBe(2);
  const saved = readPlacementOperation(db, op.id)!;
  db.delete(queuedThreadMessages)
    .where(eq(queuedThreadMessages.id, saved.queueReceipt!.queuedMessageId))
    .run();
  const repeat = db.transaction(
    (tx) =>
      recordPlacementQueueReceipt(tx, {
        operationId: op.id,
        fence: 1,
        queuedMessageId: "replacement",
        insertQueue: () => {
          throw new Error("duplicate insertion");
        },
        onCommitted: () => {
          throw new Error("duplicate notification");
        },
      }),
    { behavior: "immediate" },
  );
  expect(repeat).toEqual({ kind: "recorded", operation: saved });
});
it("rolls back thread, binding and notifications in the caller transaction", () => {
  const db = managed(),
    op = acceptPrepared(db, "rollback");
  reservePlacementWorker(db, candidate(db, op.id));
  let notified = false;
  expect(() =>
    db.transaction(
      (tx) => {
        attachPlacementThread(tx, {
          operationId: op.id,
          fence: 1,
          runtimeRootKey: "runtime",
          sourceProviderThreadId: null,
          sourceCheckpoint: null,
          insertThread: (t, id) => {
            t.insert(threads)
              .values({
                id,
                environmentId: workspace.environmentId,
                projectId: "project",
                providerId: "claude",
                latestAttentionAt: 1,
                createdAt: 1,
                updatedAt: 1,
              })
              .run();
          },
          onCommitted: () => {
            notified = true;
          },
        });
        throw new Error("crash before commit");
      },
      { behavior: "immediate" },
    ),
  ).toThrow("crash before commit");
  expect(db.select().from(threads).all()).toHaveLength(0);
  expect(db.select().from(placementBindings).all()).toHaveLength(0);
  expect(notified).toBe(false);
});
it("preserves managed mode when its owner disappears", () => {
  const db = managed(),
    op = acceptPrepared(db, "missing");
  markPlacementOwnerUnavailable(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedRevision: 2,
  });
  expect(readPlacementOwner(db, "claude")).toMatchObject({
    mode: "managed",
    available: false,
  });
  expect(reservePlacementWorker(db, candidate(db, op.id))).toEqual({
    kind: "wait",
    reason: "owner_unavailable",
  });
});
it("cancels before admission and releases only closed matching fence with fresh fixed-inode evidence", () => {
  const db = managed(),
    op = acceptPrepared(db, "cancel");
  attachAndQueue(db, op.id);
  const cancelled = cancelPlacementOperation(db, op.id)!;
  expect(cancelled.phase).toBe("cancel_requested");
  expect(
    db.transaction(
      (tx) =>
        admitPlacementDispatch(tx, {
          ...candidate(db, op.id),
          fence: 1,
          queuedMessageId: cancelled.queueReceipt!.queuedMessageId,
        }),
      { behavior: "immediate" },
    ),
  ).toMatchObject({ kind: "wait" });
  expect(
    beginCancelledPlacementRelease(db, {
      ownerPluginId: "workers",
      workerId: "worker",
      operationId: op.id,
      expectedFence: 1,
    }),
  ).toMatchObject({ kind: "reclaiming" });
  const release = {
    ownerPluginId: "workers",
    workerId: "worker",
    operationId: op.id,
    fence: 1,
    closedSourceOperationId: op.id,
    processClosed: true,
    observation: { ...observation().custody, revision: 2 },
  };
  expect(
    finishPlacementReclaim(db, { ...release, processClosed: false }),
  ).toEqual({ kind: "wait", reason: "custody_unknown" });
  expect(
    finishPlacementReclaim(db, {
      ...release,
      observation: {
        ...release.observation,
        lock: { device: "1", inode: "recreated" },
      },
    }),
  ).toMatchObject({ kind: "wait" });
  expect(finishPlacementReclaim(db, release)).toEqual({ kind: "released" });
  const next = acceptPrepared(db, "next");
  expect(reservePlacementWorker(db, candidate(db, next.id))).toMatchObject({
    kind: "reserved",
    fence: 2,
  });
  expect(finishPlacementReclaim(db, release)).toMatchObject({ kind: "wait" });
  expect(readPlacementWorker(db, "workers", "worker")?.fence).toBe(2);
});
it("unknown custody stays held and older compatible work wins while another Workspace does not block", () => {
  const db = managed();
  const incompatible = acceptPrepared(db, "different", {
    workspaceBindingId: "other",
    requiredCapabilities: ["shell.foreground"],
  });
  const first = acceptPrepared(db, "first"),
    second = acceptPrepared(db, "second");
  expect(reservePlacementWorker(db, candidate(db, second.id))).toEqual({
    kind: "wait",
    reason: "all_busy",
  });
  expect(reservePlacementWorker(db, candidate(db, first.id))).toMatchObject({
    kind: "reserved",
  });
  expect(readPlacementOperation(db, incompatible.id)?.phase).toBe("pending");
  const changed = observation({
    revision: 2,
    generation: "new",
    custody: {
      ...observation().custody,
      revision: 2,
      generation: "new",
      status: "unknown",
      lock: null,
    },
  });
  observePlacementWorkers(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedOwnerRevision: 2,
    workers: [changed],
  });
  expect(readPlacementWorker(db, "workers", "worker")?.slotState).toBe(
    "unknown",
  );
  observePlacementWorkers(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedOwnerRevision: 2,
    workers: [observation({ revision: 3 })],
  });
  expect(readPlacementWorker(db, "workers", "worker")?.slotState).toBe(
    "unknown",
  );
});
it("consumes exactly one consent and accepts retry only awaiting scheduler, with no queue or reservation", () => {
  const db = managed(),
    op = acceptPrepared(db, "failed");
  attachAndQueue(db, op.id);
  const failedRequestId = failFixture(db, op.id);
  const grant = grantPlacementRetryConsent(db, {
    failedRequestId,
    failedOperationId: op.id,
    principalScope: "owner",
    submissionKey: "action",
    permissionProvenance: {
      identity: "local-unverified",
      authority: "local-input-parity",
      actionId: "action",
    },
  });
  if (grant.kind !== "granted") throw new Error("missing consent");
  const args = {
    authority: fixtureAuthority,
    principalScope: "owner",
    submissionKey: "retry",
    ownerPluginId: "workers",
    providerId: "claude",
    request: {
      schemaVersion: 1 as const,
      intent: {
        kind: "retry" as const,
        failedOperationId: op.id,
        consentId: grant.consent.id,
      },
    },
  };
  const beforeQueue = db.select().from(queuedThreadMessages).all();
  const accepted = acceptPlacementOperation(db, args);
  expect(accepted).toMatchObject({
    kind: "accepted",
    operation: {
      phase: "pending",
      reason: "retry_scheduler_required",
      retrySchedule: {
        state: "awaiting_scheduler",
        sendAt: null,
        schedulerRevision: 0,
      },
    },
  });
  expect(acceptPlacementOperation(db, args)).toEqual(accepted);
  expect(
    acceptPlacementOperation(db, { ...args, submissionKey: "second" }),
  ).toEqual({ kind: "refused", reason: "retry_consent_required" });
  expect(db.select().from(queuedThreadMessages).all()).toEqual(beforeQueue);
  if (accepted.kind !== "accepted") throw new Error("retry missing");
  expect(
    reservePlacementWorker(db, candidate(db, accepted.operation.id)),
  ).toEqual({ kind: "wait", reason: "retry_scheduler_required" });
});
it("excludes central-routable workers and respects the model and generation scope of quota evidence", () => {
  const db = managed(),
    op = acceptPrepared(db, "quota");
  const publish = (w: ReturnType<typeof observation>) =>
    observePlacementWorkers(db, {
      providerId: "claude",
      ownerPluginId: "workers",
      expectedOwnerRevision: 2,
      workers: [w],
    });
  publish(
    observation({
      revision: 2,
      exclusion: {
        authorityPluginId: "exclusion",
        revision: 2,
        status: "included",
      },
    }),
  );
  expect(
    reservePlacementWorker(db, { ...candidate(db, op.id), workerRevision: 2 }),
  ).toEqual({ kind: "wait", reason: "worker_disabled" });
  publish(
    observation({
      revision: 3,
      exclusion: { ...observation().exclusion, revision: 3 },
      quota: {
        revision: 2,
        freshness: "fresh",
        block: {
          kind: "quota",
          generation: "gen",
          model: "model",
          recheckAt: null,
          evidenceId: "block",
        },
      },
    }),
  );
  expect(
    reservePlacementWorker(db, { ...candidate(db, op.id), workerRevision: 3 }),
  ).toEqual({ kind: "wait", reason: "quota_blocked" });
  publish(
    observation({
      revision: 4,
      exclusion: { ...observation().exclusion, revision: 3 },
      quota: {
        revision: 3,
        freshness: "fresh",
        block: {
          kind: "quota",
          generation: "gen",
          model: "other-model",
          recheckAt: null,
          evidenceId: "block",
        },
      },
    }),
  );
  expect(
    reservePlacementWorker(db, { ...candidate(db, op.id), workerRevision: 4 }),
  ).toMatchObject({ kind: "reserved" });
});
it("reclaims only proved idle residents for the oldest target and freezes donor admission", () => {
  const db = managed(),
    donor = acceptPrepared(db, "donor");
  attachAndQueue(db, donor.id);
  const saved = readPlacementOperation(db, donor.id)!;
  db.transaction(
    (tx) =>
      admitPlacementDispatch(tx, {
        ...candidate(db, donor.id),
        fence: 1,
        queuedMessageId: saved.queueReceipt!.queuedMessageId,
      }),
    { behavior: "immediate" },
  );
  const target = acceptPrepared(db, "target"),
    later = acceptPrepared(db, "later");
  const reclaim = () =>
    beginPlacementReclaim(db, {
      ...candidate(db, target.id),
      expectedSourceFence: 1,
      expectedSourceOperationId: donor.id,
    });
  expect(reclaim()).toEqual({ kind: "wait", reason: "selected_busy" });
  const state = {
    ownerPluginId: "workers",
    workerId: "worker",
    operationId: donor.id,
    fence: 1,
    activity: "idle" as const,
    backgroundWork: true,
    pendingInteraction: false,
    custody: {
      ...observation().custody,
      revision: 2,
      status: "held" as const,
      holder: {
        fence: 1,
        threadId: saved.threadId,
        processStart: "1",
        bootId: "boot",
      },
    },
  };
  recordPlacementRuntimeState(db, state);
  expect(reclaim()).toEqual({ kind: "wait", reason: "selected_busy" });
  recordPlacementRuntimeState(db, {
    ...state,
    backgroundWork: false,
    pendingInteraction: true,
    custody: { ...state.custody, revision: 3 },
  });
  expect(reclaim()).toEqual({ kind: "wait", reason: "selected_busy" });
  recordPlacementRuntimeState(db, {
    ...state,
    backgroundWork: false,
    custody: { ...state.custody, revision: 4 },
  });
  expect(
    beginPlacementReclaim(db, {
      ...candidate(db, later.id),
      expectedSourceFence: 1,
      expectedSourceOperationId: donor.id,
    }),
  ).toEqual({ kind: "wait", reason: "all_busy" });
  expect(reclaim()).toMatchObject({
    kind: "reclaiming",
    sourceOperationId: donor.id,
  });
  expect(readPlacementWorker(db, "workers", "worker")).toMatchObject({
    slotState: "reclaiming",
    ownerOperationId: donor.id,
    reclaimOperationId: target.id,
    reclaimSourceFence: 1,
  });
  expect(
    db.transaction(
      (tx) =>
        admitPlacementDispatch(tx, {
          ...candidate(db, donor.id),
          fence: 1,
          queuedMessageId: saved.queueReceipt!.queuedMessageId,
        }),
      { behavior: "immediate" },
    ),
  ).toMatchObject({ kind: "wait" });
  expect(
    finishPlacementReclaim(db, {
      ownerPluginId: "workers",
      workerId: "worker",
      operationId: target.id,
      fence: 1,
      closedSourceOperationId: donor.id,
      processClosed: true,
      observation: { ...observation().custody, revision: 5 },
    }),
  ).toEqual({ kind: "released" });
  expect(reservePlacementWorker(db, candidate(db, target.id))).toMatchObject({
    kind: "reserved",
    fence: 2,
  });
});
it("rechecks unknown custody immediately before queue admission", () => {
  const db = managed(),
    op = acceptPrepared(db, "uncertain");
  attachAndQueue(db, op.id);
  const saved = readPlacementOperation(db, op.id)!;
  observePlacementWorkers(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedOwnerRevision: 2,
    workers: [
      observation({
        revision: 2,
        custody: {
          ...observation().custody,
          revision: 2,
          status: "unknown",
          lock: null,
        },
      }),
    ],
  });
  expect(
    db.transaction(
      (tx) =>
        admitPlacementDispatch(tx, {
          ...candidate(db, op.id),
          workerRevision: 2,
          fence: 1,
          queuedMessageId: saved.queueReceipt!.queuedMessageId,
        }),
      { behavior: "immediate" },
    ),
  ).toEqual({ kind: "wait", reason: "custody_unknown" });
});
it("fork pins source Agent while a newly prepared Workspace leaves the source binding unchanged", () => {
  const db = managed(),
    source = acceptPrepared(db, "source");
  attachAndQueue(db, source.id);
  const sourceOp = readPlacementOperation(db, source.id)!,
    original = readPlacementThreadBinding(db, sourceOp.threadId!)!;
  cancelPlacementOperation(db, source.id);
  beginCancelledPlacementRelease(db, {
    ownerPluginId: "workers",
    workerId: "worker",
    operationId: source.id,
    expectedFence: 1,
  });
  finishPlacementReclaim(db, {
    ownerPluginId: "workers",
    workerId: "worker",
    operationId: source.id,
    fence: 1,
    closedSourceOperationId: source.id,
    processClosed: true,
    observation: { ...observation().custody, revision: 2 },
  });
  const fork = acceptPlacementOperation(db, {
    authority: fixtureAuthority,
    principalScope: "owner",
    submissionKey: "fork",
    ownerPluginId: "workers",
    providerId: "claude",
    request: {
      schemaVersion: 1,
      intent: {
        kind: "fork",
        request: {
          sourceThreadId: sourceOp.threadId!,
          environment: { type: "reuse", environmentId: "fork-env" },
        },
      },
    },
  });
  if (fork.kind !== "accepted") throw new Error("fork accept failed");
  const nextWorkspace = {
    ...workspace,
    workspaceBindingId: "fork-ws",
    environmentId: "fork-env",
    canonicalRoot: "/fork",
  };
  db.insert(environments)
    .values({
      id: "fork-env",
      projectId: "project",
      hostId: workspace.hostId,
      path: "/fork",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  preparePlacementOperation(db, {
    operationId: fork.operation.id,
    expectedRevision: fork.operation.revision,
    workspace: nextWorkspace,
    preparedRequest: { input: "fork" },
    preparedExecution: {
      model: "model",
      serviceTier: "default",
      reasoningLevel: "high",
      permissionMode: "auto",
      source: "client/thread/start",
    },
    attachmentReceipts: [],
  });
  observePlacementWorkers(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedOwnerRevision: 2,
    workers: [
      observation({
        revision: 2,
        custody: { ...observation().custody, revision: 3 },
        routes: [
          {
            ...observation().routes[0]!,
            revision: 2,
            workspace: workspaceBindingRef(nextWorkspace),
          },
        ],
      }),
    ],
  });
  const reserved = reservePlacementWorker(db, {
    ...candidate(db, fork.operation.id),
    workerRevision: 2,
    routeEvidenceRevision: 2,
  });
  expect(reserved).toMatchObject({
    kind: "reserved",
    operation: {
      binding: {
        accountId: original.accountId,
        workerId: original.workerId,
        agentHostId: original.agentHostId,
        generation: original.generation,
        workspace: workspaceBindingRef(nextWorkspace),
      },
    },
  });
  expect(readPlacementThreadBinding(db, sourceOp.threadId!)).toEqual(original);
});

it("does not reserve an independent request on the same owner's other provider", () => {
  const db = managed();
  const op = acceptPrepared(db, "provider-isolation");
  const other = { providerId: "other-provider", ownerPluginId: "workers" };
  registerPlacementOwner(db, other);
  observePlacementWorkers(db, {
    ...other,
    expectedOwnerRevision: 1,
    workers: [
      observation({
        providerId: other.providerId,
        workerId: "other-worker",
        custody: { ...observation().custody, workerId: "other-worker" },
      }),
    ],
  });
  expect(
    reservePlacementWorker(db, {
      ...candidate(db, op.id),
      workerId: "other-worker",
    }),
  ).toEqual({ kind: "wait", reason: "binding_changed" });
  expect(readPlacementWorker(db, "workers", "other-worker")).toMatchObject({
    slotState: "free",
    fence: 0,
  });
});

it("rolls back a callback that inserts the thread without its prepared Workspace", () => {
  const db = managed();
  const op = acceptPrepared(db, "workspace-insertion");
  const reserved = reservePlacementWorker(db, candidate(db, op.id));
  if (reserved.kind !== "reserved") throw new Error("missing reservation");
  expect(() =>
    db.transaction(
      (tx) =>
        attachPlacementThread(tx, {
          operationId: op.id,
          fence: reserved.fence,
          runtimeRootKey: "runtime",
          sourceProviderThreadId: null,
          sourceCheckpoint: null,
          insertThread: (tx, id) =>
            tx
              .insert(threads)
              .values({
                id,
                providerId: "claude",
                projectId: "project",
                latestAttentionAt: 1,
                createdAt: 1,
                updatedAt: 1,
              })
              .run(),
          onCommitted: () => {
            throw new Error("unexpected notification");
          },
        }),
      { behavior: "immediate" },
    ),
  ).toThrow("prepared Workspace");
  expect(db.select().from(threads).all()).toHaveLength(0);
  expect(db.select().from(placementBindings).all()).toHaveLength(0);
  expect(readPlacementOperation(db, op.id)).toMatchObject({
    phase: "reserved",
    threadId: null,
  });
});
