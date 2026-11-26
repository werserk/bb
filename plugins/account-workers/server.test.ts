import { createFakePluginHost, makeHostResponse, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { MOVED_INSTRUCTIONS, OTHER_PROVIDER_INSTRUCTIONS } from "./server.js";
import { PROFILES } from "./profiles/index.js";
import type { ProviderProfile } from "./profiles/types.js";
import type { Binding } from "./bindings.js";
import { callWorkspace, NO_BINDING, SAME_HOST, TOOL_NAMES } from "./tools.js";

const WORKER = "host-worker";
const WORKSPACE = "host-workspace";
const OTHER = "host-other";
const SCRATCH = "/state/bb-account-workers/scratch/aw_x";

function text(result: PluginAgentToolResult): string {
  if (typeof result === "string") return result;
  return result.content.map((part) => ("text" in part ? part.text : "")).join("");
}

type HostRpc = (call: ExperimentalFakeHostRpcCall) => unknown;

async function load(hostRpc: HostRpc) {
  const host = createFakePluginHost({ pluginId: "account-workers", experimental_callHostRpc: hostRpc });
  await plugin(host.bb);
  host.harness.sdk.stub("hosts.list", async () => [
    makeHostResponse({ id: WORKER, name: "worker", status: "connected" }),
    makeHostResponse({ id: WORKSPACE, name: "workspace", status: "connected" }),
    makeHostResponse({ id: OTHER, name: "other", status: "connected" }),
  ]);
  stubMachineEnv(host, [], []);
  return host;
}

function stubMachineEnv(host: { harness: { sdk: { stub: (method: string, fn: (...args: never[]) => unknown) => void } } }, project: string[], global: string[]) {
  const vars = (names: string[]) => names.map((name) => ({ name, value: null, secret: true as const, note: null }));
  host.harness.sdk.stub("projects.machineEnvironment", async () => ({
    builtInGit: { status: "disabled" as const, statusMessage: "" },
    variables: vars(project),
    inheritedVariables: vars(global),
  }));
}

function defaultRpc(overrides: Record<string, unknown> = {}): HostRpc {
  return (call) => {
    if (call.method in overrides) {
      const value = overrides[call.method];
      if (value instanceof Error) throw value;
      return typeof value === "function" ? (value as HostRpc)(call) : value;
    }
    switch (call.method) {
      case "resolveRoot":
        return { ok: true, root: "/work/repo", hostname: "ws", instructions: [{ file: "AGENTS.md", text: "MARKER ```x```", truncated: false }] };
      case "prepareScratch":
        return { ok: true, path: SCRATCH };
      default:
        throw new Error(`unexpected ${call.method}`);
    }
  };
}

async function spawnBound(host: Awaited<ReturnType<typeof load>>, threadId = "thread-new", extra: string[] = []) {
  host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: threadId }));
  const result = await host.harness.behavior.runCli(
    ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1", "--json", ...extra],
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as { threadId: string; bindingId: string };
}

function context(threadId: string, hostId: string, envPath: string | null, providerId = "claude-code") {
  return makePluginAgentConfigurationContext({ thread: { id: threadId }, host: { id: hostId }, environment: { path: envPath }, provider: { id: providerId } });
}

describe("spawn and configure", () => {
  it("spawns the thread on the worker in the scratch directory and gives it the workspace tools", async () => {
    const host = await load(defaultRpc());
    const spawned = await spawnBound(host);
    const [spawnArgs] = host.harness.sdk.callsTo("threads.spawn")[0] as [Record<string, unknown>];
    expect(spawnArgs).toMatchObject({
      projectId: "p1",
      environment: { type: "host", hostId: WORKER, workspace: { type: "unmanaged", path: SCRATCH } },
    });
    const prepare = host.harness.experimental_hostRpcCalls.find((c) => c.method === "prepareScratch");
    expect(prepare?.hostId).toBe(WORKER);
    expect(prepare?.input).toEqual({ bindingId: spawned.bindingId, profile: "claude", providerId: "claude-code", model: null });
    expect(spawnArgs.providerId).toBe("claude-code");
    expect(spawnArgs).not.toHaveProperty("model");

    const config = await host.harness.behavior.resolveAgentConfiguration(context(spawned.threadId, WORKER, SCRATCH));
    expect(config.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(config.instructions).toContain("MARKER");
    expect(config.instructions).toContain("````markdown");
    expect(config.instructions).toContain("Local file and shell tools are disabled");
  });

  it("removes the binding when spawn fails", async () => {
    const host = await load(defaultRpc());
    host.harness.sdk.stub("threads.spawn", async () => {
      throw new Error("409 managed path");
    });
    const result = await host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1"],
    );
    expect(result.exitCode).not.toBe(0);
    expect((await host.harness.behavior.runCli(["list"])).stdout).toBe("No bindings");
  });

  it("a thread configured in the scratch directory before spawn returns claims the binding; a fork does not", async () => {
    const host = await load(defaultRpc());
    let configured: Awaited<ReturnType<typeof host.harness.behavior.resolveAgentConfiguration>> | null = null;
    host.harness.sdk.stub("threads.spawn", async () => {
      configured = await host.harness.behavior.resolveAgentConfiguration(context("thread-early", WORKER, SCRATCH + "/"));
      return makeThreadResponse({ id: "thread-early" });
    });
    const result = await host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1"],
    );
    expect(result.exitCode).toBe(0);
    expect(configured!.tools).toHaveLength(TOOL_NAMES.length);
    const fork = await host.harness.behavior.resolveAgentConfiguration(context("thread-fork", WORKER, SCRATCH));
    expect(fork.tools).toEqual([]);
  });

  it("drops the binding when its thread is deleted", async () => {
    const host = await load(defaultRpc());
    const { threadId } = await spawnBound(host);
    await host.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: threadId }) });
    expect((await host.harness.behavior.runCli(["list"])).stdout).toBe("No bindings");
  });

  it("an unbound thread gets no tools and a tool call refuses", async () => {
    const host = await load(defaultRpc());
    const config = await host.harness.behavior.resolveAgentConfiguration(context("thread-other", WORKER, "/srv/other"));
    expect(config.tools).toEqual([]);
    expect(config.instructions).toBeNull();
    const result = await host.harness.behavior.callAgentTool("workspace_read", { path: "a" }, { threadId: "thread-other" });
    expect(result).toMatchObject({ isError: true, content: [{ text: NO_BINDING }] });
  });

  it("a bound thread that moved off its scratch directory or host loses the tools", async () => {
    const host = await load(defaultRpc());
    const { threadId } = await spawnBound(host);
    for (const ctx of [context(threadId, WORKER, "/srv/elsewhere"), context(threadId, WORKSPACE, SCRATCH), context(threadId, WORKER, null)]) {
      const config = await host.harness.behavior.resolveAgentConfiguration(ctx);
      expect(config.tools).toEqual([]);
      expect(config.instructions).toBe(MOVED_INSTRUCTIONS);
    }
  });
});

describe("worker and workspace stay on different machines", () => {
  it("spawn refuses a workspace on the worker before touching either host", async () => {
    const host = await load(defaultRpc());
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "never" }));
    const result = await host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", WORKER, "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1"],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(SAME_HOST);
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect((await host.harness.behavior.runCli(["list"])).stdout).toBe("No bindings");
  });

  it("rebind refuses the worker and keeps the binding; another host is accepted", async () => {
    const host = await load(defaultRpc());
    const { threadId } = await spawnBound(host);
    const refused = await host.harness.behavior.runCli(["rebind", "--thread", threadId, "--workspace-machine", "worker", "--path", "/work/repo"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain(SAME_HOST);
    expect((await host.harness.behavior.runCli(["list"])).stdout).toContain("workspace:/work/repo");
    const moved = await host.harness.behavior.runCli(["rebind", "--thread", threadId, "--workspace-machine", "other", "--path", "/work/repo"]);
    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toContain("other:/work/repo");
  });

  it("a tool call on a binding whose workspace is the worker refuses without a host call", async () => {
    const binding = { workerHostId: WORKER, workspaceHostId: WORKER, root: "/work/repo" } as Binding;
    const calls: unknown[] = [];
    const deps = { host: { call: async (...args: unknown[]) => calls.push(args) } as never, bindingFor: () => binding };
    const result = await callWorkspace(deps, "t", "read", { path: "a" }, new AbortController().signal, () => "ok");
    expect(result).toMatchObject({ isError: true, content: [{ text: SAME_HOST }] });
    expect(calls).toEqual([]);
  });
});

describe("tool calls", () => {
  it("send the call to the workspace host with the bound root", async () => {
    const host = await load(defaultRpc({ exec: { ok: true, output: "ws\n", truncated: false, exitCode: 0, signal: null, timedOut: false, cancelled: false, hostname: "ws", durationMs: 5 } }));
    const { threadId } = await spawnBound(host);
    const result = await host.harness.behavior.callAgentTool("workspace_exec", { command: "hostname" }, { threadId });
    expect(text(result)).toBe("ws\n[host ws] exit 0 in 5 ms");
    const call = host.harness.experimental_hostRpcCalls.find((c) => c.method === "exec")!;
    expect(call.hostId).toBe(WORKSPACE);
    expect(call.input).toMatchObject({ root: "/work/repo", command: "hostname", timeoutMs: 120_000 });
    expect(call.timeoutMs).toBe(135_000);
  });

  it("show the change as a hunk in the edit and write results", async () => {
    const hunk = "--- a/calc.py\n+++ b/calc.py\n@@ -1,1 +1,1 @@\n-return a - b\n+return a + b";
    const host = await load(defaultRpc({
      edit: { ok: true, sha256: "s1", replacements: 1, diff: hunk },
      write: { ok: true, sha256: "s2", bytes: 4, created: true, diff: "--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+new" },
    }));
    const { threadId } = await spawnBound(host);
    const edit = await host.harness.behavior.callAgentTool(
      "workspace_edit", { path: "calc.py", old_string: "a - b", new_string: "a + b" }, { threadId },
    );
    expect(text(edit)).toBe(`Edited calc.py: 1 replacement(s), sha256 s1\n${hunk}`);
    const write = await host.harness.behavior.callAgentTool("workspace_write", { path: "n.txt", content: "new\n" }, { threadId });
    expect(text(write)).toContain("Created n.txt (4 bytes, sha256 s2)\n--- /dev/null");
  });

  it("report a refusal from the workspace as an error", async () => {
    const host = await load(defaultRpc({ read: { ok: false, error: "path escapes the workspace root" } }));
    const { threadId } = await spawnBound(host);
    const result = await host.harness.behavior.callAgentTool("workspace_read", { path: "../x" }, { threadId });
    expect(result).toMatchObject({ isError: true, content: [{ text: "Workspace read refused: path escapes the workspace root" }] });
  });

  it("never report a lost write or exec as success", async () => {
    const host = await load(defaultRpc({ write: new Error("host disconnected"), exec: new Error("host disconnected"), read: new Error("host disconnected") }));
    const { threadId } = await spawnBound(host);
    const write = await host.harness.behavior.callAgentTool("workspace_write", { path: "a", content: "x" }, { threadId });
    expect(write).toMatchObject({ isError: true });
    expect(text(write)).toContain("Outcome unknown");
    const exec = await host.harness.behavior.callAgentTool("workspace_exec", { command: "sleep 9" }, { threadId });
    expect(text(exec)).toContain("may still be running");
    const read = await host.harness.behavior.callAgentTool("workspace_read", { path: "a" }, { threadId });
    expect(text(read)).toContain("Nothing was changed");
  });

  it("debug exec CLI uses the same path", async () => {
    const host = await load(defaultRpc({ exec: { ok: true, output: "", truncated: false, exitCode: null, signal: null, timedOut: false, cancelled: true, hostname: "ws", durationMs: 9 } }));
    const { threadId } = await spawnBound(host);
    const result = await host.harness.behavior.runCli(["exec", "--thread", threadId, "--timeout-ms", "1000", "--", "sleep", "300"]);
    expect(result.stdout).toContain("cancelled (process group killed)");
    expect(host.harness.experimental_hostRpcCalls.find((c) => c.method === "exec")?.input).toMatchObject({ command: "sleep 300", timeoutMs: 1000 });
  });
});

describe("provider profiles", () => {
  it("spawn picks the profile from --provider and passes provider and model on", async () => {
    const host = await load(defaultRpc());
    const spawned = await spawnBound(host, "thread-oc", ["--provider", "acp-opencode", "--model", "openrouter/cheap"]);
    const prepare = host.harness.experimental_hostRpcCalls.find((c) => c.method === "prepareScratch");
    expect(prepare?.input).toEqual({ bindingId: spawned.bindingId, profile: "opencode", providerId: "acp-opencode", model: "openrouter/cheap" });
    const [spawnArgs] = host.harness.sdk.callsTo("threads.spawn")[0] as [Record<string, unknown>];
    expect(spawnArgs).toMatchObject({ providerId: "acp-opencode", model: "openrouter/cheap" });
    expect((await host.harness.behavior.runCli(["list"])).stdout).toContain("profile opencode");
    const config = await host.harness.behavior.resolveAgentConfiguration(context("thread-oc", WORKER, SCRATCH, "acp-opencode"));
    expect(config.tools).toHaveLength(TOOL_NAMES.length);
  });

  it("spawn refuses a provider with no profile before any host call", async () => {
    const host = await load(defaultRpc());
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "never" }));
    const result = await host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1", "--provider", "acp-gemini"],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Provider acp-gemini has no account-workers profile");
    expect(host.harness.experimental_hostRpcCalls).toEqual([]);
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
  });

  it("spawn leaves no binding when the worker refuses the profile", async () => {
    const host = await load(defaultRpc({ prepareScratch: { ok: false, error: "OpenCode 1.4.0 on the worker" } }));
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "never" }));
    const result = await host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1", "--provider", "acp-opencode"],
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("OpenCode 1.4.0");
    expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    expect((await host.harness.behavior.runCli(["list"])).stdout).toBe("No bindings");
  });

  it("spawn refuses when a project or global BB machine variable overrides the profile's config, before any host call", async () => {
    for (const [project, global, name] of [[["OPENCODE_DISABLE_PROJECT_CONFIG"], [], "OPENCODE_DISABLE_PROJECT_CONFIG"], [["OTHER"], ["OPENCODE_CONFIG_CONTENT"], "OPENCODE_CONFIG_CONTENT"]] as const) {
      const host = await load(defaultRpc());
      stubMachineEnv(host, [...project], [...global]);
      host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "never" }));
      const result = await host.harness.behavior.runCli(
        ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1", "--provider", "acp-opencode"],
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(`BB machine variables ${name} are set for project p1`);
      expect(host.harness.sdk.callsTo("projects.machineEnvironment")[0]).toEqual([{ projectId: "p1" }]);
      expect(host.harness.experimental_hostRpcCalls).toEqual([]);
      expect(host.harness.sdk.callsTo("threads.spawn")).toEqual([]);
    }
  });

  it("a profile with no refused variables does not read the machine environment", async () => {
    const host = await load(defaultRpc());
    stubMachineEnv(host, ["OPENCODE_CONFIG_CONTENT"], []);
    await spawnBound(host);
    expect(host.harness.sdk.callsTo("projects.machineEnvironment")).toEqual([]);
  });

  it("a thread on a provider its profile does not guard loses the tools", async () => {
    const host = await load(defaultRpc());
    const { threadId } = await spawnBound(host);
    for (const provider of ["acp-opencode", "codex", "test-provider"]) {
      const config = await host.harness.behavior.resolveAgentConfiguration(context(threadId, WORKER, SCRATCH, provider));
      expect(config.tools).toEqual([]);
      expect(config.instructions).toBe(OTHER_PROVIDER_INSTRUCTIONS);
    }
  });
});

describe("per-call verify", () => {
  const verifying: ProviderProfile = { id: "verifying", providerIds: ["verifying-provider"], async prepare() {}, async verify() {} };
  const read = { ok: true, text: "x", sha256: "s", totalLines: 1, truncated: false };

  async function bound(verify: unknown) {
    (PROFILES as ProviderProfile[]).push(verifying);
    const host = await load(defaultRpc({ verifyProfile: verify, read }));
    const { threadId, bindingId } = await spawnBound(host, "thread-v", ["--provider", "verifying-provider"]);
    return { host, threadId, bindingId };
  }
  const methods = (host: Awaited<ReturnType<typeof load>>) => host.harness.experimental_hostRpcCalls.map((c) => c.method);

  afterEach(() => {
    const at = PROFILES.indexOf(verifying);
    if (at >= 0) (PROFILES as ProviderProfile[]).splice(at, 1);
  });

  it("asks the worker before the workspace call, with the parsed tool input", async () => {
    const { host, threadId, bindingId } = await bound({ ok: true });
    const result = await host.harness.behavior.callAgentTool("workspace_read", { path: "a", extra: 1 }, { threadId });
    expect(text(result)).toContain("x");
    expect(methods(host)).toEqual(["resolveRoot", "prepareScratch", "verifyProfile", "read"]);
    const verify = host.harness.experimental_hostRpcCalls.find((c) => c.method === "verifyProfile")!;
    expect(verify.hostId).toBe(WORKER);
    expect(verify.input).toEqual({ bindingId, profile: "verifying", toolName: "workspace_read", input: { path: "a" } });
  });

  it("a refusal marks the binding broken: later calls refuse without host calls and configure drops the tools until rebind", async () => {
    const { host, threadId } = await bound({ ok: false, error: "no heartbeat for workspace_exec" });
    const first = await host.harness.behavior.callAgentTool("workspace_exec", { command: "id" }, { threadId });
    expect(text(first)).toContain("no heartbeat for workspace_exec");
    const before = methods(host).length;
    const second = await host.harness.behavior.callAgentTool("workspace_read", { path: "a" }, { threadId });
    expect(second).toMatchObject({ isError: true });
    expect(text(second)).toContain("Workspace tools are off");
    expect(methods(host)).toHaveLength(before);
    expect(methods(host)).not.toContain("exec");
    const config = await host.harness.behavior.resolveAgentConfiguration(context(threadId, WORKER, SCRATCH, "verifying-provider"));
    expect(config.tools).toEqual([]);
    expect(config.instructions).toContain("no heartbeat");
    expect((await host.harness.behavior.runCli(["list"])).stdout).toContain("BROKEN");

    expect((await host.harness.behavior.runCli(["rebind", "--thread", threadId, "--workspace-machine", "other", "--path", "/work/repo"])).exitCode).toBe(0);
    const again = await host.harness.behavior.resolveAgentConfiguration(context(threadId, WORKER, SCRATCH, "verifying-provider"));
    expect(again.tools).toHaveLength(TOOL_NAMES.length);
  });

  it("a failed call to the worker refuses that call only", async () => {
    const { host, threadId } = await bound(new Error("worker disconnected"));
    const result = await host.harness.behavior.callAgentTool("workspace_read", { path: "a" }, { threadId });
    expect(result).toMatchObject({ isError: true });
    expect(text(result)).toContain("the worker check failed (worker disconnected). Nothing was changed");
    expect(methods(host)).not.toContain("read");
    expect((await host.harness.behavior.runCli(["list"])).stdout).not.toContain("BROKEN");
  });

  it("profiles without verify make no extra host call", async () => {
    const host = await load(defaultRpc({ read }));
    const { threadId } = await spawnBound(host);
    await host.harness.behavior.callAgentTool("workspace_read", { path: "a" }, { threadId });
    expect(methods(host)).toEqual(["resolveRoot", "prepareScratch", "read"]);
  });
});
