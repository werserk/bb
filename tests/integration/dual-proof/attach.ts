import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  acceptPlacementOperation,
  attachPlacementThread,
  registerPlacementOwner,
  preparePlacementOperation,
  reservePlacementWorker,
  observePlacementWorkers,
  placementOwners,
  threads,
  type DbConnection,
} from "@bb/db";
import { workspaceBindingRef } from "@bb/domain";
import {
  observation,
  workspace,
  purpose,
  fixtureAuthority,
  candidate,
} from "../../../packages/db/test/helpers/placement.js";

export function attachManagedFixture(
  db: DbConnection,
  target: {
    agentHostId: string;
    workspaceHostId: string;
    root: string;
    projectId: string;
    environmentId: string;
  },
) {
  // A synthetic placement publication and thread materialization. No command receipt, lifecycle or tool call is seeded.
  const providerId = "fake",
    ownerPluginId = "fixture-workers";
  const ws = {
    ...workspace,
    hostId: target.workspaceHostId,
    canonicalRoot: target.root,
    projectId: target.projectId,
    environmentId: target.environmentId,
  };
  const obs = observation();
  const { agentHostId } = target;
  assert.equal(
    registerPlacementOwner(db, { providerId, ownerPluginId }).kind,
    "registered",
  );
  db.update(placementOwners)
    .set({ mode: "managed" })
    .where(eq(placementOwners.providerId, providerId))
    .run();
  observePlacementWorkers(db, {
    providerId,
    ownerPluginId,
    expectedOwnerRevision: 1,
    workers: [
      {
        ...obs,
        providerId,
        agentHostId,
        custody: { ...obs.custody, agentHostId },
        routes: obs.routes.map((route) => ({
          ...route,
          agent: { ...route.agent, hostId: agentHostId },
          workspace: workspaceBindingRef(ws),
        })),
      },
    ],
  });
  const accepted = acceptPlacementOperation(db, {
    providerId,
    ownerPluginId,
    principalScope: fixtureAuthority.principal,
    authority: fixtureAuthority,
    submissionKey: "managed-stop",
    request: {
      schemaVersion: 1,
      intent: {
        kind: "independent",
        selection: { mode: "auto" },
        request: { input: "fixture" },
      },
    },
  });
  assert.equal(accepted.kind, "accepted");
  const id = accepted.operation.id;
  assert.equal(
    preparePlacementOperation(db, {
      operationId: id,
      expectedRevision: accepted.operation.revision,
      workspace: ws,
      preparedRequest: { input: "fixture" },
      preparedExecution: {
        model: "model",
        serviceTier: "default",
        reasoningLevel: "high",
        permissionMode: "auto",
        source: "client/thread/start",
      },
      attachmentReceipts: [],
    }).kind,
    "prepared",
  );
  const reserved = reservePlacementWorker(db, {
    ...candidate(db, id),
    purpose,
  });
  assert.equal(reserved.kind, "reserved");
  const attached = db.transaction((tx) =>
    attachPlacementThread(tx, {
      operationId: id,
      fence: reserved.fence,
      runtimeRootKey: "fixture-owned",
      sourceProviderThreadId: null,
      sourceCheckpoint: null,
      onCommitted: () => {},
      insertThread: (inner, threadId) => {
        inner
          .insert(threads)
          .values({
            id: threadId,
            environmentId: ws.environmentId,
            projectId: target.projectId,
            providerId,
            latestAttentionAt: 1,
            createdAt: 1,
            updatedAt: 1,
          })
          .run();
      },
    }),
  );
  assert.equal(attached.kind, "attached");
  assert.ok(attached.operation.threadId);
  return attached.operation.threadId;
}
