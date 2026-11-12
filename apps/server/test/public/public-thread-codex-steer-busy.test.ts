import { createNodeBbSdk } from "@bb/sdk/node";
import { resolveQuestion } from "../../src/services/threads/question-resolution.js";
import { afterEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { installFakeEnvironmentProvider } from "../helpers/environment-provider.js";
import {
  createConversationQuestion,
  getQuestionResolutionDelivery,
  getQuestionResolutionOperation,
  getLatestThreadSequence,
  environments,
  projectAttachmentThreads,
  getThread,
  listEvents,
  listQueuedThreadMessages,
  listStoredThreadPromptHistoryRows,
  setThreadExecutionOverride,
} from "@bb/db";
import {
  threadScope,
  turnRequestEventDataSchema,
  turnScope,
  type PromptInput,
  type TurnRequestEventData,
} from "@bb/domain";
import { uploadedPromptAttachmentSchema } from "@bb/server-contract";
import type { HostDaemonCommand } from "@bb/host-daemon-contract";
import type { PluginHookName } from "@get-bb/plugin-sdk";
type TurnSubmitCommand = Extract<HostDaemonCommand, { type: "turn.submit" }>;
import { createDeferredPromise } from "@bb/test-helpers";
import {
  invokePluginInline,
  setPluginHookProvider,
  type PluginHookRegistration,
} from "../../src/services/plugins/plugin-hook-registry.js";
import {
  answerConversationQuestion,
  closeConversationQuestion,
  readConversationQuestion,
} from "../../src/services/threads/conversation-questions.js";
import { deliverParentSystemMessage } from "../../src/services/threads/parent-system-messages.js";
import { readDeferredSteerRequest } from "../../src/services/threads/deferred-steer.js";
import { attemptDispatch } from "../../src/services/threads/dispatch-attempt.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { settleTurnSubmitCommandResult } from "../../src/services/threads/thread-lifecycle.js";
import { toThreadQueuedMessage } from "../../src/services/threads/thread-queued-messages.js";
import {
  registerHostRpcResponder,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
  type HostRpcHandlerResult,
} from "../helpers/host-rpc.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const providerThreadId = "codex-busy";
const turnId = "turn-busy";
const inputGroups: PromptInput[][] = [
  [{ type: "text", text: "STEER_EXACTLY_ONCE", mentions: [] }],
  [
    {
      type: "text",
      text: "ALREADY_EXPANDED_CONTEXT",
      mentions: [],
      visibility: "agent-only",
    },
  ],
];

function fixture(
  harness: TestAppHarness,
  refuse: () => HostRpcHandlerResult | Promise<HostRpcHandlerResult>,
  afterFirst?: () => HostRpcHandlerResult,
) {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "codex",
    status: "active",
  });
  seedThreadRuntimeState(harness.deps, {
    environmentId: environment.id,
    providerThreadId,
    threadId: thread.id,
  });
  seedTurnStarted(harness.deps, {
    environmentId: environment.id,
    providerThreadId,
    threadId: thread.id,
    turnId,
  });
  seedEvent(harness.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId,
    sequence: getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
    type: "turn/input/accepted",
    scope: turnScope(turnId),
    data: { providerThreadId, clientRequestId: "creq_2345678933" },
  });
  const commands: TurnSubmitCommand[] = [];
  registerHostRpcResponder(harness, {
    hostId: host.id,
    sessionId: session.id,
    handle: async ({ command }) => {
      if (command.type === "host.read_workspace_agent_context")
        return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
      if (command.type === "turn.submit") {
        commands.push(command);
        const result = await (commands.length === 1
          ? refuse()
          : (afterFirst?.() ?? { ok: true, result: {} }));
        return result.ok
          ? { ok: true, result: { trace: { spans: [] }, ...result.result } }
          : result;
      }
      return { ok: true, result: {} };
    },
  });
  return { thread, environment, host, commands };
}

function refusal(kind = "compact"): HostRpcHandlerResult {
  return {
    ok: false,
    errorCode: "turn_not_steerable",
    errorMessage: `cannot steer a ${kind} turn`,
  };
}

async function send(
  harness: TestAppHarness,
  threadId: string,
  groups = inputGroups,
) {
  const thread = getThread(harness.db, threadId);
  if (thread === null) throw new Error("Missing thread");
  return attemptDispatch(harness.deps, {
    thread,
    payload: {
      mode: "steer",
      input: groups.flat(),
      inputGroups: groups,
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "accept-edits",
      serviceTier: "default",
    },
    source: { kind: "inline" },
    queuePayload: { kind: "inline" },
    pluginSubmission: null,
    origin: null,
    originPluginId: null,
    startedOnBehalfOf: null,
    trigger: "user",
  });
}

function complete(
  harness: TestAppHarness,
  threadId: string,
  environmentId: string,
) {
  seedEvent(harness.deps, {
    threadId,
    environmentId,
    providerThreadId,
    sequence: getLatestThreadSequence(harness.db, { threadId }) + 1,
    type: "turn/completed",
    scope: turnScope(turnId),
    data: { providerThreadId, status: "completed" },
  });
  applyLoggedThreadLifecycleEvent(harness.deps, {
    threadId,
    event: { type: "run.succeeded" },
  });
}

function requests(harness: TestAppHarness, threadId: string) {
  return listEvents(harness.db, { threadId })
    .filter((e) => e.type === "client/turn/requested")
    .map((e) => turnRequestEventDataSchema.parse(JSON.parse(e.data)));
}

function replay(
  harness: TestAppHarness,
  command: TurnSubmitCommand,
  hostId: string,
  rollback = false,
  errorCode = "turn_not_steerable",
) {
  return harness.db.transaction(
    (tx) => {
      const result = settleTurnSubmitCommandResult({
        command,
        deps: { db: tx, hub: harness.hub, logger: harness.deps.logger },
        execution: { createdAt: Date.now(), hostId, id: "busy-execution" },
        report: {
          type: "turn.submit",
          ok: false,
          executionId: "busy-execution",
          completedAt: Date.now(),
          errorCode,
          errorMessage: "refused before input acceptance",
        },
      });
      if (rollback) throw new Error("crash before commit");
      return result;
    },
    { behavior: "immediate" },
  );
}

afterEach(() => setPluginHookProvider(undefined));

it.each(["review", "compact"])(
  "preserves a public owner steer refused during Codex %s",
  async (kind) => {
    await withTestHarness(async (harness) => {
      const { thread } = fixture(harness, () => refusal(kind));
      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "steer",
            input: [{ type: "text", text: `STEER_${kind}_EXACTLY_ONCE` }],
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ delivery: "sent" });
      await expect
        .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
        .toBe(1);
      const row = listQueuedThreadMessages(harness.db, thread.id)[0]!;
      expect(toThreadQueuedMessage(row)).toMatchObject({
        payload: { kind: "deferredSteer" },
        editable: false,
        initiator: "user",
      });
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        listEvents(harness.db, { threadId: thread.id }).filter(
          (e) => e.type === "system/error",
        ),
      ).toEqual([]);
    });
  },
);

it.each([false, true])(
  "drains original groups, execution and owner authority once (hooks=%s)",
  async (hooks) => {
    await withTestHarness(async (harness) => {
      const { thread, environment, host, commands } = fixture(harness, () =>
        refusal(),
      );
      expect(await send(harness, thread.id)).toEqual({ kind: "dispatched" });
      await expect
        .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
        .toBe(1);
      const source = requests(harness, thread.id).at(-1)!;
      const historyCount = listStoredThreadPromptHistoryRows(harness.db, {
        threadId: thread.id,
        limit: 100,
      }).length;
      expect(source.inputGroups).toEqual(inputGroups);
      expect(source.dispatchProvenance).toEqual({
        origin: null,
        originPluginId: null,
        requestedBy: null,
      });
      expect(replay(harness, commands[0]!, host.id).postCommitActions).toEqual(
        [],
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        modelOverride: "gpt-6-pro",
        reasoningLevelOverride: "max",
      });
      const seen: string[] = [];
      if (hooks) {
        const handlers: PluginHookRegistration<"message.dispatch">[] = [
          {
            pluginId: "observer",
            handler: (context) => {
              seen.push(context.attempt);
              return { action: "proceed" };
            },
          },
        ];
        const registry: { [K in PluginHookName]: PluginHookRegistration<K>[] } =
          { "message.dispatch": handlers };
        setPluginHookProvider({
          listHooks: (hook) => registry[hook],
          invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
          decisionTimeoutMs: 10000,
        });
      }
      complete(harness, thread.id, environment.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now() + 120000,
      });
      await expect.poll(() => commands.length).toBe(2);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      const deferred = requests(harness, thread.id).at(-1)!;
      expect(deferred).toMatchObject({
        input: source.input,
        inputGroups: source.inputGroups,
        execution: source.execution,
        initiator: "user",
        senderThreadId: null,
        dispatchProvenance: source.dispatchProvenance,
        deferredFromRequestId: source.requestId,
      });
      expect(deferred.retryOfRequestId).toBeUndefined();
      expect(commands[1]).toMatchObject({
        input: source.input,
        inputGroups: source.inputGroups,
        options: {
          permissionMode: "accept-edits",
          permissionEscalation: "ask",
        },
        target: { mode: "start" },
      });
      expect(getThread(harness.db, thread.id)).toMatchObject({
        modelOverride: "gpt-6-pro",
        reasoningLevelOverride: "max",
      });
      expect(
        listStoredThreadPromptHistoryRows(harness.db, {
          threadId: thread.id,
          limit: 100,
        }),
      ).toHaveLength(historyCount);
      expect(seen).toEqual(hooks ? ["start-turn"] : []);
      expect(replay(harness, commands[0]!, host.id).postCommitActions).toEqual(
        [],
      );
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now() + 240000,
      });
      expect(commands).toHaveLength(2);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    });
  },
);

it("recovers a late refusal after completion, and transaction rollback leaves no partial custody", async () => {
  await withTestHarness(async (harness) => {
    const pending = createDeferredPromise<HostRpcHandlerResult>();
    const { thread, environment, host, commands } = fixture(
      harness,
      () => pending.promise,
    );
    await send(harness, thread.id);
    await expect.poll(() => commands.length).toBe(1);
    complete(harness, thread.id, environment.id);
    expect(() => replay(harness, commands[0]!, host.id, true)).toThrow(
      "crash before commit",
    );
    expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    expect(
      listEvents(harness.db, { threadId: thread.id }).filter(
        (e) => e.type === "client/turn/rejected",
      ),
    ).toEqual([]);
    pending.resolve(refusal());
    await expect.poll(() => commands.length).toBe(2);
    expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    expect(requests(harness, thread.id).at(-1)?.deferredFromRequestId).toBe(
      commands[0]?.requestId,
    );
  });
});

it("does not queue a refusal that follows input acceptance", async () => {
  await withTestHarness(async (harness) => {
    const pending = createDeferredPromise<HostRpcHandlerResult>();
    const { thread, environment, host, commands } = fixture(
      harness,
      () => pending.promise,
    );
    await send(harness, thread.id);
    await expect.poll(() => commands.length).toBe(1);
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      providerThreadId,
      sequence:
        getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
      type: "turn/input/accepted",
      scope: turnScope(turnId),
      data: { providerThreadId, clientRequestId: commands[0]!.requestId },
    });
    pending.resolve(refusal());
    expect(replay(harness, commands[0]!, host.id).postCommitActions).toEqual(
      [],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    expect(
      listEvents(harness.db, { threadId: thread.id }).filter(
        (e) => e.type === "client/turn/rejected",
      ),
    ).toEqual([]);
  });
});

it("keeps a late deferred row paused after manual stop", async () => {
  await withTestHarness(async (harness) => {
    const pending = createDeferredPromise<HostRpcHandlerResult>();
    const { thread, environment, commands } = fixture(
      harness,
      () => pending.promise,
    );
    await send(harness, thread.id);
    await expect.poll(() => commands.length).toBe(1);
    complete(harness, thread.id, environment.id);
    seedEvent(harness.deps, {
      threadId: thread.id,
      environmentId: environment.id,
      sequence:
        getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
      type: "system/thread/interrupted",
      scope: threadScope(),
      data: { reason: "manual-stop" },
    });
    pending.resolve(refusal());
    await expect
      .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
      .toBe(1);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "idle-recovery",
      now: Date.now() + 120000,
    });
    expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    expect(commands).toHaveLength(1);
  });
});

it("retains frozen groups and provenance through reprovision without a second prompt-history entry", async () => {
  await withTestHarness(async (harness) => {
    const { thread, environment, host } = fixture(harness, () => refusal());
    await send(harness, thread.id);
    await expect
      .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
      .toBe(1);
    const source = requests(harness, thread.id).at(-1)!;
    const historyCount = listStoredThreadPromptHistoryRows(harness.db, {
      threadId: thread.id,
      limit: 100,
    }).length;
    installFakeEnvironmentProvider({
      id: "personal-workspace",
      pluginId: "bb-plugin-environment-personal-workspace",
      displayName: "Personal workspace",
      requires: {
        projectCheckout: false,
        gitCheckout: false,
        gitRemote: false,
        projectless: false,
      },
      decide: () => ({
        action: "ready",
        environment: {
          type: "host",
          hostId: host.id,
          path: "/tmp/deferred-rebuilt",
        },
      }),
    });
    harness.db
      .update(environments)
      .set({
        status: "error",
        environmentProviderId: "personal-workspace",
        environmentProviderPluginId: "bb-plugin-environment-personal-workspace",
        environmentProviderSelection: {
          machine: { type: "existing", hostId: host.id },
          inputs: null,
        },
      })
      .where(eq(environments.id, environment.id))
      .run();
    complete(harness, thread.id, environment.id);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    const deferred = requests(harness, thread.id).at(-1)!;
    expect(deferred).toMatchObject({
      input: source.input,
      inputGroups: source.inputGroups,
      execution: source.execution,
      dispatchProvenance: source.dispatchProvenance,
      deferredFromRequestId: source.requestId,
      initiator: "user",
    });
    expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
    expect(
      listStoredThreadPromptHistoryRows(harness.db, {
        threadId: thread.id,
        limit: 100,
      }),
    ).toHaveLength(historyCount);
  });
});

const ineligible: {
  name: string;
  change: (source: TurnRequestEventData) => TurnRequestEventData;
}[] = [
  {
    name: "legacy",
    change: (source) => ({ ...source, dispatchProvenance: undefined }),
  },
  {
    name: "agent",
    change: (source) => ({
      ...source,
      initiator: "agent",
      senderThreadId: "other-thread",
    }),
  },
  {
    name: "plugin",
    change: (source) => ({
      ...source,
      dispatchProvenance: {
        origin: "plugin",
        originPluginId: "plugin",
        requestedBy: null,
      },
    }),
  },
  {
    name: "on-behalf",
    change: (source) => ({
      ...source,
      dispatchProvenance: {
        origin: null,
        originPluginId: null,
        requestedBy: { initiator: "agent", senderThreadId: "other-thread" },
      },
    }),
  },
  {
    name: "start",
    change: (source) => ({ ...source, target: { kind: "new-turn" } }),
  },
  {
    name: "legacy-permission",
    change: (source) => ({
      ...source,
      execution: { ...source.execution, permissionMode: "readonly" },
    }),
  },
  {
    name: "mismatched-groups",
    change: (source) => ({
      ...source,
      inputGroups: [[{ type: "text", text: "different", mentions: [] }]],
    }),
  },
];

it.each(ineligible)(
  "refuses deferred resolution for $name provenance",
  async ({ change }) => {
    await withTestHarness(async (harness) => {
      const { thread, environment } = fixture(harness, () => ({
        ok: true,
        result: {},
      }));
      await send(harness, thread.id);
      const source = requests(harness, thread.id).at(-1)!;
      const requestId = "creq_2345678944";
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: { ...change(source), requestId },
      });
      expect(() =>
        readDeferredSteerRequest(harness.db, {
          threadId: thread.id,
          sourceRequestId: requestId,
        }),
      ).toThrow("eligible owner provenance");
      expect(() =>
        readDeferredSteerRequest(harness.db, {
          threadId: "other-thread",
          sourceRequestId: requestId,
        }),
      ).toThrow("source request is missing");
    });
  },
);

it("retains an uploaded attachment through deferred custody and dispatch", async () => {
  await withTestHarness(async (harness) => {
    const { thread, environment, commands } = fixture(harness, () => refusal());
    const body = new FormData();
    body.set(
      "file",
      new File(["owned evidence"], "evidence.txt", { type: "text/plain" }),
    );
    const response = await harness.app.request(
      `/api/v1/projects/${thread.projectId}/attachments`,
      { method: "POST", body },
    );
    expect(response.status).toBe(201);
    const attachment = uploadedPromptAttachmentSchema.parse(
      await response.json(),
    );
    if (attachment.type !== "localFile") throw new Error("Expected local file");
    await send(harness, thread.id, [
      [
        ...inputGroups[0]!,
        {
          type: "localFile",
          path: attachment.path,
          name: attachment.name,
          sizeBytes: attachment.sizeBytes,
          mimeType: attachment.mimeType,
        },
      ],
      inputGroups[1]!,
    ]);
    await expect
      .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
      .toBe(1);
    const original = requests(harness, thread.id).at(-1)!;
    const owners = () =>
      harness.db
        .select()
        .from(projectAttachmentThreads)
        .where(eq(projectAttachmentThreads.threadId, thread.id))
        .all();
    expect(owners()).toHaveLength(1);
    complete(harness, thread.id, environment.id);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    await expect.poll(() => commands.length).toBe(2);
    expect(commands[1]).toMatchObject({
      input: original.input,
      inputGroups: original.inputGroups,
    });
    expect(owners()).toHaveLength(1);
    expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
  });
});

it.each([false, true])(
  "retains deferred custody after a competing-turn drain refusal (hooks=%s)",
  async (hooks) => {
    await withTestHarness(async (harness) => {
      let firstDrain = true;
      const { thread, environment, host, commands } = fixture(
        harness,
        () => refusal("review"),
        () => {
          if (!firstDrain) return { ok: true, result: {} };
          firstDrain = false;
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            environmentId: environment.id,
            providerThreadId,
            turnId: "review-outer-turn",
          });
          return {
            ok: false,
            errorCode: "competing_turn",
            errorMessage: "Refusing to start a competing turn",
          };
        },
      );
      await send(harness, thread.id);
      await expect
        .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
        .toBe(1);
      const source = requests(harness, thread.id).at(-1)!;
      const historyCount = listStoredThreadPromptHistoryRows(harness.db, {
        threadId: thread.id,
        limit: 100,
      }).length;
      if (hooks) {
        const handlers: PluginHookRegistration<"message.dispatch">[] = [
          { pluginId: "observer", handler: () => ({ action: "proceed" }) },
        ];
        const registry: { [K in PluginHookName]: PluginHookRegistration<K>[] } =
          { "message.dispatch": handlers };
        setPluginHookProvider({
          listHooks: (hook) => registry[hook],
          invokeHook: (_pluginId, _label, run) => invokePluginInline(run),
          decisionTimeoutMs: 10000,
        });
      }
      complete(harness, thread.id, environment.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect.poll(() => commands.length).toBe(2);
      await expect
        .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
        .toBe(1);
      const row = toThreadQueuedMessage(
        listQueuedThreadMessages(harness.db, thread.id)[0]!,
      );
      expect(row).toMatchObject({
        payload: { kind: "deferredSteer", sourceRequestId: source.requestId },
        content: source.input,
      });
      expect(requests(harness, thread.id).at(-1)!.deferredFromRequestId).toBe(
        source.requestId,
      );
      expect(
        listEvents(harness.db, { threadId: thread.id })
          .filter((e) => e.type === "client/turn/rejected")
          .map((e) => JSON.parse(e.data)),
      ).toContainEqual(
        expect.objectContaining({
          requestId: commands[1]!.requestId,
          reason: "competing_turn",
          deferredToQueuedMessageId: row.id,
        }),
      );
      expect(
        replay(harness, commands[1]!, host.id, false, "competing_turn")
          .postCommitActions,
      ).toEqual([]);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "idle-recovery",
        now: Date.now() + 120000,
      });
      expect(commands).toHaveLength(2);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "turn/completed",
        scope: turnScope("review-outer-turn"),
        data: { providerThreadId, status: "completed" },
      });
      applyLoggedThreadLifecycleEvent(harness.deps, {
        threadId: thread.id,
        event: { type: "run.succeeded" },
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect.poll(() => commands.length).toBe(3);
      expect(commands[2]).toMatchObject({
        input: source.input,
        inputGroups: source.inputGroups,
        options: {
          model: source.execution.model,
          permissionMode: source.execution.permissionMode,
        },
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toEqual([]);
      expect(
        listStoredThreadPromptHistoryRows(harness.db, {
          threadId: thread.id,
          limit: 100,
        }),
      ).toHaveLength(historyCount);
    });
  },
);

it.each(["input", "groups", "execution", "provenance"])(
  "does not restore a competing deferred request with changed %s",
  async (field) => {
    await withTestHarness(async (harness) => {
      const { thread, environment, host, commands } = fixture(harness, () =>
        refusal(),
      );
      await send(harness, thread.id);
      await expect
        .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
        .toBe(1);
      const source = requests(harness, thread.id).at(-1)!;
      const changed = turnRequestEventDataSchema.parse({
        ...source,
        requestId: "creq_2345678955",
        target: { kind: "new-turn" },
        deferredFromRequestId: source.requestId,
        ...(field === "input"
          ? { input: [{ type: "text", text: "changed", mentions: [] }] }
          : {}),
        ...(field === "groups"
          ? { inputGroups: [...(source.inputGroups ?? [])].reverse() }
          : {}),
        ...(field === "execution"
          ? { execution: { ...source.execution, permissionMode: "full" } }
          : {}),
        ...(field === "provenance"
          ? {
              dispatchProvenance: {
                origin: "plugin",
                originPluginId: "other",
                requestedBy: null,
              },
            }
          : {}),
      });
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence:
          getLatestThreadSequence(harness.db, { threadId: thread.id }) + 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: changed,
      });
      replay(
        harness,
        {
          ...commands[0]!,
          requestId: changed.requestId,
          target: { mode: "start" },
        },
        host.id,
        false,
        "competing_turn",
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      const rejected = listEvents(harness.db, { threadId: thread.id })
        .filter((e) => e.type === "client/turn/rejected")
        .map((e) => JSON.parse(e.data))
        .find((e) => e.requestId === changed.requestId);
      expect(rejected).toMatchObject({ reason: "competing_turn" });
      expect(rejected.deferredToQueuedMessageId).toBeUndefined();
    });
  },
);

function questionResponseFixture(harness: TestAppHarness, threadId: string) {
  const question = createConversationQuestion(harness.db, {
    threadId,
    sourceTurnId: turnId,
    sourceCallId: "instant-question",
    publication: JSON.stringify({
      body: "Choose",
      materials: [],
      questions: [
        {
          id: "choice",
          prompt: "Approve?",
          required: true,
          multiSelect: false,
          allowFreeText: false,
          options: [{ value: "yes", label: "Yes" }],
        },
      ],
    }),
    materialManifest: JSON.stringify({
      hostId: null,
      storageRootPath: null,
      files: [],
      materials: [],
    }),
  });
  if (question === null) throw new Error("Missing question fixture");
  return {
    threadId,
    questionId: question.id,
    revision: question.revision,
    answers: { choice: { selected: ["yes"] } },
  };
}

it("delivers an idle question response immediately and consumes it once", async () => {
  await withTestHarness(async (harness) => {
    const { thread, environment, commands } = fixture(harness, () => ({
      ok: true,
      result: {},
    }));
    complete(harness, thread.id, environment.id);
    const answer = questionResponseFixture(harness, thread.id);
    const first = await answerConversationQuestion(harness.deps, answer);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    await expect.poll(() => commands.length).toBe(1);
    expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    expect(readConversationQuestion(harness.deps, answer).delivery.kind).toBe(
      "submitted",
    );
    expect(
      (await answerConversationQuestion(harness.deps, answer)).queuedMessageId,
    ).toBe(first.queuedMessageId);
    expect(commands).toHaveLength(1);
  });
});

it("injects a busy question response using the expected active turn and deduplicates submits", async () => {
  await withTestHarness(async (harness) => {
    const { thread, commands } = fixture(harness, () => ({
      ok: true,
      result: {},
    }));
    const answer = questionResponseFixture(harness, thread.id);
    const accepted = await answerConversationQuestion(harness.deps, answer);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.injectOnly).toBe(true);
    expect(commands[0]!.target).toEqual({
      mode: "auto",
      expectedTurnId: turnId,
    });
    expect(requests(harness, thread.id).at(-1)).toMatchObject({
      questionResponse: {
        questionId: answer.questionId,
        revision: 1,
        queuedMessageId: accepted.queuedMessageId,
      },
    });
    expect(
      (await answerConversationQuestion(harness.deps, answer)).queuedMessageId,
    ).toBe(accepted.queuedMessageId);
    expect(commands).toHaveLength(1);
    expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
  });
});

it.each(["provider has no inject support", "expected turn is stale"])(
  "preserves a question response once when %s",
  async (reason) => {
    await withTestHarness(async (harness) => {
      const { thread, environment, commands, host } = fixture(harness, () => ({
        ok: false,
        errorCode:
          reason === "expected turn is stale"
            ? "stale_turn"
            : "turn_not_steerable",
        errorMessage: reason,
      }));
      const answer = questionResponseFixture(harness, thread.id);
      const cached = await answerConversationQuestion(harness.deps, answer);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect.poll(() => commands.length).toBe(1);
      await expect
        .poll(
          () => readConversationQuestion(harness.deps, answer).delivery.kind,
        )
        .toBe("queued");
      const fresh = readConversationQuestion(harness.deps, answer);
      const restoredId = fresh.resolutionAttribution!.deliveryId!;
      expect(restoredId).not.toBe(cached.resolutionAttribution!.deliveryId);
      expect(fresh.resolutionDelivery?.kind).toBe("queued");
      const sdk = createNodeBbSdk({
        baseUrl: "http://localhost",
        fetch: async (input, init) =>
          harness.app.request(new Request(input, init)),
      });
      expect(
        (await sdk.threads.questions.get(answer)).resolutionAttribution
          ?.deliveryId,
      ).toBe(restoredId);
      const backendReplay = await resolveQuestion(
        harness.deps,
        {
          ...answer,
          operationId: fresh.resolutionAttribution!.operationId,
          reason: fresh.resolutionAttribution!.reason,
          action: "answer",
        },
        null,
      );
      expect(backendReplay.resolution.deliveryId).toBe(restoredId);
      expect(backendReplay.delivery.kind).toBe("queued");

      expect(fresh.resolutionAttribution?.actor).toEqual(
        cached.resolutionAttribution!.actor,
      );
      expect(
        getQuestionResolutionDelivery(
          harness.db,
          cached.resolutionAttribution!.deliveryId!,
        ),
      ).toBeNull();
      expect(
        getQuestionResolutionOperation(
          harness.db,
          "local-unverified",
          fresh.resolutionAttribution!.operationId,
        )?.attribution.deliveryId,
      ).toBe(restoredId);
      expect(
        harness.db.$client
          .prepare(
            "select delivery_id, submitted_at from question_resolution_events where id = ?",
          )
          .get(fresh.resolutionAttribution!.id),
      ).toEqual({ delivery_id: restoredId, submitted_at: null });
      expect(
        listQueuedThreadMessages(harness.db, thread.id)[0]?.payloadKind,
      ).toBe("questionResponse");
      expect(commands).toHaveLength(1);
      expect(readConversationQuestion(harness.deps, answer).delivery).toEqual({
        kind: "queued",
        reason: "will be sent after this turn",
      });
      replay(
        harness,
        commands[0]!,
        host.id,
        false,
        reason === "expected turn is stale"
          ? "stale_turn"
          : "turn_not_steerable",
      );
      const queued = listQueuedThreadMessages(harness.db, thread.id);
      expect(queued).toHaveLength(1);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      expect(commands).toHaveLength(1);
      expect(
        (await answerConversationQuestion(harness.deps, answer))
          .queuedMessageId,
      ).toBe(queued[0]!.id);
      complete(harness, thread.id, environment.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect.poll(() => commands.length).toBe(2);
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      expect(readConversationQuestion(harness.deps, answer).delivery.kind).toBe(
        "submitted",
      );
    });
  },
);

it("does not deliver a restored question response after withdrawal", async () => {
  await withTestHarness(async (harness) => {
    const { thread, environment, commands } = fixture(harness, () => refusal());
    const answer = questionResponseFixture(harness, thread.id);
    await answerConversationQuestion(harness.deps, answer);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    await expect.poll(() => commands.length).toBe(1);
    await expect
      .poll(() => readConversationQuestion(harness.deps, answer).delivery.kind)
      .toBe("queued");
    await closeConversationQuestion(harness.deps, {
      ...answer,
      action: "withdraw",
    });
    complete(harness, thread.id, environment.id);
    await runQueuedMessageDispatch(harness.deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
    expect(commands).toHaveLength(2);
    expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
    expect(readConversationQuestion(harness.deps, answer).delivery.kind).toBe(
      "held",
    );
    expect(readConversationQuestion(harness.deps, answer).status).toBe(
      "withdrawn",
    );
  });
});

it("does not infer question response identity from refused owner answer text", async () => {
  await withTestHarness(async (harness) => {
    const { thread } = fixture(harness, () => refusal());
    const answer = questionResponseFixture(harness, thread.id);
    await send(harness, thread.id, [
      [
        {
          type: "text",
          text: `Conversation question response: ${answer.questionId} (revision 1)`,
          mentions: [],
        },
      ],
    ]);
    await expect
      .poll(() => listQueuedThreadMessages(harness.db, thread.id).length)
      .toBe(1);
    expect(
      listQueuedThreadMessages(harness.db, thread.id)[0]!.payloadKind,
    ).toBe("deferredSteer");
    expect(readConversationQuestion(harness.deps, answer)).toMatchObject({
      status: "open",
      queuedMessageId: null,
      dispatchedAt: null,
    });
    expect(
      requests(harness, thread.id).at(-1)?.questionResponse,
    ).toBeUndefined();
  });
});

it.each(["turn_not_steerable", "competing_turn"])(
  "keeps question response custody across repeated competing inputs after initial %s",
  async (initialReason) => {
    await withTestHarness(async (harness) => {
      let retries = 0;
      const { thread, environment, commands } = fixture(
        harness,
        () => ({
          ok: false,
          errorCode: initialReason,
          errorMessage: "initial answer refused before acceptance",
        }),
        () =>
          ++retries < 3
            ? {
                ok: false,
                errorCode: "competing_turn",
                errorMessage: "another turn won",
              }
            : { ok: true, result: {} },
      );
      const answer = questionResponseFixture(harness, thread.id);
      await answerConversationQuestion(harness.deps, answer);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect
        .poll(
          () => readConversationQuestion(harness.deps, answer).delivery.kind,
        )
        .toBe("queued");
      const original = requests(harness, thread.id).at(-1)!;
      expect(original.deferredFromRequestId).toBeUndefined();
      for (let expected = 2; expected <= 3; expected++) {
        complete(harness, thread.id, environment.id);
        await runQueuedMessageDispatch(harness.deps, {
          kind: "thread-ready",
          threadId: thread.id,
        });
        await expect.poll(() => commands.length).toBe(expected);
        await expect
          .poll(
            () => readConversationQuestion(harness.deps, answer).delivery.kind,
          )
          .toBe("queued");
        expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      }
      complete(harness, thread.id, environment.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect.poll(() => commands.length).toBe(4);
      expect(requests(harness, thread.id).at(-1)?.deferredFromRequestId).toBe(
        original.requestId,
      );
      expect(readConversationQuestion(harness.deps, answer).delivery.kind).toBe(
        "submitted",
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    });
  },
);

it.each(["turn_not_steerable", "competing_turn"])(
  "does not fail the active turn or redeliver a question response withdrawn before refusal %s",
  async (reason) => {
    await withTestHarness(async (harness) => {
      const entered = createDeferredPromise<void>();
      const released = createDeferredPromise<HostRpcHandlerResult>();
      const { thread, environment, commands } = fixture(harness, () => {
        entered.resolve();
        return released.promise;
      });
      const answer = questionResponseFixture(harness, thread.id);
      const acceptedAnswer = await answerConversationQuestion(
        harness.deps,
        answer,
      );
      await entered.promise;
      const owedWithdraw = await closeConversationQuestion(harness.deps, {
        ...answer,
        action: "withdraw",
      });
      released.resolve({
        ok: false,
        errorCode: reason,
        errorMessage: "refused after card withdrawal",
      });
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      await expect
        .poll(
          () =>
            listEvents(harness.db, { threadId: thread.id }).filter(
              (e) => e.type === "client/turn/rejected",
            ).length,
        )
        .toBe(1);
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      const oldAnswerId = acceptedAnswer.resolutionAttribution!.deliveryId!;
      expect(
        getQuestionResolutionDelivery(harness.db, oldAnswerId),
      ).toMatchObject({
        submittedAt: null,
        attribution: {
          id: acceptedAnswer.resolutionAttribution!.id,
          deliveryId: oldAnswerId,
          action: "answer",
        },
      });
      expect(
        harness.db.$client
          .prepare(
            "select submitted_at from question_resolution_events where delivery_id = ?",
          )
          .get(oldAnswerId),
      ).toEqual({ submitted_at: null });
      expect(
        getQuestionResolutionDelivery(
          harness.db,
          owedWithdraw.resolutionAttribution!.deliveryId!,
        ),
      ).toMatchObject({
        submittedAt: null,
        attribution: { action: "withdraw" },
      });

      expect(readConversationQuestion(harness.deps, answer)).toMatchObject({
        status: "withdrawn",
        dispatchedAt: null,
      });
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(1);
      complete(harness, thread.id, environment.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      expect(commands).toHaveLength(2);
      expect(
        readConversationQuestion(harness.deps, answer).resolutionDelivery?.kind,
      ).toBe("submitted");
      expect(
        getQuestionResolutionDelivery(harness.db, oldAnswerId)?.submittedAt,
      ).toBeNull();
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);

      expect(
        listEvents(harness.db, { threadId: thread.id }).some(
          (e) => e.type === "system/error",
        ),
      ).toBe(false);
    });
  },
);

it.each(["system", "agent", "plugin", "owner"] as const)(
  "omits the card-only injection guard for %s auto input",
  async (kind) => {
    await withTestHarness(async (harness) => {
      const { thread, environment, commands } = fixture(harness, () => ({
        ok: true,
        result: {},
      }));
      if (kind === "system") {
        await deliverParentSystemMessage(harness.deps, {
          parentThread: thread,
          input: [{ type: "text", text: "child result", mentions: [] }],
          systemMessageKind: "child-completed",
          systemMessageSubject: null,
        });
      } else {
        const sender =
          kind === "agent"
            ? seedThread(harness.deps, {
                projectId: thread.projectId,
                environmentId: environment.id,
              })
            : null;
        await attemptDispatch(harness.deps, {
          thread,
          payload: {
            mode: "auto",
            input: inputGroups.flat(),
            inputGroups,
            ...(sender ? { senderThreadId: sender.id } : {}),
            model: "gpt-5",
            reasoningLevel: "medium",
            permissionMode: "accept-edits",
            serviceTier: "default",
          },
          source: { kind: "inline" },
          queuePayload: { kind: "inline" },
          pluginSubmission: null,
          origin: kind === "plugin" ? "plugin" : null,
          originPluginId: kind === "plugin" ? "test-plugin" : null,
          startedOnBehalfOf: null,
          trigger: "user",
        });
      }
      await expect.poll(() => commands.length).toBe(1);
      expect(commands[0]!.injectOnly).toBeUndefined();
      expect(commands[0]!.target.mode).toBe("auto");
      expect(getThread(harness.db, thread.id)?.status).toBe("active");
      expect(
        requests(harness, thread.id).at(-1)!.questionResponse,
      ).toBeUndefined();
      expect(requests(harness, thread.id).at(-1)!.initiator).toBe(
        kind === "system" ? "system" : kind === "agent" ? "agent" : "user",
      );
      expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
      complete(harness, thread.id, environment.id);
      await runQueuedMessageDispatch(harness.deps, {
        kind: "thread-ready",
        threadId: thread.id,
      });
      expect(commands).toHaveLength(1);
    });
  },
);

it("keeps first non-card competing rejection behavior unchanged", async () => {
  await withTestHarness(async (harness) => {
    const { thread } = fixture(harness, () => ({
      ok: false,
      errorCode: "competing_turn",
      errorMessage: "another turn is starting",
    }));
    await send(harness, thread.id);
    await expect
      .poll(
        () =>
          listEvents(harness.db, { threadId: thread.id }).filter(
            (e) => e.type === "client/turn/rejected",
          ).length,
      )
      .toBe(1);
    expect(listQueuedThreadMessages(harness.db, thread.id)).toHaveLength(0);
    expect(
      requests(harness, thread.id).at(-1)?.questionResponse,
    ).toBeUndefined();
    expect(getThread(harness.db, thread.id)?.status).toBe("active");
  });
});
