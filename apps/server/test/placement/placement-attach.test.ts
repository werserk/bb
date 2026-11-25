import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  createConnection,
  createThread,
  type DbConnection,
  environments,
  hosts,
  placementBindings,
  placementOperations,
  placementWorkers,
  queuedThreadMessages,
  readPlacementActionReceipt,
  readPlacementOperationRecord,
  threads,
} from "@bb/db";
import { setOwnerMode } from "@bb/db/internal-placement-owner";
import {
  PERSONAL_PROJECT_ID,
  normalizeWorkspaceBinding,
  workspaceBindingRef,
  workspaceCapabilities,
  type WorkerObservation,
} from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
  PlacementService,
} from "../../src/services/placement/placement-service.js";
import { resolvePendingThreadSessionOptions } from "../../src/services/threads/thread-session-options.js";
import type { AppDeps, PlacementRuntimeRootIdentity } from "../../src/types.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { fixtureLaunchProfileId, fixtureRootKey } from "./fixture-root.js";

const PROVIDER = "claude-code";
const OWNER = "account-workers";
const RUN = "placement-attach";
const ENV = "env_attach";
const HOST = "host_attach";
const ROOT = "/scratch/attach";
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

function observation(
  workerId = "worker-a",
  revision = 1,
  custodyRevision = revision,
): WorkerObservation {
  return {
    workerId,
    accountId: "account-a",
    agentHostId: "agent-host-a",
    generation: "gen-a",
    providerId: PROVIDER,
    providerVersion: "fixture",
    revision,
    admission: "enabled",
    connected: true,
    auth: "authenticated",
    qualification: {
      tier: "local-fixture",
      evidenceId: "fx",
      fixtureRunId: RUN,
    },
    custody: {
      revision: custodyRevision,
      status: "free",
      workerId,
      agentHostId: "agent-host-a",
      generation: "gen-a",
      holder: null,
      lock: { device: "1", inode: workerId },
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
    launchProfileId: fixtureLaunchProfileId({ workerId, generation: "gen-a" }),
  };
}

function independent(
  key: string,
  overrides: Record<string, unknown> = {},
): PlacementRequestV1 {
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
        input: [{ type: "text", text: `input ${key}`, mentions: [] }],
        environment: { type: "reuse", environmentId: ENV },
        startedOnBehalfOf: null,
        originKind: null,
        ...overrides,
      },
    },
  } as PlacementRequestV1;
}

const freeWorkers: PlacementOwnerPolicy = {
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
      : {
          kind: "candidates",
          ownerRevision: context.ownerRevision,
          candidates,
        };
  },
};

function withAttach<T>(
  run: (harness: TestAppHarness) => Promise<T>,
  rootKey: AppDeps["placementRuntimeRootKey"] = fixtureRootKey,
  workerIds: readonly string[] = ["worker-a"],
) {
  return withTestHarness(
    { placementPurpose: purpose, placementRuntimeRootKey: rootKey },
    async (harness) => {
      harness.db
        .insert(hosts)
        .values({
          id: HOST,
          name: "Workspace",
          type: "persistent",
          createdAt: 1,
          updatedAt: 1,
        })
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
      registerManagedOn(harness.placement, harness.db);
      expect(
        await observe(
          harness.placement,
          workerIds.map((workerId) => observation(workerId)),
        ),
      ).toBe("observed");
      return run(harness);
    },
  );
}

function registerManagedOn(placement: PlacementService, db: DbConnection) {
  const registration = placement.registerOwner({
    providerId: PROVIDER,
    ownerPluginId: OWNER,
    policy: freeWorkers,
  });
  const scope = { providerId: PROVIDER, ownerPluginId: OWNER };
  const mode = setOwnerMode(
    db,
    {
      ...scope,
      expectedRevision: registration.ownerRevision,
      mode: "managed",
      handoffReceiptId: null,
    },
    () => ({
      ...scope,
      kind: "verified_empty",
      ownerRevision: registration.ownerRevision,
    }),
  );
  expect(["updated", "unchanged"]).toContain(mode.kind);
}

function observe(placement: PlacementService, workers: WorkerObservation[]) {
  return placement.observeWorkers({
    providerId: PROVIDER,
    ownerPluginId: OWNER,
    workers,
  });
}

function slot(db: DbConnection, workerId: string) {
  return db
    .select()
    .from(placementWorkers)
    .where(eq(placementWorkers.workerId, workerId))
    .get()!;
}

async function post(harness: TestAppHarness, path: string, body?: unknown) {
  const response = await harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  };
}

async function accept(harness: TestAppHarness, request: PlacementRequestV1) {
  const response = await post(harness, "/placement/operations", request);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body.operation.id as string;
}

function state(harness: TestAppHarness, operationId: string) {
  return {
    record: readPlacementOperationRecord(harness.db, operationId)!,
    worker: harness.db
      .select()
      .from(placementWorkers)
      .where(eq(placementWorkers.workerId, "worker-a"))
      .get()!,
    threads: harness.db.select().from(threads).all(),
    queue: harness.db.select().from(queuedThreadMessages).all(),
    operations: harness.db.select().from(placementOperations).all().length,
  };
}

function attachOutage() {
  const calls = { count: 0, enrolled: true };
  return {
    restore: () => {
      calls.enrolled = true;
    },
    resolver: (root: PlacementRuntimeRootIdentity) => {
      calls.count += 1;
      if (calls.count === 2) calls.enrolled = false;
      return calls.enrolled ? fixtureRootKey(root) : null;
    },
  };
}

function parentThread(harness: TestAppHarness) {
  return createThread(harness.db, harness.hub, {
    projectId: PERSONAL_PROJECT_ID,
    environmentId: ENV,
    providerId: PROVIDER,
    status: "idle",
  });
}

describe("placement attach", () => {
  it("reserves only a worker whose runtime root the trusted resolver qualifies", async () => {
    await withAttach(
      async (harness) => {
        const id = await accept(harness, independent("no-root"));
        await harness.placement.wake(PROVIDER);
        const after = state(harness, id);
        expect(after.record).toMatchObject({
          phase: "pending",
          reason: "unsupported_tool_route",
          fence: null,
        });
        expect(after.worker.slotState).toBe("free");
        expect(after.threads).toHaveLength(0);
        expect(after.queue).toHaveLength(0);
      },
      () => null,
    );
  });

  it("writes the trusted root key on the binding and retries attach while the key is unavailable", async () => {
    const outage = attachOutage();
    await withAttach(async (harness) => {
      const id = await accept(harness, independent("root-flap"));
      await harness.placement.wake(PROVIDER);
      const held = state(harness, id);
      expect(held.record.phase).toBe("reserved");
      expect(held.record.fence).not.toBeNull();
      expect(held.worker).toMatchObject({
        slotState: "reserved",
        ownerOperationId: id,
      });
      expect(held.threads).toHaveLength(0);

      outage.restore();
      await harness.placement.wake(PROVIDER);
      const after = state(harness, id);
      expect(after.record.phase).toBe("queued");
      expect(after.record.fence).toBe(held.record.fence);
      expect(after.threads).toHaveLength(1);
      expect(
        harness.db
          .select()
          .from(placementBindings)
          .where(eq(placementBindings.threadId, after.threads[0]!.id))
          .get(),
      ).toMatchObject({
        boundFromOperationId: id,
        generation: "gen-a",
        runtimeRootKey: "fixture-root:worker-a:gen-a",
      });
    }, outage.resolver);
  });

  it("keeps the accepted schedule and session selections on the native thread and queue row", async () => {
    await withAttach(
      async (harness) => {
        const due = Date.now() + 3_600_000;
        const id = await accept(
          harness,
          independent("scheduled", {
            sendAt: due,
            sessionOptions: { fixtureOption: "chosen" },
          }),
        );
        await harness.placement.wake(PROVIDER);
        const after = state(harness, id);
        expect(after.record.phase).toBe("queued");
        expect(after.queue).toHaveLength(1);
        expect(after.queue[0]).toMatchObject({
          placementOperationId: id,
          sendAt: due,
        });
        expect(JSON.parse(after.queue[0]!.waitingOn!)).toEqual({
          kind: "time",
        });
        expect(
          resolvePendingThreadSessionOptions(harness.db, after.threads[0]!.id),
        ).toEqual({ fixtureOption: "chosen" });

        const elapsed = Date.now() - 1_000;
        const dueId = await accept(
          harness,
          independent("already-due", { sendAt: elapsed }),
        );
        await harness.placement.wake(PROVIDER);
        const dueRow = state(harness, dueId).queue.find(
          (row) => row.placementOperationId === dueId,
        )!;
        expect(dueRow.sendAt).toBe(elapsed);
        expect(JSON.parse(dueRow.waitingOn!)).toEqual({ kind: "time" });
      },
      fixtureRootKey,
      ["worker-a", "worker-b"],
    );
  });

  it("refuses inputs the native pending mapping does not carry before reserving", async () => {
    await withAttach(async (harness) => {
      const plugin = await accept(
        harness,
        independent("plugin-submission", {
          pluginSubmission: { pluginId: "fixture-plugin", data: {} },
        }),
      );
      await harness.placement.wake(PROVIDER);
      const after = state(harness, plugin);
      expect(after.record).toMatchObject({
        phase: "refused",
        reason: "unsupported_preparation",
        fence: null,
      });
      expect(after.worker.slotState).toBe("free");
      expect(after.threads).toHaveLength(0);
    });
  });

  it("replays an accepted child after its parent is archived, while new or changed submissions still meet native eligibility", async () => {
    await withAttach(async (harness) => {
      const parent = parentThread(harness);
      const request = independent("child", { parentThreadId: parent.id });
      const id = await accept(harness, request);
      await harness.placement.wake(PROVIDER);
      expect(state(harness, id).record.phase).toBe("queued");
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, parent.id))
        .run();

      const replay = await post(harness, "/placement/operations", request);
      expect(replay.status, JSON.stringify(replay.body)).toBe(200);
      expect(replay.body.operation.id).toBe(id);

      const changedBody = independent("child", {
        parentThreadId: parent.id,
        input: [{ type: "text", text: "different", mentions: [] }],
      });
      const conflict = await post(
        harness,
        "/placement/operations",
        changedBody,
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.code).toBe("placement_submission_conflict");

      const newKey = await post(
        harness,
        "/placement/operations",
        independent("child-2", { parentThreadId: parent.id }),
      );
      expect(newKey.status).toBe(400);
      expect(newKey.body.code).toBe("parent_thread_invalid");

      await expect(
        harness.placement.accept(
          { kind: "plugin", pluginId: "fixture-other" },
          request,
        ),
      ).rejects.toMatchObject({ status: 400 });
      expect(state(harness, id).operations).toBe(1);
      expect(
        readPlacementActionReceipt(harness.db, id)!.authority.principal,
      ).toBe("local");
    });
  });

  it("refuses a permanently failed attach and frees its worker only on fresh free custody", async () => {
    const outage = attachOutage();
    await withAttach(async (harness) => {
      const parent = parentThread(harness);
      const id = await accept(
        harness,
        independent("orphan-parent", { parentThreadId: parent.id }),
      );
      await harness.placement.wake(PROVIDER);
      expect(state(harness, id).record.phase).toBe("reserved");
      outage.restore();
      harness.db
        .update(threads)
        .set({ archivedAt: Date.now() })
        .where(eq(threads.id, parent.id))
        .run();
      await harness.placement.wake(PROVIDER);
      const refused = state(harness, id);
      expect(refused.record).toMatchObject({
        phase: "refused",
        reason: "binding_changed",
      });
      expect(refused.worker).toMatchObject({
        slotState: "reserved",
        ownerOperationId: id,
        fence: refused.record.fence,
      });
      expect(refused.threads.map((thread) => thread.id)).toEqual([parent.id]);
      expect(refused.queue).toHaveLength(0);

      expect(
        await observe(harness.placement, [observation("worker-a", 2, 1)]),
      ).toBe("observed");
      expect(state(harness, id).worker.slotState).toBe("reserved");
      expect(
        await observe(harness.placement, [observation("worker-a", 3, 2)]),
      ).toBe("observed");
      expect(state(harness, id).worker).toMatchObject({
        slotState: "free",
        ownerOperationId: null,
      });

      const later = await accept(harness, independent("after-refusal"));
      await harness.placement.wake(PROVIDER);
      expect(state(harness, later).record.phase).toBe("queued");
    }, outage.resolver);
  });

  it("cancels bound input before admission, holds the lease across reopen until fresh free custody, and leaves a sibling intact", async () => {
    await withAttach(
      async (harness) => {
        const id = await accept(harness, independent("cancel-after-attach"));
        const sibling = await accept(harness, independent("sibling"));
        await harness.placement.wake(PROVIDER);
        const bound = state(harness, id);
        const siblingBound = state(harness, sibling).record;
        expect(bound.record.phase).toBe("queued");
        expect(siblingBound.phase).toBe("queued");
        expect(bound.record.binding!.workerId).not.toBe(
          siblingBound.binding!.workerId,
        );
        const worker = bound.record.binding!.workerId;
        const siblingRow = bound.queue.find(
          (row) => row.placementOperationId === sibling,
        )!;

        const cancelled = await post(
          harness,
          `/placement/operations/${id}/cancel`,
        );
        expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);
        await harness.placement.wake(PROVIDER);
        const after = state(harness, id);
        expect(after.record).toMatchObject({
          phase: "cancel_requested",
          cancelRequested: true,
          fence: bound.record.fence,
        });
        expect(after.queue).toEqual([siblingRow]);
        expect(after.threads).toHaveLength(2);
        expect(slot(harness.db, worker)).toMatchObject({
          slotState: "reserved",
          ownerOperationId: id,
        });

        const path = join(harness.config.dataDir, "cancel-reopen.sqlite");
        await harness.db.$client.backup(path);
        const db = createConnection(path);
        try {
          const { placement } = createApp({ ...harness.deps, db });
          registerManagedOn(placement, db);
          expect(
            await observe(placement, [
              observation("worker-a", 2, 1),
              observation("worker-b", 2, 1),
            ]),
          ).toBe("observed");
          expect(slot(db, worker)).toMatchObject({
            slotState: "reserved",
            ownerOperationId: id,
          });
          expect(
            await observe(placement, [
              observation("worker-a", 3, 2),
              observation("worker-b", 3, 2),
            ]),
          ).toBe("observed");
          expect(slot(db, worker)).toMatchObject({
            slotState: "free",
            ownerOperationId: null,
          });
          expect(readPlacementOperationRecord(db, id)!.phase).toBe("cancelled");
          expect(readPlacementOperationRecord(db, sibling)).toMatchObject({
            phase: "queued",
            fence: siblingBound.fence,
          });
          expect(slot(db, siblingBound.binding!.workerId)).toMatchObject({
            slotState: "reserved",
            ownerOperationId: sibling,
          });
          expect(db.select().from(queuedThreadMessages).all()).toEqual([
            siblingRow,
          ]);

          const later = await placement.accept(
            { kind: "client" },
            independent("after-cancel"),
          );
          await placement.wake(PROVIDER);
          expect(
            readPlacementOperationRecord(db, later.operation.id),
          ).toMatchObject({
            phase: "queued",
            binding: { workerId: worker },
          });
        } finally {
          db.$client.close();
        }
      },
      fixtureRootKey,
      ["worker-a", "worker-b"],
    );
  });
  it("replays an attached operation as placed after the first send is refused, across reopen, while a pre-thread refusal stays not-created", async () => {
    await withAttach(
      async (harness) => {
        harness.deps.resolvePlacementSendScope = () => ({
          principal: "local",
          identity: "local-unverified",
          authority: "local-input-parity",
        });
        const request = independent("refused-after-attach");
        const id = await accept(harness, request);
        await harness.placement.wake(PROVIDER);
        const bound = state(harness, id);
        expect(bound.record.phase).toBe("queued");
        const threadId = bound.record.threadId!;
        const sent = await post(
          harness,
          `/threads/${threadId}/queued-messages/${bound.record.queuedMessageId}/send`,
          { mode: "auto" },
        );
        expect(sent.status, JSON.stringify(sent.body)).toBe(409);
        expect(sent.body.code).toBe("managed_execution_unsupported");
        const refused = state(harness, id);
        expect(refused.record.phase).toBe("refused");
        expect(refused.queue).toHaveLength(0);
        const requestId = refused.record.clientTurnRequestId;
        expect(requestId).not.toBeNull();

        const changes = (db: DbConnection) =>
          db.$client.prepare("select total_changes()").pluck().get();
        const before = changes(harness.db);
        const replay = await post(harness, "/placement/operations", request);
        expect(replay.status, JSON.stringify(replay.body)).toBe(200);
        expect(replay.body).toMatchObject({
          kind: "placed",
          operation: {
            id,
            phase: "refused",
            threadId,
            queueReceipt: { requestId },
          },
          thread: { id: threadId, status: "pending" },
        });
        await harness.placement.wake(PROVIDER);
        expect(changes(harness.db)).toBe(before);
        expect(state(harness, id).threads).toHaveLength(1);

        const path = join(harness.config.dataDir, "refused-reopen.sqlite");
        await harness.db.$client.backup(path);
        const db = createConnection(path);
        try {
          const { placement } = createApp({ ...harness.deps, db });
          const reopened = changes(db);
          const again = await placement.accept({ kind: "client" }, request);
          expect(again).toMatchObject({
            kind: "placed",
            operation: { id, phase: "refused", threadId },
            thread: { id: threadId },
          });
          expect(changes(db)).toBe(reopened);
          expect(db.select().from(threads).all()).toHaveLength(1);
          expect(db.select().from(placementOperations).all()).toHaveLength(1);
        } finally {
          db.$client.close();
        }

        const unsupported = independent("pre-thread-refusal", {
          pluginSubmission: { pluginId: "fixture-plugin", data: {} },
        });
        const preThread = await accept(harness, unsupported);
        await harness.placement.wake(PROVIDER);
        const preReplay = await post(
          harness,
          "/placement/operations",
          unsupported,
        );
        expect(preReplay.body).toMatchObject({
          kind: "refused",
          outcome: "not-created",
          operation: { id: preThread, threadId: null },
        });
      },
      fixtureRootKey,
      ["worker-a", "worker-b"],
    );
  });
});
