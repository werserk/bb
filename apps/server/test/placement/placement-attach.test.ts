import { eq } from "drizzle-orm";
import {
  createThread,
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
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
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

const identity = { workerId: "worker-a", generation: "gen-a" };

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
    qualification: {
      tier: "local-fixture",
      evidenceId: "fx",
      fixtureRunId: RUN,
    },
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
    launchProfileId: fixtureLaunchProfileId(identity),
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
      await registerManaged(harness);
      return run(harness);
    },
  );
}

async function registerManaged(harness: TestAppHarness) {
  const registration = harness.placement.registerOwner({
    providerId: PROVIDER,
    ownerPluginId: OWNER,
    policy: freeWorkers,
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
    () => ({
      ...scope,
      kind: "verified_empty",
      ownerRevision: registration.ownerRevision,
    }),
  );
  expect(mode.kind).toBe("updated");
  expect(
    await harness.placement.observeWorkers({
      ...scope,
      workers: [observation()],
    }),
  ).toBe("observed");
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
    await withAttach(async (harness) => {
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
      expect(JSON.parse(after.queue[0]!.waitingOn!)).toEqual({ kind: "time" });
      expect(
        resolvePendingThreadSessionOptions(harness.db, after.threads[0]!.id),
      ).toEqual({ fixtureOption: "chosen" });

      const unscheduled = await accept(harness, independent("unscheduled"));
      await harness.placement.wake(PROVIDER);
      expect(
        state(harness, unscheduled).queue.find(
          (row) => row.placementOperationId === unscheduled,
        ),
      ).toBeUndefined();
    });
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

  it("keeps the fence held without a thread when attach fails permanently", async () => {
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
      await harness.placement.wake(PROVIDER);
      const after = state(harness, id);
      expect(after.record.phase).toBe("reserved");
      expect(after.record.fence).not.toBeNull();
      expect(after.worker).toMatchObject({
        slotState: "reserved",
        ownerOperationId: id,
      });
      expect(after.threads.map((thread) => thread.id)).toEqual([parent.id]);
      expect(after.queue).toHaveLength(0);
    }, outage.resolver);
  });

  it("records cancel after attach without dispatching the bound input", async () => {
    await withAttach(async (harness) => {
      const id = await accept(harness, independent("cancel-after-attach"));
      await harness.placement.wake(PROVIDER);
      const bound = state(harness, id);
      expect(bound.record.phase).toBe("queued");

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
      expect(after.threads).toHaveLength(1);
      expect(after.threads[0]!.status).toBe("pending");
      expect(after.queue).toHaveLength(1);
      expect(after.queue[0]!.claimToken).toBeNull();
      expect(after.worker).toMatchObject({
        slotState: "reserved",
        ownerOperationId: id,
      });
    });
  });
});
