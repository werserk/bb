import { ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Options,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

const mockQueryInstance = {
  initializationResult: vi.fn().mockResolvedValue({}),
  applyFlagSettings: vi.fn(),
  close: vi.fn(),
  interrupt: vi.fn(),
  setModel: vi.fn(),
  setPermissionMode: vi.fn(),
  [Symbol.asyncIterator]: vi.fn(),
};
const { queryMock, spawnMock, recordingMock, recordMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  recordingMock: vi.fn(() => false),
  recordMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock("@get-bb/plugin-sdk/process", () => ({
  experimental_spawnHostProcess: spawnMock,
}));

vi.mock("@get-bb/plugin-sdk/provider-bridge", () => ({
  experimental_isProviderBridgeRecording: recordingMock,
  experimental_recordProviderChildIo: recordMock,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

import { SdkSession, type SdkSessionOptions } from "../sdk-session.js";

const defaultOptions: SdkSessionOptions = {
  cwd: "/tmp/test",
  systemPrompt: "You are a test assistant.",
  allowBypassPermissions: false,
};

interface ClaudeQueryPromptCall {
  options: Options;
  prompt: AsyncIterable<SDKUserMessage>;
}

function isClaudeQueryPromptCall(
  value: unknown,
): value is ClaudeQueryPromptCall {
  return (
    value !== null &&
    typeof value === "object" &&
    "options" in value &&
    "prompt" in value
  );
}

function getLatestQueryCall(): ClaudeQueryPromptCall {
  const latestCall = queryMock.mock.calls.at(-1)?.[0];
  if (!isClaudeQueryPromptCall(latestCall)) {
    throw new Error("Expected Claude SDK query call");
  }
  return latestCall;
}

function getLatestPrompt(): AsyncIterable<SDKUserMessage> {
  return getLatestQueryCall().prompt;
}

function keepSdkStreamOpen(): void {
  mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
    next: vi.fn(() => new Promise<IteratorResult<SDKMessage>>(() => {})),
    return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
  });
}

function mockProcessUid(uid: number): void {
  vi.spyOn(process, "getuid").mockReturnValue(uid);
}

function waitForAsyncWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SdkSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingMock.mockReturnValue(false);
    mockQueryInstance.initializationResult.mockResolvedValue({});
    queryMock.mockImplementation(() => mockQueryInstance);
    mockQueryInstance.applyFlagSettings.mockResolvedValue(undefined);
    mockQueryInstance.interrupt.mockResolvedValue(undefined);
    mockQueryInstance.setModel.mockResolvedValue(undefined);
    mockQueryInstance.setPermissionMode.mockResolvedValue(undefined);
    mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
      next: vi.fn().mockResolvedValue({ value: undefined, done: true }),
      return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "waits for child termination with recording=%s",
    async (recording) => {
      recordingMock.mockReturnValue(recording);
      const child = new ChildProcess();
      Object.defineProperty(child, "pid", { value: 123 });
      spawnMock.mockReturnValue(child);
      queryMock.mockImplementation(({ options }: ClaudeQueryPromptCall) => {
        options.spawnClaudeCodeProcess?.({
          command: "fake",
          args: [],
          env: {},
          signal: new AbortController().signal,
        });
        return mockQueryInstance;
      });
      const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
      session.start();
      await waitForAsyncWork();
      let stopped = false;
      const closing = session.stopAndWait(1_000).then(() => {
        stopped = true;
      });
      await waitForAsyncWork();
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(recordMock).toHaveBeenCalledTimes(recording ? 1 : 0);
      expect(stopped).toBe(false);
      child.emit("close", 0, null);
      await closing;
      expect(stopped).toBe(true);
    },
  );

  it("keeps an unresolved child owned after timeout and permits confirmed later closure", async () => {
    vi.useFakeTimers();
    const child = new ChildProcess();
    Object.defineProperty(child, "pid", { value: 123 });
    spawnMock.mockReturnValue(child);
    queryMock.mockImplementation(({ options }: ClaudeQueryPromptCall) => {
      options.spawnClaudeCodeProcess?.({
        command: "fake",
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      return mockQueryInstance;
    });
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    try {
      session.start();
      const closing = session.stopAndWait(100);
      const rejected = expect(closing).rejects.toThrow(
        "termination was not confirmed",
      );
      child.emit("error", new Error("signal failed"));
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      child.emit("close", 0, null);
      await session.stopAndWait(100);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a failed spawn with no child PID without waiting for a close deadline", async () => {
    const child = new ChildProcess();
    spawnMock.mockReturnValue(child);
    queryMock.mockImplementation(({ options }: ClaudeQueryPromptCall) => {
      options.spawnClaudeCodeProcess?.({
        command: "missing",
        args: [],
        env: {},
        signal: new AbortController().signal,
      });
      return mockQueryInstance;
    });
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    child.emit("error", new Error("ENOENT"));
    await session.stopAndWait(100);
  });

  it("stops a never-started session and refuses a delayed spawn after Stop", async () => {
    const neverStarted = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    await neverStarted.stopAndWait(100);
    keepSdkStreamOpen();
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    await session.stopAndWait(100);
    expect(() =>
      getLatestQueryCall().options.spawnClaudeCodeProcess?.({
        command: "fake",
        args: [],
        env: {},
        signal: new AbortController().signal,
      }),
    ).toThrow("stopped before process start");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("holds FIFO input until the captured query initializes", async () => {
    keepSdkStreamOpen();
    let ready!: () => void;
    mockQueryInstance.initializationResult.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    const iterator = getLatestPrompt()[Symbol.asyncIterator]();
    const received: string[] = [];
    const first = iterator.next().then((item) => {
      received.push(JSON.stringify(item.value));
      return item;
    });
    const one = session.pushInput("first");
    const two = session.pushInput("second");
    await waitForAsyncWork();
    expect(received).toEqual([]);
    ready();
    expect((await first).value.message.content).toBe("first");
    expect((await iterator.next()).value.message.content).toBe("second");
    await Promise.all([one, two]);
    expect(mockQueryInstance.initializationResult).toHaveBeenCalledTimes(1);
    session.stop();
  });

  it("rejects initialization failure without yielding input", async () => {
    keepSdkStreamOpen();
    let fail!: (error: Error) => void;
    mockQueryInstance.initializationResult.mockReturnValue(
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    const consumed = session.pushInput("original");
    const assertion = expect(consumed).rejects.toThrow(
      "busy before initialization",
    );
    fail(new Error("busy before initialization"));
    await assertion;
    session.stop();
    expect((await getLatestPrompt()[Symbol.asyncIterator]().next()).done).toBe(
      true,
    );
  });

  it("settles a readiness waiter on Stop even if SDK initialization never settles", async () => {
    keepSdkStreamOpen();
    mockQueryInstance.initializationResult.mockReturnValue(
      new Promise(() => {}),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    const consumed = session.pushInput("original");
    const assertion = expect(consumed).rejects.toThrow(
      "stopped before input consumed",
    );
    session.stop();
    await assertion;
    expect((await getLatestPrompt()[Symbol.asyncIterator]().next()).done).toBe(
      true,
    );
  });

  it("refuses input when readiness belongs to a replaced query", async () => {
    keepSdkStreamOpen();
    let ready!: () => void;
    mockQueryInstance.initializationResult.mockReturnValue(
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    const consumed = session.pushInput("stale");
    const assertion = expect(consumed).rejects.toThrow(
      "input stream is closed",
    );
    queryMock.mockReturnValue({
      ...mockQueryInstance,
      initializationResult: () => Promise.resolve({}),
    });
    session.start();
    ready();
    await assertion;
    session.stop();
  });

  it("settles readiness waiters when the SDK output stream ends", async () => {
    mockQueryInstance.initializationResult.mockReturnValue(
      new Promise(() => {}),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    await expect(session.pushInput("never delivered")).rejects.toThrow(
      "stream ended before input consumed",
    );
  });

  it("handles rejected initialization without submitted input", async () => {
    keepSdkStreamOpen();
    mockQueryInstance.initializationResult.mockRejectedValue(
      new Error("startup failed"),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    await waitForAsyncWork();
    session.stop();
  });

  it("preserves injected question aliases alongside native tool exclusions", () => {
    const toolAliases = { AskUserQuestion: "mcp__bb__bb_ask_question" };
    const session = new SdkSession(
      { ...defaultOptions, toolAliases, disallowedTools: ["AskUserQuestion"] },
      vi.fn(),
      vi.fn(),
    );
    session.start();
    expect(getLatestQueryCall().options.toolAliases).toEqual(toolAliases);
    expect(getLatestQueryCall().options.disallowedTools).toEqual([
      "AskUserQuestion",
    ]);
    session.stop();
  });

  it("omits question aliases when none are supplied", () => {
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    session.start();
    expect(getLatestQueryCall().options).not.toHaveProperty("toolAliases");
    session.stop();
  });

  it("rejects queued input when the SDK input stream closes before consumption", async () => {
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());
    keepSdkStreamOpen();
    session.start();
    const consumed = session.pushInput("hello");
    await waitForAsyncWork();
    session.stop();
    expect(session.canPushInput()).toBe(false);

    await expect(consumed).rejects.toThrow(
      "Claude SDK session stopped before input consumed",
    );
  });

  it("interrupts the running turn before ending SDK input during graceful close", async () => {
    let finishStream:
      | ((result: IteratorResult<SDKMessage>) => void)
      | undefined;
    const next = vi.fn(
      () =>
        new Promise<IteratorResult<SDKMessage>>((resolve) => {
          finishStream = resolve;
        }),
    );
    mockQueryInstance[Symbol.asyncIterator].mockReturnValue({
      next,
      return: vi.fn().mockResolvedValue({ value: undefined, done: true }),
    });
    let finishInterrupt: (() => void) | undefined;
    mockQueryInstance.interrupt.mockReturnValue(
      new Promise<void>((resolve) => {
        finishInterrupt = resolve;
      }),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());

    session.start();
    const pendingInput = getLatestPrompt()[Symbol.asyncIterator]().next();
    let inputResolved = false;
    void pendingInput.then(() => {
      inputResolved = true;
    });
    const closePromise = session.closeGracefully(1_000);
    await waitForAsyncWork();

    expect(mockQueryInstance.interrupt).toHaveBeenCalledOnce();
    expect(inputResolved).toBe(false);
    if (!finishInterrupt) {
      throw new Error("Expected Claude SDK interrupt to be pending");
    }
    finishInterrupt();
    await expect(pendingInput).resolves.toEqual({
      value: undefined,
      done: true,
    });
    if (!finishStream) {
      throw new Error("Expected Claude SDK stream to be pending");
    }
    finishStream({ value: undefined, done: true });
    await closePromise;
    expect(mockQueryInstance.close).not.toHaveBeenCalled();
  });

  it("force-stops the session when the interrupt request fails during graceful close", async () => {
    keepSdkStreamOpen();
    mockQueryInstance.interrupt.mockRejectedValue(
      new Error("Claude CLI transport closed"),
    );
    const session = new SdkSession(defaultOptions, vi.fn(), vi.fn());

    session.start();
    await session.closeGracefully(60_000);
    expect(mockQueryInstance.close).toHaveBeenCalledOnce();
  });

  it("forwards an explicit Claude Code executable path to the SDK", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          pathToClaudeCodeExecutable: "/usr/local/bin/claude",
        }),
      }),
    );
  });

  it("passes non-bypass permission modes through without the dangerous skip flag", () => {
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "acceptEdits",
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "acceptEdits",
        }),
      }),
    );
    expect(queryMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("only enables dangerous permission skipping for bypass mode", () => {
    if (process.platform !== "win32") mockProcessUid(1000);
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "bypassPermissions",
        allowBypassPermissions: true,
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("launches full access sessions that start in plan mode able to switch to bypass mode", () => {
    if (process.platform !== "win32") mockProcessUid(1000);
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "plan",
        allowBypassPermissions: true,
      },
      vi.fn(),
      vi.fn(),
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "plan",
          allowDangerouslySkipPermissions: true,
        }),
      }),
    );
  });

  it("does not send root-forbidden bypass flags when running as root", ({
    skip,
  }) => {
    skip(process.platform === "win32", "Windows has no root uid");
    mockProcessUid(0);
    const onMessage = vi.fn();
    const onDone = vi.fn();
    const session = new SdkSession(
      {
        ...defaultOptions,
        permissionMode: "bypassPermissions",
        allowBypassPermissions: true,
      },
      onMessage,
      onDone,
    );

    session.start();

    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          permissionMode: "default",
        }),
      }),
    );
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty(
      "allowDangerouslySkipPermissions",
    );
  });
});
