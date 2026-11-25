import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  acceptPlacementOperation,
  createConnection,
  createQueuedThreadMessageInTransaction,
  deleteThreadEventSuffixInTransaction,
  getLatestThreadSequence,
  getQueuedThreadMessage,
  listEvents,
  placementEffects,
  placementOperations,
  preparePlacementOperation,
  readPlacementDispatchReceipt,
  recordPlacementQueueReceipt,
  setQueuedThreadMessageGroupBoundary,
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
  resolvedThreadExecutionOptionsSchema,
  turnRequestEventDataSchema,
  type WorkerObservation,
} from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
} from "../../src/services/placement/placement-service.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { fixtureLaunchProfileId, fixtureRootKey } from "./fixture-root.js";

import { createApp } from "../../src/server.js";
import * as managedRuntime from "../../src/services/threads/managed-execution.js";
import { advanceThreadProvisioning } from "../../src/services/threads/thread-provisioning.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";

const PROVIDER = "claude-code";
const OWNER = "account-workers";
const RUN = "placement-dispatch";
const ENV = "env_dispatch";
const HOST = "host_dispatch";
const ROOT = "/scratch/dispatch";
const purpose = { kind: "local-fixture" as const, fixtureRunId: RUN };
const harnessOptions = {
  placementPurpose: purpose,
  placementRuntimeRootKey: fixtureRootKey,
};

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
    launchProfileId: fixtureLaunchProfileId({
      workerId: "worker-a",
      generation: "gen-a",
    }),
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
  return withTestHarness(harnessOptions, async (harness) => {
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

// A2 creates the independent head. Continuation transfer is still storage-owned.
function addFollower(
  h: TestAppHarness,
  headId: string,
  principal = "local",
  sendAt: number | null = null,
) {
  const { record, receipt } = placed(h, headId);
  const threadId = record.threadId!;
  const input = [{ type: "text" as const, text: "second", mentions: [] }];
  const clientSubmissionId = crypto.randomUUID();
  const request = {
    input,
    clientSubmissionId,
    ...(sendAt === null ? {} : { sendAt }),
  };
  const accepted = acceptPlacementOperation(h.db, {
    providerId: PROVIDER,
    ownerPluginId: OWNER,
    principalScope: principal,
    authority: { ...receipt.authority, principal },
    submissionKey: clientSubmissionId,
    request: {
      schemaVersion: 1,
      intent: { kind: "continuation", threadId, request },
    },
  });
  expect(accepted.kind).toBe("accepted");
  if (accepted.kind !== "accepted") throw new Error("Missing continuation");
  const execution = resolvedThreadExecutionOptionsSchema.parse(
    JSON.parse(record.preparedExecution!),
  );
  expect(
    preparePlacementOperation(h.db, {
      operationId: accepted.operation.id,
      expectedRevision: accepted.operation.revision,
      workspace,
      preparedRequest: request,
      preparedExecution: execution,
      attachmentReceipts: [],
    }).kind,
  ).toBe("prepared");
  const id = clientSubmissionQueueId(clientSubmissionId);
  expect(
    h.db.transaction((tx) =>
      recordPlacementQueueReceipt(tx, {
        operationId: accepted.operation.id,
        fence: record.fence!,
        queuedMessageId: id,
        onCommitted: () => {},
        insertQueue: (t, placement) => {
          createQueuedThreadMessageInTransaction(t, {
            placement,
            threadId,
            clientSubmissionId,
            ...execution,
            origin: receipt.authority.origin,
            originPluginId: receipt.authority.plugin,
            requestedBy: receipt.authority.requestedBy,
            senderThreadId: receipt.authority.sender,
            content: input,
            sendAt,
            waitingOn: sendAt === null ? null : { kind: "time" },
            payload: { kind: "inline" },
            systemNotice: null,
          });
        },
      }),
    ).kind,
  ).toBe("recorded");
  return { id, op: accepted.operation.id, clientSubmissionId };
}

describe("placement dispatch", () => {
  it("queues the first input on a new pending bound thread once; Send now commits one native first request before the protocol refusal", async () => {
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
        runtimeRootKey: "fixture-root:worker-a:gen-a",
      });

      await harness.placement.wake(PROVIDER);
      expect(placed(harness, id).threadRows).toHaveLength(1);
      expect(placed(harness, id).queueRows).toHaveLength(1);

      const unscoped = await send(thread.id, queueId, null);
      expect(unscoped.status, JSON.stringify(unscoped.body)).toBe(404);
      expect(unscoped.body.code).toBe("invalid_request");
      const foreign = await send(thread.id, queueId, "plugin:other");
      expect(foreign.status, JSON.stringify(foreign.body)).toBe(404);
      expect(placed(harness, id).queueRows[0]).toMatchObject({
        id: queueId,
        claimToken: null,
      });

      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await advanceThreadProvisioning(harness.deps, { threadId: thread.id });
      expect(listEvents(harness.db, { threadId: thread.id })).toEqual([]);
      const [first, second] = await Promise.all([
        send(thread.id, queueId, "local"),
        send(thread.id, queueId, "local"),
        runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        }),
      ]);
      const refused =
        first.body.code === "managed_execution_unsupported" ? first : second;
      expect(refused.status, JSON.stringify(refused.body)).toBe(409);
      expect(refused.body.code).toBe("managed_execution_unsupported");
      const after = placed(harness, id);
      expect(after.record.phase).toBe("admitted");
      expect(after.threadRows).toHaveLength(1);
      expect(after.threadRows[0]!.status).toBe("pending");
      expect(after.queueRows).toHaveLength(0);
      expect(after.threadRows[0]!.startupContext).toBe(thread.startupContext);
      await advanceThreadProvisioning(harness.deps, { threadId: thread.id });
      const timeline = listEvents(harness.db, { threadId: thread.id });
      expect(timeline.map((e) => e.type)).toEqual([
        "client/turn/requested",
        "client/turn/rejected",
      ]);
      const body = turnRequestEventDataSchema.parse(
        JSON.parse(timeline[0]!.data),
      );
      expect(body).toMatchObject({
        target: { kind: "thread-start" },
        source: "spawn",
        request: { method: "thread/start" },
        sourceQueuedMessageIds: [queueId],
        clientSubmissions: [{ id: receipt.submissionUuid, inputGroupIndex: 0 }],
        initiator: receipt.authority.initiator,
        execution: JSON.parse(record.preparedExecution!),
      });
      expect(
        readPlacementDispatchReceipt(harness.db, {
          threadId: thread.id,
          requestId: body.requestId,
        }),
      ).toMatchObject({
        eventId: timeline[0]!.id,
        requestSequence: timeline[0]!.sequence,
        rejectionEventId: timeline[1]!.id,
        rejectionReason: "managed_execution_unsupported",
        state: "refused_unsent",
        members: [{ op: id, queueId }],
      });
      expect(await send(thread.id, queueId, "local")).toEqual(refused);
      expect(
        listQueuedThreadCommands(harness, "thread.start", thread.id),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toHaveLength(0);
    });
  });

  it.each(["local", "foreign"] as const)(
    "only the original head can admit the authorized group (%s follower)",
    async (principal) => {
      await withDispatch(async (h, send) => {
        await registerManaged(h, freeWorkers());
        const id = await accept(h, "first", "start");
        await h.placement.wake(PROVIDER);
        const { record, receipt } = placed(h, id);
        const threadId = record.threadId!,
          head = record.queuedMessageId!;
        const follower = addFollower(h, id, principal);
        expect(
          setQueuedThreadMessageGroupBoundary({
            db: h.db,
            notifier: h.hub,
            threadId,
            expectedGroupedPrefixQueuedMessageIds: [head, follower.id],
            groupBoundaryQueuedMessageId: follower.id,
          }).kind,
        ).toBe("updated");
        const changes = () =>
          h.db.$client.prepare("select total_changes()").pluck().get();
        const before = changes();
        expect((await send(threadId, follower.id, "local")).status).toBe(
          principal === "local" ? 409 : 404,
        );
        expect(changes()).toBe(before);
        const res = await send(threadId, head, "local");
        if (principal === "foreign") {
          expect(res.status).toBe(404);
          expect(changes()).toBe(before);
          return;
        }
        expect(res.body).toMatchObject({
          code: "managed_execution_unsupported",
          details: {
            state: "refused_unsent",
            sourceQueuedMessageIds: [head, follower.id],
            submissionIds: [
              receipt.submissionUuid,
              follower.clientSubmissionId,
            ],
          },
        });
        expect(await send(threadId, follower.id, "local")).toEqual(res);
      });
    },
  );

  it.each(["prepared", "refused_unsent"] as const)(
    "recovers the same first request offline after %s",
    async (state) => {
      await withDispatch(async (h, send) => {
        await registerManaged(h, freeWorkers());
        const id = await accept(h, "start", "hello");
        await h.placement.wake(PROVIDER);
        const { record } = placed(h, id);
        const threadId = record.threadId!,
          queueId = record.queuedMessageId!;
        const handoff = vi.spyOn(managedRuntime, "dispatchManagedOrdinaryTurn");
        if (state === "prepared")
          handoff.mockRejectedValueOnce(new Error("fixture loss after commit"));
        try {
          const first = await send(threadId, queueId, "local");
          expect(first.status).toBe(state === "prepared" ? 500 : 409);
          const [effect] = h.db.select().from(placementEffects).all();
          expect(effect!.state).toBe(state);
          const path = join(h.config.dataDir, "first-reopen.sqlite");
          await h.db.$client.backup(path);
          const db = createConnection(path);
          try {
            const deps = {
              ...h.deps,
              db,
              resolvePlacementSendScope: () => ({
                principal: "local",
                identity: "local-unverified" as const,
                authority: "local-input-parity" as const,
              }),
            };
            const { app } = createApp(deps);
            expect(readPlacementOwner(db, PROVIDER)?.available).toBe(false);
            const changes = () =>
              db.$client.prepare("select total_changes()").pluck().get();
            const before = changes();
            const resp = await app.request(
              "/api/v1/threads/" +
                threadId +
                "/queued-messages/" +
                queueId +
                "/send",
              {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ mode: "auto" }),
              },
            );
            const body = await resp.json();
            expect(resp.status).toBe(409);
            expect(body).toMatchObject({
              details: {
                state,
                requested: {
                  requestId: effect!.request,
                  sequence: effect!.requestSequence,
                },
              },
            });
            if (state === "refused_unsent") expect(body).toEqual(first.body);
            await runQueuedMessageDispatch(deps, {
              kind: "thread-ready",
              threadId,
            });
            await advanceThreadProvisioning(deps, { threadId });
            expect(changes()).toBe(before);
            expect(handoff).toHaveBeenCalledTimes(1);
            expect(listEvents(db, { threadId }).map((e) => e.type)).toEqual(
              state === "prepared"
                ? ["client/turn/requested"]
                : ["client/turn/requested", "client/turn/rejected"],
            );
            expect(
              listQueuedThreadCommands(h, "thread.start", threadId),
            ).toHaveLength(0);
          } finally {
            db.$client.close();
          }
        } finally {
          handoff.mockRestore();
        }
      });
    },
  );

  it.each(["cancelled", "changed context", "claim lost"] as const)(
    "preserves the first qsub after %s",
    async (fault) => {
      await withDispatch(async (h, send) => {
        await registerManaged(h, freeWorkers());
        const id = await accept(h, "start", "hello");
        await h.placement.wake(PROVIDER);
        const { record } = placed(h, id);
        const threadId = record.threadId!,
          queueId = record.queuedMessageId!;
        if (fault === "cancelled")
          h.db
            .update(placementOperations)
            .set({ cancelRequested: true })
            .where(eq(placementOperations.id, id))
            .run();
        if (fault === "changed context")
          h.db
            .update(threads)
            .set({ startupContext: null })
            .where(eq(threads.id, threadId))
            .run();
        if (fault === "claim lost")
          h.db.$client.exec(
            "CREATE TRIGGER lose_first_claim AFTER INSERT ON events WHEN NEW.type='client/turn/requested' BEGIN UPDATE queued_thread_messages SET claim_token='other' WHERE thread_id=NEW.thread_id; END",
          );
        const res = await send(threadId, queueId, "local");
        expect(res.status).toBe(409);
        expect(listEvents(h.db, { threadId })).toEqual([]);
        expect(getQueuedThreadMessage(h.db, queueId)?.claimToken).toBeNull();
        expect(h.db.select().from(placementEffects).all()).toEqual([]);
        expect(
          listQueuedThreadCommands(h, "thread.start", threadId),
        ).toHaveLength(0);
      });
    },
  );

  it("detached first admission cannot start again or consume a later qsub", async () => {
    await withDispatch(async (h, send) => {
      await registerManaged(h, freeWorkers());
      const id = await accept(h, "start", "hello");
      await h.placement.wake(PROVIDER);
      const { record } = placed(h, id);
      const threadId = record.threadId!,
        head = record.queuedMessageId!;
      const later = addFollower(h, id);
      expect((await send(threadId, head, "local")).body.code).toBe(
        "managed_execution_unsupported",
      );
      const [requested] = listEvents(h.db, { threadId });
      h.db.transaction((tx) =>
        deleteThreadEventSuffixInTransaction(tx, {
          threadId,
          cutoffSequence: requested!.sequence,
          oldMaxSequence: getLatestThreadSequence(tx, { threadId }),
        }),
      );
      const before = h.db.$client
        .prepare("select total_changes()")
        .pluck()
        .get();
      for (const qid of [head, later.id])
        expect((await send(threadId, qid, "local")).body.code).toBe(
          "placement_dispatch_unavailable",
        );
      expect(h.db.$client.prepare("select total_changes()").pluck().get()).toBe(
        before,
      );
      expect(h.db.select().from(placementEffects).all()).toMatchObject([
        { liveEventId: null },
      ]);
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
