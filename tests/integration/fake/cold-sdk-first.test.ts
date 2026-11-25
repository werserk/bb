// The synthetic workspace, observations and native Send now scope follow the A2 dispatch fixture at 4dce8738.
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createNodeWebSocketConstructor } from "../../../apps/host-daemon/src/websocket-constructor.js";
import { openPinnedGuest } from "../../../apps/host-daemon/src/managed-guest/journal.js";
import { buildHostDaemonWebSocketProtocols } from "@bb/host-daemon-contract";
import { eq } from "drizzle-orm";
import { it, expect, vi } from "vitest";
import { createNodeBbSdk } from "@bb/sdk/node";
import {
  createConnection,
  afterCommit,
  hasStoredTerminalClientTurnRequestEvent,
  placementEffects,
  getThread,
  getStoredProviderSession,
  readPlacementWorker,
  environments,
  hosts,
  placementBindings,
  readPlacementOperationRecord,
  readPlacementActionReceipt,
  readPlacementDispatchReceipt,
  listEvents,
} from "@bb/db";
import { setOwnerMode } from "@bb/db/internal-placement-owner";
import {
  PERSONAL_PROJECT_ID,
  clientTurnRequestIdSchema,
  clientSubmissionQueueId,
  normalizeWorkspaceBinding,
  workspaceBindingRef,
  workspaceCapabilities,
  turnRequestEventDataSchema,
  type WorkerObservation,
} from "@bb/domain";
import type { PlacementRequestV1 } from "@bb/server-contract";
import type {
  PlacementOwnerPolicy,
  PlacementPolicyDecision,
} from "../../../apps/server/src/services/placement/placement-service.js";
import {
  fixtureLaunchProfileId,
  fixtureRootKey,
} from "../../../apps/server/test/placement/fixture-root.js";
import {
  startTestServer,
  createTestDb,
  createTestDaemonHostKey,
  type TestAppHarness,
} from "../../../apps/server/test/helpers/test-app.js";
import { settleUnconfirmedTurnStartInTransaction } from "../../../apps/server/src/services/threads/unconfirmed-turn-requests.js";
import { registerColdDispatchLab } from "../../../apps/server/src/services/threads/cold-dispatch-lab.js";
import { createColdFirstHandler } from "../helpers/cold-first-dispatch.js";
import {
  FixtureEnrollmentRegistry,
  startPendingLabGuest,
} from "../helpers/cold-pending-lab.js";
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
        : {
            kind: "candidates",
            ownerRevision: context.ownerRevision,
            candidates,
          };
    },
  };
}

function setupSend(harness: TestAppHarness) {
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
  const principals = new WeakMap<Request, string>();
  harness.deps.resolvePlacementSendScope = (req) => {
    const principal = principals.get(req);
    return principal
      ? {
          principal,
          identity: "local-unverified",
          authority: "local-input-parity",
        }
      : null;
  };
  const send = async (
    threadId: string,
    queueId: string,
    principal: string | null,
  ) => {
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
  return send;
}

async function registerManaged(
  harness: TestAppHarness,
  policy: PlacementOwnerPolicy,
) {
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

it.each([
  "accepted",
  "lost-ack",
  "retired-manifest",
  "replaced-socket",
  "no-sender",
  "retire-after-claim",
  "native-terminal-before-claim",
])("local SDK pending start: %s", async (mode) => {
  const registry = new FixtureEnrollmentRegistry();
  const scratch = await mkdtemp(join(tmpdir(), "cold-sdk-server-"));
  const dbFile = join(scratch, "server.sqlite");
  const template = createTestDb();
  try {
    await writeFile(dbFile, template.$client.serialize(), {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    template.$client.close();
  }
  const db = createConnection(dbFile);
  const server = await startTestServer({
    placementPurpose: purpose,
    placementRuntimeRootKey: registry.rootKey,
    fixtureDb: db,
  });
  let running = true;
  const cleanup: (() => Promise<void>)[] = [];
  try {
    const send = setupSend(server);
    const worker = observation();
    const binding = {
      ownerPluginId: OWNER,
      providerId: PROVIDER,
      accountId: worker.accountId,
      agentHostId: worker.agentHostId,
      workerId: worker.workerId,
      generation: worker.generation,
      workspace: workspaceBindingRef(workspace),
    };
    const lab = await startPendingLabGuest(
      server,
      registry,
      {
        binding,
        runtimeRootKey: fixtureRootKey(binding),
        launchProfileId: fixtureLaunchProfileId(binding),
      },
      1,
      mode === "lost-ack",
    );
    cleanup.push(() => lab.close());
    const reports: { commandId: string; guestSessionId: string }[] = [];
    if (mode !== "no-sender") {
      const remove = registerColdDispatchLab(
        db,
        RUN,
        createColdFirstHandler(db, server.hub, lab.channel, (r) =>
          reports.push(r),
        ),
      );
      cleanup.push(async () => {
        remove();
      });
    }
    await registerManaged(server, freeWorkers());
    const sdk = createNodeBbSdk({ baseUrl: server.baseUrl });
    const { operation } = await sdk.experimental_placement.accept(
      request("cold-sdk", "original local SDK input"),
    );
    await server.placement.wake(PROVIDER);
    const op = readPlacementOperationRecord(db, operation.id)!;
    const action = readPlacementActionReceipt(db, op.id)!;
    expect(action.authority).toMatchObject({
      actor: "local-unverified",
      principal: "local",
    });
    const threadId = op.threadId!;
    const qid = clientSubmissionQueueId(action.submissionUuid!);
    expect(getThread(db, threadId)?.status).toBe("pending");
    expect(getStoredProviderSession(db, threadId).kind).toBe("none");
    expect(readPlacementWorker(db, OWNER, worker.workerId)?.slotState).toBe(
      "reserved",
    );
    expect(
      db
        .select()
        .from(placementBindings)
        .where(eq(placementBindings.threadId, threadId))
        .get()?.runtimeRootKey,
    ).toBe(registry.rootKey(binding));
    let terminalRequest: string | null = null;
    if (mode === "native-terminal-before-claim") {
      const read = registry.read.bind(registry);
      vi.spyOn(registry, "read").mockImplementation((identity) => {
        const candidate = read(identity);
        if (candidate && !terminalRequest && !db.$client.inTransaction) {
          const effect = db
            .select()
            .from(placementEffects)
            .where(eq(placementEffects.thread, threadId))
            .get();
          if (effect?.state === "prepared" && effect.commandId) {
            const key = {
              threadId,
              requestId: clientTurnRequestIdSchema.parse(effect.request),
            };
            const other = createConnection(dbFile);
            try {
              other.transaction(
                (tx) => settleUnconfirmedTurnStartInTransaction(tx, key),
                { behavior: "immediate" },
              );
            } finally {
              other.$client.close();
            }
            expect(hasStoredTerminalClientTurnRequestEvent(db, key)).toBe(true);
            terminalRequest = key.requestId;
          }
        }
        return candidate;
      });
    }
    let retiredAfterWin = false;
    if (mode === "retire-after-claim") {
      const read = registry.read.bind(registry);
      vi.spyOn(registry, "read").mockImplementation((identity) => {
        const live = read(identity);
        // Inside the final writer the exact command has been prepared. Retire the
        // registration policy from its after-commit hook, before the sender resumes.
        if (
          live &&
          db.$client.inTransaction &&
          db
            .select()
            .from(placementEffects)
            .where(eq(placementEffects.thread, threadId))
            .get()?.commandId
        ) {
          afterCommit(db, () => {
            registry.replace(null);
            retiredAfterWin = true;
          });
        }
        return live;
      });
    }
    let replacementStarts = 0;
    if (mode === "retired-manifest") registry.replace(null);
    if (mode === "replaced-socket") {
      const hostId = binding.agentHostId;
      const url = new URL("/internal/ws", server.baseUrl);
      url.protocol = "ws:";
      url.searchParams.set("sessionId", lab.sessionId);
      const Socket = createNodeWebSocketConstructor({
        authorization: "Bearer " + createTestDaemonHostKey({ hostId }),
      });
      const other = new Socket(url, buildHostDaemonWebSocketProtocols());
      other.on("message", (bytes) => {
        const raw = JSON.parse(String(bytes));
        if (raw.type !== "host-rpc.request") return;
        if (raw.command.type === "managed.thread.start") replacementStarts++;
        if (raw.command.type === "managed.lab.qualify")
          other.send(
            JSON.stringify({
              type: "host-rpc.response",
              requestId: raw.requestId,
              ok: true,
              commandType: raw.command.type,
              result: { signature: lab.guest.previousPublicProof() },
            }),
          );
      });
      await once(other, "open");
      cleanup.push(async () => {
        if (other.readyState !== 3) {
          const done = once(other, "close");
          other.close();
          await done;
        }
      });
      expect(await lab.channel.qualify(binding)).toBe(false);
    }
    const initial = await send(threadId, qid, action.authority.principal);
    const replay = await send(threadId, qid, action.authority.principal);
    if (mode === "accepted" || mode === "lost-ack")
      console.info(
        mode + " public responses " + JSON.stringify({ initial, replay }),
      );
    const timeline = listEvents(db, { threadId });
    const native = timeline.find((e) => e.type === "client/turn/requested")!;
    expect(
      timeline.filter((e) => e.type === "client/turn/requested"),
    ).toHaveLength(1);
    const body = turnRequestEventDataSchema.parse(JSON.parse(native.data));
    expect(body).toMatchObject({
      source: "spawn",
      target: { kind: "thread-start" },
      request: { method: "thread/start" },
      input: [{ type: "text", text: "original local SDK input" }],
    });
    const key = { threadId, requestId: body.requestId };
    const r = readPlacementDispatchReceipt(db, key)!;
    expect(r).toMatchObject({
      eventId: native.id,
      executionOwnerOperationId: op.id,
      members: [{ op: op.id, queueId: qid }],
    });
    expect(getStoredProviderSession(db, threadId).kind).toBe("none");
    expect(getThread(db, threadId)?.status).toBe("pending");
    expect(initial.status).toBe(409);
    expect(replay.status).toBe(409);
    expect(replay).toEqual(initial);
    if (mode === "native-terminal-before-claim") {
      expect(terminalRequest).toBe(key.requestId);
      expect(r.commandId).toBeTruthy();
      expect(r.nativeExecutionId).toBe(r.commandId);
      const observed = {
        receipt: r.state,
        frames: lab.guest.starts(),
        creates: lab.ids.length,
      };
      console.info(
        "second writer committed native rejection after prepare",
        observed,
      );
      expect(observed).toEqual({ receipt: "prepared", frames: 0, creates: 0 });
      expect(replay.body.details).toMatchObject({ state: "prepared" });
      expect(lab.guest.journal.createdSession(r.commandId!)).toBeNull();
      return;
    }
    if (mode === "retire-after-claim") {
      expect(retiredAfterWin).toBe(true);
      expect(r.state).toBe("possibly_sent");
      expect(replay.body.details).toMatchObject({ state: "possibly_sent" });
      // Ordered round trip on the original socket confirms the receive boundary.
      const barrier = await server.hub.requestHostOnlineRpc({
        hostId: binding.agentHostId,
        expectedConnection: server.hub.captureDaemonConnection(
          binding.agentHostId,
        )!,
        timeoutMs: 2000,
        message: {
          type: "host-rpc.request",
          requestId: crypto.randomUUID(),
          command: {
            type: "managed.lab.qualify",
            challenge: {
              domain: "bb.synthetic-cold-create.271",
              hostId: binding.agentHostId,
              sessionId: lab.sessionId,
              manifestDigest: lab.fixture.pin.descriptorDigest,
              nonce: crypto.randomUUID(),
              registrationNonce: crypto.randomUUID(),
            },
          },
        },
      });
      expect(barrier.ok).toBe(true);
      expect(lab.guest.starts()).toBe(0);
      expect(lab.ids).toEqual([]);
      console.info(
        "real first CAS won; manifest retired on commit; starts=0 creates=0 state=possibly_sent",
      );
      return;
    }
    if (mode !== "accepted" && mode !== "lost-ack") {
      expect(initial.body.code).toBe("managed_execution_unsupported");
      expect(replay).toEqual(initial);
      expect(r).toMatchObject({ state: "refused_unsent", commandId: null });
      expect({
        original: lab.guest.starts(),
        replacementStarts,
        creates: lab.ids.length,
      }).toEqual({ original: 0, replacementStarts: 0, creates: 0 });
      console.info(
        mode +
          " native first request=1 state=refused_unsent starts=0 creates=0",
      );
      return;
    }
    expect(r).toMatchObject({
      state: "possibly_sent",
      commandId: expect.stringMatching(/^rpc_/),
      agentSessionId: lab.sessionId,
    });
    expect(r.commandId).toBe(r.nativeExecutionId);
    expect(r.commandId).not.toBe(key.requestId);
    expect(lab.guest.starts()).toBe(1);
    expect(lab.ids).toHaveLength(1);
    const commandId = r.commandId!,
      localId = lab.ids[0]!;
    expect(lab.guest.journal.createdSession(commandId)).toBe(localId);
    expect(reports.map((x) => [x.commandId, x.guestSessionId])).toEqual(
      mode === "lost-ack" ? [] : [[commandId, localId]],
    );
    expect(replay.body.details).toMatchObject({
      state: "possibly_sent",
      requested: { requestId: key.requestId },
    });
    await lab.disconnect();
    await server.close();
    running = false;
    db.$client.close();
    const reopened = createConnection(dbFile);
    const offline = await startTestServer({
      placementPurpose: purpose,
      placementRuntimeRootKey: registry.rootKey,
      fixtureDb: reopened,
    });
    try {
      // Recover only by the scoped original qsub. No guest or sender is registered on this server.
      const req = new Request(
        "http://localhost/api/v1/threads/" +
          threadId +
          "/queued-messages/" +
          qid +
          "/send",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );
      offline.deps.resolvePlacementSendScope = (r) =>
        r === req
          ? {
              identity: "local-unverified",
              authority: "local-input-parity",
              principal: action.authority.principal,
            }
          : null;
      const response = await offline.app.fetch(req);
      expect({ status: response.status, body: await response.json() }).toEqual(
        replay,
      );
      expect(readPlacementDispatchReceipt(reopened, key)?.state).toBe(
        "possibly_sent",
      );
      const observer = await openPinnedGuest(
        lab.fixture.root,
        lab.fixture.pin,
        {
          hostId: binding.agentHostId,
          sessionId: lab.sessionId,
          protocolVersion: 271,
        },
        {
          inspectEmpty: () => null,
          createSyntheticSession() {
            throw Error("Unexpected restart create");
          },
        },
      );
      if (observer.kind !== "protected")
        throw Error("Missing receiver journal");
      try {
        expect(observer.journal.createdSession(commandId)).toBe(localId);
      } finally {
        observer.journal.close();
      }
      expect(lab.ids).toHaveLength(1);
      console.info(
        mode +
          " local Node SDK: native=1 frame=1 create=1 guest=applied reports=" +
          reports.length +
          " reopened=possibly_sent replayFrames=0",
      );
    } finally {
      await offline.close();
      reopened.$client.close();
    }
  } finally {
    for (const close of cleanup.reverse()) await close();
    if (running) {
      await server.close();
      db.$client.close();
    }
    await rm(scratch, { recursive: true, force: true });
  }
});
