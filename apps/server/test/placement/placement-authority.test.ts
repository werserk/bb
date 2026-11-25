import { once } from "node:events";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import {
  createThread,
  environments,
  hosts,
  placementBindings,
  placementOperations,
  placementWorkers,
  queuedThreadMessages,
  readPlacementActionReceipt,
  threads,
  upsertProjectExecutionDefaults,
} from "@bb/db";
import { setOwnerMode } from "@bb/db/internal-placement-owner";
import {
  PERSONAL_PROJECT_ID,
  normalizeWorkspaceBinding,
  workspaceBindingRef,
  workspaceCapabilities,
  type PermissionMode,
  type WorkerObservation,
} from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
} from "../../src/services/placement/placement-service.js";
import { seedEnvironment, seedProjectWithSource } from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const PROVIDER = "claude-code";
const OWNER = "account-workers";
const CLIENT = "placement-client";
const RUN = "placement-authority";
const ENV = "env_placement";
const HOST = "host_workspace";
const ROOT = "/scratch/placement";
const SECRET = "private prompt body 9c1d";

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
    launchProfileId: null,
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
        input: [{ type: "text", text: SECRET, mentions: [] }],
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

function deferredPolicy() {
  let finish!: (decision: PlacementPolicyDecision) => void;
  let context!: Parameters<PlacementOwnerPolicy["evaluate"]>[0];
  const policy: PlacementOwnerPolicy = {
    evaluate: (received) => {
      context = received;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  };
  return {
    policy,
    finish: (decision: PlacementPolicyDecision) => finish(decision),
    context: () => context,
  };
}

function seedWorkspace(harness: TestAppHarness) {
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
}

function register(harness: TestAppHarness, policy: PlacementOwnerPolicy) {
  return harness.placement.registerOwner({
    providerId: PROVIDER,
    ownerPluginId: OWNER,
    policy,
  });
}

function setMode(
  harness: TestAppHarness,
  expectedRevision: number,
  mode: "managed" | "disabled",
) {
  const result = setOwnerMode(
    harness.db,
    {
      providerId: PROVIDER,
      ownerPluginId: OWNER,
      expectedRevision,
      mode,
      handoffReceiptId: null,
    },
    () => ({
      kind: "verified_empty",
      providerId: PROVIDER,
      ownerPluginId: OWNER,
      ownerRevision: expectedRevision,
    }),
  );
  if (result.kind !== "updated")
    throw new Error(`mode ${mode}: ${result.kind}`);
  return result.owner.revision;
}

function setDefaultPermission(
  harness: TestAppHarness,
  permissionMode: PermissionMode,
) {
  upsertProjectExecutionDefaults(harness.db, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: PROVIDER,
    model: "fixture-model",
    permissionMode,
    serviceTier: "default",
    reasoningLevel: "medium",
  });
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

function operationCount(harness: TestAppHarness) {
  return harness.db.select().from(placementOperations).all().length;
}

function withPlacement<T>(
  run: (harness: TestAppHarness) => Promise<T>,
  purpose = true,
) {
  return withTestHarness(
    purpose
      ? { placementPurpose: { kind: "local-fixture", fixtureRunId: RUN } }
      : {},
    async (harness) => {
      seedWorkspace(harness);
      return run(harness);
    },
  );
}

async function installPlugins(harness: TestAppHarness, names: string[]) {
  const root = await mkdtemp(join(tmpdir(), "placement-plugins-"));
  for (const name of names) {
    const dir = join(root, name);
    await mkdir(dir);
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: `bb-plugin-${name}`,
        version: "0.1.0",
        bb: {
          name,
          description: "Synthetic placement caller",
          branding: { icon: "Zap" },
          server: "./index.ts",
        },
      }),
    );
    await writeFile(
      join(dir, "index.ts"),
      "export default function plugin() {}",
    );
    expect((await harness.pluginService.installPath(dir)).status).toBe(
      "running",
    );
  }
}

async function withPluginSdk<T>(
  harness: TestAppHarness,
  names: string[],
  run: () => Promise<T>,
) {
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: harness.app.fetch,
  }) as Server;
  try {
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    harness.pluginService.bindSdk({ baseUrl: `http://127.0.0.1:${port}` });
    await installPlugins(harness, names);
    return await run();
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function placementSdk(harness: TestAppHarness, pluginId: string) {
  return harness.pluginService.getApi(pluginId)!.sdk.experimental_placement;
}

function managedThread(
  harness: TestAppHarness,
  projectId: string,
  environmentId: string,
) {
  return createThread(harness.db, harness.hub, {
    projectId,
    environmentId,
    providerId: PROVIDER,
    status: "idle",
    pluginMetadata: { pluginId: CLIENT, metadata: { role: "managed" } },
  });
}

function bindThread(
  harness: TestAppHarness,
  threadId: string,
  operationId: string,
) {
  const ref = workspaceBindingRef(workspace);
  harness.db
    .insert(placementBindings)
    .values({
      threadId,
      ownerPluginId: OWNER,
      providerId: PROVIDER,
      accountId: "account-a",
      workerId: "worker-a",
      agentHostId: "agent-host-a",
      generation: "gen-a",
      workspaceId: ref.workspaceBindingId,
      workspaceRevision: ref.revision,
      workspaceDigest: ref.workspaceDigest,
      boundFromOperationId: operationId,
      runtimeRootKey: "root",
      createdAt: 1,
    })
    .run();
}

function serviceRequest(key: string, threadId: string, senderThreadId: string) {
  const input = [
    { type: "text" as const, text: "synthetic service", mentions: [] },
  ];
  return {
    input,
    request: {
      schemaVersion: 1,
      submissionKey: key,
      intent: {
        kind: "continuation",
        threadId,
        request: {
          input,
          mode: "queue-if-active",
          senderThreadId,
          serviceTurn: {
            version: 1,
            visibility: "hidden",
            reason: "self-reminder",
            origin: { pluginId: CLIENT, senderThreadId },
          },
        },
      },
    } as PlacementRequestV1,
  };
}

describe("placement ingress authority", () => {
  it("serves a plugin through the real wrapped SDK with private drafts and a cancelled replay", async () => {
    await withPlacement(async (h) => {
      await withPluginSdk(h, [OWNER, CLIENT, "other-client"], async () => {
        const sdk = placementSdk(h, CLIENT);
        const owner = placementSdk(h, OWNER);
        const other = placementSdk(h, "other-client");
        setMode(h, register(h, freeWorkers).ownerRevision, "managed");
        const accepted = await sdk.accept(independent("same"));
        const args = { operationId: accepted.operation.id };
        const local = (
          await post(h, "/placement/operations", independent("same"))
        ).body.operation;
        expect(local.id).not.toBe(accepted.operation.id);
        expect(
          readPlacementActionReceipt(h.db, args.operationId)!.authority,
        ).toMatchObject({
          actor: "plugin",
          principal: `plugin:${CLIENT}`,
          plugin: CLIENT,
        });
        expect(
          readPlacementActionReceipt(h.db, local.id)!.authority,
        ).toMatchObject({
          actor: "local-unverified",
          principal: "local",
          plugin: null,
        });
        expect(JSON.stringify(await owner.get(args))).not.toContain(SECRET);
        for (const caller of [owner, other])
          for (const op of ["recoverDraft", "cancel"] as const)
            await expect(caller[op](args)).rejects.toMatchObject({
              status: 404,
            });
        await expect(other.get(args)).rejects.toMatchObject({ status: 404 });
        expect(
          (await post(h, `/placement/operations/${args.operationId}/cancel`))
            .status,
        ).toBe(404);
        const draftOverHttp = await h.app.request(
          `/api/v1/placement/operations/${args.operationId}/draft`,
        );
        expect(draftOverHttp.status).toBe(404);
        for (const op of ["get", "recoverDraft", "cancel"] as const)
          await expect(
            sdk[op]({ operationId: local.id }),
          ).rejects.toMatchObject({
            status: 404,
          });
        const draft = await sdk.recoverDraft(args);
        expect(JSON.stringify(draft.originalRequest)).toContain(SECRET);
        const cancelled = await sdk.cancel(args);
        expect(cancelled.phase).toBe("cancelled");
        await h.placement.wake(PROVIDER);
        expect(await sdk.accept(independent("same"))).toEqual({
          kind: "cancelled",
          operation: await sdk.get(args),
        });
        await h.pluginService.reload(CLIENT);
        await expect(sdk.get(args)).rejects.toMatchObject({ status: 403 });
        expect((await placementSdk(h, CLIENT).get(args)).id).toBe(
          args.operationId,
        );
      });
    });
  });

  it("applies the native service-turn scope to plugin continuations", async () => {
    await withPlacement(async (h) => {
      await withPluginSdk(h, [OWNER, CLIENT], async () => {
        setMode(h, register(h, freeWorkers).ownerRevision, "managed");
        const seedOp = async (key: string) =>
          (await post(h, "/placement/operations", independent(key))).body
            .operation.id;
        const target = managedThread(h, PERSONAL_PROJECT_ID, ENV);
        bindThread(h, target.id, await seedOp("seed-target"));
        const second = seedProjectWithSource(h.deps, { hostId: HOST }).project;
        const otherEnv = seedEnvironment(h.deps, {
          hostId: HOST,
          projectId: second.id,
        });
        const foreignSender = managedThread(h, second.id, otherEnv.id);
        const api = h.pluginService.getApi(CLIENT)!;
        const crossed = serviceRequest("crossed", target.id, foreignSender.id);
        await expect(
          api.experimental_threads.experimental_sendService({
            threadId: target.id,
            input: crossed.input,
            senderThreadId: foreignSender.id,
            reason: "self-reminder",
          }),
        ).rejects.toMatchObject({ status: 403 });
        const unmanaged = createThread(h.db, h.hub, {
          projectId: PERSONAL_PROJECT_ID,
          environmentId: ENV,
          providerId: PROVIDER,
          status: "idle",
        });
        bindThread(h, unmanaged.id, await seedOp("seed-unmanaged"));
        const before = operationCount(h);
        await expect(
          api.sdk.experimental_placement.accept(crossed.request),
        ).rejects.toMatchObject({
          status: 403,
        });
        expect(
          (await post(h, "/placement/operations", crossed.request)).status,
        ).toBe(403);
        const sender = managedThread(h, PERSONAL_PROJECT_ID, ENV);
        await expect(
          api.sdk.experimental_placement.accept(
            serviceRequest("unmanaged", unmanaged.id, sender.id).request,
          ),
        ).rejects.toMatchObject({ status: 403 });
        expect(operationCount(h)).toBe(before);
        const scoped = await api.sdk.experimental_placement.accept(
          serviceRequest("scoped", target.id, sender.id).request,
        );
        expect(
          readPlacementActionReceipt(h.db, scoped.operation.id)!.authority,
        ).toMatchObject({
          actor: "plugin",
          sender: sender.id,
          initiator: "agent",
          serviceTurn: {
            origin: { pluginId: CLIENT, senderThreadId: sender.id },
          },
        });
      });
    });
  });

  it("refuses unverified attribution with the native create errors and persists nothing", async () => {
    await withPlacement(async (h) => {
      setMode(h, register(h, freeWorkers).ownerRevision, "managed");
      const behalf = await post(
        h,
        "/placement/operations",
        independent("behalf", {
          startedOnBehalfOf: {
            initiator: "system",
            senderThreadId: "missing-thread",
          },
        }),
      );
      expect(behalf).toMatchObject({
        status: 400,
        body: { code: "invalid_request" },
      });
      const sender = await post(
        h,
        "/placement/operations",
        independent("sender", { senderThreadId: "missing-thread" }),
      );
      expect(sender).toMatchObject({
        status: 400,
        body: { code: "parent_thread_invalid" },
      });
      const foreignPlugin = await post(
        h,
        "/placement/operations",
        independent("plugin-origin", {
          origin: "plugin",
          originPluginId: OWNER,
        }),
      );
      expect(foreignPlugin.status).toBe(200);
      expect(
        readPlacementActionReceipt(h.db, foreignPlugin.body.operation.id)!
          .authority,
      ).toMatchObject({
        actor: "local-unverified",
        plugin: null,
        origin: "plugin",
      });
      expect(operationCount(h)).toBe(1);
      const live = createThread(h.db, h.hub, {
        projectId: PERSONAL_PROJECT_ID,
        environmentId: ENV,
        providerId: PROVIDER,
        status: "idle",
      });
      const attributed = await post(
        h,
        "/placement/operations",
        independent("live-sender", { senderThreadId: live.id }),
      );
      expect(
        readPlacementActionReceipt(h.db, attributed.body.operation.id)!
          .authority,
      ).toMatchObject({ sender: live.id, initiator: "user" });
    });
  });

  it("replays the exact receipt with its retained permission after defaults and mode change", async () => {
    await withPlacement(async (h) => {
      setDefaultPermission(h, "auto");
      const revision = setMode(
        h,
        register(h, freeWorkers).ownerRevision,
        "managed",
      );
      const first = await post(
        h,
        "/placement/operations",
        independent("replay"),
      );
      const id = first.body.operation.id;
      expect(readPlacementActionReceipt(h.db, id)!.authority.permission).toBe(
        "auto",
      );
      setDefaultPermission(h, "full");
      const afterDefaults = await post(
        h,
        "/placement/operations",
        independent("replay"),
      );
      expect(afterDefaults).toMatchObject({
        status: 200,
        body: { operation: { id } },
      });
      setMode(h, revision, "disabled");
      const afterDisable = await post(
        h,
        "/placement/operations",
        independent("replay"),
      );
      expect(afterDisable).toMatchObject({
        status: 200,
        body: { operation: { id } },
      });
      expect(readPlacementActionReceipt(h.db, id)!.authority.permission).toBe(
        "auto",
      );
      const changed = await post(
        h,
        "/placement/operations",
        independent("replay", { model: "other-model" }),
      );
      expect(changed).toMatchObject({
        status: 409,
        body: { code: "placement_submission_conflict" },
      });
      const fresh = await post(
        h,
        "/placement/operations",
        independent("fresh"),
      );
      expect(fresh).toMatchObject({
        status: 409,
        body: { code: "placement_refused" },
      });
      expect(operationCount(h)).toBe(1);
    });
  });

  it("prepares with at most the accepted permission when defaults loosen or tighten", async () => {
    await withPlacement(async (h) => {
      setDefaultPermission(h, "auto");
      const owner = register(h, freeWorkers);
      setMode(h, owner.ownerRevision, "managed");
      owner.dispose();
      const loosened = await post(
        h,
        "/placement/operations",
        independent("loosened"),
      );
      expect(loosened.body.operation).toMatchObject({
        phase: "pending",
        reason: "owner_unavailable",
      });
      setDefaultPermission(h, "full");
      const tightened = await post(
        h,
        "/placement/operations",
        independent("tightened"),
      );
      expect(
        readPlacementActionReceipt(h.db, tightened.body.operation.id)!.authority
          .permission,
      ).toBe("full");
      setDefaultPermission(h, "auto");
      register(h, freeWorkers);
      await h.placement.wake(PROVIDER);
      const draft = (id: string) =>
        h.placement.recoverDraft({ kind: "client" }, id);
      expect(draft(loosened.body.operation.id).preparedExecution).toMatchObject(
        {
          permissionMode: "auto",
        },
      );
      expect(
        draft(tightened.body.operation.id).preparedExecution,
      ).toMatchObject({
        permissionMode: "auto",
      });
    });
  });

  it("drops a decision from a disposed or replaced policy epoch", async () => {
    await withPlacement(async (h) => {
      const stale = deferredPolicy();
      const old = register(h, stale.policy);
      setMode(h, old.ownerRevision, "managed");
      const refused = (
        await post(h, "/placement/operations", independent("refuse-race"))
      ).body.operation;
      await vi.waitFor(() => expect(stale.context()).toBeDefined());
      old.dispose();
      register(h, freeWorkers);
      stale.finish({ kind: "refuse", reason: "capability_mismatch" });
      await h.placement.wake(PROVIDER);
      expect(h.placement.get({ kind: "client" }, refused.id)).toMatchObject({
        phase: "pending",
        reason: "all_busy",
      });
    });
    await withPlacement(async (h) => {
      const stale = deferredPolicy();
      const old = register(h, stale.policy);
      setMode(h, old.ownerRevision, "managed");
      await h.placement.observeWorkers({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        workers: [observation()],
      });
      const reserved = (
        await post(h, "/placement/operations", independent("reserve-race"))
      ).body.operation;
      await vi.waitFor(() => expect(stale.context()?.workers).toHaveLength(1));
      const epoch = stale.context().ownerRevision;
      old.dispose();
      const waiting = deferredPolicy();
      register(h, waiting.policy);
      const resumed = h.placement.wake(PROVIDER);
      stale.finish({
        kind: "candidates",
        ownerRevision: epoch,
        candidates: [
          { workerId: "worker-a", workerRevision: 1, routeEvidenceRevision: 1 },
        ],
      });
      await vi.waitFor(() => expect(waiting.context()).toBeDefined());
      expect(h.placement.get({ kind: "client" }, reserved.id)).toMatchObject({
        reason: null,
        binding: null,
      });
      expect(h.db.select().from(placementWorkers).get()).toMatchObject({
        slotState: "free",
      });
      waiting.finish({ kind: "wait", reason: "selected_busy" });
      await resumed;
      expect(h.placement.get({ kind: "client" }, reserved.id)).toMatchObject({
        phase: "pending",
        reason: "selected_busy",
      });
    });
  });

  it("marks waiting work owner_unavailable after disposal", async () => {
    await withPlacement(async (h) => {
      const owner = register(h, freeWorkers);
      setMode(h, owner.ownerRevision, "managed");
      const id = (
        await post(h, "/placement/operations", independent("waiting"))
      ).body.operation.id;
      await h.placement.wake(PROVIDER);
      expect(h.placement.get({ kind: "client" }, id)).toMatchObject({
        reason: "all_busy",
      });
      owner.dispose();
      await h.placement.wake(PROVIDER);
      expect(h.placement.get({ kind: "client" }, id)).toMatchObject({
        phase: "pending",
        reason: "owner_unavailable",
      });
    });
  });

  it("refuses an unsupported root per operation and keeps waking later work", async () => {
    await withPlacement(async (h) => {
      setMode(h, register(h, freeWorkers).ownerRevision, "managed");
      const windows = seedEnvironment(h.deps, {
        hostId: HOST,
        projectId: PERSONAL_PROJECT_ID,
        path: "C:\\work",
      });
      const unsupported = (
        await post(
          h,
          "/placement/operations",
          independent("windows", {
            environment: { type: "reuse", environmentId: windows.id },
          }),
        )
      ).body.operation;
      const later = (
        await post(h, "/placement/operations", independent("posix"))
      ).body.operation;
      await h.placement.wake(PROVIDER);
      await h.placement.wake(PROVIDER);
      expect(h.placement.get({ kind: "client" }, unsupported.id)).toMatchObject(
        {
          phase: "refused",
          reason: "unsupported_preparation",
        },
      );
      expect(h.placement.get({ kind: "client" }, later.id)).toMatchObject({
        phase: "pending",
        reason: "all_busy",
      });
    });
  });

  it("fails closed without a trusted workspace purpose", async () => {
    await withPlacement(async (h) => {
      setMode(h, register(h, freeWorkers).ownerRevision, "managed");
      await h.placement.observeWorkers({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        workers: [observation()],
      });
      const id = (
        await post(h, "/placement/operations", independent("no-purpose"))
      ).body.operation.id;
      await h.placement.wake(PROVIDER);
      expect(h.placement.get({ kind: "client" }, id)).toMatchObject({
        phase: "pending",
        reason: "unsupported_tool_route",
        binding: null,
      });
      expect(h.db.select().from(placementWorkers).get()).toMatchObject({
        slotState: "free",
      });
      expect(h.db.select().from(threads).all()).toHaveLength(0);
      expect(h.db.select().from(queuedThreadMessages).all()).toHaveLength(0);
    }, false);
  });

  it("refuses new work when the owner is disabled inside the accept transaction", async () => {
    await withPlacement(async (h) => {
      const revision = setMode(
        h,
        register(h, freeWorkers).ownerRevision,
        "managed",
      );
      const original = h.db.transaction.bind(h.db);
      vi.spyOn(h.db, "transaction").mockImplementationOnce((...args) => {
        setMode(h, revision, "disabled");
        return original(...args);
      });
      const result = await post(
        h,
        "/placement/operations",
        independent("interleaved"),
      );
      expect(result).toMatchObject({
        status: 409,
        body: { code: "placement_refused" },
      });
      expect(operationCount(h)).toBe(0);
    });
  });
});
