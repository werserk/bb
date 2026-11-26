import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";
import {
  cleanupBridgeProcessTest,
  spawnedAppServerPids,
  waitForAppServerChildrenToExit,
} from "./bridge-process.test-support.js";

let harness: ReturnType<typeof createHarness>;
let workspaceDir: string;
let processLogPath: string;
let scriptPath: string;
let launchLogPath: string;
let requestLogPath: string;
let writerLockPath: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "bb-stop-activation-"));
  processLogPath = join(workspaceDir, "process.log");
  scriptPath = join(workspaceDir, "scenario.json");
  launchLogPath = join(workspaceDir, "launch.jsonl");
  requestLogPath = join(workspaceDir, "requests.jsonl");
  writerLockPath = join(workspaceDir, "writer.lock");
  vi.stubEnv("CODEX_OPENAI_BASE_URL", "");
  vi.stubEnv("CODEX_POOL_AUTH_TOKEN", "");
  vi.stubEnv("BB_PRE_COMPLETION_HOOKS", "1");
  stubFakeCodexAppServer(scriptPath);
  harness = createHarness(handleLine);
});

afterEach(async () => {
  await cleanupBridgeProcessTest({
    harness,
    workspaceDir,
    processLogPath,
    threadId: "bb-activation-failure",
    providerThreadId: "cleanup",
    cleanupId: 99,
    unstubEnvs: () => vi.unstubAllEnvs(),
  });
});

it.each(["recheck", "verify"])(
  "fails construction and releases forced-hook child on %s rejection",
  async (phase) => {
    writeFileSync(
      scriptPath,
      JSON.stringify({
        processLogPath,
        launchLogPath,
        requestLogPath,
        writerLockPath,
        hookActivationFailure: phase,
      }),
    );
    harness.sendRequest(1, "thread/start", {
      threadId: "bb-activation-failure",
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    const response = await harness.waitForResponse(1);
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain(
      phase === "recheck" ? "Conflicting or unknown" : "not trusted",
    );
    await waitForAppServerChildrenToExit(processLogPath);
    expect(spawnedAppServerPids(processLogPath)).toHaveLength(2);
    expect(existsSync(writerLockPath)).toBe(false);
    const launches = readFileSync(launchLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) =>
        z.object({ args: z.array(z.string()) }).parse(JSON.parse(line)),
      );
    expect(launches[0].args).toEqual([scriptPath]);
    expect(launches[1].args).toContain("features.hooks=true");
    const flag = launches[1].args.find((arg) => arg.startsWith("hooks.Stop="))!;
    const command = z
      .string()
      .parse(
        JSON.parse(
          flag.slice(flag.indexOf("command=") + 8, flag.indexOf(",timeout=")),
        ),
      );
    const client = command.split("'")[3];
    expect(client).toMatch(/\/bb-stop-[^/]+\/hook\.cjs$/);
    expect(existsSync(dirname(client))).toBe(false);
    const requests = readFileSync(requestLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => z.object({ method: z.string() }).parse(JSON.parse(line)));
    expect(requests.filter((r) => r.method === "thread/start")).toHaveLength(
      phase === "recheck" ? 0 : 1,
    );
    expect(requests.some((r) => r.method === "turn/start")).toBe(false);

    writeFileSync(
      scriptPath,
      JSON.stringify({ processLogPath, launchLogPath, writerLockPath }),
    );
    harness.sendRequest(2, "thread/start", {
      threadId: "bb-activation-failure",
      cwd: workspaceDir,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    expect((await harness.waitForResponse(2)).error).toBeUndefined();
    const retryLaunch = z
      .object({ args: z.array(z.string()) })
      .parse(
        JSON.parse(
          readFileSync(launchLogPath, "utf8").trim().split("\n").at(-1)!,
        ),
      );
    expect(retryLaunch.args).toEqual(launches[0].args);
    expect(JSON.stringify(harness.messages)).not.toContain("provider.warning");
  },
  15000,
);

it("is inert when pre-completion hooks are off: no probe, hook, restart or config", async () => {
  vi.stubEnv("BB_PRE_COMPLETION_HOOKS", "");
  writeFileSync(
    scriptPath,
    JSON.stringify({ processLogPath, launchLogPath, requestLogPath }),
  );
  harness.sendRequest(1, "thread/start", {
    threadId: "bb-activation-failure",
    cwd: workspaceDir,
    instructionMode: "append",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });
  expect((await harness.waitForResponse(1)).error).toBeUndefined();
  expect(spawnedAppServerPids(processLogPath)).toHaveLength(1);
  const launches = readFileSync(launchLogPath, "utf8").trim().split("\n");
  expect(launches).toHaveLength(1);
  expect(
    z.object({ args: z.array(z.string()) }).parse(JSON.parse(launches[0])).args,
  ).toEqual([scriptPath]);
  const requests = readFileSync(requestLogPath, "utf8")
    .trim()
    .split("\n")
    .map((line) =>
      z
        .object({
          method: z.string(),
          params: z.record(z.string(), z.unknown()),
        })
        .parse(JSON.parse(line)),
    );
  expect(requests.filter((r) => r.method === "hooks/list")).toEqual([]);
  expect(
    requests.filter(
      (r) => r.method === "config/read" && r.params.includeLayers === true,
    ),
  ).toEqual([]);
  const start = requests.find((r) => r.method === "thread/start");
  expect(start).toBeDefined();
  expect(JSON.stringify(start?.params.config ?? {})).not.toMatch(/hooks|Stop/);
}, 15000);
