import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cachedModels, codexVersion, resolveCodexLaunch, runCanary } from "./codex-canary.js";
import { codexAllowed, codexFiles, createCodexProfile, expectedTrustKey, gateFile, hasTrust, heartbeatDir } from "./codex.js";
import { writeProfileFiles } from "./files.js";
import type { ProfileContext } from "./types.js";

const codexCli = spawnSync("codex", ["--version"], { encoding: "utf8" });
const hasCodex = codexCli.status === 0;
const installedVersion = hasCodex ? codexCli.stdout.trim().split(/\s+/u).at(-1)! : "0.0.0";
const TOOLS = ["workspace_read", "workspace_write", "workspace_edit", "workspace_glob", "workspace_grep", "workspace_exec", "workspace_diff"];
const SYNTHETIC = `model = "gpt-5.6-luna"

[features]
memories = true

[memories]
use_memories = true

[mcp_servers.fake]
command = "/nonexistent/server"
`;

const realConfig = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "config.toml");
const digest = async () => createHash("sha256").update(await readFile(realConfig).catch(() => Buffer.alloc(0))).digest("hex");

describe.skipIf(!hasCodex)("Codex no-fallback canary (real codex app-server, mock model)", () => {
  let dir: string;
  let home: string;
  let scratchDir: string;
  let realBefore: string;

  beforeAll(async () => {
    realBefore = await digest();
  });
  afterAll(async () => {
    expect(await digest()).toBe(realBefore);
  });
  beforeEach(async () => {
    dir = await realpath(await mkdtemp(path.join(tmpdir(), "aw-codex-canary-test-")));
    home = path.join(dir, "home");
    scratchDir = path.join(dir, "scratch", "b1");
    await mkdir(home);
    await mkdir(path.join(scratchDir, ".aw"), { recursive: true });
    await writeFile(path.join(home, "config.toml"), SYNTHETIC);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const ctx = (): ProfileContext => ({
    scratchDir,
    bindingId: "b1",
    toolNames: TOOLS,
    providerId: "codex",
    model: "gpt-5.6-luna",
    signal: new AbortController().signal,
  });
  const canary = async (withTrust: boolean, model: string | null = null) => {
    const config = parse(await readFile(path.join(home, "config.toml"), "utf8"));
    return runCanary({
      launch: resolveCodexLaunch({}),
      config: withTrust ? config : { ...config, hooks: {} },
      mcpNames: ["fake"],
      home,
      scratchDir,
      trustKey: expectedTrustKey(scratchDir),
      model,
      toolNames: TOOLS,
      allowed: codexAllowed(TOOLS),
      signal: new AbortController().signal,
    });
  };

  it("baseline: a scratch dir without the profile acts on the worker, so the gate fails", async () => {
    const report = await canary(false);
    expect(report.failures.join("\n")).toMatch(/acted on the worker:/);
    expect(report.failures.join("\n")).toMatch(/mcp_started_fake/);
    expect(report.failures.join("\n")).toMatch(/guard hook is missing/);
  }, 90_000);

  it.each([null, "gpt-5.5"])("an untrusted guard hook is skipped by Codex, so apply_patch runs and the gate fails (model %s)", async (model) => {
    await writeProfileFiles(scratchDir, codexFiles(scratchDir, TOOLS, ["fake"]));
    const report = await canary(false, model);
    const text = report.failures.join("\n");
    expect(text).toMatch(/untrusted, not trusted/);
    expect(text).toMatch(/acted on the worker: .*apply_patch/);
    expect(text).not.toMatch(/exec_command/);
  }, 90_000);

  it.each(["gpt-5.6-luna", "gpt-5.5"])("the Codex profile passes: nothing runs on the worker, the workspace tool reaches BB (model %s)", async (model) => {
    const profile = createCodexProfile({ CODEX_HOME: home });
    await profile.prepare({ ...ctx(), model });
    await profile.check!({ ...ctx(), model });
    const config = parse(await readFile(path.join(home, "config.toml"), "utf8"));
    expect((config.projects as Record<string, unknown>)[scratchDir]).toEqual({ trust_level: "trusted" });
    expect(Object.keys((config.hooks as { state: object }).state)).toEqual([expectedTrustKey(scratchDir)]);
    expect(await readdir(heartbeatDir(scratchDir))).toEqual([]);
    const gate = JSON.parse(await readFile(gateFile(scratchDir), "utf8"));
    expect(gate).toMatchObject({ passed: true, model, catalog: "bundled", failures: [] });
    expect(gate.userAgent).toMatch(/\d+\.\d+/);
  }, 120_000);

  it("refuses a spawn without an explicit model before writing any trust", async () => {
    const profile = createCodexProfile({ CODEX_HOME: home });
    await expect(profile.prepare({ ...ctx(), model: null })).rejects.toThrow(/explicit model/);
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(SYNTHETIC);
  });

  describe("with the worker's models_cache.json", () => {
    const bundled = () => JSON.parse(spawnSync("codex", ["debug", "models", "--bundled"], { encoding: "utf8" }).stdout) as { models: Record<string, unknown>[] };
    beforeEach(async () => {
      const luna = bundled().models.find((m) => m.slug === "gpt-5.6-luna")!;
      const models = [{ ...luna, slug: "aw-cache-only", display_name: "aw-cache-only" }];
      await writeCache(models, installedVersion);
    });
    let models: Record<string, unknown>[] = [];
    const writeCache = async (list: Record<string, unknown>[], clientVersion: string) => {
      models = list;
      const cache = { fetched_at: new Date().toISOString(), identity: "opaque", client_version: clientVersion, models: list };
      await writeFile(path.join(home, "models_cache.json"), JSON.stringify(cache));
    };

    it("ignores a cache another Codex version wrote, as Codex does, and checks the bundled catalog", async () => {
      await writeCache(models, "0.0.1");
      const profile = createCodexProfile({ CODEX_HOME: home });
      await profile.prepare({ ...ctx(), model: "aw-cache-only" });
      await expect(profile.check!({ ...ctx(), model: "aw-cache-only" })).rejects.toThrow(/catalog has no model aw-cache-only/);
      const gate = JSON.parse(await readFile(gateFile(scratchDir), "utf8"));
      expect(gate).toMatchObject({ passed: false, catalog: "bundled" });
      expect(gate.catalogSkipped).toBe(`models_cache.json is for Codex 0.0.1, the worker runs ${installedVersion}`);
    }, 120_000);

    it("checks a model that exists only in the cache with the cache's tool set", async () => {
      const profile = createCodexProfile({ CODEX_HOME: home });
      await profile.prepare({ ...ctx(), model: "aw-cache-only" });
      await profile.check!({ ...ctx(), model: "aw-cache-only" });
      const gate = JSON.parse(await readFile(gateFile(scratchDir), "utf8"));
      expect(gate).toMatchObject({ passed: true, model: "aw-cache-only", catalog: "models_cache", toolMode: "code_mode_only" });
      expect(gate.offered).toContain("exec");
    }, 120_000);

    it("fails the gate for a model the catalog lacks", async () => {
      const profile = createCodexProfile({ CODEX_HOME: home });
      await profile.prepare({ ...ctx(), model: "aw-not-in-catalog" });
      await expect(profile.check!({ ...ctx(), model: "aw-not-in-catalog" })).rejects.toThrow(/catalog has no model aw-not-in-catalog/);
      expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(SYNTHETIC);
      expect(JSON.parse(await readFile(gateFile(scratchDir), "utf8"))).toMatchObject({ passed: false });
    }, 120_000);
  });

  it("a broken scratch config fails the gate and removes the trust entry again", async () => {
    const profile = createCodexProfile({ CODEX_HOME: home });
    await profile.prepare(ctx());
    await writeFile(path.join(scratchDir, ".codex", "config.toml"), "");
    await expect(profile.check!(ctx())).rejects.toThrow(/no-fallback check failed: .*acted on the worker/);
    const config = parse(await readFile(path.join(home, "config.toml"), "utf8"));
    expect(hasTrust(config, scratchDir, { key: expectedTrustKey(scratchDir), hash: "" })).toBe(false);
    expect(config.hooks).toBeUndefined();
    expect(await readFile(path.join(home, "config.toml"), "utf8")).toBe(SYNTHETIC);
  }, 120_000);
});

describe("the worker's Codex model cache", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "aw-codex-cache-test-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const write = (cache: unknown) => writeFile(path.join(dir, "models_cache.json"), typeof cache === "string" ? cache : JSON.stringify(cache));

  it("reads the Codex version from the app-server userAgent", () => {
    expect(codexVersion("bb/0.167.1 (Arch Linux Rolling Release; x86_64) unknown (bb; 1.0.0)")).toBe("0.167.1");
    expect(codexVersion("bb/0.168.0-alpha.2 (Linux)")).toBe("0.168.0-alpha.2");
    expect(codexVersion("unknown")).toBeNull();
  });

  it("uses the cache only when the installed Codex wrote it", async () => {
    expect(await cachedModels(dir, "0.167.1")).toEqual({ models: null, skipped: null });
    await write({ client_version: "0.167.1", models: [{ slug: "m" }] });
    expect(await cachedModels(dir, "0.167.1")).toEqual({ models: [{ slug: "m" }], skipped: null });
    expect(await cachedModels(dir, "0.168.0")).toEqual({ models: null, skipped: "models_cache.json is for Codex 0.167.1, the worker runs 0.168.0" });
    expect(await cachedModels(dir, null)).toEqual({ models: null, skipped: "models_cache.json is for Codex 0.167.1, the worker runs (unknown)" });
    await write({ models: [{ slug: "m" }] });
    expect((await cachedModels(dir, "0.167.1")).skipped).toBe("models_cache.json is for Codex (no version), the worker runs 0.167.1");
    await write("{not json");
    await expect(cachedModels(dir, "0.167.1")).rejects.toThrow(/not valid JSON/);
  });
});
