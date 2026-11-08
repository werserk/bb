import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
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
      push(
        assistantText("msg_head", `started ${String(input.message.content)}`),
      );
      push(successResult());
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
      initializationResult: vi.fn(),
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

it("maps a tool call in a turn the SDK resumes on its own to that live turn", async () => {
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
  let drained = 0;
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
  const openTurnIds = () => {
    const completed = new Set(
      events.flatMap((event) =>
        event.type === "turn/completed" && event.scope.kind === "turn"
          ? [event.scope.turnId]
          : [],
      ),
    );
    return startedTurnIds().filter((turnId) => !completed.has(turnId));
  };
  const startedTurnIds = (): string[] =>
    events.flatMap((event) =>
      event.type === "turn/started" && event.scope.kind === "turn"
        ? [event.scope.turnId]
        : [],
    );

  try {
    bridge.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd: workspaceDir,
      options: OPTIONS,
      dynamicTools: [
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

    pushToToolQuery(
      asSdkMessage({
        type: "user",
        session_id: SESSION_ID,
        uuid: "task-notification",
        parent_tool_use_id: null,
        message: {
          role: "user",
          content: "<task-notification>gate finished</task-notification>",
        },
      }),
    );
    pushToToolQuery(
      assistantText("msg_resume", "the gate finished; reporting"),
    );
    await settle();
    const resumedTurnId = startedTurnIds()[1];
    expect(resumedTurnId).toBeDefined();
    expect(resumedTurnId).not.toBe(clientTurnId);
    expect(openTurnIds()).toEqual([resumedTurnId]);

    const server = calls[0]?.options.mcpServers?.["bb-bridge"];
    expect(server).toBeDefined();
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server!.instance.connect(serverTransport);
    await client.connect(clientTransport);
    void client
      .callTool({ name: "wprojects_outcome", arguments: {} })
      .catch(() => undefined);
    await vi.waitFor(() =>
      expect(
        bridge.messages.some((message) => message.method === "item/tool/call"),
      ).toBe(true),
    );
    const toolCall = bridge.messages.find(
      (message) => message.method === "item/tool/call",
    );
    const origin = (toolCall?.params as { turnId: string }).turnId;

    expect(collector.assembler.getBbTurnId(THREAD_ID, origin)).toBe(
      resumedTurnId,
    );
  } finally {
    await client.close().catch(() => undefined);
    bridge.restore();
    rmSync(workspaceDir, { recursive: true, force: true });
  }
}, 60_000);
