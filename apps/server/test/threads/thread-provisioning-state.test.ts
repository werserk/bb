import { describe, expect, it } from "vitest";
import {
  createEnvironment,
  createProject,
  createThread,
  noopNotifier,
  upsertHost,
} from "@bb/db";
import { createMigratedConnection, listEvents } from "@bb/db/testing";
import { getThreadProvisionContext } from "../../src/services/threads/thread-startup-store.js";
import {
  requestThreadProvision,
  requestThreadTargetReprovision,
} from "../../src/services/threads/thread-provisioning.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { assertPromptHistoryForTurnRequest } from "../helpers/prompt-history.js";
import { textInput } from "../helpers/prompt-input.js";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, {
    name: "test-host",
  });
  const { project } = createProject(db, noopNotifier, {
    name: "test-project",
    source: { type: "local_path", hostId: host.id, path: "/tmp/source" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: host.id,
    projectId: project.id,
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "starting",
  });
  const hub = new NotificationHub();
  return { db, environment, host, thread, hub };
}

describe("thread provisioning state", () => {
  it.each(["user", "system", "agent"] as const)(
    "retains resolved %s author and provisioning progress",
    (initiator) => {
      const { db, host, hub, thread } = setup();
      const input = textInput("start this workspace");
      const membership =
        initiator === "user"
          ? [{ id: crypto.randomUUID(), inputGroupIndex: 0 }]
          : undefined;

      const { context } = requestThreadProvision(
        { db, hub },
        {
          originPluginId: null,
          thread,
          clientSubmissions: membership,
          author: {
            initiator,
            senderThreadId: initiator === "agent" ? thread.id : null,
          },
          ...(initiator === "system"
            ? { retryOf: { requestId: "creq_abcdefghij", attempt: 2 } }
            : {}),
          environmentIntent: {
            type: "provider",
            environmentProviderId: "project-checkout",
            machine: { type: "existing", hostId: host.id },
            inputs: {},
            selectionResolved: true,
          },
          input,
          execution: {
            model: "gpt-5",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
          fork: null,
          startedOnBehalfOf: null,
          titleProvided: true,
        },
      );

      const event = listEvents(db, { threadId: thread.id }).find(
        (e) => e.type === "client/turn/requested",
      )!;
      expect(JSON.parse(event.data)).toMatchObject({
        initiator,
        senderThreadId: initiator === "agent" ? thread.id : null,
        ...(initiator === "system"
          ? { retryOfRequestId: "creq_abcdefghij", retryAttempt: 2 }
          : {}),
      });
      expect(JSON.parse(event.data).clientSubmissions).toEqual(membership);
      expect(context.request.clientSubmissions).toEqual(membership);
      expect(context.state.provisioningId).toMatch(/^tpv_/);
      expect(context.state.environmentId).toBeNull();
      expect(context.state.environmentId).toBeNull();
      expect(context.state.provisionEventSequence).toBeNull();
      expect(context.state.workspaceReadyEventSequence).toBeNull();
      expect(getThreadProvisionContext(db, thread.id)).toEqual(context);
      if (initiator === "user")
        assertPromptHistoryForTurnRequest({
          db,
          threadId: thread.id,
          scope: "project",
          input,
        });
    },
  );
});

it("keeps grouped queue provenance in reprovision and its restored startup context", () => {
  const { db, hub, thread, environment } = setup();
  const groups = [textInput("first"), textInput("legacy"), textInput("last")];
  const clientSubmissions = [
    { id: crypto.randomUUID(), inputGroupIndex: 0 },
    { id: crypto.randomUUID(), inputGroupIndex: 2 },
  ];
  const aliases = ["deferred-a", "legacy-b"];
  const { context } = requestThreadTargetReprovision(
    { db, hub },
    {
      thread,
      environment,
      provider: {
        environmentProviderId: "project-checkout",
        selection: {
          machine: { type: "existing", hostId: environment.hostId },
          inputs: {},
        },
      },
      input: groups.flat(),
      inputGroups: groups,
      clientSubmissions,
      sourceQueuedMessageIds: aliases,
      initiator: "user",
      originPluginId: null,
      senderThreadId: null,
      execution: {
        model: "test",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    },
  );
  const requested = listEvents(db, { threadId: thread.id }).find(
    (event) => event.type === "client/turn/requested",
  )!;
  expect(JSON.parse(requested.data)).toMatchObject({
    inputGroups: groups,
    clientSubmissions,
    sourceQueuedMessageIds: aliases,
  });
  expect(context.request).toMatchObject({
    inputGroups: groups,
    clientSubmissions,
    sourceQueuedMessageIds: aliases,
  });
  expect(getThreadProvisionContext(db, thread.id)).toEqual(context);
});
