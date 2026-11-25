import { failFixture } from "./helpers/placement-dispatch.js";
import { fixtureAuthority } from "./helpers/placement.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import {
  acceptPrepared,
  attachAndQueue,
  candidate,
  observation,
  setupPlacement,
  workspace,
} from "./helpers/placement.js";
import {
  acceptPlacementOperation,
  cancelPlacementOperation,
  grantPlacementRetryConsent,
  readPlacementOperation,
} from "../src/data/placement-operations.js";
import {
  admitPlacementDispatch,
  beginCancelledPlacementRelease,
  beginPlacementReclaim,
  finishPlacementReclaim,
  recordPlacementRuntimeState,
  reservePlacementWorker,
} from "../src/data/placement-admission.js";
import {
  observePlacementWorkers,
  readPlacementWorker,
  registerPlacementOwner,
  resetPlacementOwnerAvailability,
} from "../src/data/placement-workers.js";
import { threads } from "../src/schema.js";
import {
  attachPlacementThread,
  preparePlacementOperation,
} from "../src/data/placement-bindings.js";
import type { WorkerObservation } from "@bb/domain";

const scope = {
  ownerPluginId: "workers",
  providerId: "claude",
  authority: fixtureAuthority,
  principalScope: "owner",
};
const worker = { ownerPluginId: "workers", workerId: "worker" };
function scratch(run: (db: DbConnection, reopen: () => DbConnection) => void) {
  const dir = mkdtempSync(join(tmpdir(), "placement-correction-"));
  const connections: DbConnection[] = [];
  const open = () => {
    const db = createConnection(join(dir, "bb.db"));
    connections.push(db);
    return db;
  };
  try {
    const db = open();
    migrate(db);
    setupPlacement(db);
    run(db, open);
  } finally {
    for (const db of connections) if (db.$client.open) db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function admit(db: DbConnection, id: string) {
  return db.transaction(
    (tx) =>
      admitPlacementDispatch(tx, {
        ...candidate(db, id),
        fence: 1,
        queuedMessageId: readPlacementOperation(db, id)!.queueReceipt!
          .queuedMessageId,
      }),
    { behavior: "immediate" },
  );
}
function publish(db: DbConnection, value: WorkerObservation, epoch = 1) {
  return observePlacementWorkers(db, {
    ...scope,
    expectedOwnerRevision: epoch,
    workers: [value],
  });
}
function independent(db: DbConnection, key: string) {
  return acceptPlacementOperation(db, {
    ...scope,
    submissionKey: key,
    request: {
      schemaVersion: 1,
      intent: {
        kind: "independent",
        selection: { mode: "auto" },
        request: { input: key },
      },
    },
  });
}
function prepare(db: DbConnection, id: string, target = workspace) {
  return preparePlacementOperation(db, {
    operationId: id,
    expectedRevision: 1,
    workspace: target,
    preparedExecution: {
      model: "model",
      reasoningLevel: "high",
      serviceTier: "default",
      permissionMode: "auto",
      source: "client/thread/start",
    },
    preparedRequest: { input: "fixture" },
    attachmentReceipts: [],
  });
}
it.each([1, 2])(
  "pins the original release inode through publication at custody revision %i and reopen",
  (revision) =>
    scratch((db, open) => {
      const op = acceptPrepared(db, "cancel");
      attachAndQueue(db, op.id);
      cancelPlacementOperation(db, op.id);
      expect(
        beginCancelledPlacementRelease(db, {
          ...worker,
          operationId: op.id,
          expectedFence: 1,
        }).kind,
      ).toBe("reclaiming");
      const replaced = {
        ...observation().custody,
        revision,
        lock: { device: "1", inode: "999" },
      };
      expect(
        publish(open(), observation({ revision: 2, custody: replaced })).kind,
      ).toBe(revision === 1 ? "stale" : "observed");
      db.$client.close();
      const restarted = open();
      const release = {
        ...worker,
        operationId: op.id,
        fence: 1,
        closedSourceOperationId: op.id,
        processClosed: true,
        observation: { ...replaced, revision: 3 },
      };
      expect(finishPlacementReclaim(restarted, release).kind).toBe("wait");
      expect(readPlacementWorker(restarted, "workers", "worker")).toMatchObject(
        { ownerOperationId: op.id, fenceLock: { device: "1", inode: "2" } },
      );
      if (revision === 1)
        expect(
          finishPlacementReclaim(restarted, {
            ...release,
            observation: { ...observation().custody, revision: 3 },
          }).kind,
        ).toBe("released");
    }),
);
it("refuses root and source drift during attach and after queue insertion", () =>
  scratch((db, open) => {
    db.$client.exec(
      "insert into project_sources(id,project_id,type,host_id,path,created_at,updated_at) values('src','project','local_path','workspace-host','/repo',1,1)",
    );
    const other = open();
    const op = acceptPrepared(db, "root");
    const pin = reservePlacementWorker(db, candidate(db, op.id));
    expect(pin.kind).toBe("reserved");
    other.$client.exec("update environments set path='/other-project'");
    expect(() =>
      db.transaction(
        (tx) =>
          attachPlacementThread(tx, {
            operationId: op.id,
            fence: 1,
            runtimeRootKey: "runtime",
            sourceProviderThreadId: null,
            sourceCheckpoint: null,
            insertThread: (inner, id) =>
              inner
                .insert(threads)
                .values({
                  id,
                  providerId: "claude",
                  environmentId: "env",
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
    expect(
      db.$client.prepare("select count(*) from threads").pluck().get(),
    ).toBe(0);
    expect(
      db.$client
        .prepare("select count(*) from queued_thread_messages")
        .pluck()
        .get(),
    ).toBe(0);
    other.$client.exec("update environments set path='/scratch'");
    attachAndQueue(db, op.id);
    other.$client.exec("update environments set path='/other-project'");
    expect(admit(db, op.id)).toEqual({
      kind: "wait",
      reason: "workspace_unavailable",
    });
    other.$client.exec("update environments set path='/scratch'");
    expect(admit(db, op.id).kind).toBe("admitted");
    const sourced = acceptPrepared(db, "source", {
      sourceId: "src",
      workspaceBindingId: "sourced",
    });
    other.$client.exec("update project_sources set path='/different'");
    expect(reservePlacementWorker(db, candidate(db, sourced.id))).toEqual({
      kind: "wait",
      reason: "workspace_unavailable",
    });
  }));
it("rejects a fork Workspace replacement unless the accepted target matches", () =>
  scratch((db) => {
    const source = acceptPrepared(db, "source");
    attachAndQueue(db, source.id);
    const sourceThreadId = readPlacementOperation(db, source.id)!.threadId!;
    db.$client.exec(
      "insert into environments(id,project_id,host_id,path,created_at,updated_at) values('other-env','project','workspace-host','/fork',1,1)",
    );
    const fork = (
      submissionKey: string,
      request: {
        sourceThreadId: string;
        environment?: { type: string; environmentId: string };
      },
    ) => {
      const result = acceptPlacementOperation(db, {
        ...scope,
        submissionKey,
        request: { schemaVersion: 1, intent: { kind: "fork", request } },
      });
      if (result.kind !== "accepted") throw new Error("missing fork");
      return result.operation.id;
    };
    const alternate = {
      ...workspace,
      workspaceBindingId: "other",
      environmentId: "other-env",
      canonicalRoot: "/fork",
    };
    const implicit = fork("implicit", { sourceThreadId });
    expect(prepare(db, implicit, alternate).kind).toBe("conflict");
    expect(prepare(db, implicit).kind).toBe("prepared");
    const explicit = fork("explicit", {
      sourceThreadId,
      environment: { type: "reuse", environmentId: "other-env" },
    });
    expect(prepare(db, explicit).kind).toBe("conflict");
    expect(prepare(db, explicit, alternate).kind).toBe("prepared");
  }));
it("preserves source watermarks when an envelope advances, a route disappears or its owner reloads", () =>
  scratch((db, open) => {
    const op = acceptPrepared(db, "quota");
    const initial = observation();
    const route = { ...initial.routes[0]!, revision: 7 };
    const blocked = observation({
      revision: 2,
      quota: {
        revision: 9,
        freshness: "fresh",
        block: {
          kind: "quota",
          generation: "gen",
          model: null,
          recheckAt: null,
          evidenceId: "block",
        },
      },
      exclusion: { ...initial.exclusion, revision: 5 },
      routes: [route],
    });
    expect(publish(db, blocked).kind).toBe("observed");
    for (const patch of [
      { quota: initial.quota },
      { quota: { ...blocked.quota, block: null } },
      { exclusion: initial.exclusion },
      { exclusion: { ...blocked.exclusion, status: "included" as const } },
      { routes: [{ ...route, connected: false }] },
    ]) {
      expect(publish(open(), { ...blocked, revision: 3, ...patch }).kind).toBe(
        "stale",
      );
    }
    expect(publish(db, { ...blocked, revision: 3, routes: [] }).kind).toBe(
      "observed",
    );
    expect(
      publish(db, { ...blocked, revision: 4, routes: initial.routes }).kind,
    ).toBe("stale");
    resetPlacementOwnerAvailability(db);
    expect(registerPlacementOwner(db, scope).kind).toBe("registered");
    const rebased = {
      ...candidate(db, op.id),
      ownerRevision: 2,
      workerRevision: 3,
      routeEvidenceRevision: 7,
    };
    expect(reservePlacementWorker(db, rebased)).toEqual({
      kind: "wait",
      reason: "worker_offline",
    });
    expect(publish(db, { ...blocked, revision: 4 }, 1).kind).toBe("stale");
    expect(publish(db, { ...blocked, revision: 4 }, 2).kind).toBe("observed");
    expect(
      reservePlacementWorker(db, { ...rebased, workerRevision: 4 }),
    ).toEqual({ kind: "wait", reason: "quota_blocked" });
    expect(
      publish(
        db,
        { ...blocked, revision: 5, quota: { ...initial.quota, revision: 10 } },
        2,
      ).kind,
    ).toBe("observed");
    expect(
      reservePlacementWorker(db, { ...rebased, workerRevision: 5 }).kind,
    ).toBe("reserved");
  }));
it("a committed grant progresses after an older operation becomes compatible", () =>
  scratch((db, open) => {
    const a = independent(db, "A");
    if (a.kind !== "accepted") throw new Error("missing A");
    const b = acceptPrepared(db, "B");
    attachAndQueue(db, b.id);
    const competitor = open();
    const older = acceptPrepared(competitor, "A");
    expect(
      reservePlacementWorker(competitor, candidate(competitor, older.id)),
    ).toEqual({ kind: "wait", reason: "selected_busy" });
    db.$client.close();
    expect(admit(open(), b.id).kind).toBe("admitted");
  }));
it.each([false, true])(
  "orders a resident continuation and a new request, continuation first=%s",
  (first) =>
    scratch((db, open) => {
      const donor = acceptPrepared(db, "donor");
      attachAndQueue(db, donor.id);
      expect(admit(db, donor.id).kind).toBe("admitted");
      const threadId = readPlacementOperation(db, donor.id)!.threadId!;
      const runtime = {
        ...worker,
        operationId: donor.id,
        fence: 1,
        activity: "idle" as const,
        backgroundWork: false,
        pendingInteraction: false,
        custody: {
          ...observation().custody,
          status: "held" as const,
          revision: 2,
          holder: { threadId, fence: 1, processStart: "p", bootId: "b" },
        },
      };
      expect(recordPlacementRuntimeState(db, runtime)).toMatchObject({
        state: "resident",
      });
      const acceptFollow = () => {
        const follow = acceptPlacementOperation(db, {
          ...scope,
          submissionKey: "follow",
          request: {
            schemaVersion: 1,
            intent: {
              kind: "continuation",
              threadId,
              request: { input: "follow" },
            },
          },
        });
        if (follow.kind !== "accepted") throw new Error("missing follow");
        expect(prepare(db, follow.operation.id).kind).toBe("prepared");
        return follow.operation;
      };
      const earlier = first ? acceptFollow() : acceptPrepared(db, "new");
      const later = first ? acceptPrepared(db, "new") : acceptFollow();
      const follow = first ? earlier : later;
      const target = first ? later : earlier;
      const competitor = open();
      const reclaim = {
        ...candidate(competitor, target.id),
        expectedSourceFence: 1,
        expectedSourceOperationId: donor.id,
      };
      expect(
        beginPlacementReclaim(competitor, {
          ...reclaim,
          ...candidate(competitor, follow.id),
        }).kind,
      ).toBe("wait");
      if (!first) {
        expect(
          reservePlacementWorker(competitor, candidate(competitor, follow.id))
            .kind,
        ).toBe("wait");
        expect(beginPlacementReclaim(db, reclaim).kind).toBe("reclaiming");
        expect(
          finishPlacementReclaim(db, {
            ...worker,
            operationId: target.id,
            fence: 1,
            closedSourceOperationId: donor.id,
            processClosed: true,
            observation: { ...observation().custody, revision: 3 },
          }).kind,
        ).toBe("released");
        expect(
          reservePlacementWorker(competitor, candidate(competitor, target.id)),
        ).toMatchObject({ kind: "reserved", fence: 2 });
        return;
      }
      expect(beginPlacementReclaim(competitor, reclaim).kind).toBe("wait");
      attachAndQueue(db, follow.id);
      expect(admit(db, follow.id).kind).toBe("admitted");
      db.$client.close();
      const reopened = open();
      expect(
        beginCancelledPlacementRelease(reopened, {
          ...worker,
          operationId: donor.id,
          expectedFence: 1,
        }).kind,
      ).toBe("wait");
      expect(
        finishPlacementReclaim(reopened, {
          ...worker,
          operationId: donor.id,
          fence: 1,
          closedSourceOperationId: donor.id,
          processClosed: true,
          observation: { ...observation().custody, revision: 4 },
        }).kind,
      ).toBe("wait");
      expect(
        recordPlacementRuntimeState(reopened, {
          ...runtime,
          custody: { ...runtime.custody, revision: 3 },
        }).kind,
      ).toBe("wait");
      expect(
        readPlacementWorker(competitor, "workers", "worker"),
      ).toMatchObject({
        slotState: "active",
        ownerOperationId: follow.id,
        fence: 1,
        nativeCustody: runtime.custody,
      });
      expect(
        recordPlacementRuntimeState(reopened, {
          ...runtime,
          operationId: follow.id,
          custody: { ...runtime.custody, revision: 3 },
        }),
      ).toMatchObject({ state: "resident" });
      expect(beginPlacementReclaim(competitor, reclaim).kind).toBe("wait");
      expect(
        beginPlacementReclaim(competitor, {
          ...reclaim,
          expectedSourceOperationId: follow.id,
        }).kind,
      ).toBe("reclaiming");
      const completion = {
        ...worker,
        operationId: target.id,
        fence: 1,
        processClosed: true,
        observation: { ...observation().custody, revision: 4 },
      };
      for (const closedSourceOperationId of [donor.id, null]) {
        expect(
          finishPlacementReclaim(competitor, {
            ...completion,
            closedSourceOperationId,
          }),
        ).toEqual({ kind: "wait", reason: "custody_unknown" });
        expect(
          readPlacementWorker(reopened, "workers", "worker"),
        ).toMatchObject({
          slotState: "reclaiming",
          ownerOperationId: follow.id,
          fence: 1,
          nativeCustody: { status: "held" },
        });
      }
      expect(
        finishPlacementReclaim(reopened, {
          ...completion,
          closedSourceOperationId: follow.id,
        }),
      ).toEqual({ kind: "released" });
    }),
);
it("admits a time wait only once the native row is due and refuses a non-time wait", () =>
  scratch((db, open) => {
    const op = acceptPrepared(db, "timer");
    attachAndQueue(db, op.id);
    const other = open();
    const set = other.$client.prepare(
      "update queued_thread_messages set state=?, waiting_on=json_object('kind',?),send_at=? where id=?",
    );
    set.run(
      "scheduled",
      "time",
      Date.now() + 3600000,
      readPlacementOperation(db, op.id)!.queueReceipt!.queuedMessageId,
    );
    expect(admit(db, op.id)).toEqual({
      kind: "wait",
      reason: "native_queue_wait",
    });
    set.run(
      "waiting",
      "host-offline",
      null,
      readPlacementOperation(db, op.id)!.queueReceipt!.queuedMessageId,
    );
    expect(admit(db, op.id).kind).toBe("wait");
    set.run(
      "scheduled",
      "time",
      Date.now() - 1,
      readPlacementOperation(db, op.id)!.queueReceipt!.queuedMessageId,
    );
    expect(admit(db, op.id).kind).toBe("admitted");
  }));
it("one attributed action funds one retry and the migrated DB requires both scheduler fields", () =>
  scratch((db, open) => {
    const op = acceptPrepared(db, "failed");
    attachAndQueue(db, op.id);
    const failedRequestId = failFixture(db, op.id);
    const args = {
      ...scope,
      failedRequestId,
      failedOperationId: op.id,
      permissionProvenance: {
        actionId: "one-click",
        authority: "local-input-parity" as const,
        identity: "local-unverified" as const,
      },
    };
    const g = grantPlacementRetryConsent(db, { ...args, submissionKey: "g1" });
    if (g.kind !== "granted") throw new Error("no consent");
    db.$client.close();
    const reopened = open();
    expect(
      grantPlacementRetryConsent(reopened, { ...args, submissionKey: "g2" }),
    ).toEqual(g);
    expect(
      grantPlacementRetryConsent(reopened, {
        ...args,
        submissionKey: "g3",
        failedOperationId: "different",
      }),
    ).toEqual({ kind: "conflict" });
    const request = {
      schemaVersion: 1 as const,
      intent: {
        kind: "retry" as const,
        failedOperationId: op.id,
        consentId: g.consent.id,
      },
    };
    const retry = acceptPlacementOperation(reopened, {
      ...scope,
      submissionKey: "r1",
      request,
    });
    if (retry.kind !== "accepted") throw new Error("no retry");
    expect(
      acceptPlacementOperation(open(), {
        ...scope,
        submissionKey: "r2",
        request,
      }).kind,
    ).toBe("refused");
    for (const fields of [
      "retry_schedule_state=NULL",
      "scheduler_revision=NULL",
      "retry_schedule_state=NULL,scheduler_revision=NULL",
    ])
      expect(() =>
        reopened.$client
          .prepare(`update placement_operation set ${fields} where id=?`)
          .run(retry.operation.id),
      ).toThrow(/placement_operation_retry/);
  }));

it("accepts an environment alias only with matching host resolution and rechecks the stored alias", () =>
  scratch((db, other) => {
    db.$client.exec("update environments set path='/alias'");
    const op = independent(db, "alias");
    if (op.kind !== "accepted") throw new Error("missing accept");
    const args = {
      operationId: op.operation.id,
      expectedRevision: 1,
      workspace,
      preparedRequest: { input: "alias" },
      preparedExecution: {
        model: "model",
        reasoningLevel: "high",
        serviceTier: "default",
        permissionMode: "auto",
        source: "client/thread/start",
      } as const,
      attachmentReceipts: [],
    };
    const evidence = {
      hostId: workspace.hostId,
      environmentId: "env",
      environmentPath: "/alias",
      canonicalRoot: "/scratch",
    };
    expect(preparePlacementOperation(db, args).kind).toBe("conflict");
    expect(
      preparePlacementOperation(db, {
        ...args,
        rootResolution: { ...evidence, hostId: "unrelated" },
      }).kind,
    ).toBe("conflict");
    expect(
      preparePlacementOperation(db, { ...args, rootResolution: evidence }).kind,
    ).toBe("prepared");
    attachAndQueue(db, op.operation.id);
    other().$client.exec("update environments set path='/new-alias'");
    expect(admit(db, op.operation.id)).toEqual({
      kind: "wait",
      reason: "workspace_unavailable",
    });
  }));

it("retains separate source histories across a host round trip and owner reload", () =>
  scratch((db, open) => {
    const op = acceptPrepared(db, "round-trip");
    const first = observation({ revision: 2 });
    first.quota = {
      revision: 9,
      freshness: "fresh",
      block: {
        kind: "quota",
        model: null,
        generation: "gen",
        evidenceId: "nine",
        recheckAt: null,
      },
    };
    first.exclusion.revision = 7;
    first.custody.revision = 6;
    expect(publish(db, first).kind).toBe("observed");
    expect(
      reservePlacementWorker(db, {
        ...candidate(db, op.id),
        workerRevision: 2,
      }),
    ).toMatchObject({ reason: "quota_blocked" });
    const other = observation({ revision: 3, agentHostId: "H2" });
    other.custody.agentHostId = "H2";
    other.routes = [];
    expect(publish(db, other).kind).toBe("observed");
    db.$client.close();
    const reopened = open();
    resetPlacementOwnerAvailability(reopened);
    expect(
      registerPlacementOwner(reopened, {
        providerId: "claude",
        ownerPluginId: "workers",
      }).kind,
    ).toBe("registered");
    const returning = { ...first, revision: 4 };
    for (const patch of [
      { quota: observation().quota },
      { quota: { ...first.quota, block: null } },
      { custody: observation().custody },
      { custody: { ...first.custody, lock: { device: "1", inode: "other" } } },
      { exclusion: observation().exclusion },
      { exclusion: { ...first.exclusion, status: "included" as const } },
    ])
      expect(publish(reopened, { ...returning, ...patch }, 2).kind).toBe(
        "stale",
      );
    expect(publish(reopened, returning, 2).kind).toBe("observed");
    expect(
      reservePlacementWorker(reopened, {
        ...candidate(reopened, op.id),
        ownerRevision: 2,
        workerRevision: 4,
      }),
    ).toMatchObject({ reason: "quota_blocked" });
    expect(
      publish(
        reopened,
        {
          ...returning,
          revision: 5,
          quota: { ...first.quota, revision: 10, block: null },
        },
        2,
      ).kind,
    ).toBe("observed");
    expect(
      reservePlacementWorker(reopened, {
        ...candidate(reopened, op.id),
        ownerRevision: 2,
        workerRevision: 5,
      }).kind,
    ).toBe("reserved");
  }));

it("allows an independently routed host with its own quota revision one", () =>
  scratch((db) => {
    const op = acceptPrepared(db, "different-host");
    const first = observation({ revision: 2 });
    first.quota = {
      revision: 9,
      freshness: "fresh",
      block: {
        kind: "quota",
        model: null,
        generation: "gen",
        evidenceId: "nine",
        recheckAt: null,
      },
    };
    expect(publish(db, first).kind).toBe("observed");
    const second = observation({
      revision: 3,
      agentHostId: "independent-host",
    });
    second.custody.agentHostId = second.agentHostId;
    second.routes[0]!.agent.hostId = second.agentHostId;
    expect(publish(db, second).kind).toBe("observed");
    expect(
      reservePlacementWorker(db, { ...candidate(db, op.id), workerRevision: 3 })
        .kind,
    ).toBe("reserved");
  }));

it.each(["quota", "exclusion"] as const)(
  "retains shared %s after replacement and checks a sibling's current source at admission",
  (stream) =>
    scratch((db, open) => {
      const owner = acceptPrepared(db, "resident");
      attachAndQueue(db, owner.id);
      const a = observation({ workerId: "sibling", revision: 1 });
      a.custody.workerId = a.workerId;
      const b = observation({ revision: 2 });
      const batch = (conn: DbConnection, ws: WorkerObservation[], epoch = 1) =>
        observePlacementWorkers(conn, {
          ...scope,
          expectedOwnerRevision: epoch,
          workers: ws,
        }).kind;
      const blocked = structuredClone(a);
      if (stream === "quota")
        blocked.quota = {
          revision: 9,
          freshness: "fresh",
          block: {
            kind: "quota",
            model: null,
            generation: "gen",
            evidenceId: "shared-nine",
            recheckAt: null,
          },
        };
      else
        blocked.exclusion = { ...a.exclusion, revision: 9, status: "included" };
      expect(batch(db, [b, blocked])).toBe("observed");
      const admission = (conn: DbConnection, rev: number, epoch = 1) =>
        conn.transaction(
          (tx) =>
            admitPlacementDispatch(tx, {
              ...candidate(conn, owner.id),
              workerRevision: rev,
              ownerRevision: epoch,
              fence: 1,
              queuedMessageId: readPlacementOperation(conn, owner.id)!
                .queueReceipt!.queuedMessageId,
            }),
          { behavior: "immediate" },
        );
      expect(admission(db, 2)).toMatchObject({
        reason: stream === "quota" ? "quota_blocked" : "worker_disabled",
      });
      expect(batch(db, [])).toBe("observed");
      db.$client.close();
      const next = open();
      resetPlacementOwnerAvailability(next);
      registerPlacementOwner(next, scope);
      const independent = observation({ workerId: "replacement" });
      independent.custody.workerId = independent.workerId;
      expect(batch(next, [independent], 2)).toBe("stale");
      independent[stream].revision = 9;
      expect(batch(next, [independent], 2)).toBe("stale");
      b.revision = 3;
      b[stream].revision = 10;
      expect(batch(next, [b], 2)).toBe("observed");
      expect(admission(next, 3, 2).kind).toBe("admitted");
    }),
);

it("requires fresh evidence to clear a known shared quota block", () =>
  scratch((db, open) => {
    const op = acceptPrepared(db, "fresh-clear");
    const w = observation({ revision: 2 });
    w.quota = {
      revision: 8,
      freshness: "fresh",
      block: {
        kind: "quota",
        model: null,
        generation: "gen",
        evidenceId: "eight",
        recheckAt: null,
      },
    };
    expect(publish(db, w).kind).toBe("observed");
    const next = open();
    expect(
      publish(next, {
        ...w,
        revision: 3,
        quota: { revision: 9, freshness: "unknown", block: null },
      }).kind,
    ).toBe("observed");
    expect(
      reservePlacementWorker(db, {
        ...candidate(db, op.id),
        workerRevision: 3,
      }),
    ).toMatchObject({ reason: "quota_blocked" });
    expect(
      publish(next, {
        ...w,
        revision: 4,
        quota: { revision: 10, freshness: "fresh", block: null },
      }).kind,
    ).toBe("observed");
    expect(
      reservePlacementWorker(db, { ...candidate(db, op.id), workerRevision: 4 })
        .kind,
    ).toBe("reserved");
  }));
