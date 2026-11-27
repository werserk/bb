import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createProcessLifeline } from "@bb/test-helpers";
import { createAgentRuntime } from "./runtime.js";
import {
  createScriptedEchoLaunch,
  fullRuntimeOptions,
  waitForRuntimeState,
  withBridgeLaunch,
} from "./test/runtime-test-harness.js";
import type { AgentRuntime } from "./types.js";

const acpBridgeModulePath = fileURLToPath(
  new URL("../../provider-bridge-acp/src/bridge/bridge.ts", import.meta.url),
);
const fakeAgentPath = fileURLToPath(
  new URL(
    "../../provider-bridge-acp/src/bridge/fake-acp-agent.mjs",
    import.meta.url,
  ),
);

describe("acp process topology", () => {
  let workspaceDir: string;
  const runtimes: AgentRuntime[] = [];

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "bb-acp-topology-"));
  });

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("reaps the agent under construction when the runtime times out thread construction", async () => {
    const setTimeoutReal = setTimeout;
    const readyFile = join(workspaceDir, "agent-ready");
    const lifeline = await createProcessLifeline();
    onTestFinished(() => lifeline.close());
    const lifelinePreloadPath = join(workspaceDir, "agent-lifeline.mjs");
    writeFileSync(lifelinePreloadPath, lifeline.holdSource("agent"));
    const runtime = withBridgeLaunch(
      createAgentRuntime({
        workspacePath: workspaceDir,
        env: {},
        onEvent: () => {},
        onProcessExit: () => {},
        onToolCall: async () => ({ contentItems: [], success: true }),
        threadCreation: { requestTimeoutMs: 300 },
      }),
      createScriptedEchoLaunch({
        pluginId: "provider-acp",
        digest: "acp-v1",
        modulePath: acpBridgeModulePath,
        capabilities: { fork: "tip" },
        providerOptions: {
          acpLaunchSpec: {
            displayName: "Fake ACP",
            command: process.execPath,
            args: [
              "--import",
              pathToFileURL(lifelinePreloadPath).href,
              fakeAgentPath,
            ],
            env: {
              FAKE_ACP_SESSION_NEW_DELAY_MS: "60000",
              FAKE_ACP_READY_FILE: readyFile,
            },
          },
        },
      }),
    );
    runtimes.push(runtime);

    await runtime.ensureProvider({ providerId: "acp" });
    const constructionDeadlines: Array<() => void> = [];
    const constructionTimeout = vi
      .fn<typeof setTimeout>()
      .mockImplementation((callback, delay, ...args) => {
        if (delay !== 300) return setTimeoutReal(callback, delay, ...args);
        const timer = setTimeoutReal(callback, 60_000, ...args);
        constructionDeadlines.push(() => {
          clearTimeout(timer);
          callback(...args);
        });
        return timer;
      });
    vi.stubGlobal("setTimeout", constructionTimeout);
    try {
      const outcome = runtime
        .startThread({
          environmentId: "env-1",
          projectId: "p1",
          providerId: "acp",
          threadId: "t1",
          options: fullRuntimeOptions,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await waitForRuntimeState({
        label: "the agent and its construction deadline are ready",
        predicate: () =>
          existsSync(readyFile) && constructionDeadlines.length === 1,
        timeoutMs: 10_000,
      });
      vi.unstubAllGlobals();
      const expire = constructionDeadlines[0];
      if (expire === undefined)
        throw new Error("No construction deadline was armed");
      expire();
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/timed out/i);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(runtime.hasThread("t1")).toBe(false);
    const [agent] = await lifeline.waitForHolders(1);
    await agent?.exited;
    expect(runtime.listRunningProviders()).toEqual([]);
  }, 30_000);

  it("keeps queue-mode ACP auto input out of the bridge while explicit steer retains queue/cancel behavior", async () => {
    const promptLog = join(workspaceDir, "steer-prompts.jsonl");
    const accepted: string[] = [];
    const runtime = withBridgeLaunch(
      createAgentRuntime({
        workspacePath: workspaceDir,
        env: {},
        onEvent: (event) => {
          if (event.type === "turn/input/accepted")
            accepted.push(event.clientRequestId);
        },
        onProcessExit: () => {},
        onToolCall: async () => ({ contentItems: [], success: true }),
      }),
      createScriptedEchoLaunch({
        pluginId: "provider-acp",
        digest: "acp-auto-steer-guard",
        modulePath: acpBridgeModulePath,
        capabilities: { fork: "tip" },
        providerOptions: {
          acpLaunchSpec: {
            displayName: "Fake ACP",
            command: process.execPath,
            args: [fakeAgentPath],
            env: { FAKE_ACP_PROMPT_LOG: promptLog },
          },
        },
      }),
    );
    runtimes.push(runtime);
    await runtime.ensureProvider({ providerId: "acp" });
    await runtime.startThread({
      environmentId: "env-1",
      projectId: "p1",
      providerId: "acp",
      threadId: "t1",
      options: fullRuntimeOptions,
    });
    await runtime.runTurn({
      threadId: "t1",
      clientRequestId: "creq_23456789ab",
      input: [{ type: "text", text: "hang", mentions: [] }],
      options: fullRuntimeOptions,
    });
    await waitForRuntimeState({
      label: "real ACP prompt is active",
      predicate: () =>
        runtime.getActiveTurnId("t1") !== null && existsSync(promptLog),
      timeoutMs: 10000,
    });
    const expectedTurnId = runtime.getActiveTurnId("t1")!;
    const before = readFileSync(promptLog, "utf8");
    await expect(
      runtime.steerTurn({
        threadId: "t1",
        expectedTurnId,
        clientRequestId: "creq_23456789ac",
        injectOnly: true,
        input: [{ type: "text", text: "automatic answer", mentions: [] }],
        options: fullRuntimeOptions,
      }),
    ).resolves.toEqual({ status: "busy", activeTurnId: expectedTurnId });
    expect(runtime.getActiveTurnId("t1")).toBe(expectedTurnId);
    expect(readFileSync(promptLog, "utf8")).toBe(before);
    expect(accepted).not.toContain("creq_23456789ac");
    await expect(
      runtime.steerTurn({
        threadId: "t1",
        expectedTurnId,
        clientRequestId: "creq_23456789ad",
        input: [{ type: "text", text: "explicit steer", mentions: [] }],
        options: fullRuntimeOptions,
      }),
    ).resolves.toEqual({ status: "steered" });
    await waitForRuntimeState({
      label: "explicit steer uses real ACP queue/cancel",
      predicate: () =>
        readFileSync(promptLog, "utf8").includes("explicit steer"),
      timeoutMs: 10000,
    });
    expect(accepted).toContain("creq_23456789ad");
  });
});
