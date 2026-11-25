import { eq } from "drizzle-orm";
import {
  environments,
  hosts,
  placementOperations,
  placementOwners,
  queuedThreadMessages,
  threads,
} from "@bb/db";
import {
  PERSONAL_PROJECT_ID,
  normalizeWorkspaceBinding,
  workspaceBindingRef,
  workspaceCapabilities,
  type WorkerObservation,
} from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import { describe, expect, it, vi } from "vitest";
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
} from "../../src/services/placement/placement-service.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { fixtureRootKey } from "./fixture-root.js";

const PROVIDER = "claude-code";
const OWNER = "account-workers";
const RUN = "placement-ingress";
const ENV = "env_placement";
const HOST = "host_workspace";
const ROOT = "/scratch/placement";
const SECRET_PROMPT = "private prompt body 7f3a";

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

function observation(revision = 1): WorkerObservation {
  return {
    workerId: "worker-a",
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
      revision,
      status: "free",
      workerId: "worker-a",
      agentHostId: "agent-host-a",
      generation: "gen-a",
      holder: null,
      lock: { device: "1", inode: "2" },
    },
    exclusion: { authorityPluginId: OWNER, revision, status: "excluded" },
    quota: { revision, freshness: "unknown", block: null },
    routes: [
      {
        revision,
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

function request(
  key: string,
  text = SECRET_PROMPT,
  environment: object = { type: "reuse", environmentId: ENV },
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
        input: [{ type: "text", text, mentions: [] }],
        environment,
        startedOnBehalfOf: null,
        originKind: null,
      },
    },
  } as PlacementRequestV1;
}

const policy: PlacementOwnerPolicy = {
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

function seedWorkspace(harness: TestAppHarness) {
  harness.db
    .insert(hosts)
    .values({
      id: HOST,
      name: "Physical workspace",
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

function fixtureManagedOwnerMode(harness: TestAppHarness) {
  harness.db
    .update(placementOwners)
    .set({ mode: "managed" })
    .where(eq(placementOwners.providerId, PROVIDER))
    .run();
}

async function post(
  harness: TestAppHarness,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await harness.app.request(`/api/v1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, text: await response.text() };
}

async function get(
  harness: TestAppHarness,
  path: string,
  headers: Record<string, string> = {},
) {
  const response = await harness.app.request(`/api/v1${path}`, { headers });
  return { status: response.status, text: await response.text() };
}

function sideEffectCounts(harness: TestAppHarness) {
  return {
    threads: harness.db.select().from(threads).all().length,
    queued: harness.db.select().from(queuedThreadMessages).all().length,
    environment: harness.db
      .select()
      .from(environments)
      .where(eq(environments.id, ENV))
      .get(),
  };
}

const fixturePurpose = { kind: "local-fixture" as const, fixtureRunId: RUN };

async function withPlacement<T>(run: (harness: TestAppHarness) => Promise<T>) {
  return withTestHarness(
    {
      placementPurpose: fixturePurpose,
      placementRuntimeRootKey: fixtureRootKey,
    },
    async (harness) => {
      seedWorkspace(harness);
      return run(harness);
    },
  );
}

describe("placement ingress", () => {
  it("refuses an unmanaged provider before acceptance and persists nothing", async () => {
    await withPlacement(async (harness) => {
      const before = sideEffectCounts(harness);
      const response = await post(
        harness,
        "/placement/operations",
        request("k1"),
      );
      expect(response.status).toBe(409);
      expect(JSON.parse(response.text)).toMatchObject({
        code: "placement_refused",
        details: { reason: "owner_unavailable", created: false },
      });
      expect(harness.db.select().from(placementOperations).all()).toEqual([]);
      expect(sideEffectCounts(harness)).toEqual(before);
    });
  });

  it("returns one receipt for an identical submission and a payload-free conflict for changed bytes", async () => {
    await withPlacement(async (harness) => {
      harness.placement.registerOwner({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        policy,
      });
      fixtureManagedOwnerMode(harness);
      const first = await post(harness, "/placement/operations", request("k1"));
      const second = await post(
        harness,
        "/placement/operations",
        request("k1"),
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const a = JSON.parse(first.text);
      const b = JSON.parse(second.text);
      expect(a.kind).toBe("pending");
      expect(b.operation.id).toBe(a.operation.id);
      expect(b.operation.acceptedSeq).toBe(a.operation.acceptedSeq);
      expect(b.operation.payloadDigest).toBe(a.operation.payloadDigest);
      expect(first.text).not.toContain(SECRET_PROMPT);

      const changed = await post(
        harness,
        "/placement/operations",
        request("k1", "different bytes"),
      );
      expect(changed.status).toBe(409);
      expect(JSON.parse(changed.text).code).toBe(
        "placement_submission_conflict",
      );
      expect(changed.text).not.toContain(SECRET_PROMPT);
      expect(changed.text).not.toContain(a.operation.id);
      expect(harness.db.select().from(placementOperations).all()).toHaveLength(
        1,
      );
    });
  });

  it("records explicit waiting without thread, queue or Workspace side effects", async () => {
    await withPlacement(async (harness) => {
      const owner = harness.placement.registerOwner({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        policy,
      });
      fixtureManagedOwnerMode(harness);
      const before = sideEffectCounts(harness);

      const noWorker = JSON.parse(
        (await post(harness, "/placement/operations", request("wait"))).text,
      );
      await harness.placement.wake(PROVIDER);
      const waiting = JSON.parse(
        (await get(harness, `/placement/operations/${noWorker.operation.id}`))
          .text,
      );
      expect(waiting).toMatchObject({
        phase: "pending",
        reason: "all_busy",
        threadId: null,
        binding: null,
        queueReceipt: null,
      });

      const fresh = JSON.parse(
        (
          await post(
            harness,
            "/placement/operations",
            request("fresh", "x", {
              type: "host",
              hostId: HOST,
              workspace: { type: "personal" },
            }),
          )
        ).text,
      );
      await harness.placement.wake(PROVIDER);
      const refusedReplay = JSON.parse(
        (
          await post(
            harness,
            "/placement/operations",
            request("fresh", "x", {
              type: "host",
              hostId: HOST,
              workspace: { type: "personal" },
            }),
          )
        ).text,
      );
      expect(refusedReplay).toMatchObject({
        kind: "refused",
        outcome: "not-created",
        operation: {
          id: fresh.operation.id,
          phase: "refused",
          reason: "unsupported_preparation",
        },
      });

      owner.dispose();
      const unavailable = JSON.parse(
        (await post(harness, "/placement/operations", request("offline"))).text,
      );
      expect(unavailable.operation).toMatchObject({
        phase: "pending",
        reason: "owner_unavailable",
      });
      expect(sideEffectCounts(harness)).toEqual(before);
    });
  });

  it("reserves the sole fake worker through normal wake, queues it once and keeps later work waiting", async () => {
    await withPlacement(async (harness) => {
      const owner = harness.placement.registerOwner({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        policy,
      });
      fixtureManagedOwnerMode(harness);
      expect(
        await harness.placement.observeWorkers({
          providerId: PROVIDER,
          ownerPluginId: OWNER,
          workers: [observation()],
        }),
      ).toBe("observed");
      const before = sideEffectCounts(harness);
      const first = JSON.parse(
        (await post(harness, "/placement/operations", request("seq1"))).text,
      );
      const second = JSON.parse(
        (await post(harness, "/placement/operations", request("seq2", "next")))
          .text,
      );
      await harness.placement.wake(PROVIDER);
      const reserved = JSON.parse(
        (await get(harness, `/placement/operations/${first.operation.id}`))
          .text,
      );
      expect(reserved).toMatchObject({
        phase: "queued",
        reason: null,
        threadId: expect.any(String),
        binding: {
          ownerPluginId: OWNER,
          providerId: PROVIDER,
          accountId: "account-a",
          workerId: "worker-a",
          agentHostId: "agent-host-a",
          generation: "gen-a",
          workspace: workspaceBindingRef(workspace),
        },
      });
      const later = JSON.parse(
        (await get(harness, `/placement/operations/${second.operation.id}`))
          .text,
      );
      expect(later).toMatchObject({ phase: "pending", binding: null });
      expect(["all_busy", "selected_busy"]).toContain(later.reason);
      expect(second.operation.acceptedSeq).toBeGreaterThan(
        first.operation.acceptedSeq,
      );
      expect(sideEffectCounts(harness)).toEqual({
        ...before,
        threads: before.threads + 1,
        queued: before.queued + 1,
      });
      expect(owner.ownerRevision).toBeGreaterThan(0);
    });
  });

  it("recovers a draft only for the accepting principal and refuses unknown plugin tokens", async () => {
    await withPlacement(async (harness) => {
      harness.placement.registerOwner({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        policy,
      });
      fixtureManagedOwnerMode(harness);
      const submitted = request("draft");
      const accepted = JSON.parse(
        (await post(harness, "/placement/operations", submitted)).text,
      );
      const id = accepted.operation.id;

      const own = await get(harness, `/placement/operations/${id}/draft`);
      expect(own.status).toBe(200);
      const draft = JSON.parse(own.text);
      expect(draft.originalRequest.submissionKey).toBe("draft");
      expect(draft.originalRequest.intent.request.input[0].text).toBe(
        SECRET_PROMPT,
      );

      const forged = await get(harness, `/placement/operations/${id}/draft`, {
        "x-bb-plugin-caller": "not-a-live-token",
      });
      expect(forged.status).toBe(403);
      expect(forged.text).not.toContain(SECRET_PROMPT);

      const plugin = { kind: "plugin" as const, pluginId: "other-plugin" };
      expect(() => harness.placement.recoverDraft(plugin, id)).toThrow(
        /not found/i,
      );
      expect(() => harness.placement.cancel(plugin, id)).toThrow(/not found/i);
      expect(() => harness.placement.get(plugin, id)).toThrow(/not found/i);
      const ownerPlugin = { kind: "plugin" as const, pluginId: OWNER };
      expect(harness.placement.get(ownerPlugin, id).id).toBe(id);
      expect(() => harness.placement.recoverDraft(ownerPlugin, id)).toThrow(
        /not found/i,
      );

      const missing = await get(
        harness,
        `/placement/operations/plc_missing/draft`,
      );
      expect(missing.status).toBe(404);
      expect(JSON.parse(missing.text).code).toBe("placement_not_found");

      const cancelled = await post(
        harness,
        `/placement/operations/${id}/cancel`,
      );
      expect(cancelled.status).toBe(200);
      expect(JSON.parse(cancelled.text)).toMatchObject({
        id,
        cancelRequested: true,
        phase: "cancelled",
      });
    });
  });

  it("keeps plugin and local drafts in separate principal scopes over HTTP", async () => {
    await withPlacement(async (harness) => {
      harness.placement.registerOwner({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        policy,
      });
      fixtureManagedOwnerMode(harness);
      const pluginHeaders = { "x-bb-plugin-caller": "fixture" };
      const resolve = vi
        .spyOn(harness.pluginService, "resolveRpcCaller")
        .mockImplementation((token) =>
          token === "fixture"
            ? { ok: true, caller: { kind: "plugin", pluginId: "mine" } }
            : token === undefined
              ? { ok: true, caller: { kind: "client" } }
              : { ok: false },
        );
      const local = JSON.parse(
        (await post(harness, "/placement/operations", request("same-key")))
          .text,
      );
      const plugin = JSON.parse(
        (
          await post(
            harness,
            "/placement/operations",
            request("same-key", "plugin body"),
            pluginHeaders,
          )
        ).text,
      );
      expect(plugin.operation.id).not.toBe(local.operation.id);
      expect(resolve).toHaveBeenCalledWith("fixture");
      const foreign = await get(
        harness,
        `/placement/operations/${local.operation.id}/draft`,
        pluginHeaders,
      );
      expect(foreign.status).toBe(404);
      expect(foreign.text).not.toContain(SECRET_PROMPT);
      const ownDraft = await get(
        harness,
        `/placement/operations/${plugin.operation.id}/draft`,
        pluginHeaders,
      );
      expect(
        JSON.parse(ownDraft.text).originalRequest.intent.request.input[0].text,
      ).toBe("plugin body");
      const localView = await get(
        harness,
        `/placement/operations/${plugin.operation.id}/draft`,
      );
      expect(localView.status).toBe(404);
      expect(localView.text).not.toContain("plugin body");
    });
  });

  it("does not let a plugin caller claim another plugin's origin", async () => {
    await withPlacement(async (harness) => {
      harness.placement.registerOwner({
        providerId: PROVIDER,
        ownerPluginId: OWNER,
        policy,
      });
      fixtureManagedOwnerMode(harness);
      const base = request("spoof");
      const spoofed = {
        ...base,
        intent: {
          ...base.intent,
          request: {
            ...(base.intent.kind === "independent" ? base.intent.request : {}),
            origin: "plugin",
            originPluginId: "someone-else",
          },
        },
      } as PlacementRequestV1;
      await expect(
        harness.placement.accept({ kind: "plugin", pluginId: "mine" }, spoofed),
      ).rejects.toThrow(/another plugin/);
      expect(harness.db.select().from(placementOperations).all()).toEqual([]);
    });
  });
});
