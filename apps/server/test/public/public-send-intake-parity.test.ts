import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getThreadSendIntake, listQueuedThreadMessages, listStoredEventRows } from "@bb/db";
import type { PromptInput } from "@bb/domain";
import type { MessageDispatchHookContext, PluginHookName } from "@get-bb/plugin-sdk";
import { setPluginHookProvider, type PluginHookRegistration } from "../../src/services/plugins/plugin-hook-registry.js";
import { getThreadSendIntakeService } from "../../src/services/threads/thread-send-request.js";
import * as commands from "../../src/services/threads/thread-commands.js";
import * as mentions from "../../src/services/plugins/plugin-mentions.js";
import { EMPTY_WORKSPACE_AGENT_CONTEXT, registerHostRpcResponder, type HostRpcHandlerResult } from "../helpers/host-rpc.js";
import { seedThreadFixture, seedThreadRuntimeState, seedTurnStarted } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

const execution = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" } as const;
afterEach(() => { setPluginHookProvider(undefined); vi.restoreAllMocks(); });

function builtin(name: "clear" | "compact"): PromptInput[] {
  return [{ type: "text", text: `/${name}`, mentions: [{ start: 0, end: name.length + 1,
    resource: { kind: "command", trigger: "/", name, source: "command", origin: "builtin", label: name, argumentHint: null } }] }];
}

type HookRegistry = { [K in PluginHookName]: PluginHookRegistration<K>[] };

const modes = [
  { status: "idle", mode: "auto", attempt: "start-turn" },
  { status: "idle", mode: "steer", attempt: "start-turn" },
  { status: "idle", mode: "queue-if-active", attempt: "start-turn" },
  { status: "idle", mode: "start", attempt: "start-turn" },
  { status: "idle", mode: "steer-if-active", attempt: "start-turn" },
  { status: "active", mode: "auto", attempt: "join-turn" },
  { status: "active", mode: "steer", attempt: "join-turn" },
  { status: "active", mode: "steer-if-active", attempt: "join-turn" },
  { status: "active", mode: "start", attempt: "start-turn" },
  { status: "active", mode: "queue-if-active", attempt: "start-turn" },
] as const;

describe("original inline intake contract", () => {
  it("preserves a stock active/start 409 as terminal rejection and lets a legacy successor queue", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread, environment, session } = seedThreadFixture(h, { thread: { status: "active" } });
      seedTurnStarted(h.deps, { threadId: thread.id, environmentId: environment.id, turnId: "active-rejection" });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      const id = randomUUID();
      const post = (mode: "start" | "auto", clientSubmissionId: string) => h.app.request(`/api/v1/threads/${thread.id}/send`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: textInput("original request"), mode, clientSubmissionId }),
      });
      const rejected = await post("start", id);
      expect(rejected.status).toBe(409);
      const original: unknown = await rejected.json();
      expect(getThreadSendIntake(h.db, `qsub_${id}`)).toMatchObject({ state: "rejected", sealedAt: null, currentEnvelope: null });
      const replay = await post("start", id);
      expect(replay.status).toBe(409); expect(await replay.json()).toEqual(original);
      h.hub.unregisterDaemon(session.id);
      const nextId = randomUUID();
      const successor = await post("auto", nextId);
      expect(successor.status).toBe(200);
      expect(await successor.json()).toMatchObject({ delivery: "queued", queuedMessage: { id: `qsub_${nextId}`, waitingOn: { kind: "host-offline" } } });
      expect(listQueuedThreadMessages(h.db, thread.id).map(row => row.id)).toEqual([`qsub_${nextId}`]);
    });
  });

  it.each(modes)("preserves $status/$mode hook attempt and original context on old and negotiated ingress", async entry => {
    for (const route of ["send", "send-admission"] as const) {
      await withTestHarness({ sendIntake: true }, async h => {
        const { thread, environment } = seedThreadFixture(h, { thread: { status: entry.status } });
        if (entry.status === "active") seedTurnStarted(h.deps, { threadId: thread.id, environmentId: environment.id, turnId: `turn-${route}` });
        const seen: MessageDispatchHookContext[] = [];
        const registry: HookRegistry = { "message.dispatch": [{ pluginId: "intake-parity", handler: context => {
          seen.push(context); return { action: "wait", reason: "unit policy hold" };
        } }] };
        setPluginHookProvider({
          listHooks: hook => registry[hook],
          invokeHook: async (_registration, _label, run) => ({ ok: true, value: await run() }), decisionTimeoutMs: 10_000,
        });
        vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
        const resolveMentions = vi.spyOn(mentions, "resolvePluginMentionContextInputs");
        const id = randomUUID(); const input = textInput("original request");
        const pluginSubmission = { pluginId: "intake-parity", data: { ticket: "retained" } };
        const response = await h.app.request(`/api/v1/threads/${thread.id}/${route}`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, clientSubmissionId: id, mode: entry.mode, pluginSubmission, ...(route === "send-admission" ? { admissionVersion: 1 } : {}) }) });
        expect(response.status).toBe(200);
        await getThreadSendIntakeService(h.deps).wait(`qsub_${id}`);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ attempt: entry.attempt, initiator: "user", queuedMessages: [],
          input: { blocks: input, text: "original request" }, experimental_submission: pluginSubmission });
        expect(resolveMentions).not.toHaveBeenCalled();
        expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
        expect(getThreadSendIntake(h.db, `qsub_${id}`)?.state).toBe("transferred");
      });
    }
  });

  it.each([
    { command: "clear", form: "raw" }, { command: "compact", form: "raw" },
    { command: "clear", form: "mixed" }, { command: "compact", form: "mixed" },
  ] as const)("keeps $form /$command as original message input through both routes", async entry => {
    for (const route of ["send", "send-admission"] as const) {
      await withTestHarness({ sendIntake: true }, async h => {
        const { thread } = seedThreadFixture(h);
        const input = entry.form === "raw" ? textInput(`/${entry.command}`) : builtin(entry.command).map(block =>
          block.type === "text" ? { ...block, text: `${block.text} original argument` } : block);
        const seen: MessageDispatchHookContext[] = [];
        const registry: HookRegistry = { "message.dispatch": [{ pluginId: "intake-parity", handler: context => {
          seen.push(context); return { action: "wait", reason: "original variant policy" };
        } }] };
        setPluginHookProvider({ listHooks: hook => registry[hook],
          invokeHook: async (_registration, _label, run) => ({ ok: true, value: await run() }), decisionTimeoutMs: 10_000 });
        vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
        const id = randomUUID();
        expect((await h.app.request(`/api/v1/threads/${thread.id}/${route}`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ input, clientSubmissionId: id, mode: "auto", ...(route === "send-admission" ? { admissionVersion: 1 } : {}) }) })).status).toBe(200);
        await getThreadSendIntakeService(h.deps).wait(`qsub_${id}`);
        expect(seen).toHaveLength(1); expect(seen[0]?.input.blocks).toEqual(input);
        expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
        expect(listStoredEventRows(h.db, { threadId: thread.id, types: ["system/operation"] })).toEqual([]);
      });
    }
  });

  it.each([
    { route: "send", command: "clear" }, { route: "send-admission", command: "clear" },
    { route: "send", command: "compact" }, { route: "send-admission", command: "compact" },
  ] as const)("preserves selected builtin $command through $route and same-ID replay", async entry => {
    await withTestHarness({ sendIntake: true }, async h => {
      const f = seedThreadFixture(h);
      seedThreadRuntimeState(h.deps, { threadId: f.thread.id, environmentId: f.environment.id, providerThreadId: "intake-command" });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      vi.spyOn(h.deps.providerRegistry, "supportsManualCompaction").mockReturnValue(true);
      const responder = registerHostRpcResponder(h, { hostId: f.host.id, sessionId: f.session.id,
        handle: async ({ command }): Promise<HostRpcHandlerResult> => {
          switch (command.type) {
            case "thread.stop": return { ok: true, result: { providerCheckpointId: null } };
            case "thread.start": return { ok: true, result: { providerThreadId: "after-intake-command" } };
            case "turn.submit": return { ok: true, result: { trace: { spans: [] } } };
            case "host.read_workspace_agent_context": return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
            default: throw new Error(`Unexpected command ${command.type}`);
          }
        },
      });
      const id = randomUUID();
      const body = { input: builtin(entry.command), clientSubmissionId: id, mode: "auto", ...(entry.route === "send-admission" ? { admissionVersion: 1 } : {}) };
      const post = () => h.app.request(`/api/v1/threads/${f.thread.id}/${entry.route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      try {
        expect((await post()).status).toBe(200);
        await getThreadSendIntakeService(h.deps).wait(`qsub_${id}`);
        const before = listStoredEventRows(h.db, { threadId: f.thread.id, types: ["client/turn/requested", "system/operation"] });
        expect(getThreadSendIntake(h.db, `qsub_${id}`)?.state).toBe("transferred");
        if (entry.command === "clear") expect(before.filter(row => row.type === "system/operation")).toHaveLength(1);
        else expect(before.filter(row => row.type === "client/turn/requested")).toHaveLength(2);
        expect((await post()).status).toBe(200);
        expect(listStoredEventRows(h.db, { threadId: f.thread.id, types: ["client/turn/requested", "system/operation"] })).toEqual(before);
      } finally { responder.unregister(); }
    });
  });
});
