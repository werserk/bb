import { eq } from "drizzle-orm";
import {
  environments,
  hosts,
  placementBindings,
  queuedThreadMessages,
  readPlacementActionReceipt,
  readPlacementOperationRecord,
  readPlacementOwner,
  reservePlacementWorker,
  threads,
} from "@bb/db";
import { setOwnerMode } from "@bb/db/internal-placement-owner";
import {
  PERSONAL_PROJECT_ID,
  clientSubmissionQueueId,
  normalizeWorkspaceBinding,
  workspaceBindingRef,
  workspaceCapabilities,
  type WorkerObservation,
} from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
} from "../../src/services/placement/placement-service.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER = "claude-code";
const OWNER = "account-workers";
const RUN = "placement-dispatch";
const ENV = "env_dispatch";
const HOST = "host_dispatch";
const ROOT = "/scratch/dispatch";
const purpose = { kind: "local-fixture" as const, fixtureRunId: RUN };

const workspace = normalizeWorkspaceBinding({
  schemaVersion: 1,
  workspaceBindingId: `env:${ENV}`,
  revision: 1,
  hostId: HOST,
  environmentId: ENV,
  projectId: PERSONAL_PROJECT_ID,
  sourceId: null,
  pathFlavor: "posix",
  canonicalRoot: ROOT,
  adapter: { id: "bb-mcp-workspace", version: "1" },
  requiredCapabilities: [...workspaceCapabilities],
});

function observation(): WorkerObservation {
  return {
    workerId: "worker-a",
    accountId: "account-a",
    agentHostId: "agent-host-a",
    generation: "gen-a",
    providerId: PROVIDER,
    providerVersion: "fixture",
    revision: 1,
    admission: "enabled",
    connected: true,
    auth: "authenticated",
    qualification: { tier: "local-fixture", evidenceId: "fx", fixtureRunId: RUN },
    custody: {
      revision: 1,
      status: "free",
      workerId: "worker-a",
      agentHostId: "agent-host-a",
      generation: "gen-a",
      holder: null,
      lock: { device: "1", inode: "2" },
    },
    exclusion: { authorityPluginId: OWNER, revision: 1, status: "excluded" },
    quota: { revision: 1, freshness: "unknown", block: null },
    routes: [
      {
        revision: 1,
        workspace: workspaceBindingRef(workspace),
        agent: {
          hostId: "agent-host-a",
          generation: "gen-a",
          providerVersion: "fixture",
        },
        tier: "local-fixture",
        evidenceId: "route-fx",
        fixtureRunId: RUN,
        connected: true,
        rootVerified: true,
        capabilities: Object.fromEntries(
          workspaceCapabilities.map((name) => [name, "checked" as const]),
        ),
      },
    ],
    launchProfileId: null,
  };
}

function request(key: string, text: string): PlacementRequestV1 {
  return {
    schemaVersion: 1,
    submissionKey: key,
    intent: {
      kind: "independent",
      selection: { mode: "auto" },
      request: {
        projectId: PERSONAL_PROJECT_ID,
        providerId: PROVIDER,
        origin: "app",
        model: "fixture-model",
        input: [{ type: "text", text, mentions: [] }],
        environment: { type: "reuse", environmentId: ENV },
        startedOnBehalfOf: null,
        originKind: null,
      },
    },
  } as PlacementRequestV1;
}

function freeWorkers(): PlacementOwnerPolicy {
  return {
    async evaluate(context): Promise<PlacementPolicyDecision> {
      const candidates = context.workers
        .filter((worker) => worker.slotState === "free")
        .map((worker) => ({
          workerId: worker.workerId,
          workerRevision: worker.observation.revision,
          routeEvidenceRevision: worker.observation.routes[0]?.revision ?? 0,
        }));
      return candidates.length === 0
        ? { kind: "wait", reason: "all_busy" }
        : { kind: "candidates", ownerRevision: context.ownerRevision, candidates };
    },
  };
}

const waiting: PlacementOwnerPolicy = {
  evaluate: async () => ({ kind: "wait", reason: "native_queue_wait" }),
};

async function withDispatch<T>(
  run: (
    harness: TestAppHarness,
    send: (threadId: string, queueId: string, principal: string | null) => Promise<{
      status: number;
      body: { code?: string; details?: unknown };
    }>,
  ) => Promise<T>,
) {
  return withTestHarness({ placementPurpose: purpose }, async (harness) => {
    harness.db
      .insert(hosts)
      .values({ id: HOST, name: "Workspace", type: "persistent", createdAt: 1, updatedAt: 1 })
      .run();
    harness.db
      .insert(environments)
      .values({
        id: ENV,
        projectId: PERSONAL_PROJECT_ID,
        hostId: HOST,
        path: ROOT,
        status: "ready",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();
    const principals = new WeakMap<Request, string>();
    harness.deps.resolvePlacementSendScope = (req) => {
      const principal = principals.get(req);
      return principal
        ? { principal, identity: "local-unverified", authority: "local-input-parity" }
        : null;
    };
    const send = async (threadId: string, queueId: string, principal: string | null) => {
      const req = new Request(
        `http://localhost/api/v1/threads/${threadId}/queued-messages/${queueId}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      if (principal) principals.set(req, principal);
      const response = await harness.app.fetch(req);
      return { status: response.status, body: await response.json() };
    };
    return run(harness, send);
  });
}

async function registerManaged(harness: TestAppHarness, policy: PlacementOwnerPolicy) {
  const registration = harness.placement.registerOwner({
    providerId: PROVIDER,
    ownerPluginId: OWNER,
    policy,
  });
  const scope = { providerId: PROVIDER, ownerPluginId: OWNER };
  const mode = setOwnerMode(
    harness.db,
    {
      ...scope,
      expectedRevision: registration.ownerRevision,
      mode: "managed",
      handoffReceiptId: null,
    },
    () => ({ ...scope, kind: "verified_empty", ownerRevision: registration.ownerRevision }),
  );
  expect(mode.kind).toBe("updated");
  expect(
    await harness.placement.observeWorkers({ ...scope, workers: [observation()] }),
  ).toBe("observed");
}

async function accept(harness: TestAppHarness, key: string, text: string) {
  const response = await harness.app.request("/api/v1/placement/operations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request(key, text)),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { operation: { id: string } }).operation.id;
}

function placed(harness: TestAppHarness, operationId: string) {
  const record = readPlacementOperationRecord(harness.db, operationId)!;
  const receipt = readPlacementActionReceipt(harness.db, operationId)!;
  const threadRows = harness.db.select().from(threads).all();
  const queueRows = harness.db.select().from(queuedThreadMessages).all();
  return { record, receipt, threadRows, queueRows };
}

describe("placement dispatch", () => {
  it("queues the first input on a new pending bound thread once; Send now refuses the unsupported managed first dispatch and releases the row", async () => {
    await withDispatch(async (harness, send) => {
      await registerManaged(harness, freeWorkers());
      const id = await accept(harness, "seq1", "dispatch me");
      await harness.placement.wake(PROVIDER);
      const { record, receipt, threadRows, queueRows } = placed(harness, id);
      expect(record).toMatchObject({ phase: "queued", reason: null });
      expect(threadRows).toHaveLength(1);
      const thread = threadRows[0]!;
      expect(record.threadId).toBe(thread.id);
      expect(thread).toMatchObject({
        projectId: PERSONAL_PROJECT_ID,
        environmentId: ENV,
        providerId: PROVIDER,
        status: "pending",
        originPluginId: null,
        deletedAt: null,
      });
      expect(JSON.parse(thread.startupContext!)).toMatchObject({
        kind: "pending",
        environmentIntent: { type: "reuse", environmentId: ENV },
        fork: null,
        startedOnBehalfOf: null,
        titleProvided: false,
        execution: { model: "fixture-model" },
      });
      const queueId = clientSubmissionQueueId(receipt.submissionUuid!);
      expect(queueRows).toHaveLength(1);
      expect(queueRows[0]).toMatchObject({
        id: queueId,
        threadId: thread.id,
        placementOperationId: id,
        placementFence: record.fence,
        model: "fixture-model",
        permissionMode: receipt.authority.permission,
        payloadKind: "inline",
      });
      expect(JSON.parse(queueRows[0]!.content)).toEqual([
        expect.objectContaining({ type: "text", text: "dispatch me" }),
      ]);
      expect(
        harness.db
          .select()
          .from(placementBindings)
          .where(eq(placementBindings.threadId, thread.id))
          .get(),
      ).toMatchObject({
        boundFromOperationId: id,
        workerId: "worker-a",
        runtimeRootKey: `placement:${id}`,
      });

      await harness.placement.wake(PROVIDER);
      expect(placed(harness, id).threadRows).toHaveLength(1);
      expect(placed(harness, id).queueRows).toHaveLength(1);

      const unscoped = await send(thread.id, queueId, null);
      expect(unscoped.status, JSON.stringify(unscoped.body)).toBe(404);
      expect(unscoped.body.code).toBe("invalid_request");
      const foreign = await send(thread.id, queueId, "plugin:other");
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
      expect(placed(harness, id).queueRows[0]).toMatchObject({ id: queueId, claimToken: null });

      const refused = await send(thread.id, queueId, "local");
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("placement_dispatch_unavailable");
      const after = placed(harness, id);
      expect(after.record.phase).toBe("queued");
      expect(after.threadRows).toHaveLength(1);
      expect(after.threadRows[0]!.status).toBe("pending");
      expect(after.queueRows).toHaveLength(1);
      expect(after.queueRows[0]).toMatchObject({ id: queueId, claimToken: null });
    });
  });

  it("attaches an orphaned reservation on the next wake without a second thread", async () => {
    await withDispatch(async (harness) => {
      await registerManaged(harness, waiting);
      const id = await accept(harness, "orphan", "left reserved");
      await harness.placement.wake(PROVIDER);
      const prepared = readPlacementOperationRecord(harness.db, id)!;
      expect(prepared.resolvedWorkspaceDigest).not.toBeNull();
      const owner = readPlacementOwner(harness.db, PROVIDER)!;
      const reserved = reservePlacementWorker(harness.db, {
        operationId: id,
        expectedRevision: prepared.revision,
        ownerRevision: owner.revision,
        workerId: "worker-a",
        workerRevision: 1,
        routeEvidenceRevision: 1,
        purpose,
      });
      expect(reserved.kind).toBe("reserved");
      expect(placed(harness, id).threadRows).toHaveLength(0);

      await harness.placement.wake(PROVIDER);
      const after = placed(harness, id);
      expect(after.record.phase).toBe("queued");
      expect(after.threadRows).toHaveLength(1);
      expect(after.queueRows).toHaveLength(1);
      expect(after.queueRows[0]!.placementOperationId).toBe(id);
    });
  });
});
