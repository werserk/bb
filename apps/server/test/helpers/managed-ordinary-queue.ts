import { eq } from "drizzle-orm";
import {
  acceptPlacementOperation,
  attachPlacementThread,
  createQueuedThreadMessageInTransaction,
  observePlacementWorkers,
  placementOwners,
  preparePlacementOperation,
  recordPlacementQueueReceipt,
  registerPlacementOwner,
  reservePlacementWorker,
  setQueuedThreadMessageGroupBoundary,
  threads,
} from "@bb/db";
import {
  clientSubmissionQueueId,
  flattenPromptInputGroups,
  workspaceBindingRef,
  type WorkspaceBinding,
} from "@bb/domain";
import { expect } from "vitest";
import { textInput } from "./prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThreadRuntimeState,
} from "./seed.js";
import type { TestAppHarness } from "./test-app.js";

export const purpose = {
  kind: "local-fixture",
  fixtureRunId: "managed-queue-test",
} as const;
const providerId = "claude-code";
export const ownerPluginId = "account-workers";
const execution = {
  model: "fixture-model",
  reasoningLevel: "high",
  permissionMode: "auto",
  serviceTier: "default",
  source: "client/turn/requested",
} as const;
const authority = {
  principal: "local",
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

export function seedManagedGroup(
  h: TestAppHarness,
  options: {
    secondPrincipal?: string;
    third?: boolean;
    intervening?: "compatible" | "incompatible";
    singleWorker?: boolean;
    firstInputShape?: "flat" | "grouped";
  } = {},
) {
  const { db, deps } = h;
  const { secondPrincipal = "local", third = false, intervening } = options;
  deps.placementWorkspacePurpose = purpose;
  const principals = new WeakMap<Request, string>();
  deps.resolvePlacementSendScope = (request) => {
    const principal = principals.get(request);
    return principal
      ? {
          principal,
          identity: "local-unverified",
          authority: "local-input-parity",
        }
      : null;
  };
  const workerId = "worker";
  const secondWorker = "second-worker";
  const observations = (
    intervening && !options.singleWorker ? [workerId, secondWorker] : [workerId]
  ).map((id, i) => ({
    id,
    agent: seedHostSession(deps, { id: "agent-vm-" + i }),
  }));
  const physical = seedHostSession(deps, { id: "workspace-pc2" });
  const { project } = seedProjectWithSource(deps, {
    hostId: physical.host.id,
    path: "/project",
  });
  const env = seedEnvironment(deps, {
    hostId: physical.host.id,
    projectId: project.id,
    path: "/project",
  });
  const workspace: WorkspaceBinding = {
    schemaVersion: 1,
    workspaceBindingId: "ws",
    revision: 1,
    hostId: physical.host.id,
    environmentId: env.id,
    projectId: project.id,
    sourceId: null,
    pathFlavor: "posix",
    canonicalRoot: "/project",
    adapter: { id: "bb-mcp-workspace", version: "1" },
    requiredCapabilities: ["text.read"],
  };
  registerPlacementOwner(db, { providerId, ownerPluginId });
  db.update(placementOwners)
    .set({ mode: "managed" })
    .where(eq(placementOwners.providerId, providerId))
    .run();
  observePlacementWorkers(db, {
    providerId,
    ownerPluginId,
    expectedOwnerRevision: 1,
    workers: observations.map(({ id: workerId, agent }) => ({
      workerId,
      providerId,
      accountId: "account-" + workerId,
      agentHostId: agent.host.id,
      generation: "g1",
      providerVersion: "fixture",
      revision: 1,
      admission: "enabled",
      connected: true,
      auth: "authenticated",
      qualification: {
        tier: "local-fixture",
        evidenceId: "proof",
        fixtureRunId: purpose.fixtureRunId,
      },
      custody: {
        revision: 1,
        status: "free",
        workerId,
        agentHostId: agent.host.id,
        generation: "g1",
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
            hostId: agent.host.id,
            generation: "g1",
            providerVersion: "fixture",
          },
          tier: "local-fixture",
          evidenceId: "proof",
          fixtureRunId: purpose.fixtureRunId,
          connected: true,
          rootVerified: true,
          capabilities: { "text.read": "checked" },
        },
      ],
      launchProfileId: "fixture",
    })),
  });
  function prepare(key: string, threadId?: string) {
    const clientSubmissionId = crypto.randomUUID();
    const groups =
      key === "first" && options.firstInputShape
        ? [textInput("left"), textInput("right")]
        : undefined;
    const request = {
      input: groups ? flattenPromptInputGroups(groups) : textInput(key),
      ...(groups && options.firstInputShape === "grouped"
        ? { inputGroups: groups }
        : {}),
      clientSubmissionId,
    };
    const principal = key === "second" ? secondPrincipal : authority.principal;
    const accepted = acceptPlacementOperation(db, {
      principalScope: principal,
      authority: { ...authority, principal },
      submissionKey: key,
      ownerPluginId,
      providerId,
      request: {
        schemaVersion: 1,
        intent: threadId
          ? { kind: "continuation", threadId, request }
          : {
              kind: "independent",
              selection:
                key === "intervening" && intervening === "incompatible"
                  ? { mode: "worker", workerId: secondWorker }
                  : { mode: "auto" },
              request,
            },
      },
    });
    if (accepted.kind !== "accepted")
      throw new Error("Fixture acceptance failed");
    const op = preparePlacementOperation(db, {
      operationId: accepted.operation.id,
      expectedRevision: accepted.operation.revision,
      workspace,
      preparedRequest: request,
      preparedExecution: execution,
      attachmentReceipts: [],
    });
    if (op.kind !== "prepared") throw new Error("Fixture preparation failed");
    return {
      id: op.operation.id,
      revision: op.operation.revision,
      clientSubmissionId,
      input: request.input,
    };
  }
  function attach(resident: ReturnType<typeof prepare>, workerId: string) {
    const allocation = reservePlacementWorker(db, {
      operationId: resident.id,
      expectedRevision: resident.revision,
      ownerRevision: 1,
      workerId,
      workerRevision: 1,
      routeEvidenceRevision: 1,
      purpose,
    });
    if (allocation.kind !== "reserved")
      throw new Error("Fixture reservation failed");
    const attached = db.transaction((tx) =>
      attachPlacementThread(tx, {
        operationId: resident.id,
        fence: allocation.fence,
        runtimeRootKey: "test",
        sourceProviderThreadId: null,
        sourceCheckpoint: null,
        insertThread: (t, id) => {
          t.insert(threads)
            .values({
              id,
              projectId: project.id,
              environmentId: env.id,
              providerId,
              status: "idle",
              latestAttentionAt: 1,
              createdAt: 1,
              updatedAt: 1,
            })
            .run();
        },
        onCommitted: () => {},
      }),
    );
    if (attached.kind !== "attached" || !attached.operation.threadId)
      throw new Error("Fixture attachment failed");
    const threadId = attached.operation.threadId;
    seedThreadRuntimeState(deps, {
      threadId,
      environmentId: env.id,
      providerThreadId: "guest-session-" + workerId,
      model: execution.model,
      permissionMode: execution.permissionMode,
      reasoningLevel: execution.reasoningLevel,
    });
    return { threadId, fence: allocation.fence };
  }
  function queueMember(
    member: ReturnType<typeof prepare>,
    threadId: string,
    fence: number,
  ) {
    const id = clientSubmissionQueueId(member.clientSubmissionId);
    const receipt = db.transaction((tx) =>
      recordPlacementQueueReceipt(tx, {
        operationId: member.id,
        fence,
        queuedMessageId: id,
        onCommitted: () => {},
        insertQueue: (t, identity) => {
          createQueuedThreadMessageInTransaction(t, {
            placement: identity,
            clientSubmissionId: member.clientSubmissionId,
            threadId,
            content: member.input,
            ...execution,
            waitingOn: null,
            sendAt: null,
            payload: { kind: "inline" },
            systemNotice: null,
          });
        },
      }),
    );
    expect(receipt.kind).toBe("recorded");
    return id;
  }
  const resident = prepare("resident");
  const { threadId, fence } = attach(resident, workerId);
  const middle = intervening ? prepare("intervening") : null;
  const members = [
    intervening ? resident : prepare("first", threadId),
    prepare("second", threadId),
  ];
  if (third) members.push(prepare("third", threadId));
  const queueIds = members.map((m) => queueMember(m, threadId, fence));
  expect(
    setQueuedThreadMessageGroupBoundary({
      db,
      notifier: h.hub,
      threadId,
      groupBoundaryQueuedMessageId: queueIds.at(-1)!,
      expectedGroupedPrefixQueuedMessageIds: queueIds,
    }).kind,
  ).toBe("updated");
  const send = (
    app = h.app,
    id = queueIds[0]!,
    principal: string | null = authority.principal,
    headers: Record<string, string> = {},
    targetThread = threadId,
  ) => {
    const req = new Request(
      `http://localhost/api/v1/threads/${targetThread}/queued-messages/${id}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ mode: "auto" }),
      },
    );
    if (principal) principals.set(req, principal);
    return app.fetch(req);
  };
  return {
    threadId,
    workerId,
    send,
    queueIds,
    members,
    resident,
    middle,
    workerId2: secondWorker,
    fence,
    attach,
    agentHostId: observations[0]!.agent.host.id,
    agentSessionId: observations[0]!.agent.session.id,
    queueMember,
    sendMiddle: async () => {
      if (!middle) throw new Error("Missing independent operation");
      const target = attach(middle, secondWorker);
      const qid = queueMember(middle, target.threadId, target.fence);
      return {
        target,
        qid,
        response: await send(
          h.app,
          qid,
          authority.principal,
          {},
          target.threadId,
        ),
      };
    },
  };
}
