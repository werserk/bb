import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  HookInput,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { JsonValue } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: unknown) => queryMock(args),
  createSdkMcpServer: vi.fn(() => ({})),
  tool: vi.fn((_name, _desc, _schema, handler) => handler),
}));

import { handleLine } from "../bridge.js";
import { buildSessionOptions } from "../session-options.js";
import { PLAN_TURN_CHECK_REASON } from "../plan-turn-check.js";

type SessionHooks = NonNullable<
  ReturnType<typeof buildSessionOptions>["hooks"]
>;

interface QueryCall {
  options: { hooks?: SessionHooks };
  prompt: AsyncIterable<SDKUserMessage>;
}

interface ControlledQuery {
  emit(message: Record<string, unknown>): void;
  finish(): void;
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage>;
}

function createControlledQuery(): ControlledQuery & Record<string, unknown> {
  const pending: IteratorResult<SDKMessage>[] = [];
  let resolveNext: ((result: IteratorResult<SDKMessage>) => void) | undefined;
  const push = (result: IteratorResult<SDKMessage>): void => {
    const resolve = resolveNext;
    resolveNext = undefined;
    if (resolve) resolve(result);
    else pending.push(result);
  };
  const iterator: AsyncIterator<SDKMessage> = {
    next: () => {
      const result = pending.shift();
      if (result) return Promise.resolve(result);
      return new Promise((resolve) => {
        resolveNext = resolve;
      });
    },
    return: async () => ({ value: undefined, done: true }),
  };
  return {
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(() => push({ value: undefined, done: true })),
    emit(message) {
      push({ value: message as unknown as SDKMessage, done: false });
    },
    finish() {
      push({ value: undefined, done: true });
    },
    mcpServerStatus: vi.fn().mockResolvedValue([]),
    getContextUsage: vi.fn().mockResolvedValue(null),
    initializationResult: vi.fn().mockResolvedValue({}),
    interrupt: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    supportedCommands: vi.fn().mockResolvedValue([]),
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };
}

function latestHooks(): SessionHooks {
  const call = queryMock.mock.calls.at(-1)?.[0] as QueryCall | undefined;
  if (!call?.options.hooks) throw new Error("Expected Claude SDK hooks");
  return call.options.hooks;
}

function latestPrompt(): AsyncIterable<SDKUserMessage> {
  const call = queryMock.mock.calls.at(-1)?.[0] as QueryCall | undefined;
  if (!call) throw new Error("Expected a Claude SDK query");
  return call.prompt;
}

function options(chromeEnabled = false): Record<string, JsonValue> {
  return {
    permissionMode: "accept-edits",
    permissionScope: "workspace",
    approvalReviewer: "user",
    permissionEscalation: "ask",
    instructions: "test",
    providerOptions: { workflowsEnabled: false, chromeEnabled },
  };
}

const common = { session_id: "s", transcript_path: "/t", cwd: "/" };

async function fire(input: HookInput): Promise<unknown> {
  const event = input.hook_event_name as "PostToolUse" | "Stop";
  let last: unknown;
  for (const matcher of latestHooks()[event] ?? []) {
    for (const hook of matcher.hooks) {
      last = await hook(input, undefined, {
        signal: new AbortController().signal,
      });
    }
  }
  return last;
}

async function postPendingPlan(): Promise<void> {
  await fire({
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__bb-bridge__bb_update_plan",
    tool_input: {
      plan: [
        { step: "Build", status: "completed" },
        { step: "Report", status: "pending" },
      ],
    },
    tool_response: "ok",
    tool_use_id: "tu-plan",
  } as HookInput);
}

async function stopDecision(promptId: string): Promise<string | undefined> {
  const result = (await fire({
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
    prompt_id: promptId,
  } as HookInput)) as { decision?: string; reason?: string };
  if (result.decision === "block") {
    expect(result.reason).toBe(PLAN_TURN_CHECK_REASON);
  }
  return result.decision;
}

function system(subtype: string, fields: Record<string, unknown>) {
  return {
    type: "system",
    subtype,
    uuid: `u-${subtype}`,
    session_id: "s",
    ...fields,
  };
}

describe("claude-code plan turn check with background work", () => {
  const threadId = "thread-plan-check";
  let bridge: ReturnType<typeof createBridgeJsonRpcTestHarness>;
  let queries: ReturnType<typeof createControlledQuery>[];

  beforeEach(async () => {
    vi.clearAllMocks();
    queries = [];
    queryMock.mockImplementation(() => {
      const query = createControlledQuery();
      queries.push(query);
      return query;
    });
    bridge = createBridgeJsonRpcTestHarness(handleLine);
    bridge.sendRequest(1, "thread/start", {
      threadId,
      cwd: "/tmp/worktree",
      instructionMode: "append",
      options: options(),
    });
    await bridge.waitForResponse(1);
    await postPendingPlan();
  });

  afterEach(async () => {
    bridge.sendRequest(99, "thread/stop", {
      threadId,
      providerThreadId: threadId,
      intent: "interrupt",
      activeTurnId: null,
    });
    await bridge.flushWork();
    queries.forEach((query) => query.finish());
    await bridge.waitForResponse(99);
    bridge.restore();
  });

  async function emit(message: Record<string, unknown>): Promise<void> {
    queries.at(-1)?.emit(message);
    await bridge.flushWork();
  }

  it("Gate running in the background", async () => {
    await emit(
      system("task_started", {
        task_id: "gate",
        description: "Run the gates",
        task_type: "local_bash",
        is_backgrounded: true,
      }),
    );

    expect(await stopDecision("p1")).toBeUndefined();
  });

  it("Moved to the background", async () => {
    await emit(
      system("task_started", {
        task_id: "build",
        description: "Build",
        task_type: "local_bash",
        is_backgrounded: false,
      }),
    );
    await emit(
      system("task_updated", {
        task_id: "build",
        patch: { is_backgrounded: true },
      }),
    );

    expect(await stopDecision("p1")).toBeUndefined();
  });

  it("Finished through a task update", async () => {
    await emit(
      system("task_started", {
        task_id: "watch",
        description: "Watch",
        task_type: "monitor",
      }),
    );
    expect(await stopDecision("p1")).toBeUndefined();

    await emit(
      system("task_updated", {
        task_id: "watch",
        patch: { status: "completed" },
      }),
    );

    expect(await stopDecision("p1")).toBe("block");
    expect(await stopDecision("p1")).toBeUndefined();
  });

  it("Background task finished", async () => {
    for (const [taskId, status] of [
      ["a", "completed"],
      ["b", "failed"],
      ["c", "stopped"],
    ] as const) {
      await emit(
        system("task_started", {
          task_id: taskId,
          description: taskId,
          task_type: "local_bash",
        }),
      );
      await emit(
        system("task_notification", {
          task_id: taskId,
          status,
          output_file: "",
          summary: `${taskId} ${status}`,
        }),
      );
    }

    expect(await stopDecision("p1")).toBe("block");
    expect(await stopDecision("p1")).toBeUndefined();
  });

  it("Interrupted", async () => {
    await emit(
      system("task_started", {
        task_id: "gate",
        description: "Run the gates",
        task_type: "local_bash",
      }),
    );
    expect(await stopDecision("p1")).toBeUndefined();

    queries.at(-1)?.finish();
    await bridge.flushWork();

    expect(await stopDecision("p2")).toBe("block");
    expect(await stopDecision("p2")).toBeUndefined();
  });

  it("Replaced session starts closed", async () => {
    await emit(
      system("task_started", {
        task_id: "gate",
        description: "Run the gates",
        task_type: "local_bash",
      }),
    );
    expect(await stopDecision("p1")).toBeUndefined();

    bridge.sendRequest(2, "turn/start", {
      threadId,
      providerThreadId: threadId,
      clientRequestId: "creq_abcdefghjk",
      input: [{ type: "text", text: "restart please" }],
      options: options(true),
    });
    await bridge.flushWork();
    expect(queries).toHaveLength(2);
    expect(
      bridge.messages.some((message) => message.method === "session/replaced"),
    ).toBe(true);
    await latestPrompt()[Symbol.asyncIterator]().next();
    await bridge.waitForResponse(2);

    expect(await stopDecision("p2")).toBe("block");
    expect(await stopDecision("p2")).toBeUndefined();
  });
});
