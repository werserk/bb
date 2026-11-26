import { experimental_spawnHostProcess as spawnHostProcess } from "@get-bb/plugin-sdk/process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "smol-toml";
import { WorkspaceRefusal } from "../confine.js";

type Json = Record<string, unknown>;

export interface CodexLaunch {
  command: string;
  args: string[];
}

export function resolveCodexLaunch(env: NodeJS.ProcessEnv): CodexLaunch {
  const command = env.BB_CODEX_BRIDGE_APP_SERVER_COMMAND;
  if (!command) return { command: "codex", args: ["app-server"] };
  const raw = env.BB_CODEX_BRIDGE_APP_SERVER_ARGS;
  const args: unknown = raw ? JSON.parse(raw) : [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new WorkspaceRefusal("BB_CODEX_BRIDGE_APP_SERVER_ARGS is not a JSON array of strings");
  }
  return { command, args };
}

const BLOCKED = "blocked by PreToolUse hook";
const PRECHECKED: Record<string, RegExp> = {
  apply_patch: /expects a string input|apply_patch verification failed/,
  read_mcp_resource: /unknown MCP server|missing field `server`/,
};
const DECOY = "aw_canary_other_plugin";
const ABSENT = "AWABSENT";
const TURN_TIMEOUT_MS = 40_000;

const FAKE_MCP = `import { writeFileSync } from "node:fs";
import path from "node:path";
const marks = process.env.AW_MARK_DIR;
writeFileSync(path.join(marks, "mcp_started_" + process.env.AW_MCP_NAME), "1");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    let result;
    if (msg.method === "initialize") result = { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {}, resources: {} }, serverInfo: { name: "aw-canary", version: "1" } };
    else if (msg.method === "tools/list") result = { tools: [{ name: "touch", description: "canary", inputSchema: { type: "object", properties: {} } }] };
    else if (msg.method === "resources/list") result = { resources: [] };
    else {
      writeFileSync(path.join(marks, "mcp_called_" + process.env.AW_MCP_NAME), "1");
      result = { content: [{ type: "text", text: "touched" }], contents: [] };
    }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
  }
});
`;


interface MockRequest {
  tools: Json[];
  outputs: Map<string, string>;
}

function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => String((part as Json).text ?? "")).join("");
  return JSON.stringify(output ?? "");
}

async function startMock(reply: (request: MockRequest) => Json[]) {
  const requests: MockRequest[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      if (!req.url?.includes("/responses")) {
        res.writeHead(404).end();
        return;
      }
      const parsed = JSON.parse(body) as { tools?: Json[]; input?: Json[] };
      const input = parsed.input ?? [];
      const outputs = new Map<string, string>();
      for (const item of input) {
        if (typeof item.type === "string" && item.type.endsWith("_output")) outputs.set(String(item.call_id), outputText(item.output));
      }
      const extra = input.filter((item) => item.type === "additional_tools").flatMap((item) => (item.tools as Json[] | undefined) ?? []);
      const request = { tools: [...(parsed.tools ?? []), ...extra], outputs };
      requests.push(request);
      const id = `r${requests.length}`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Json) => res.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
      send({ type: "response.created", response: { id } });
      for (const item of reply(request)) send({ type: "response.output_item.done", item });
      const usage = { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 };
      send({ type: "response.completed", response: { id, usage } });
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

function mockProviderArgs(url: string, model: string | null, catalog: string | null): string[] {
  return [
    ...(model ? ["-c", `model=${JSON.stringify(model)}`] : []),
    ...(catalog ? ["-c", `model_catalog_json=${JSON.stringify(catalog)}`] : []),
    "-c", 'model_provider="aw_canary"',
    "-c", 'model_providers.aw_canary.name="aw_canary"',
    "-c", `model_providers.aw_canary.base_url=${JSON.stringify(url)}`,
    "-c", 'model_providers.aw_canary.wire_api="responses"',
    "-c", "model_providers.aw_canary.requires_openai_auth=false",
    "-c", "model_providers.aw_canary.supports_websockets=false",
  ];
}


class AppServer {
  readonly dynamicCalls: string[] = [];
  readonly turnCompleted: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private exited: Error | undefined;

  constructor(launch: CodexLaunch, extraArgs: string[], env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal) {
    let completeTurn = () => {};
    this.turnCompleted = new Promise<void>((resolve) => (completeTurn = resolve));
    this.child = spawnHostProcess(launch.command, [...launch.args, ...extraArgs], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const fail = (error: Error) => {
      this.exited ??= error;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
    };
    this.child.on("error", (error) => fail(new WorkspaceRefusal(`could not start ${launch.command}: ${error.message}`)));
    this.child.on("exit", (code) => fail(new WorkspaceRefusal(`codex app-server exited (${code}): ${this.stderr.trim().slice(-300)}`)));
    signal.addEventListener("abort", () => fail(new WorkspaceRefusal("cancelled")), { once: true });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => (this.stderr = (this.stderr + chunk).slice(-4000)));
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      this.buffer += chunk;
      let i;
      while ((i = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        if (line) this.onMessage(JSON.parse(line) as Json, completeTurn);
      }
    });
  }

  private send(message: Json) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onMessage(message: Json, completeTurn: () => void) {
    const id = message.id as number | undefined;
    const method = message.method as string | undefined;
    if (id !== undefined && method === undefined) {
      const waiter = this.pending.get(id);
      this.pending.delete(id);
      if (message.error) waiter?.reject(new WorkspaceRefusal(`codex app-server: ${JSON.stringify(message.error).slice(0, 300)}`));
      else waiter?.resolve((message.result ?? {}) as Json);
    } else if (id !== undefined && method === "item/tool/call") {
      this.dynamicCalls.push(String((message.params as Json | undefined)?.tool));
      this.send({ id, result: { contentItems: [{ type: "inputText", text: "[aw canary] ok" }], success: true } });
    } else if (id !== undefined && method?.endsWith("requestApproval")) {
      this.send({ id, result: { decision: "decline" } });
    } else if (id !== undefined && method) {
      this.send({ id, error: { code: -32601, message: "not handled by the account-workers canary" } });
    } else if (method === "turn/completed") {
      completeTurn();
    }
  }

  request(method: string, params: Json, timeoutMs = 30_000): Promise<Json> {
    if (this.exited) return Promise.reject(this.exited);
    return new Promise<Json>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkspaceRefusal(`codex app-server: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.send({ id, method, params });
    });
  }

  async initialize(): Promise<string> {
    const result = await this.request("initialize", { clientInfo: { name: "bb", version: "1.0.0", title: null }, capabilities: { experimentalApi: true } });
    this.send({ method: "initialized" });
    return String(result.userAgent ?? "unknown");
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => this.child.once("exit", () => resolve()));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    await exited;
    clearTimeout(timer);
  }
}

function canaryEnv(home: string, temp: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home, TMPDIR: temp, NO_PROXY: "127.0.0.1,localhost" };
  for (const name of ["PATH", "HOME", "LANG"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

interface StartedThread {
  server: AppServer;
  threadId: string;
  userAgent: string;
}

async function startThread(
  opts: { launch: CodexLaunch; home: string; temp: string; scratchDir: string; url: string; model: string | null; catalog?: string | null; signal: AbortSignal; toolNames: readonly string[] },
): Promise<StartedThread> {
  const server = new AppServer(opts.launch, mockProviderArgs(opts.url, opts.model, opts.catalog ?? null), canaryEnv(opts.home, opts.temp), opts.temp, opts.signal);
  try {
    const userAgent = await server.initialize();
    const schema = { type: "object", properties: { command: { type: "string" } }, additionalProperties: true };
    const started = await server.request("thread/start", {
      cwd: opts.scratchDir,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      ephemeral: false,
      developerInstructions: "account-workers canary",
      config: { "memories.use_memories": true, "memories.generate_memories": true, "shell_environment_policy.set.BB_THREAD_ID": "aw-canary" },
      dynamicTools: [...opts.toolNames, DECOY].map((name) => ({ type: "function", name, description: name, inputSchema: schema })),
    });
    const threadId = String((started.thread as Json | undefined)?.id ?? "");
    if (!threadId) throw new WorkspaceRefusal("codex app-server returned no thread id");
    return { server, threadId, userAgent };
  } catch (error) {
    await server.close();
    throw error;
  }
}

interface ListedHook {
  key: string;
  source: string;
  currentHash: string;
  trustStatus: string;
}

async function projectHooks(server: AppServer, threadId: string, scratchDir: string): Promise<ListedHook[]> {
  const listed = await server.request("hooks/list", { threadId });
  const prefix = `${path.join(scratchDir, ".codex", "hooks.json")}:`;
  return ((listed.data as Json[] | undefined) ?? [])
    .flatMap((entry) => (entry.hooks as ListedHook[] | undefined) ?? [])
    .filter((hook) => hook.source === "project" && hook.key.startsWith(prefix));
}

async function withTemp<T>(run: (temp: string) => Promise<T>): Promise<T> {
  const temp = await mkdtemp(path.join(tmpdir(), "aw-codex-canary-"));
  try {
    return await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export function discoverHookTrust(
  opts: { launch: CodexLaunch; scratchDir: string; mcpNames: readonly string[]; signal: AbortSignal },
): Promise<{ key: string; hash: string }> {
  return withTemp(async (temp) => {
    const home = path.join(temp, "home");
    await mkdir(home, { mode: 0o700 });
    const servers = Object.fromEntries(opts.mcpNames.map((name) => [name, { command: "/bin/false" }]));
    await writeFile(path.join(home, "config.toml"), stringify({ projects: { [opts.scratchDir]: { trust_level: "trusted" } }, mcp_servers: servers }));
    const mock = await startMock(() => []);
    try {
      const { server, threadId } = await startThread({ ...opts, home, temp, url: mock.url, model: null, toolNames: [] });
      try {
        const hooks = await projectHooks(server, threadId, opts.scratchDir);
        if (hooks.length !== 1 || !hooks[0]!.currentHash) {
          throw new WorkspaceRefusal(`Codex lists ${hooks.length} guard hooks in the scratch directory, expected 1`);
        }
        return { key: hooks[0]!.key, hash: hooks[0]!.currentHash };
      } finally {
        await server.close();
      }
    } finally {
      await mock.close();
    }
  });
}


interface PlannedCall {
  item: Json;
  expect: "marker" | "blocked" | "enumerate" | "reach";
  name: string;
}

function patch(file: string): string {
  return `*** Begin Patch\n*** Add File: ${file}\n+x\n*** End Patch\n`;
}

export function knownCalls(marks: string, mcpNames: readonly string[], toolNames: readonly string[], codeMode = true): PlannedCall[] {
  const m = (name: string) => path.join(marks, name);
  const fn = (name: string, args: Json, expect: PlannedCall["expect"] = "marker", namespace?: string): PlannedCall => ({
    name,
    expect,
    item: { type: "function_call", name, arguments: JSON.stringify(args), ...(namespace ? { namespace } : {}) },
  });
  const code = (name: string, input: string, expect: PlannedCall["expect"] = "marker"): PlannedCall => ({
    name,
    expect: codeMode ? expect : "marker",
    item: { type: "custom_tool_call", name: "exec", input },
  });
  const nested = (name: string, args: Json): PlannedCall =>
    code(`exec>${name}`, `if (typeof tools[${JSON.stringify(name)}] !== "function") text(${JSON.stringify(ABSENT)}); else text(String(await tools[${JSON.stringify(name)}](${JSON.stringify(args)}).catch((e) => e)));`, "blocked");
  const mcp = mcpNames[0];
  const calls: PlannedCall[] = [
    fn("exec_command", { cmd: `touch ${m("exec_command")}`, yield_time_ms: 10_000 }),
    fn("shell", { command: ["touch", m("shell")] }),
    fn("shell_command", { command: `touch ${m("shell_command")}` }),
    { name: "local_shell", expect: "marker", item: { type: "local_shell_call", status: "completed", action: { type: "exec", command: ["touch", m("local_shell")] } } },
    { name: "apply_patch", expect: "marker", item: { type: "custom_tool_call", name: "apply_patch", input: patch(m("apply_patch_custom")) } },
    fn("apply_patch", { input: patch(m("apply_patch_fn")) }),
    fn("view_image", { path: m("worker-image.png") }),
    code("exec>exec_command", `await tools.exec_command({cmd: ${JSON.stringify(`touch ${m("code_exec_command")}`)}, yield_time_ms: 10000});`),
    code("exec>apply_patch", `await tools.apply_patch(${JSON.stringify(patch(m("code_apply_patch")))});`),
    code(
      "exec>escape",
      `for (const f of [() => require("fs").writeFileSync(${JSON.stringify(m("code_require"))}, "x"), () => process.binding("fs"), () => Deno.writeTextFileSync(${JSON.stringify(m("code_deno"))}, "x"), async () => fetch(${JSON.stringify(`file://${m("worker-image.png")}`)})]) { try { await f(); text("ran"); } catch (e) { text("no"); } }`,
    ),
    nested("read_mcp_resource", { server: mcp ?? "aw", uri: "aw://x" }),
    fn(DECOY, { command: "touch x" }, "blocked"),
    nested(DECOY, { command: "touch x" }),
  ];
  if (mcp !== undefined) {
    calls.push(fn(`mcp__${mcp}__touch`, {}), fn("touch", {}, "marker", `mcp__${mcp}__`));
  }
  const reach = toolNames.includes("workspace_exec") ? "workspace_exec" : toolNames[0];
  if (reach !== undefined) {
    calls.push(fn(reach, { command: "echo canary" }, "reach"), code(`exec>${reach}`, `text(JSON.stringify(await tools.${reach}({command: "echo canary"})));`, "reach"));
  }
  return calls;
}

export interface OfferedTool {
  name: string;
  type: string;
  namespace?: string;
}

export function offeredTools(tools: readonly Json[]): OfferedTool[] {
  const out: OfferedTool[] = [];
  for (const tool of tools) {
    if (tool.type === "namespace") {
      const ns = String(tool.name);
      for (const inner of (tool.tools as Json[] | undefined) ?? []) {
        out.push({ name: String(inner.name), type: String(inner.type), ...(ns === "functions" ? {} : { namespace: ns }) });
      }
    } else {
      out.push({ name: String(tool.name ?? tool.type), type: String(tool.type) });
    }
  }
  return out;
}

const NOT_HOOKED = new Set(["exec", "wait"]);

export function sweepCalls(offered: readonly OfferedTool[], allowed: readonly string[]): PlannedCall[] {
  const skip = new Set([...allowed, ...NOT_HOOKED]);
  const codeMode = offered.some((tool) => tool.name === "exec" && tool.type === "custom");
  const calls: PlannedCall[] = [];
  for (const tool of offered) {
    if (skip.has(tool.name)) continue;
    if (tool.type === "function") {
      calls.push({ name: tool.name, expect: "blocked", item: { type: "function_call", name: tool.name, arguments: "{}", ...(tool.namespace ? { namespace: tool.namespace } : {}) } });
    } else if (tool.type === "custom") {
      calls.push({ name: tool.name, expect: "blocked", item: { type: "custom_tool_call", name: tool.name, input: "" } });
    }
  }
  if (!codeMode) return calls;
  const skipList = JSON.stringify([...skip]);
  calls.push({
    name: "exec>*",
    expect: "enumerate",
    item: {
      type: "custom_tool_call",
      name: "exec",
      input: `const skip = new Set(${skipList}); const out = {}; for (const n of Object.keys(tools)) { if (skip.has(n)) continue; try { await tools[n]({}); out[n] = "ran"; } catch (e) { out[n] = String(e).slice(0, 300); } } text("AWSWEEP" + JSON.stringify(out));`,
    },
  });
  return calls;
}


export interface CanaryObservation {
  model: string | null;
  catalogModels: string[];
  toolMode: string | null;
  turnCompleted: boolean;
  hookTrust: string | undefined;
  markers: string[];
  dynamicCalls: string[];
  offered: OfferedTool[];
  calls: { name: string; expect: PlannedCall["expect"]; output: string | undefined }[];
}

export function evaluateGate(obs: CanaryObservation, allowed: readonly string[]): string[] {
  const failures: string[] = [];
  if (obs.model !== null && !obs.catalogModels.includes(obs.model)) failures.push(`the canary's model catalog has no model ${obs.model}`);
  if (obs.toolMode === "code_mode_only" && !obs.offered.some((tool) => tool.name === "exec" && tool.type === "custom")) {
    failures.push(`the catalog marks ${String(obs.model)} code_mode_only, but the canary was not offered exec`);
  }
  if (!obs.turnCompleted) failures.push("the canary turn did not complete");
  if (obs.hookTrust !== "trusted") failures.push(`the guard hook is ${obs.hookTrust ?? "missing"}, not trusted`);
  if (obs.markers.length > 0) failures.push(`acted on the worker: ${obs.markers.sort().join(", ")}`);
  const allowedSet = new Set([...allowed, ...NOT_HOOKED]);
  for (const tool of obs.offered) {
    if (tool.type === "custom" && tool.name !== "exec" && tool.name !== "apply_patch") failures.push(`unhooked custom tool offered: ${tool.name}`);
    if (tool.type !== "function" && tool.type !== "custom") failures.push(`hosted tool offered: ${tool.type}`);
  }
  const reached = obs.dynamicCalls.filter((name) => allowedSet.has(name)).length;
  const reachCalls = obs.calls.filter((call) => call.expect === "reach").length;
  if (reachCalls === 0 || reached < reachCalls) failures.push("the workspace tool did not reach BB both directly and from exec");
  if (obs.dynamicCalls.some((name) => !allowedSet.has(name))) failures.push(`a tool outside the allowlist reached BB: ${obs.dynamicCalls.join(", ")}`);
  for (const call of obs.calls) {
    const output = call.output ?? "";
    const nested = call.name.startsWith("exec>");
    const bare = nested ? call.name.slice("exec>".length) : call.name;
    const didNothing = (nested && output.includes(ABSENT)) || PRECHECKED[bare]?.test(output) === true;
    if (call.expect === "blocked" && !output.includes(BLOCKED) && !didNothing) failures.push(`${call.name} was not blocked by the guard hook (${output.replace(/\s+/g, " ").slice(0, 160) || "no output"})`);
    if (call.expect !== "enumerate") continue;
    const at = call.output?.indexOf("AWSWEEP") ?? -1;
    if (at < 0) {
      failures.push("the nested tool sweep did not run");
      continue;
    }
    const swept = JSON.parse(call.output!.slice(at + "AWSWEEP".length).split("\n")[0]!) as Record<string, string>;
    for (const [name, result] of Object.entries(swept)) {
      if (!result.includes(BLOCKED) && PRECHECKED[name]?.test(result) !== true) failures.push(`nested ${name} was not blocked by the guard hook`);
    }
  }
  return failures;
}


export interface CanaryInput {
  launch: CodexLaunch;
  config: Json;
  mcpNames: readonly string[];
  home: string;
  scratchDir: string;
  trustKey: string;
  model: string | null;
  toolNames: readonly string[];
  allowed: readonly string[];
  signal: AbortSignal;
  nodePath?: string;
}

export interface CanaryReport {
  failures: string[];
  userAgent: string;
  command: string;
  model: string | null;
  catalog: "models_cache" | "bundled";
  toolMode: string | null;
  offered: string[];
  calls: number;
}

function booleans(value: unknown): Json {
  return Object.fromEntries(Object.entries((value ?? {}) as Json).filter(([, v]) => typeof v === "boolean"));
}

function enabledFlags(value: unknown): Json {
  const out: Json = {};
  for (const [key, entry] of Object.entries((value ?? {}) as Json)) {
    const enabled = (entry as Json | null)?.enabled;
    if (typeof enabled === "boolean") out[key] = { enabled };
  }
  return out;
}

export function canaryConfig(input: Pick<CanaryInput, "config" | "mcpNames" | "scratchDir" | "trustKey">, fakeMcp: string, marks: string, nodePath: string): Json {
  const config = input.config;
  const pick = (key: string) => (typeof config[key] === "string" ? { [key]: config[key] } : {});
  const project = ((config.projects ?? {}) as Json)[input.scratchDir];
  const hook = ((((config.hooks ?? {}) as Json).state ?? {}) as Json)[input.trustKey];
  return {
    ...pick("web_search"),
    features: booleans(config.features),
    memories: booleans(config.memories),
    plugins: enabledFlags(config.plugins),
    apps: enabledFlags(config.apps),
    ...(project ? { projects: { [input.scratchDir]: project } } : {}),
    ...(hook ? { hooks: { state: { [input.trustKey]: hook } } } : {}),
    mcp_servers: Object.fromEntries(input.mcpNames.map((name) => [name, { command: nodePath, args: [fakeMcp], env: { AW_MARK_DIR: marks, AW_MCP_NAME: name } }])),
  };
}

async function cachedModels(home: string): Promise<Json[] | null> {
  let text: string;
  try {
    text = await readFile(path.join(home, "models_cache.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const models = (JSON.parse(text) as Json).models;
    return Array.isArray(models) && models.length > 0 ? (models as Json[]) : null;
  } catch {
    throw new WorkspaceRefusal("the worker's Codex models_cache.json is not valid JSON");
  }
}

async function listModels(server: AppServer): Promise<string[]> {
  const slugs: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const result = await server.request("model/list", { includeHidden: true, limit: 100, cursor });
    for (const m of (result.data as Json[] | undefined) ?? []) slugs.push(String(m.model ?? m.id));
    cursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    if (cursor === null) break;
  }
  return slugs;
}

export function runCanary(input: CanaryInput): Promise<CanaryReport> {
  return withTemp(async (temp) => {
    const home = path.join(temp, "home");
    const marks = path.join(temp, "marks");
    await mkdir(home, { mode: 0o700 });
    await mkdir(marks, { mode: 0o700 });
    const fakeMcp = path.join(temp, "fake-mcp.mjs");
    await writeFile(fakeMcp, FAKE_MCP);
    await writeFile(path.join(marks, "worker-image.png"), Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"));
    const nodePath = input.nodePath ?? process.execPath;
    await writeFile(path.join(home, "config.toml"), stringify(canaryConfig(input, fakeMcp, marks, nodePath)));
    const cached = await cachedModels(input.home);
    const catalog = cached === null ? null : path.join(temp, "model-catalog.json");
    if (catalog !== null) await writeFile(catalog, JSON.stringify({ models: cached }), { mode: 0o600 });
    const model = input.model;
    const entry = cached?.find((m) => m.slug === model);
    const toolMode = typeof entry?.tool_mode === "string" ? entry.tool_mode : null;

    const planned: PlannedCall[] = [];
    let offered: OfferedTool[] = [];
    const mock = await startMock((request) => {
      if (request.outputs.size > 0) return [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }];
      if (planned.length > 0) return [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }];
      offered = offeredTools(request.tools);
      const codeMode = offered.some((tool) => tool.name === "exec" && tool.type === "custom");
      planned.push(...knownCalls(marks, input.mcpNames, input.toolNames, codeMode), ...sweepCalls(offered, input.allowed));
      return planned.map((call, i) => ({ ...call.item, call_id: `aw_${i}` }));
    });
    try {
      const { server, threadId, userAgent } = await startThread({ ...input, home, temp, url: mock.url, model, catalog });
      try {
        const catalogModels = await listModels(server);
        const hookTrust = (await projectHooks(server, threadId, input.scratchDir)).find((hook) => hook.key === input.trustKey)?.trustStatus;
        await server.request("turn/start", { threadId, input: [{ type: "text", text: "canary", text_elements: [] }] });
        let timer: NodeJS.Timeout | undefined;
        const turnCompleted = await Promise.race([
          server.turnCompleted.then(() => true),
          new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), TURN_TIMEOUT_MS))),
        ]);
        clearTimeout(timer);
        const outputs = new Map<string, string>();
        for (const request of mock.requests) for (const [id, text] of request.outputs) outputs.set(id, text);
        const observation: CanaryObservation = {
          model,
          catalogModels,
          toolMode,
          turnCompleted,
          hookTrust,
          markers: (await readdir(marks)).filter((name) => name !== "worker-image.png"),
          dynamicCalls: server.dynamicCalls,
          offered,
          calls: planned.map((call, i) => ({ name: call.name, expect: call.expect, output: outputs.get(`aw_${i}`) })),
        };
        return {
          failures: evaluateGate(observation, input.allowed),
          userAgent,
          command: [input.launch.command, ...input.launch.args].join(" "),
          model,
          catalog: catalog === null ? "bundled" : "models_cache",
          toolMode,
          offered: offered.map((tool) => (tool.namespace ? `${tool.namespace}${tool.name}` : tool.name)),
          calls: planned.length,
        };
      } finally {
        await server.close();
      }
    } finally {
      await mock.close();
    }
  });
}
