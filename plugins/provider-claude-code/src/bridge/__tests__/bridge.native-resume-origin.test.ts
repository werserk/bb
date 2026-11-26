import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => vi.stubEnv("BB_PRE_COMPLETION_HOOKS", "1"));
afterEach(() => vi.unstubAllEnvs());
import type {
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { PromptInput } from "@get-bb/plugin-sdk/provider-bridge";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
  forkSession: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { handleLine } from "../bridge.js";
import {
  experimental_createBridgeDeltaEventCollector as createBridgeDeltaEventCollector,
  experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness,
} from "@get-bb/plugin-sdk/provider-bridge/testing";
import type { ThreadEvent } from "@get-bb/plugin-sdk/provider-bridge/testing";

const THREAD_ID = "thr_native_resume_1";
const SESSION_ID = "native-resume-session";
const OPTIONS = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
  instructions: "test",
} as const;

interface ScriptedCall {
  prompt: AsyncIterable<SDKUserMessage>;
  options: {
    hooks?: { Stop?: Array<{ hooks: HookCallback[] }> };
    mcpServers?: Record<
      string,
      { instance: { connect(transport: unknown): Promise<void> } }
    >;
  };
}

function asSdkMessage(message: Record<string, unknown>): SDKMessage {
  return message as unknown as SDKMessage;
}

function assistantText(id: string, text: string): SDKMessage {
  return asSdkMessage({
    type: "assistant",
    session_id: SESSION_ID,
    uuid: `ck-${id}`,
    message: {
      id,
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
}

function successResult(): SDKMessage {
  return asSdkMessage({
    type: "result",
    subtype: "success",
    session_id: SESSION_ID,
    is_error: false,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: { "claude-sonnet-5": { contextWindow: 200_000 } },
  });
}

function promptInput(text: string): PromptInput[] {
  return [{ type: "text", text, mentions: [] }];
}

let nextMessageNumber = 0;

function nextAssistantText(text: string): SDKMessage {
  nextMessageNumber += 1;
  return assistantText(`msg_${nextMessageNumber}`, text);
}

function taskNotification(text: string): SDKMessage {
  nextMessageNumber += 1;
  return asSdkMessage({
    type: "user",
    session_id: SESSION_ID,
    uuid: `task-notification-${nextMessageNumber}`,
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: `<task-notification>${text}</task-notification>`,
    },
  });
}

function createScriptedQuery(call: ScriptedCall) {
  const queue: SDKMessage[] = [];
  let closed = false;
  let notify: (() => void) | null = null;
  const wake = (): void => {
    const pending = notify;
    notify = null;
    pending?.();
  };
  const push = (message: SDKMessage): void => {
    queue.push(message);
    wake();
  };
  void (async () => {
    for await (const input of call.prompt) {
      const text = String(input.message.content);
      push(nextAssistantText(`working on ${text}`));
      if (!text.startsWith("steer")) {
        push(successResult());
      }
    }
    closed = true;
    wake();
  })();
  return {
    push,
    query: {
      applyFlagSettings: vi.fn(async () => {}),
      close: vi.fn(() => {
        closed = true;
        wake();
      }),
      initializationResult: vi.fn().mockResolvedValue({}),
      interrupt: vi.fn(async () => {}),
      setModel: vi.fn(async () => {}),
      setPermissionMode: vi.fn(async () => {}),
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<SDKMessage>> => {
          for (;;) {
            const message = queue.shift();
            if (message) {
              return { value: message, done: false };
            }
            if (closed) {
              return { value: undefined, done: true };
            }
            await new Promise<void>((resolve) => {
              notify = resolve;
            });
          }
        },
        return: async (): Promise<IteratorResult<SDKMessage>> => {
          closed = true;
          return { value: undefined, done: true };
        },
      }),
    },
  };
}

async function withResumedTurn(
  run: (fixture: {
    clientTurnId: string;
    resumedTurnId: string;
    events: ThreadEvent[];
    startedTurnIds(): string[];
    openTurnIds(): string[];
    resume(): Promise<string | undefined>;
    finishTurn(): Promise<void>;
    steer(expectedTurnId: string, clientRequestId: string): Promise<void>;
    callTool(): Promise<string>;
    checkStop(): Promise<{ origin: string; output: unknown }>;
    checkStopInert(): Promise<{ output: unknown; roundTrips: number }>;
    callReserved(): Promise<unknown>;
    bbTurnId(origin: string): string | undefined;
    openAssembledTurnId(): string | undefined;
  }) => Promise<void>,
): Promise<void> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "bb-native-resume-"));
  const calls: ScriptedCall[] = [];
  let pushToToolQuery: (message: SDKMessage) => void = () => {};
  queryMock.mockImplementation((call: ScriptedCall) => {
    calls.push(call);
    const scripted = createScriptedQuery(call);
    if (calls.length === 1) {
      pushToToolQuery = scripted.push;
    }
    return scripted.query;
  });
  const bridge = createBridgeJsonRpcTestHarness(handleLine);
  const collector = createBridgeDeltaEventCollector("claude-code");
  const events: ThreadEvent[] = [];
  const client = new Client({ name: "native-resume", version: "1" });
  let clientConnected = false;
  let drained = 0;
  let requestId = 2;
  const settle = async (): Promise<void> => {
    for (let round = 0; round < 12; round += 1) {
      await bridge.flushWork();
      for (const message of bridge.messages.slice(drained)) {
        for (const event of collector.assembleMessage(message)) {
          events.push(event);
        }
      }
      drained = bridge.messages.length;
    }
  };
  const startedTurnIds = (): string[] =>
    events.flatMap((event) =>
      event.type === "turn/started" && event.scope.kind === "turn"
        ? [event.scope.turnId]
        : [],
    );
  const openTurnIds = (): string[] => {
    const completed = new Set(
      events.flatMap((event) =>
        event.type === "turn/completed" && event.scope.kind === "turn"
          ? [event.scope.turnId]
          : [],
      ),
    );
    return startedTurnIds().filter((turnId) => !completed.has(turnId));
  };
  const resume = async (): Promise<string | undefined> => {
    const before = startedTurnIds().length;
    pushToToolQuery(taskNotification("gate finished"));
    pushToToolQuery(nextAssistantText("the gate finished; reporting"));
    await settle();
    return startedTurnIds()[before];
  };
  const toolCallOrigins = (): string[] =>
    bridge.messages.flatMap((message) =>
      message.method === "item/tool/call"
        ? [(message.params as { turnId: string }).turnId]
        : [],
    );

  try {
    bridge.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      options: OPTIONS,
      dynamicTools: [
        {
          name: "bb_internal_pre_completion",
          description: "forged test tool",
          inputSchema: { type: "object" },
        },
        {
          name: "wprojects_outcome",
          description: "report",
          inputSchema: { type: "object" },
        },
      ],
      instructionMode: "append",
    });
    const started = await bridge.waitForResponse(1);
    const { providerThreadId } = started.result as { providerThreadId: string };
    bridge.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      input: promptInput("run the gate in the background"),
      clientRequestId: "creq_23456789af",
      options: OPTIONS,
    });
    expect((await bridge.waitForResponse(2)).error).toBeUndefined();
    await settle();
    const [clientTurnId] = startedTurnIds();
    expect(clientTurnId).toBeDefined();
    expect(openTurnIds()).toEqual([]);

    const resumedTurnId = await resume();
    expect(resumedTurnId).toBeDefined();
    expect(resumedTurnId).not.toBe(clientTurnId);
    expect(openTurnIds()).toEqual([resumedTurnId]);

    await run({
      clientTurnId: clientTurnId!,
      resumedTurnId: resumedTurnId!,
      events,
      startedTurnIds,
      openTurnIds,
      resume,
      finishTurn: async () => {
        pushToToolQuery(successResult());
        await settle();
      },
      steer: async (expectedTurnId, clientRequestId) => {
        requestId += 1;
        bridge.sendRequest(requestId, "turn/steer", {
          threadId: THREAD_ID,
          providerThreadId,
          expectedTurnId,
          input: promptInput("steer: also check the log"),
          clientRequestId,
          options: OPTIONS,
        });
        expect((await bridge.waitForResponse(requestId)).error).toBeUndefined();
        await settle();
      },
      callTool: async () => {
        if (!clientConnected) {
          const server = calls[0]?.options.mcpServers?.["bb-bridge"];
          expect(server).toBeDefined();
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          await server!.instance.connect(serverTransport);
          await client.connect(clientTransport);
          clientConnected = true;
        }
        const before = toolCallOrigins().length;
        void client
          .callTool({ name: "wprojects_outcome", arguments: {} })
          .catch(() => undefined);
        await vi.waitFor(() =>
          expect(toolCallOrigins().length).toBe(before + 1),
        );
        return toolCallOrigins()[before]!;
      },
      checkStop: async () => {
        const hook = calls[0]?.options.hooks?.Stop?.[0]?.hooks[0];
        expect(hook).toBeDefined();
        const before = bridge.messages.length;
        const outputPromise = hook!(
          {
            hook_event_name: "Stop",
            stop_hook_active: false,
            last_assistant_message: "Need your decision",
            session_id: SESSION_ID,
            transcript_path: "/unused",
            cwd: workspaceDir,
          },
          undefined,
          { signal: new AbortController().signal },
        );
        await vi.waitFor(() =>
          expect(
            bridge.messages
              .slice(before)
              .some((m) => m.method === "item/tool/call"),
          ).toBe(true),
        );
        const request = bridge.messages
          .slice(before)
          .find((m) => m.method === "item/tool/call")!;
        const params = request.params as {
          turnId: string;
          tool: string;
          arguments: unknown;
        };
        expect(params.tool).toBe("bb_internal_pre_completion");
        expect(params.arguments).toEqual({
          finalText: "Need your decision",
          truncated: false,
        });
        handleLine(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: {
              success: true,
              contentItems: [
                {
                  type: "inputText",
                  text: JSON.stringify({
                    action: "continue",
                    instruction: "Use the native question tool.",
                  }),
                },
              ],
            },
          }),
        );
        return { origin: params.turnId, output: await outputPromise };
      },
      checkStopInert: async () => {
        const hook = calls[0]?.options.hooks?.Stop?.[0]?.hooks[0];
        expect(hook).toBeDefined();
        const before = bridge.messages.length;
        const output = await hook!(
          {
            hook_event_name: "Stop",
            stop_hook_active: false,
            last_assistant_message: "Need your decision",
            session_id: SESSION_ID,
            transcript_path: "/unused",
            cwd: workspaceDir,
          },
          undefined,
          { signal: new AbortController().signal },
        );
        const roundTrips = bridge.messages
          .slice(before)
          .filter((m) => m.method === "item/tool/call").length;
        return { output, roundTrips };
      },
      callReserved: async () => {
        if (!clientConnected) {
          const server = calls[0]!.options.mcpServers!["bb-bridge"]!;
          const [clientTransport, serverTransport] =
            InMemoryTransport.createLinkedPair();
          await server.instance.connect(serverTransport);
          await client.connect(clientTransport);
          clientConnected = true;
        }
        const before = toolCallOrigins().length;
        const result = await client.callTool({
          name: "bb_internal_pre_completion",
          arguments: {},
        });
        expect(toolCallOrigins()).toHaveLength(before);
        return result;
      },
      bbTurnId: (origin) => collector.assembler.getBbTurnId(THREAD_ID, origin),
      openAssembledTurnId: () => collector.assembler.getOpenTurnId(THREAD_ID),
    });
  } finally {
    await client.close().catch(() => undefined);
    bridge.restore();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}

it("maps a tool call in a turn the SDK resumes on its own to that live turn", async () => {
  await withResumedTurn(async ({ resumedTurnId, callTool, bbTurnId }) => {
    expect(bbTurnId(await callTool())).toBe(resumedTurnId);
  });
}, 60_000);

it("ends the resumed turn and gives a second resume its own origin", async () => {
  await withResumedTurn(
    async ({
      resumedTurnId,
      events,
      openTurnIds,
      resume,
      finishTurn,
      callTool,
      bbTurnId,
      openAssembledTurnId,
    }) => {
      const firstOrigin = await callTool();
      await finishTurn();

      expect(openTurnIds()).toEqual([]);
      expect(openAssembledTurnId()).toBeUndefined();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn/completed",
          scope: { kind: "turn", turnId: resumedTurnId },
          status: "completed",
        }),
      );

      const secondResumedTurnId = await resume();
      expect(secondResumedTurnId).toBeDefined();
      expect(secondResumedTurnId).not.toBe(resumedTurnId);
      expect(openTurnIds()).toEqual([secondResumedTurnId]);
      const secondOrigin = await callTool();
      expect(secondOrigin).not.toBe(firstOrigin);
      expect(bbTurnId(secondOrigin)).toBe(secondResumedTurnId);
      expect(bbTurnId(firstOrigin)).toBe(resumedTurnId);
    },
  );
}, 60_000);

it("keeps the resumed turn and its origin when a steer arrives in it", async () => {
  await withResumedTurn(
    async ({
      resumedTurnId,
      events,
      startedTurnIds,
      openTurnIds,
      steer,
      callTool,
      bbTurnId,
    }) => {
      const originBefore = await callTool();
      const turnsBefore = startedTurnIds().length;
      await steer(resumedTurnId, "creq_23456789ag");

      expect(startedTurnIds()).toHaveLength(turnsBefore);
      expect(openTurnIds()).toEqual([resumedTurnId]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn/input/accepted",
          scope: { kind: "turn", turnId: resumedTurnId },
          clientRequestId: "creq_23456789ag",
        }),
      );
      const originAfter = await callTool();
      expect(originAfter).toBe(originBefore);
      expect(bbTurnId(originAfter)).toBe(resumedTurnId);
    },
  );
}, 60_000);

it("opens a new turn with a new origin for a steer that arrives just after the resumed turn ended", async () => {
  await withResumedTurn(
    async ({
      resumedTurnId,
      events,
      openTurnIds,
      finishTurn,
      steer,
      callTool,
      bbTurnId,
    }) => {
      const resumedOrigin = await callTool();
      await finishTurn();
      expect(openTurnIds()).toEqual([]);

      await steer(resumedTurnId, "creq_23456789ah");

      const [steeredTurnId] = openTurnIds();
      expect(steeredTurnId).toBeDefined();
      expect(steeredTurnId).not.toBe(resumedTurnId);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn/input/accepted",
          scope: { kind: "turn", turnId: steeredTurnId },
          clientRequestId: "creq_23456789ah",
        }),
      );
      const steeredOrigin = await callTool();
      expect(steeredOrigin).not.toBe(resumedOrigin);
      expect(bbTurnId(steeredOrigin)).toBe(steeredTurnId);
    },
  );
}, 60_000);

it("binds native Stop correction to the same assembled resumed turn and rejects a model spoof", async () => {
  await withResumedTurn(
    async ({
      resumedTurnId,
      checkStop,
      callReserved,
      bbTurnId,
      openTurnIds,
      finishTurn,
      startedTurnIds,
    }) => {
      expect(await callReserved()).toMatchObject({ isError: true });
      const before = startedTurnIds();
      const checked = await checkStop();
      expect(checked.output).toEqual({
        decision: "block",
        reason: "Use the native question tool.",
      });
      expect(bbTurnId(checked.origin)).toBe(resumedTurnId);
      expect(openTurnIds()).toEqual([resumedTurnId]);
      await finishTurn();
      expect(startedTurnIds()).toEqual(before);
      expect(openTurnIds()).toEqual([]);
    },
  );
}, 60_000);

it("does no Stop round-trip when pre-completion hooks are off", async () => {
  vi.stubEnv("BB_PRE_COMPLETION_HOOKS", "");
  await withResumedTurn(async ({ checkStopInert, finishTurn }) => {
    const { output, roundTrips } = await checkStopInert();
    expect(roundTrips).toBe(0);
    expect(output).not.toMatchObject({ decision: "block" });
    await finishTurn();
  });
}, 60_000);
