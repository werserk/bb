import { createFakePluginHost, makeHostResponse, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, { MOVED_INSTRUCTIONS } from "./server.js";
import { NO_BINDING, TOOL_NAMES } from "./tools.js";

const WORKER = "host-worker";
const WORKSPACE = "host-workspace";
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
  ]);
  return host;
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

async function spawnBound(host: Awaited<ReturnType<typeof load>>, threadId = "thread-new") {
  host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: threadId }));
  const result = await host.harness.behavior.runCli(
    ["spawn", "--workspace-machine", "workspace", "--path", "/work/repo", "--machine", "worker", "--prompt", "hi", "--project", "p1", "--json"],
  );
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  return JSON.parse(result.stdout) as { threadId: string; bindingId: string };
}

function context(threadId: string, hostId: string, envPath: string | null) {
  return makePluginAgentConfigurationContext({ thread: { id: threadId }, host: { id: hostId }, environment: { path: envPath } });
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
    expect((prepare?.input as { allowedTools: string[] }).allowedTools).toContain("mcp__bb-bridge__workspace_exec");

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
