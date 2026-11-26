import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../tools.js";
import {
  BUILTIN_AGENTS,
  checkOpenCode,
  guardPlugin,
  openCodeFiles,
  openCodeProfile,
  OVERRIDING_ENV,
  parseMajor,
  REMOVED_PLUGINS,
  type OpenCodeCheckDeps,
} from "./opencode.js";

const ALLOWED = [...TOOL_NAMES.map((n) => `bb-bridge_${n}`), "bb-bridge_bb_update_plan"];

describe("opencode profile files", () => {
  const files = openCodeFiles(TOOL_NAMES);
  const config = JSON.parse(files.find((f) => f.path === ".opencode/opencode.json")!.content);

  it("writes only the scratch config and the guard plugin", () => {
    expect(files.map((f) => f.path)).toEqual([".opencode/opencode.json", ".opencode/plugins/aw-guard.js"]);
  });

  it("removes every native tool plugin, browser tools and config commands", () => {
    expect(config.plugin).toEqual(["-opencode.tool.*", "-opencode.tools", "-opencode.tools.*", "-opencode.browser", "-opencode.config.command"]);
    expect(config.plugin).toEqual(REMOVED_PLUGINS);
  });

  it("denies everything, then allows exactly the workspace tools and bb_update_plan, at top level and per built-in agent", () => {
    const expected = { "*": "deny", ...Object.fromEntries(ALLOWED.map((n) => [n, "allow"])) };
    expect(config.permission).toEqual(expected);
    expect(Object.keys(config.permission)[0]).toBe("*");
    expect(Object.keys(config.permission).some((k) => k.includes("*") && k !== "*")).toBe(false);
    expect(Object.keys(config.agent).sort()).toEqual([...BUILTIN_AGENTS].sort());
    for (const id of BUILTIN_AGENTS) expect(config.agent[id]).toEqual({ permission: expected });
    expect(config).toMatchObject({ default_agent: "build", snapshots: false });
  });

  it("prepare writes the files into the scratch directory", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aw-oc-"));
    try {
      await openCodeProfile.prepare({ scratchDir: dir, bindingId: "aw_x", toolNames: TOOL_NAMES, providerId: "acp-opencode", model: null, signal: new AbortController().signal });
      expect(JSON.parse(await readFile(path.join(dir, ".opencode/opencode.json"), "utf8"))).toEqual(config);
      expect(await readFile(path.join(dir, ".opencode/plugins/aw-guard.js"), "utf8")).toBe(guardPlugin(ALLOWED));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

type Hook = (event: Record<string, unknown>) => void;

async function loadGuard() {
  const dir = await mkdtemp(path.join(tmpdir(), "aw-oc-guard-"));
  const file = path.join(dir, "aw-guard.mjs");
  await writeFile(file, guardPlugin(ALLOWED));
  const plugin = (await import(pathToFileURL(file).href)).default as { id: string; setup(ctx: unknown): Promise<void> };
  await rm(dir, { recursive: true, force: true });
  const hooks: Record<string, Hook> = {};
  await plugin.setup({
    tool: { hook: async (name: string, fn: Hook) => void (hooks[`tool.${name}`] = fn) },
    permission: { hook: async (name: string, fn: Hook) => void (hooks[`permission.${name}`] = fn) },
  });
  return { plugin, hooks };
}

describe("opencode guard plugin", () => {
  it("registers execute.before and permission.evaluate", async () => {
    const { plugin, hooks } = await loadGuard();
    expect(plugin.id).toBe("account-workers.guard");
    expect(Object.keys(hooks).sort()).toEqual(["permission.evaluate", "tool.execute.before"]);
  });

  it("rejects every tool call not on the allowlist, including code-mode execute and other BB tools", async () => {
    const { hooks } = await loadGuard();
    const before = hooks["tool.execute.before"]!;
    for (const tool of ALLOWED) expect(() => before({ tool, input: {} })).not.toThrow();
    for (const tool of ["shell", "bash", "read", "edit", "write", "glob", "grep", "webfetch", "subagent", "execute", "bb-bridge_rtk_shell", "bb-bridge_agent_plugins_call", "bb-bridge_update_environment_directory", "keenable_search", "bb-bridge_workspace_exec ", undefined]) {
      expect(() => before({ tool, input: {} }), String(tool)).toThrow("disabled in this thread");
    }
  });

  it("forces deny on every permission outside the allowlist and leaves allowed ones alone", async () => {
    const { hooks } = await loadGuard();
    const evaluate = hooks["permission.evaluate"]!;
    for (const action of ["shell", "edit", "webfetch", "external_directory", "execute", "bb-bridge_rtk_shell"]) {
      const event: Record<string, unknown> = { action, resource: "*", effect: "allow" };
      expect(() => evaluate(event)).not.toThrow();
      expect(event.effect).toBe("deny");
      expect(String(event.message)).toContain("disabled in this thread");
    }
    const allowed: Record<string, unknown> = { action: "bb-bridge_workspace_exec", resource: "*", effect: "allow" };
    evaluate(allowed);
    expect(allowed).toEqual({ action: "bb-bridge_workspace_exec", resource: "*", effect: "allow" });
  });
});

describe("opencode check", () => {
  const signal = new AbortController().signal;
  const deps = (over: Partial<OpenCodeCheckDeps> = {}): OpenCodeCheckDeps => ({
    env: {},
    managedConfigExists: () => false,
    version: async () => "opencode v2.2.7\n",
    ...over,
  });

  it("parses the version line", () => {
    expect(parseMajor("opencode v2.2.7\n")).toBe(2);
    expect(parseMajor("2.10.0")).toBe(2);
    expect(parseMajor("v1.4.3")).toBe(1);
    expect(parseMajor("garbage")).toBeNull();
  });

  it("accepts OpenCode 2 with no overriding sources", async () => {
    await expect(checkOpenCode(signal, deps())).resolves.toBeUndefined();
  });

  it("refuses another major", async () => {
    for (const v of ["opencode v1.4.3", "opencode v3.0.0", "", "nonsense"]) {
      await expect(checkOpenCode(signal, deps({ version: async () => v })), v).rejects.toThrow("supports major 2 only");
    }
  });

  it("refuses when an env source overrides or disables the scratch config, naming the variable only", async () => {
    for (const name of OVERRIDING_ENV) {
      const error = await checkOpenCode(signal, deps({ env: { [name]: "SECRET-VALUE" } })).catch((e: Error) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain("SECRET-VALUE");
    }
    await expect(checkOpenCode(signal, deps({ env: { OPENCODE_CONFIG: "" } }))).resolves.toBeUndefined();
  });

  it("refuses when managed config exists in /etc/opencode", async () => {
    await expect(checkOpenCode(signal, deps({ managedConfigExists: () => true }))).rejects.toThrow("/etc/opencode exists");
  });

  it("refuses when opencode cannot run", async () => {
    await expect(checkOpenCode(signal, deps({ version: async () => { throw new Error("spawn opencode ENOENT"); } }))).rejects.toThrow("ENOENT");
  });
});
