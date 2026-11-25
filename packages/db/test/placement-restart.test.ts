import { fixtureAuthority } from "./helpers/placement.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { workspaceBindingRef } from "@bb/domain";
import { createConnection, migrate } from "../src/index.js";
import {
  acceptPlacementOperation,
  readPlacementOperation,
} from "../src/data/placement-operations.js";
import {
  admitPlacementDispatch,
  reservePlacementWorker,
} from "../src/data/placement-admission.js";
import {
  preparePlacementOperation,
  readPlacementThreadBinding,
} from "../src/data/placement-bindings.js";
import { observePlacementWorkers } from "../src/data/placement-workers.js";
import {
  acceptPrepared,
  attachAndQueue,
  candidate,
  observation,
  setupPlacement,
  workspace,
} from "./helpers/placement.js";

it("reopens a single admitted Agent and physical Workspace with its original receipt", () => {
  const dir = mkdtempSync(join(tmpdir(), "placement-restart-"));
  const path = join(dir, "bb.db");
  let db = createConnection(path);
  const counts = () =>
    ["placement_operation", "threads", "queued_thread_messages"].map((table) =>
      db.$client.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),
    );
  const scope = {
    authority: fixtureAuthority,
    principalScope: "owner",
    ownerPluginId: "workers",
    providerId: "claude",
  };
  const key = "restart";
  const independent = (input: string) =>
    acceptPlacementOperation(db, {
      ...scope,
      submissionKey: key,
      request: {
        schemaVersion: 1,
        intent: {
          kind: "independent",
          selection: { mode: "auto" },
          request: { input },
        },
      },
    });
  try {
    migrate(db);
    setupPlacement(db);
    const receipt = independent(key);
    expect(receipt.kind).toBe("accepted");
    expect(independent(key)).toEqual(receipt);
    expect(independent("different")).toEqual({ kind: "conflict" });
    expect(counts()).toEqual([1, 0, 0]);
    const prepared = acceptPrepared(db, key);
    expect(counts()).toEqual([1, 0, 0]);
    const queued = attachAndQueue(db, prepared.id);
    if (queued.kind !== "recorded") throw new Error("missing queue receipt");
    const { threadId, queueReceipt, binding } = queued.operation;
    if (!threadId || !queueReceipt || !binding)
      throw new Error("missing identities");
    expect(binding).toEqual({
      ownerPluginId: "workers",
      providerId: "claude",
      workerId: "worker",
      accountId: "account",
      agentHostId: "agent-host",
      generation: "gen",
      workspace: workspaceBindingRef(workspace),
    });
    const admitted = db.transaction(
      (tx) =>
        admitPlacementDispatch(tx, {
          ...candidate(db, prepared.id),
          fence: 1,
          queuedMessageId: queueReceipt.queuedMessageId,
        }),
      { behavior: "immediate" },
    );
    expect(admitted.kind).toBe("admitted");
    db.$client.close();
    db = createConnection(path);
    expect(counts()).toEqual([1, 1, 1]);
    expect(readPlacementOperation(db, prepared.id)).toMatchObject({
      phase: "admitted",
      threadId,
      queueReceipt,
      binding,
    });
    expect(readPlacementThreadBinding(db, threadId)).toEqual(binding);
    expect(
      db.$client
        .prepare(
          "SELECT e.host_id, e.id, e.path FROM environments e JOIN threads t ON e.id=t.environment_id WHERE t.id=?",
        )
        .get(threadId),
    ).toEqual({
      host_id: workspace.hostId,
      id: workspace.environmentId,
      path: workspace.canonicalRoot,
    });
    const continuation = acceptPlacementOperation(db, {
      ...scope,
      submissionKey: "resume",
      request: {
        schemaVersion: 1,
        intent: { kind: "continuation", threadId, request: { input: "next" } },
      },
    });
    if (continuation.kind !== "accepted")
      throw new Error("missing continuation");
    const args = {
      operationId: continuation.operation.id,
      expectedRevision: continuation.operation.revision,
      preparedRequest: { input: "next" },
      preparedExecution: {
        model: "model",
        serviceTier: "default",
        reasoningLevel: "high",
        permissionMode: "auto",
        source: "client/thread/start",
      } as const,
      attachmentReceipts: [],
    };
    expect(
      preparePlacementOperation(db, {
        ...args,
        workspace: { ...workspace, hostId: "another-host" },
      }),
    ).toEqual({ kind: "conflict" });
    expect(preparePlacementOperation(db, { ...args, workspace }).kind).toBe(
      "prepared",
    );
    const worker = observation();
    observePlacementWorkers(db, {
      ...scope,
      expectedOwnerRevision: 2,
      workers: [
        {
          ...worker,
          revision: 2,
          generation: "next",
          custody: { ...worker.custody, revision: 2, generation: "next" },
        },
      ],
    });
    expect(
      reservePlacementWorker(db, {
        ...candidate(db, args.operationId),
        workerRevision: 2,
      }),
    ).toEqual({ kind: "wait", reason: "binding_changed" });
    expect(counts()).toEqual([2, 1, 1]);
    expect(readPlacementThreadBinding(db, threadId)).toEqual(binding);
  } finally {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
