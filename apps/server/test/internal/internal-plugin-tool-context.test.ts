import { spawn } from "node:child_process";
import { vi } from "vitest";
import { createBridgeProtocolAdapter } from "@bb/agent-runtime/test";
import {
  handleRuntimeProviderRequest,
  RuntimeToolCalls,
} from "@bb/agent-runtime/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginAgentToolContext } from "@get-bb/plugin-sdk";
import {
  internalAuthHeaders,
  waitForQueuedCommand,
  reportQueuedCommandSuccess,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

for (const providerId of ["claude-code", "codex"]) {
  describe(`${providerId} native plugin tool context`, () => {
    it("preserves late and concurrent caller identities across rollover and Stop/restart", async () => {
      await withTestHarness(async (harness) => {
        const root = await mkdtemp(join(tmpdir(), "bb-caller-context-"));
        const contexts: PluginAgentToolContext[] = [];
        const child = spawn(process.execPath, [
          "-e",
          "process.stdin.pipe(process.stdout)",
        ]);
        child.stdout?.resume();
        const daemonCalls = new RuntimeToolCalls();
        const adapter = createBridgeProtocolAdapter({
          id: providerId,
          capabilities: {
            supportsThreadRename: false,
            supportsThreadArchive: false,
            supportsServiceTier: false,
            fork: "checkpoint",
            permissionModes: ["full"],
          },
          process: { command: "node", args: [] },
        });
        const activeTurnLookup = vi.fn(() => "new-turn");
        const pending = new Map<string, () => void>();
        try {
          await mkdir(join(root, "plugin"));
          await writeFile(
            join(root, "plugin/package.json"),
            JSON.stringify({
              name: "bb-plugin-caller-context",
              version: "0.1.0",
              bb: {
                name: "Caller context",
                description: "Test fixture",
                branding: { icon: "Zap" },
                server: "./server.ts",
              },
            }),
          );
          await writeFile(
            join(root, "plugin/server.ts"),
            "export default function plugin() {}",
          );
          expect(
            (await harness.pluginService.installPath(join(root, "plugin")))
              .status,
          ).toBe("running");
          const api = harness.pluginService.getApi("caller-context")!;
          expect(api.agents.experimental_toolContextCapabilities()).toEqual({
            callerIdentity: true,
            exactTurnOrigin: false,
          });
          api.agents.registerTool({
            name: "caller_context",
            description: "Record native caller identity",
            parameters: { type: "object" },
            execute: async (_input, ctx) => {
              contexts.push(ctx);
              await new Promise<void>((resolve) => {
                pending.set(ctx.callId!, resolve);
                ctx.signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
              return JSON.stringify({ turnId: ctx.turnId, callId: ctx.callId });
            },
          });
          const { session } = seedHostSession(harness.deps);
          const { project } = seedProjectWithSource(harness.deps, {
            hostId: session.hostId,
          });
          const environment = seedEnvironment(harness.deps, {
            hostId: session.hostId,
            projectId: project.id,
          });
          const thread = seedThread(harness.deps, {
            projectId: project.id,
            environmentId: environment.id,
            providerId,
            status: "active",
          });
          const start = (turnId: string) =>
            seedTurnStarted(harness.deps, {
              threadId: thread.id,
              environmentId: environment.id,
              turnId,
              providerThreadId: `${providerId}-session`,
            });
          const postRaw = (
            callId: string,
            turnId?: string,
            tool = "caller_context",
            authenticated = true,
          ) =>
            harness.app.request("/internal/session/tool-call", {
              method: "POST",
              headers: authenticated
                ? internalAuthHeaders(harness)
                : { "content-type": "application/json" },
              body: JSON.stringify({
                sessionId: session.id,
                threadId: thread.id,
                providerThreadId: `${providerId}-session`,
                ...(turnId === undefined ? {} : { turnId }),
                callId,
                tool,
                arguments: { turnId: "forged-turn", callId: "forged-call" },
              }),
            });
          const post = (
            callId: string,
            turnId?: string,
            tool = "caller_context",
            authenticated = true,
          ): Promise<Response> => {
            if (turnId === undefined || !authenticated)
              return Promise.resolve(
                postRaw(callId, turnId, tool, authenticated),
              );
            return new Promise((resolve, reject) => {
              handleRuntimeProviderRequest({
                parsedId: callId,
                parsedMethod: "item/tool/call",
                rawRequest: {
                  jsonrpc: "2.0",
                  id: callId,
                  method: "item/tool/call",
                  params: {
                    threadId: thread.id,
                    providerThreadId: `${providerId}-session`,
                    turnId,
                    callId,
                    tool,
                    arguments: {},
                  },
                },
                providerProcess: {
                  adapter,
                  child,
                  interactiveRequestScope: thread.id,
                },
                toolCalls: daemonCalls,
                getActiveTurnId: activeTurnLookup,
                getThreadExecutionOptions: () => undefined,
                resolveThreadId: () => thread.id,
                onInteractiveRequest: async () => ({ decision: "deny" }),
                onToolCall: async (request) => {
                  try {
                    const response = await postRaw(
                      request.callId,
                      request.turnId,
                      request.tool,
                    );
                    resolve(response.clone());
                    return await response.json();
                  } catch (error) {
                    reject(error);
                    throw error;
                  }
                },
              });
            });
          };
          const finish = async (response: Response, callId: string) => {
            expect(response.status).toBe(200);
            pending.get(callId)!();
            const result = await response.json();
            expect(result.success).toBe(true);
            return JSON.parse(result.contentItems[0].text);
          };
          start("old-turn");
          const oldResponse = await post("old-call", "old-turn");
          start("new-turn");
          const lateResponse = await post("late-call", "old-turn");
          const responses = await Promise.all([
            post("parallel-a", "new-turn"),
            post("parallel-b", "new-turn"),
          ]);
          expect(
            contexts.map(({ turnId, callId }) => ({ turnId, callId })),
          ).toEqual([
            { turnId: "old-turn", callId: "old-call" },
            { turnId: "old-turn", callId: "late-call" },
            { turnId: "new-turn", callId: "parallel-a" },
            { turnId: "new-turn", callId: "parallel-b" },
          ]);
          expect(
            contexts.every(
              (ctx) =>
                ctx.threadId === thread.id && ctx.projectId === project.id,
            ),
          ).toBe(true);
          await finish(oldResponse, "old-call");
          await finish(lateResponse, "late-call");
          await finish(responses[0], "parallel-a");
          await finish(responses[1], "parallel-b");
          const stopping = await post("stopped-call", "new-turn");
          const stoppedContext = contexts.at(-1)!;
          const stopResponse = harness.app.request(
            `/api/v1/threads/${thread.id}/stop`,
            { method: "POST" },
          );
          const stop = await waitForQueuedCommand(
            harness,
            ({ command }) =>
              command.type === "thread.stop" && command.threadId === thread.id,
          );
          await reportQueuedCommandSuccess(harness, stop, {
            providerCheckpointId: null,
          });
          expect((await stopResponse).status).toBe(200);
          await stopping.json();
          expect(stoppedContext.signal.aborted).toBe(true);
          start("restart-turn");
          const restarted = await post("restart-call", "restart-turn");
          expect(contexts.at(-1)!.signal.aborted).toBe(false);
          expect(await finish(restarted, "restart-call")).toEqual({
            turnId: "restart-turn",
            callId: "restart-call",
          });
          expect(stoppedContext.turnId).toBe("new-turn");
          const missing = await post("missing-turn");
          expect(contexts.at(-1)).not.toHaveProperty("turnId");
          expect(await finish(missing, "missing-turn")).toEqual({
            callId: "missing-turn",
          });
          for (const tool of [
            "bb_update_plan",
            "update_environment_directory",
          ]) {
            expect(
              (await post("missing-builtin", undefined, tool)).status,
            ).toBe(400);
          }
          expect(activeTurnLookup).not.toHaveBeenCalled();
          const count = contexts.length;
          expect(
            (
              await post(
                "unauthenticated",
                "forged-turn",
                "caller_context",
                false,
              )
            ).status,
          ).toBe(401);
          expect(contexts).toHaveLength(count);
        } finally {
          child.kill();
          for (const finish of pending.values()) finish();
          await rm(root, { recursive: true, force: true });
        }
      });
    });
  });
}
