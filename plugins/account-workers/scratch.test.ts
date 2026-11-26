import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DENIED_NATIVE_TOOLS, guardLauncher, prepareScratch, scratchBase } from "./scratch.js";

let state: string;
beforeEach(async () => {
  state = await mkdtemp(path.join(tmpdir(), "aw-state-"));
  vi.stubEnv("XDG_STATE_HOME", state);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(state, { recursive: true, force: true });
});

const ALLOWED = ["mcp__bb-bridge__workspace_read"];

function runGuard(dir: string, stdin: string) {
  return spawnSync("sh", [path.join(dir, ".claude", "aw-guard.sh")], { input: stdin, encoding: "utf8" });
}

describe("scratch directory", () => {
  it("lives outside the BB data directory, under XDG state", () => {
    expect(scratchBase({ XDG_STATE_HOME: "/s" })).toBe("/s/bb-account-workers/scratch");
    expect(scratchBase({ XDG_STATE_HOME: "relative" })).toMatch(/\.local\/state\/bb-account-workers\/scratch$/);
  });

  it("writes a settings file that denies native tools and hooks every tool call", async () => {
    const { path: dir } = await prepareScratch({ bindingId: "aw_test", allowedTools: ALLOWED });
    expect(dir).toBe(path.join(state, "bb-account-workers/scratch/aw_test"));
    const settings = JSON.parse(await readFile(path.join(dir, ".claude/settings.local.json"), "utf8"));
    expect(settings.permissions.deny).toEqual(DENIED_NATIVE_TOOLS);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Bash", "Read", "Agent", "mcp__bb-bridge__update_environment_directory"]));
    expect(settings.hooks.PreToolUse).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: `sh '${dir}/.claude/aw-guard.sh'` }] },
    ]);
    expect((await stat(path.join(dir, ".claude/aw-guard.sh"))).mode & 0o111).not.toBe(0);
  });

  it("guard allows only listed tools and blocks everything else with exit 2", async () => {
    const { path: dir } = await prepareScratch({ bindingId: "aw_guard", allowedTools: ALLOWED });
    const call = (tool_name: unknown, extra = {}) => runGuard(dir, JSON.stringify({ tool_name, tool_input: {}, ...extra }));
    expect(call("mcp__bb-bridge__workspace_read").status).toBe(0);
    expect(call("ToolSearch").status).toBe(0);
    expect(call("mcp__bb-bridge__bb_update_plan").status).toBe(0);
    for (const name of ["Bash", "mcp__bb-bridge__rtk_shell", "mcp__bb-bridge__agent_plugins_call", "mcp__other__x", "Agent"]) {
      const result = call(name);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("disabled in this thread");
    }
    expect(call(42).status).toBe(2);
    expect(runGuard(dir, "not json").status).toBe(2);
    expect(runGuard(dir, "").status).toBe(2);
    expect(runGuard(dir, JSON.stringify({ tool_name: "Bash", tool_input: { tool_name: "ToolSearch" } })).status).toBe(2);
  });

  it("launcher fails closed when the guard script is missing or broken", async () => {
    const { path: dir } = await prepareScratch({ bindingId: "aw_broken", allowedTools: ALLOWED });
    const guard = path.join(dir, ".claude", "aw-guard.mjs");
    const allowed = JSON.stringify({ tool_name: "ToolSearch", tool_input: {} });
    expect(runGuard(dir, allowed).status).toBe(0);
    await writeFile(guard, "this is not javascript (");
    expect(runGuard(dir, allowed).status).toBe(2);
    await writeFile(guard, "process.exit(1);");
    expect(runGuard(dir, allowed).status).toBe(2);
    await writeFile(guard, "process.kill(process.pid, 'SIGKILL');");
    expect(runGuard(dir, allowed).status).toBe(2);
    await rm(guard);
    const missing = runGuard(dir, allowed);
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("tool blocked");
  });

  it("launcher fails closed when no node is found", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aw-launch-"));
    try {
      const launcher = path.join(dir, "aw-guard.sh");
      await writeFile(launcher, guardLauncher("/nonexistent/node"));
      const result = spawnSync("/bin/sh", [launcher], { input: "{}", encoding: "utf8", env: { PATH: "/nonexistent" } });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("node not found");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
