import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { threadScope } from "@bb/domain";
import * as S from "../src/index.js";
import { events, placementRetryTargets, threads } from "../src/schema.js";
import { appendStoredThreadEventInTransaction } from "../src/data/events.js";
import {
  observation,
  setupPlacement,
  candidate,
  acceptPrepared,
  attachAndQueue,
  purpose,
  fixtureAuthority,
} from "./helpers/placement.js";
import {
  appendFixture,
  claimFixture,
  fixtureCommand,
} from "./helpers/placement-dispatch.js";
let path: string, dir: string, db: S.DbConnection;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "custody-quality-"));
  path = join(dir, "scratch.db");
  db = S.createConnection(path);
  S.migrate(db);
  setupPlacement(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});
function reopen() {
  db.$client.close();
  db = S.createConnection(path);
}
const worker = { ownerPluginId: "workers", workerId: "worker" };
function resident() {
  const head = attachAndQueue(db, acceptPrepared(db, "head").id);
  if (head.kind !== "recorded") throw Error("head");
  const claims = claimFixture(db, head.operation.queueReceipt!.queuedMessageId);
  const result = db.transaction(
    (tx) => appendFixture(tx, head.operation.id, claims, "creq_2222222222"),
    { behavior: "immediate" },
  );
  const cmd = {
    ...result.guard,
    ...fixtureCommand,
    currentAgentSessionId: fixtureCommand.agentSessionId,
  };
  expect(S.preparePlacementExecutionCommand(db, cmd).kind).toBe("prepared");
  return { ...result, cmd, op: head.operation.id, qid: claims[0]!.id };
}
function publish(rows: ReturnType<typeof observation>[]) {
  expect(
    S.observePlacementWorkers(db, {
      ownerPluginId: "workers",
      providerId: "claude",
      expectedOwnerRevision: 2,
      workers: rows,
    }).kind,
  ).toBe("observed");
}
function alias(id: string, host = "agent-host", gen = "gen") {
  const w = observation({ workerId: id, agentHostId: host, generation: gen });
  w.custody = {
    ...w.custody,
    workerId: id,
    agentHostId: host,
    generation: gen,
  };
  w.routes[0]!.agent = { ...w.routes[0]!.agent, hostId: host, generation: gen };
  return w;
}
function reserve(id: string, name: string) {
  return S.reservePlacementWorker(db, {
    ...candidate(db, id),
    workerId: name,
    workerRevision: S.readPlacementWorker(db, "workers", name)!
      .observationRevision,
  });
}
function completedResidentWithAlias() {
  const { cmd, op } = resident();
  expect(S.claimPlacementExecutionCommand(db, cmd).kind).toBe("won");
  expect(
    db.transaction((tx) =>
      S.settlePlacementExecutionCommand(tx, { ...cmd, outcome: "succeeded" }),
    ),
  ).toBe(true);
  const a = observation({ revision: 2 });
  const holder = {
    bootId: "boot",
    processStart: "p",
    threadId: cmd.threadId,
    fence: 1,
  };
  a.custody = { ...a.custody, revision: 2, status: "held", holder };
  expect(
    S.recordPlacementRuntimeState(db, {
      ...worker,
      operationId: op,
      fence: 1,
      activity: "idle",
      backgroundWork: false,
      pendingInteraction: false,
      custody: a.custody,
    }),
  ).toMatchObject({ state: "resident" });
  const b = alias("alias");
  return { op, a, b, holder };
}
it.each([false, true])(
  "closes a corroborated completed resident, alias withdrawn=%s",
  (withdrawn) => {
    const { op, a, b, holder } = completedResidentWithAlias();
    b.custody = { ...b.custody, revision: 9, status: "held", holder };
    publish([a, b]);
    if (withdrawn) {
      a.revision++;
      publish([a]);
    }
    const target = acceptPrepared(db, "target", {}, {}, "worker");
    const later = acceptPrepared(db, "later", {}, {}, "worker");
    reopen();
    const begin = (id: string) =>
      S.beginPlacementReclaim(db, {
        ...candidate(db, id),
        workerRevision: a.revision,
        expectedSourceFence: 1,
        expectedSourceOperationId: op,
      });
    expect(begin(later.id)).toEqual({ kind: "wait", reason: "all_busy" });
    expect(begin(target.id).kind).toBe("reclaiming");
    expect(begin(target.id).kind).toBe("wait");
    expect(reserve(target.id, "worker").kind).toBe("wait");
    const free = { ...observation().custody, revision: 4 };
    const finish = {
      ...worker,
      operationId: target.id,
      closedSourceOperationId: op,
      fence: 1,
      processClosed: true,
      observation: free,
    };
    expect(
      S.finishPlacementReclaim(db, { ...finish, processClosed: false }).kind,
    ).toBe("wait");
    expect(
      S.finishPlacementReclaim(db, { ...finish, observation: a.custody }).kind,
    ).toBe("wait");
    expect(
      S.finishPlacementReclaim(db, {
        ...finish,
        observation: { ...free, revision: 2 },
      }).kind,
    ).toBe("wait");
    expect(
      S.finishPlacementReclaim(db, {
        ...finish,
        closedSourceOperationId: later.id,
      }).kind,
    ).toBe("wait");
    expect(S.readPlacementWorker(db, "workers", "worker")).toMatchObject({
      slotState: "reclaiming",
      ownerOperationId: op,
      reclaimHolder: holder,
    });
    a.revision++;
    a.custody = { ...free, revision: 3 };
    const rows = () => (withdrawn ? [a] : [a, b]);
    b.revision++;
    publish(rows());
    reopen();
    expect(S.finishPlacementReclaim(db, finish).kind).toBe("released");
    reopen();
    a.revision++;
    a.custody = free;
    b.revision++;
    publish([a, b]);
    expect(S.finishPlacementReclaim(db, finish).kind).toBe("wait");
    b.revision++;
    b.custody = {
      ...b.custody,
      revision: 10,
      holder: { ...holder, processStart: "new" },
    };
    a.revision++;
    publish([a, b]);
    expect(reserve(target.id, "worker")).toEqual({
      kind: "wait",
      reason: "custody_unknown",
    });
    a.revision++;
    b.revision++;
    b.custody = { ...b.custody, revision: 11, holder: null, status: "free" };
    publish([a, b]);
    reopen();
    expect(reserve(target.id, "worker")).toMatchObject({
      kind: "reserved",
      fence: 2,
    });
    expect(reserve(later.id, "worker").kind).toBe("wait");
  },
);
it.each(["bootId", "processStart", "threadId", "fence", "unknown"] as const)(
  "holds custody across contradictory alias %s before and during reclaim",
  (different) => {
    const { op, a, b, holder } = completedResidentWithAlias();
    function report(conflicting: boolean) {
      b.revision++;
      a.revision++;
      b.custody = {
        ...b.custody,
        revision: b.revision,
        status: conflicting && different === "unknown" ? "unknown" : "held",
        holder: !conflicting
          ? holder
          : different === "unknown"
            ? null
            : {
                ...holder,
                [different]: different === "fence" ? 2 : "different",
              },
      };
      publish([a, b]);
    }
    report(true);
    const target = acceptPrepared(db, "target", {}, {}, "worker");
    const begin = () =>
      S.beginPlacementReclaim(db, {
        ...candidate(db, target.id),
        workerRevision: a.revision,
        expectedSourceFence: 1,
        expectedSourceOperationId: op,
      });
    expect(begin()).toEqual({ kind: "wait", reason: "custody_unknown" });
    report(false);
    expect(begin().kind).toBe("reclaiming");
    report(true);
    a.revision++;
    publish([a]);
    reopen();
    const finish = {
      ...worker,
      operationId: target.id,
      closedSourceOperationId: op,
      fence: 1,
      processClosed: true,
      observation: { ...observation().custody, revision: 3 },
    };
    expect(S.finishPlacementReclaim(db, finish)).toEqual({
      kind: "wait",
      reason: "custody_unknown",
    });
    expect(
      S.readPlacementWorker(db, "workers", "worker")?.ownerOperationId,
    ).toBe(op);
    report(false);
    expect(S.finishPlacementReclaim(db, finish).kind).toBe("released");
    expect(reserve(target.id, "worker").kind).toBe("reserved");
  },
);
it("keeps the original host/inode locked through withdrawal, drift, reclaim and missing closure", () => {
  const a = acceptPrepared(db, "a", {}, {}, "worker");
  expect(db.transaction(() => reserve(a.id, "worker")).kind).toBe("wait");
  expect(reserve(a.id, "worker").kind).toBe("reserved");
  const same = alias("same", "agent-host", "other-generation"),
    other = alias("independent-host", "host-B");
  publish([same, other]);
  reopen();
  const b = acceptPrepared(db, "b", {}, {}, "same"),
    c = acceptPrepared(db, "c", {}, {}, "independent-host");
  expect(reserve(b.id, "same").kind).toBe("wait");
  expect(reserve(c.id, "independent-host").kind).toBe("reserved");
  const moved = alias("worker", "host-C", "replacement");
  moved.revision = 2;
  publish([moved]);
  expect(S.readPlacementWorker(db, "workers", "worker")).toMatchObject({
    slotState: "unknown",
    physicalLock: JSON.stringify(["agent-host", "1", "2"]),
  });
  same.revision = 2;
  const original = observation({ revision: 3 });
  publish([original, same]);
  expect(reserve(b.id, "same").kind).toBe("wait");
  S.cancelPlacementOperation(db, a.id);
  const start = () =>
    S.beginCancelledPlacementRelease(db, {
      ...worker,
      operationId: a.id,
      expectedFence: 1,
    });
  expect(db.transaction(start).kind).toBe("wait");
  expect(start().kind).toBe("reclaiming");
  expect(reserve(b.id, "same").kind).toBe("wait");
  const finish = {
    ...worker,
    operationId: a.id,
    closedSourceOperationId: a.id,
    fence: 1,
    processClosed: true,
    observation: { ...original.custody, revision: 2 },
  };
  expect(
    S.finishPlacementReclaim(db, { ...finish, closedSourceOperationId: null })
      .kind,
  ).toBe("wait");
  expect(
    S.finishPlacementReclaim(db, {
      ...finish,
      observation: { ...finish.observation, agentHostId: "host-C" },
    }).kind,
  ).toBe("wait");
  expect(S.finishPlacementReclaim(db, finish).kind).toBe("released");
  reopen();
  expect(reserve(b.id, "same").kind).toBe("reserved");
});
it.each(["held", "unknown"] as const)(
  "keeps unowned %s evidence across alias replacement until its source reports free",
  (status) => {
    const a = observation({ revision: 2 });
    a.custody = {
      ...a.custody,
      status,
      revision: 2,
      holder:
        status === "held"
          ? { threadId: null, fence: 7, bootId: "b", processStart: "p" }
          : null,
    };
    const b = alias("b", "agent-host", "new-generation");
    publish([a, b]);
    b.revision = 2;
    publish([b]);
    reopen();
    const target = acceptPrepared(db, "target", {}, {}, "b");
    expect(reserve(target.id, "b")).toMatchObject({
      kind: "wait",
      reason: "custody_unknown",
    });
    const free = observation({ revision: 3 });
    free.custody.revision = 3;
    b.revision = 3;
    publish([free, b]);
    expect(reserve(target.id, "b").kind).toBe("reserved");
  },
);
it.each(["prepared", "possibly_sent", "succeeded", "failed_accepted"] as const)(
  "detaches a %s receipt on native suffix edit, with rollback and sequence reuse",
  (mode) => {
    const { cmd, receipt, body, op, qid, guard } = resident();
    const grant = () =>
      S.grantPlacementRetryConsent(db, {
        failedRequestId: cmd.requestId,
        failedOperationId: op,
        principalScope: "owner",
        submissionKey: "grant",
        permissionProvenance: {
          actionId: "click",
          identity: "local-unverified",
          authority: "local-input-parity",
        },
      });
    let consent: string | undefined;
    if (mode !== "prepared")
      expect(S.claimPlacementExecutionCommand(db, cmd).kind).toBe("won");
    if (mode === "succeeded" || mode === "failed_accepted")
      expect(
        db.transaction((tx) =>
          S.settlePlacementExecutionCommand(tx, { ...cmd, outcome: mode }),
        ),
      ).toBe(true);
    if (mode === "failed_accepted") {
      db.update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, guard.threadId))
        .run();
      const g = grant();
      if (g.kind !== "granted") throw Error("grant");
      consent = g.consent.id;
      const retry = S.acceptPlacementOperation(db, {
        principalScope: "owner",
        submissionKey: "retry",
        ownerPluginId: "workers",
        providerId: "claude",
        authority: fixtureAuthority,
        request: {
          schemaVersion: 1,
          intent: { kind: "retry", failedOperationId: op, consentId: consent },
        },
      });
      if (retry.kind !== "accepted") throw Error("retry");
      expect(
        S.schedulePlacementRetry(db, {
          operationId: retry.operation.id,
          scheduler: "provider-retry",
          sendAt: Date.now(),
        }),
      ).toBeTruthy();
    }
    const key = { threadId: cmd.threadId, requestId: cmd.requestId },
      before = S.readPlacementDispatchReceipt(db, key)!;
    const cut = (tx: S.DbTransaction) =>
      S.deleteThreadEventSuffixInTransaction(tx, {
        threadId: cmd.threadId,
        cutoffSequence: receipt.requestSequence,
        oldMaxSequence: receipt.requestSequence,
      });
    expect(() =>
      db.transaction((tx) => {
        expect(cut(tx).deletedEventCount).toBe(1);
        throw Error("rollback edit");
      }),
    ).toThrow("rollback edit");
    expect(S.readPlacementDispatchReceipt(db, key)).toEqual(before);
    if (consent)
      expect(db.select().from(placementRetryTargets).get()?.state).toBe(
        "scheduled",
      );
    const replacement = db.transaction((tx) => {
      expect(cut(tx).deletedEventCount).toBe(1);
      return appendStoredThreadEventInTransaction(tx, {
        threadId: cmd.threadId,
        scope: threadScope(),
        type: "client/turn/requested",
        data: { ...body, requestId: "creq_3333333333" },
      });
    });
    reopen();
    expect(replacement).toBe(receipt.requestSequence);
    expect(
      db.select().from(events).where(eq(events.id, receipt.eventId)).get(),
    ).toBeUndefined();
    expect(S.readPlacementDispatchReceipt(db, key)).toEqual({
      ...before,
      liveEventId: null,
      state: mode === "prepared" ? "cancelled" : mode,
    });
    expect(S.readPlacementQueueAttempts(db, qid)[0]?.request).toBe(
      cmd.requestId,
    );
    expect(
      S.readPlacementAdmittedExecution(db, { ...key, purpose }),
    ).toBeNull();
    expect(S.claimPlacementExecutionCommand(db, cmd).kind).toBe(
      mode === "possibly_sent" ? "held" : "refused",
    );
    expect(
      db.transaction((tx) =>
        S.settlePlacementExecutionCommand(tx, {
          ...cmd,
          commandId: "different",
          outcome: "succeeded",
        }),
      ),
    ).toBe(false);
    expect(
      S.readPlacementDispatchReceipt(db, {
        threadId: cmd.threadId,
        requestId: "creq_3333333333",
      }),
    ).toBeNull();
    if (consent)
      expect(db.select().from(placementRetryTargets).get()?.state).toBe(
        "superseded",
      );
    expect(
      S.grantPlacementRetryConsent(db, {
        failedRequestId: cmd.requestId,
        failedOperationId: op,
        principalScope: "owner",
        submissionKey: "new",
        permissionProvenance: {
          actionId: "new",
          identity: "local-unverified",
          authority: "local-input-parity",
        },
      }).kind,
    ).toBe("refused");
  },
);
it("uses the active owner/fence index for matching and settled effects inside the custody writer", () => {
  const { cmd, op } = resident();
  const idle = (revision: number) =>
    S.recordPlacementRuntimeState(db, {
      ...worker,
      operationId: op,
      fence: 1,
      activity: "idle",
      backgroundWork: false,
      pendingInteraction: false,
      custody: {
        ...observation().custody,
        status: "held",
        revision,
        holder: {
          threadId: cmd.threadId,
          fence: 1,
          bootId: "boot",
          processStart: "p",
        },
      },
    });
  const prepared = vi.spyOn(db.$client, "prepare");
  let query: string | undefined;
  try {
    expect(idle(2)).toMatchObject({ state: "active" });
    query = prepared.mock.calls.find(([q]) =>
      q.startsWith('select "request" from "placement_effect"'),
    )?.[0];
  } finally {
    prepared.mockRestore();
  }
  if (!query) throw Error("actual unresolved effect lookup missing");
  const plan = db.$client.prepare("EXPLAIN QUERY PLAN " + query).all(op, 1);
  expect(plan).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        detail: expect.stringContaining(
          "SEARCH placement_effect USING INDEX placement_active_effect_owner_fence",
        ),
      }),
    ]),
  );
  expect(
    db.transaction(() => S.claimPlacementExecutionCommand(db, cmd)).kind,
  ).toBe("refused");
  expect(S.claimPlacementExecutionCommand(db, cmd).kind).toBe("won");
  expect(idle(3)).toMatchObject({ state: "active" });
  expect(
    db.transaction((tx) =>
      S.settlePlacementExecutionCommand(tx, { ...cmd, outcome: "succeeded" }),
    ),
  ).toBe(true);
  expect(idle(4)).toMatchObject({ state: "resident" });
});
