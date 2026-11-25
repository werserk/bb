import { readPlacementActionReceipt } from "../../src/data/placement-action-receipts.js";
import { clientSubmissionQueueId } from "@bb/domain";
import { setOwnerMode } from "../../src/internal-placement-owner.js";
import {
  workspaceBindingRef,
  type WorkspaceBinding,
  type WorkerObservation,
} from "@bb/domain";
import type { DbConnection } from "../../src/connection.js";
import {
  projects,
  environments,
  hosts,
  threads,
  queuedThreadMessages,
} from "../../src/schema.js";
import {
  registerPlacementOwner,
  observePlacementWorkers,
} from "../../src/data/placement-workers.js";
import {
  acceptPlacementOperation,
  readPlacementOperation,
  readPlacementOperationRecord,
} from "../../src/data/placement-operations.js";
import {
  preparePlacementOperation,
  attachPlacementThread,
  recordPlacementQueueReceipt,
} from "../../src/data/placement-bindings.js";
import {
  reservePlacementWorker,
  type PlacementCandidate,
} from "../../src/data/placement-admission.js";
export const fixtureAuthority = {
  principal: "owner",
  actor: "local-unverified",
  origin: null,
  plugin: null,
  requestedBy: null,
  sender: null,
  initiator: "user",
  escalation: "ask",
  permission: "auto",
  serviceTurn: null,
} as const;
export const workspace: WorkspaceBinding = {
  schemaVersion: 1,
  workspaceBindingId: "ws",
  revision: 1,
  hostId: "workspace-host",
  environmentId: "env",
  projectId: "project",
  sourceId: null,
  pathFlavor: "posix",
  canonicalRoot: "/scratch",
  adapter: { id: "bb-mcp-workspace", version: "1" },
  requiredCapabilities: ["text.read"],
};
export const purpose = {
  kind: "local-fixture" as const,
  fixtureRunId: "placement-test",
};
export function observation(
  patch: Partial<WorkerObservation> = {},
): WorkerObservation {
  return {
    workerId: "worker",
    accountId: "account",
    agentHostId: "agent-host",
    generation: "gen",
    providerId: "claude",
    providerVersion: "fixture-version",
    revision: 1,
    admission: "enabled",
    connected: true,
    auth: "authenticated",
    qualification: {
      tier: "local-fixture",
      evidenceId: "fixture",
      fixtureRunId: "placement-test",
    },
    custody: {
      revision: 1,
      status: "free",
      workerId: "worker",
      agentHostId: "agent-host",
      generation: "gen",
      holder: null,
      lock: { device: "1", inode: "2" },
    },
    exclusion: {
      authorityPluginId: "exclusion",
      revision: 1,
      status: "excluded",
    },
    quota: { revision: 1, freshness: "fresh", block: null },
    routes: [
      {
        revision: 1,
        workspace: workspaceBindingRef(workspace),
        agent: {
          hostId: "agent-host",
          generation: "gen",
          providerVersion: "fixture-version",
        },
        tier: "local-fixture",
        evidenceId: "route-fixture",
        fixtureRunId: "placement-test",
        connected: true,
        rootVerified: true,
        capabilities: { "text.read": "checked" },
      },
    ],
    launchProfileId: "fixture",
    ...patch,
  };
}
export function setupPlacement(db: DbConnection) {
  const scope = { providerId: "claude", ownerPluginId: "workers" };
  const registration = registerPlacementOwner(db, scope);
  if (registration.kind !== "registered")
    throw new Error("fixture owner registration failed");
  const activation = setOwnerMode(
    db,
    {
      ...scope,
      expectedRevision: registration.owner.revision,
      mode: "managed",
      handoffReceiptId: null,
    },
    () => ({
      ...scope,
      kind: "verified_empty",
      ownerRevision: registration.owner.revision,
    }),
  );
  if (activation.kind !== "updated")
    throw new Error("fixture activation failed");
  observePlacementWorkers(db, {
    providerId: "claude",
    ownerPluginId: "workers",
    expectedOwnerRevision: activation.owner.revision,
    workers: [observation()],
  });
  db.insert(projects)
    .values({ id: "project", name: "test", createdAt: 1, updatedAt: 1 })
    .run();
  db.insert(hosts)
    .values({
      id: workspace.hostId,
      name: "Physical workspace",
      type: "persistent",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  db.insert(environments)
    .values({
      id: workspace.environmentId,
      projectId: "project",
      hostId: workspace.hostId,
      path: workspace.canonicalRoot,
      status: "ready",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
}
export function acceptPrepared(
  db: DbConnection,
  key: string,
  patch: Partial<WorkspaceBinding> = {},
  requestOptions: { compactFirst?: boolean } = {},
  selectedWorker?: string,
) {
  const accepted = acceptPlacementOperation(db, {
    authority: fixtureAuthority,
    principalScope: "owner",
    submissionKey: key,
    ownerPluginId: "workers",
    providerId: "claude",
    request: {
      schemaVersion: 1,
      intent: {
        kind: "independent",
        selection: selectedWorker
          ? { mode: "worker", workerId: selectedWorker }
          : { mode: "auto" },
        request: { input: key, ...requestOptions },
      },
    },
  });
  if (accepted.kind !== "accepted") throw new Error("accept failed");
  const prepared = preparePlacementOperation(db, {
    operationId: accepted.operation.id,
    expectedRevision: accepted.operation.revision,
    workspace: { ...workspace, ...patch },
    preparedRequest: { input: `prepared ${key}` },
    preparedExecution: {
      model: "model",
      serviceTier: "default",
      reasoningLevel: "high",
      permissionMode: "auto",
      source: "client/thread/start",
    },
    attachmentReceipts: [],
  });
  if (prepared.kind !== "prepared") throw new Error("prepare failed");
  return prepared.operation;
}
export function candidate(db: DbConnection, id: string): PlacementCandidate {
  const op = readPlacementOperation(db, id);
  if (!op) throw new Error("missing operation");
  return {
    operationId: id,
    expectedRevision: op.revision,
    ownerRevision: 2,
    workerId: "worker",
    workerRevision: 1,
    routeEvidenceRevision: 1,
    purpose,
  };
}
export function attachAndQueue(
  db: DbConnection,
  id: string,
  notify: () => void = () => {},
) {
  const reserved = reservePlacementWorker(db, candidate(db, id));
  if (reserved.kind !== "reserved") throw new Error(JSON.stringify(reserved));
  return db.transaction(
    (tx) => {
      const attached = attachPlacementThread(tx, {
        operationId: id,
        fence: reserved.fence,
        runtimeRootKey: "runtime",
        sourceProviderThreadId: null,
        sourceCheckpoint: null,
        insertThread: (t, threadId) => {
          t.insert(threads)
            .values({
              id: threadId,
              environmentId: workspace.environmentId,
              projectId: "project",
              providerId: "claude",
              latestAttentionAt: 1,
              createdAt: 1,
              updatedAt: 1,
            })
            .run();
        },
        onCommitted: notify,
      });
      if (attached.kind !== "attached" || !attached.operation.threadId)
        throw new Error("attach failed");
      const threadId = attached.operation.threadId;
      const qid = clientSubmissionQueueId(
        readPlacementActionReceipt(tx, id)!.submissionUuid!,
      );
      return recordPlacementQueueReceipt(tx, {
        operationId: id,
        fence: reserved.fence,
        queuedMessageId: qid,
        insertQueue: (t, identity) => {
          t.insert(queuedThreadMessages)
            .values({
              id: qid,
              threadId,
              placementOperationId: identity.operationId,
              placementFence: identity.fence,
              content: JSON.stringify([
                {
                  type: "text",
                  text: JSON.parse(
                    readPlacementOperationRecord(t, id)!.preparedRequest!,
                  ).input,
                  mentions: [],
                },
              ]),
              model: "model",
              reasoningLevel: "high",
              permissionMode: "auto",
              serviceTier: "default",
              state: "queued",
              sortKey: "V",
              createdAt: 1,
              updatedAt: 1,
            })
            .run();
        },
        onCommitted: notify,
      });
    },
    { behavior: "immediate" },
  );
}
