import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canaryConfig, evaluateGate, offeredTools, resolveCodexLaunch, type CanaryObservation } from "./codex-canary.js";
import {
  addTrust,
  codexFiles,
  CODEX_FEATURES_OFF,
  CODEX_FEATURES_ON,
  codexProfile,
  expectedTrustKey,
  hasTrust,
  HEARTBEAT_MAX_AGE_MS,
  heartbeatDir,
  mcpServerNames,
  overlayToml,
  removeTrust,
  removeTrustText,
  sameCall,
  verifiedFile,
  verifyHeartbeat,
} from "./codex.js";
import { writeProfileFiles } from "./files.js";

const TOOLS = ["workspace_read", "workspace_exec"];
let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(path.join(tmpdir(), "aw-codex-test-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("scratch config", () => {
  it("turns every listed feature, web search and each MCP server off", () => {
    const config = parse(overlayToml(["playwright-extension", "node_repl"])) as Record<string, any>;
    expect(config.web_search).toBe("disabled");
    for (const feature of CODEX_FEATURES_OFF) expect(config.features[feature]).toBe(false);
    expect(CODEX_FEATURES_ON).toEqual(["hooks"]);
    expect(config.features.hooks).toBe(true);
    expect(config.features.multi_agent_v2).toBe(false);
    expect(config.mcp_servers).toEqual({ "playwright-extension": { enabled: false }, node_repl: { enabled: false } });
  });

  it("refuses a spawn when a BB machine variable would move the Codex home or binary away from what the gate checked", () => {
    expect(codexProfile.refusedMachineEnv).toEqual(["CODEX_HOME", "BB_CODEX_BRIDGE_APP_SERVER_COMMAND", "BB_CODEX_BRIDGE_APP_SERVER_ARGS"]);
  });

  it("refuses MCP server names it cannot quote safely", () => {
    expect(mcpServerNames({ mcp_servers: { ok_name: {}, "x-1": {} } })).toEqual(["ok_name", "x-1"]);
    expect(() => mcpServerNames({ mcp_servers: { 'bad"]\n[x': {} } })).toThrow(/unsupported Codex MCP server name/);
  });

  it("declares one PreToolUse hook whose trust key matches what Codex reports", () => {
    const files = codexFiles(dir, TOOLS, []);
    const hooks = JSON.parse(files.find((f) => f.path === ".codex/hooks.json")!.content);
    expect(hooks.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command: `sh '${dir}/.codex/aw-guard.sh'` }] }]);
    expect(expectedTrustKey(dir)).toBe(`${dir}/.codex/hooks.json:pre_tool_use:0:0`);
    expect(() => codexFiles("/tmp/it's", TOOLS, [])).toThrow(/quote/);
  });
});

describe("guard hook", () => {
  const run = (input: string) => spawnSync("sh", [path.join(dir, ".codex", "aw-guard.sh")], { input, encoding: "utf8" });
  const call = (tool_name: string, tool_input: unknown = {}) => JSON.stringify({ tool_name, tool_input, tool_use_id: `id-${tool_name}` });

  beforeEach(async () => {
    await mkdir(heartbeatDir(dir), { recursive: true });
    await writeProfileFiles(dir, codexFiles(dir, TOOLS, [], process.execPath));
  });

  it("allows workspace tools and records each call with its raw input", async () => {
    expect(run(call("workspace_exec", { command: "ls", extra: 1 })).status).toBe(0);
    expect(run(call("update_plan")).status).toBe(0);
    const files = await readdir(heartbeatDir(dir));
    const beats = await Promise.all(files.map(async (f) => JSON.parse(await readFile(path.join(heartbeatDir(dir), f), "utf8"))));
    expect(beats).toMatchObject([{ tool_name: "workspace_exec", tool_input: { command: "ls", extra: 1 }, tool_use_id: "id-workspace_exec" }]);
  });

  it("blocks everything else with exit 2 and a reason, including unreadable input", () => {
    for (const name of ["apply_patch", "exec_command", "rtk_shell", "spawn_agent", "mcp__x__y"]) {
      const result = run(call(name));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(`Tool ${name} is disabled`);
    }
    expect(run("not json").status).toBe(2);
  });

  it("blocks an allowed call it cannot record", async () => {
    await rm(path.join(dir, ".aw"), { recursive: true });
    const result = run(call("workspace_exec", { command: "ls" }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not record");
  });
});

describe("trust entry", () => {
  const trust = { key: "/s/.codex/hooks.json:pre_tool_use:0:0", hash: "sha256:abc" };
  const original = '# owner comment\nmodel = "m"\n\n[projects."/other"]\ntrust_level = "trusted"\n';

  it("adds and removes exactly its two tables, keeping the rest and the file mode", async () => {
    const file = path.join(dir, "config.toml");
    await writeFile(file, original);
    await chmod(file, 0o640);
    await addTrust(dir, "/s", trust);
    const added = await readFile(file, "utf8");
    expect(added.startsWith(original)).toBe(true);
    expect(hasTrust(parse(added), "/s", trust)).toBe(true);
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    await removeTrust(dir, "/s", trust);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("does not write an edit that would break the config", async () => {
    const file = path.join(dir, "config.toml");
    const clash = `${original}\n[projects."/s"]\ntrust_level = "untrusted"\n`;
    await writeFile(file, clash);
    await expect(addTrust(dir, "/s", trust)).rejects.toThrow(/not valid TOML/);
    expect(await readFile(file, "utf8")).toBe(clash);
  });

  it("removes its keys by parsed key, also when reformatted, and keeps other keys of the same tables", () => {
    const reformatted = `${original}\n[projects."/s"]\ntrust_level="trusted"\nnote = "keep"\n\n[ hooks.state."${trust.key}" ]\n  trusted_hash = "sha256:abc"\n`;
    const removed = removeTrustText(reformatted, "/s", trust);
    expect(parse(removed)).toEqual({ ...parse(original), projects: { "/other": { trust_level: "trusted" }, "/s": { note: "keep" } } });
  });

  it("writes through a symlinked config to its target", async () => {
    const target = path.join(dir, "dotfiles-config.toml");
    await writeFile(target, original);
    await symlink(target, path.join(dir, "config.toml"));
    await addTrust(dir, "/s", trust);
    expect((await lstat(path.join(dir, "config.toml"))).isSymbolicLink()).toBe(true);
    expect(hasTrust(parse(await readFile(target, "utf8")), "/s", trust)).toBe(true);
    await removeTrust(dir, "/s", trust);
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("keeps both entries when two bindings write at once", async () => {
    await writeFile(path.join(dir, "config.toml"), original);
    const other = { key: "/t/.codex/hooks.json:pre_tool_use:0:0", hash: "sha256:def" };
    await Promise.all([addTrust(dir, "/s", trust), addTrust(dir, "/t", other)]);
    const config = parse(await readFile(path.join(dir, "config.toml"), "utf8"));
    expect(hasTrust(config, "/s", trust) && hasTrust(config, "/t", other)).toBe(true);
  });

  it("creates the config with mode 0600 when there is none", async () => {
    await addTrust(dir, "/s", trust);
    expect((await stat(path.join(dir, "config.toml"))).mode & 0o777).toBe(0o600);
  });
});

describe("per-call heartbeat check", () => {
  const ctx = () => ({ scratchDir: dir, bindingId: path.basename(dir), toolName: "workspace_exec", input: { command: "ls" } });
  const beat = (over: Record<string, unknown> = {}) =>
    `${JSON.stringify({ tool_name: "workspace_exec", tool_input: { command: "ls", ignored: true }, tool_use_id: "c1", t: Date.now(), ...over })}\n`;

  const put = (body: string, name = `${Date.now()}-x.json`) => writeFile(path.join(heartbeatDir(dir), name), body);

  beforeEach(async () => {
    await mkdir(heartbeatDir(dir), { recursive: true });
  });

  it("consumes one matching heartbeat per call, records it and refuses a replay", async () => {
    await put(beat());
    await expect(verifyHeartbeat(ctx())).resolves.toBeUndefined();
    expect(await readdir(heartbeatDir(dir))).toEqual([]);
    expect(JSON.parse(await readFile(verifiedFile(dir), "utf8"))).toMatchObject({ tool_name: "workspace_exec", tool_use_id: "c1" });
    await expect(verifyHeartbeat(ctx())).rejects.toThrow(/did not see this call/);
  });

  it("accepts a heartbeat as old as the longest workspace_exec and drops older ones", async () => {
    expect(HEARTBEAT_MAX_AGE_MS).toBeGreaterThan(600_000);
    await put(beat({ t: Date.now() - 600_000 }));
    await expect(verifyHeartbeat(ctx())).resolves.toBeUndefined();
    await put(beat({ t: Date.now() - HEARTBEAT_MAX_AGE_MS - 1000 }), "old.json");
    await expect(verifyHeartbeat(ctx())).rejects.toThrow(/did not see this call/);
    expect(await readdir(heartbeatDir(dir))).toEqual([]);
  });

  it("refuses without a heartbeat, for other args, another tool or a stale one", async () => {
    await expect(verifyHeartbeat(ctx())).rejects.toThrow(/marked broken/);
    for (const over of [{ tool_input: { command: "rm -rf /" } }, { tool_name: "workspace_read" }, { t: Date.now() - HEARTBEAT_MAX_AGE_MS - 1000 }, { tool_use_id: "" }]) {
      await rm(heartbeatDir(dir), { recursive: true });
      await mkdir(heartbeatDir(dir));
      await put(beat(over));
      await expect(verifyHeartbeat(ctx())).rejects.toThrow(/did not see this call/);
    }
  });

  it("compares on the parsed keys only, order-independent", () => {
    expect(sameCall({ b: 1, a: { y: 2, x: 1 }, extra: 3 }, { a: { x: 1, y: 2 }, b: 1 })).toBe(true);
    expect(sameCall({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameCall(null, { a: 1 })).toBe(false);
  });
});

describe("canary gate", () => {
  const allowed = ["workspace_exec", "update_plan"];
  const pass: CanaryObservation = {
    model: "m",
    catalogModels: ["m", "n"],
    toolMode: "code_mode_only",
    turnCompleted: true,
    hookTrust: "trusted",
    markers: [],
    dynamicCalls: ["workspace_exec", "workspace_exec"],
    offered: offeredTools([{ type: "namespace", name: "functions", tools: [{ type: "custom", name: "exec" }, { type: "function", name: "wait" }] }]),
    calls: [
      { name: "workspace_exec", expect: "reach", output: "ok" },
      { name: "exec>workspace_exec", expect: "reach", output: "ok" },
      { name: "request_user_input", expect: "blocked", output: "Tool call blocked by PreToolUse hook: no" },
      { name: "exec>*", expect: "enumerate", output: 'Script completed\nAWSWEEP{"spawn_agent":"Error: Tool call blocked by PreToolUse hook: x","apply_patch":"expects a string input"}' },
    ],
  };

  it("passes a clean observation", () => {
    expect(evaluateGate(pass, allowed)).toEqual([]);
  });

  it("fails on markers, an untrusted hook, a missed workspace call, an unblocked tool, a new custom or hosted tool", () => {
    const failures = (over: Partial<CanaryObservation>) => evaluateGate({ ...pass, ...over }, allowed);
    expect(failures({ markers: ["apply_patch_custom"] })).toEqual(["acted on the worker: apply_patch_custom"]);
    expect(failures({ hookTrust: "untrusted" })[0]).toMatch(/untrusted, not trusted/);
    expect(failures({ hookTrust: undefined })[0]).toMatch(/missing/);
    expect(failures({ dynamicCalls: ["workspace_exec"] })[0]).toMatch(/did not reach BB/);
    expect(failures({ dynamicCalls: ["workspace_exec", "workspace_exec", "rtk_shell"] })[0]).toMatch(/outside the allowlist/);
    expect(failures({ offered: [{ name: "patch_v2", type: "custom" }], toolMode: null })).toEqual(["unhooked custom tool offered: patch_v2"]);
    expect(failures({ offered: [{ name: "web_search", type: "web_search" }], toolMode: null })).toEqual(["hosted tool offered: web_search"]);
    expect(failures({ turnCompleted: false })).toEqual(["the canary turn did not complete"]);
    expect(failures({ catalogModels: ["n"] })).toEqual(["the canary's model catalog has no model m"]);
    expect(failures({ offered: [{ name: "exec_command", type: "function" }] })).toEqual(["the catalog marks m code_mode_only, but the canary was not offered exec"]);
    expect(failures({ offered: [{ name: "exec_command", type: "function" }], toolMode: null })).toEqual([]);
    const calls = pass.calls.map((c) => (c.expect === "enumerate" ? { ...c, output: 'AWSWEEP{"new_tool":"ran"}' } : c));
    expect(failures({ calls })).toEqual(["nested new_tool was not blocked by the guard hook"]);
    const unblocked = pass.calls.map((c) => (c.expect === "blocked" ? { ...c, output: "ok" } : c));
    expect(failures({ calls: unblocked })).toEqual(["request_user_input was not blocked by the guard hook (ok)"]);
  });

  it("builds its Codex config without credentials or real MCP servers", () => {
    const config = canaryConfig(
      {
        config: {
          model: "m",
          features: { memories: true, odd: "x" },
          mcp_servers: { pw: { command: "npx", env: { PW_TOKEN: "secret-value" } } },
          plugins: { p: { enabled: true, token: "secret-value" } },
          projects: { "/s": { trust_level: "trusted" }, "/other": { trust_level: "trusted" } },
          hooks: { state: { k: { trusted_hash: "h" }, other: { trusted_hash: "o" } } },
          model_providers: { x: { env_key: "secret-value" } },
        },
        mcpNames: ["pw"],
        scratchDir: "/s",
        trustKey: "k",
      },
      "/t/fake.mjs",
      "/t/marks",
      "/usr/bin/node",
    );
    expect(JSON.stringify(config)).not.toContain("secret-value");
    expect(config).toEqual({
      features: { memories: true },
      memories: {},
      plugins: { p: { enabled: true } },
      apps: {},
      projects: { "/s": { trust_level: "trusted" } },
      hooks: { state: { k: { trusted_hash: "h" } } },
      mcp_servers: { pw: { command: "/usr/bin/node", args: ["/t/fake.mjs"], env: { AW_MARK_DIR: "/t/marks", AW_MCP_NAME: "pw" } } },
    });
  });

  it("launches the binary the bridge would run", () => {
    expect(resolveCodexLaunch({})).toEqual({ command: "codex", args: ["app-server"] });
    expect(resolveCodexLaunch({ BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "/x/codex", BB_CODEX_BRIDGE_APP_SERVER_ARGS: '["app-server","-c","a=1"]' }))
      .toEqual({ command: "/x/codex", args: ["app-server", "-c", "a=1"] });
    expect(() => resolveCodexLaunch({ BB_CODEX_BRIDGE_APP_SERVER_COMMAND: "/x", BB_CODEX_BRIDGE_APP_SERVER_ARGS: "[1]" })).toThrow(/array of strings/);
  });
});
