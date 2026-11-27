import Database from "better-sqlite3";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { ExperimentalFakeHostRpcCall } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "./server.js";
import { BindingStore } from "./bindings.js";
import { noteProviderStart, WORKER_PROVIDER_ID, workerProvider, type WorkerCreateContext } from "./provider.js";
import { SAME_HOST, TOOL_NAMES } from "./tools.js";

const WORKER = "host-worker";
const WORKSPACE = "host-workspace";
const SCRATCH = "/state/bb-account-workers/scratch/aw_x";
const ROOT = "/work/repo";
const INPUTS = { workspaceHostId: WORKSPACE, root: ROOT };

type HostRpc = (call: ExperimentalFakeHostRpcCall) => unknown;

function rpc(overrides: Record<string, HostRpc> = {}): HostRpc {
  return (call) => {
    const override = overrides[call.method];
    if (override !== undefined) return override(call);
    switch (call.method) {
      case "resolveRoot":
        return { ok: true, root: ROOT, hostname: "ws", instructions: [{ file: "AGENTS.md", text: "MARKER", truncated: false }], branch: "main" };
      case "prepareScratch":
        return { ok: true, path: SCRATCH };
      case "releaseScratch":
        return { ok: true };
      default:
        throw new Error(`unexpected ${call.method}`);
    }
  };
}

const hosts = (workspaceStatus = "connected") => [
  makeHostResponse({ id: WORKER, name: "worker", status: "connected" }),
  makeHostResponse({ id: WORKSPACE, name: "workspace", status: workspaceStatus as "connected" }),
];

const sources = [{ id: "src1", projectId: "p1", isDefault: true, createdAt: 1, updatedAt: 1, type: "local_path", hostId: WORKSPACE, path: ROOT }];

async function load(hostRpc: HostRpc, options: { workspaceStatus?: string; threadStatus?: string } = {}) {
  const host = createFakePluginHost({ pluginId: "account-workers", experimental_callHostRpc: hostRpc });
  await plugin(host.bb);
  host.harness.sdk.stub("hosts.list", async () => hosts(options.workspaceStatus));
  host.harness.sdk.stub("projects.get", async () => ({ id: "p1", sources }) as never);
  host.harness.sdk.stub("projects.machineEnvironment", async () => ({
    builtInGit: { status: "disabled" as const, statusMessage: "" },
    variables: [],
    inheritedVariables: [],
  }) as never);
  host.harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
    makeThreadResponse({ id: args.threadId, projectId: "p1", status: (options.threadStatus ?? "idle") as "idle" }));
  return host;
}

type Loaded = Awaited<ReturnType<typeof load>>;

function provider(host: Loaded) {
  const registered = host.harness.inspection.registrations.environmentProviders.get(WORKER_PROVIDER_ID);
  if (registered === undefined) throw new Error("provider not registered");
  return registered as unknown as {
    apiVersion: number;
    validate(ctx: unknown): Promise<{ action: string; message?: string }>;
    create(ctx: unknown): Promise<{ status: string; path?: string; message?: string; resource?: unknown }>;
    remove(ctx: unknown): Promise<{ status: string; message?: string }>;
    availability(ctx: unknown): Promise<{ status: string; message?: string }>;
  };
}

const report = () => {
  const steps: string[] = [];
  return { steps, step: (text: string) => void steps.push(text), log: () => undefined };
};

function createContext(threadId = "thr_new", overrides: Partial<WorkerCreateContext> = {}) {
  return {
    project: { id: "p1" },
    host: { id: WORKER, name: "worker", status: "connected" },
    inputs: INPUTS,
    thread: { id: threadId, projectId: "p1", providerId: "claude-code" },
    attempt: 1,
    report: report(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

const calls = (host: Loaded, method: string) => host.harness.experimental_hostRpcCalls.filter((c) => c.method === method);

async function startHook(host: Loaded, threadId: string, providerId = "claude-code", model: string | null = "claude-model") {
  const handler = host.harness.inspection.registrations.hooks["message.dispatch"]!;
  return handler(makeMessageDispatchHookContext({
    thread: { id: threadId, status: "pending", createdAt: Date.now() },
    attempt: "start-turn",
    environmentIntent: { kind: "provider", environmentProviderId: WORKER_PROVIDER_ID, machine: { type: "existing", hostId: WORKER }, inputs: INPUTS },
    requestedExecution: { providerId, model, reasoningLevel: null, serviceTier: null, permissionMode: null },
  }));
}

describe("worker environment provider", () => {
  it("registers a version-1 provider with a valid id and inputs", async () => {
    const host = await load(rpc());
    expect(provider(host).apiVersion).toBe(1);
  });

  it("validate accepts the project's source and refuses the agent host, an offline machine, a project without a source and another root", async () => {
    const host = await load(rpc());
    const ctx = (inputs: Record<string, string>) => ({ project: { id: "p1" }, host: { id: WORKER }, inputs, projectCheckout: null, gitRemote: null });
    expect(await provider(host).validate(ctx(INPUTS))).toEqual({ action: "accept" });
    expect(await provider(host).validate(ctx({ workspaceHostId: WORKER, root: ROOT }))).toEqual({ action: "refuse", message: SAME_HOST });
    expect((await provider(host).validate(ctx({ ...INPUTS, root: "/etc" }))).action).toBe("refuse");
    const offline = await load(rpc(), { workspaceStatus: "disconnected" });
    expect((await provider(offline).validate(ctx(INPUTS))).message).toContain("disconnected");
    host.harness.sdk.stub("projects.get", async () => ({ id: "p1", sources: [] }) as never);
    expect((await provider(host).validate(ctx(INPUTS))).message).toContain("no source");
  });

  it("create makes the scratch with the start's model and a binding for the real thread, which gets the tools", async () => {
    const host = await load(rpc());
    await startHook(host, "thr_new", "claude-code", "claude-model");
    const result = await provider(host).create(createContext());
    expect(result).toMatchObject({ status: "created", path: SCRATCH, ownsPath: false });
    const [prepare] = calls(host, "prepareScratch");
    expect(prepare?.hostId).toBe(WORKER);
    expect(prepare?.input).toMatchObject({ profile: "claude", providerId: "claude-code", model: "claude-model" });
    expect(result.resource).toEqual({ bindingId: (prepare!.input as { bindingId: string }).bindingId });
    expect(host.harness.inspection.experimental_rpcInvalidations).toContainEqual(["workspace:thr_new"]);
    const config = await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: "thr_new" }, host: { id: WORKER }, environment: { path: SCRATCH }, provider: { id: "claude-code" } }),
    );
    expect(config.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(config.instructions).toContain("MARKER");
    expect(config.instructions).toContain("A file path the user mentions is relative to the workspace root");
  });

  it("a second create for the same thread reuses the binding without touching the worker", async () => {
    const host = await load(rpc());
    const first = await provider(host).create(createContext());
    const second = await provider(host).create(createContext("thr_new", { attempt: 2 }));
    expect(second).toEqual(first);
    expect(calls(host, "prepareScratch")).toHaveLength(1);
  });

  it("create refuses a provider without a profile before touching the worker", async () => {
    const host = await load(rpc());
    const result = await provider(host).create(createContext("thr_new", { thread: { id: "thr_new", projectId: "p1", providerId: "pi" } }));
    expect(result).toMatchObject({ status: "failed" });
    expect(host.harness.experimental_hostRpcCalls).toHaveLength(0);
  });

  it("remove releases the scratch on the worker once, and archive leaves a provider binding to core", async () => {
    const host = await load(rpc());
    const created = await provider(host).create(createContext());
    const archived = makeThreadResponse({ id: "thr_new", archivedAt: Date.now() - 60_000 });
    await host.harness.behavior.emitThreadEvent("thread.archived", { thread: archived });
    await host.harness.behavior.emitThreadEvent("thread.deleted", { thread: archived });
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: archived, lastAssistantText: null });
    expect(calls(host, "releaseScratch")).toHaveLength(0);
    expect(await host.harness.callRpc("threadWorkspace", { threadId: "thr_new" })).toMatchObject({ workspace: { root: ROOT } });
    const ctx = { environment: null, hostId: WORKER, path: SCRATCH, pathKey: "k", resource: created.resource, attempt: 1, report: report(), signal: new AbortController().signal };
    expect(await provider(host).remove(ctx)).toEqual({ status: "removed" });
    expect(calls(host, "releaseScratch").map((c) => c.hostId)).toEqual([WORKER]);
    expect(await provider(host).remove(ctx)).toEqual({ status: "removed" });
    expect(calls(host, "releaseScratch")).toHaveLength(1);
  });

  it("a failed worker cleanup makes remove fail so core retries it", async () => {
    let fail = true;
    const host = await load(rpc({ releaseScratch: () => (fail ? { ok: false, error: "disk busy" } : { ok: true }) }));
    const created = await provider(host).create(createContext());
    const ctx = { environment: null, hostId: WORKER, path: SCRATCH, pathKey: "k", resource: created.resource, attempt: 1, report: report(), signal: new AbortController().signal };
    expect(await provider(host).remove(ctx)).toEqual({ status: "failed", message: "disk busy" });
    fail = false;
    expect(await provider(host).remove({ ...ctx, attempt: 2 })).toEqual({ status: "removed" });
  });
});

describe("provider review cases", () => {
  const worker = (status = "connected") => ({ id: WORKER, name: "worker", status });

  it("availability: needs a connected machine and a source on another machine", async () => {
    const host = await load(rpc());
    const ask = (status?: string) => provider(host).availability({ project: { id: "p1" }, host: worker(status) });
    expect(await ask()).toEqual({ status: "available" });
    expect(await ask("disconnected")).toEqual({ status: "unavailable", message: "worker is disconnected" });
    host.harness.sdk.stub("projects.get", async () => ({ id: "p1", sources: [{ ...sources[0], hostId: WORKER }] }) as never);
    expect(await ask()).toEqual({ status: "unavailable", message: "No other machine holds this project's source" });
    host.harness.sdk.stub("projects.get", async () => ({ id: "p1", sources: [] }) as never);
    expect((await ask()).status).toBe("unavailable");
  });

  it("validate refuses when the workspace machine refuses the source path", async () => {
    const host = await load(rpc({ resolveRoot: () => ({ ok: false, error: "not a directory" }) }));
    const ctx = { project: { id: "p1" }, host: { id: WORKER }, inputs: INPUTS, projectCheckout: null, gitRemote: null };
    expect(await provider(host).validate(ctx)).toEqual({ action: "refuse", message: "Workspace path refused: not a directory" });
  });

  it("a reattempt on another worker fails instead of reusing the binding", async () => {
    const host = await load(rpc());
    await provider(host).create(createContext());
    const other = await provider(host).create(createContext("thr_new", { attempt: 2, host: { id: "host-other", name: "other", status: "connected" } }));
    expect(other.status).toBe("failed");
    expect(other.message).toMatch(/already has workspace binding/);
    expect(calls(host, "prepareScratch")).toHaveLength(1);
  });

  it("create fails when the chosen root is no longer the project's source, before the worker", async () => {
    const host = await load(rpc());
    const result = await provider(host).create(createContext("thr_new", { inputs: { workspaceHostId: WORKSPACE, root: "/elsewhere" } }));
    expect(result.status).toBe("failed");
    expect(result.message).toMatch(/no longer this project's source/);
    expect(calls(host, "prepareScratch")).toHaveLength(0);
    expect(await host.harness.callRpc("threadWorkspace", { threadId: "thr_new" })).toEqual({ workspace: null });
  });

  it("unarchive never restores a provider binding, even one in the archive undo window", async () => {
    const host = await load(rpc());
    await provider(host).create(createContext());
    host.bb.storage.database()
      .prepare("UPDATE bindings SET released_at = ?, release_reason = 'archive', release_due = ? WHERE thread_id = 'thr_new'")
      .run(Date.now(), Date.now() + 60_000);
    expect(await host.harness.callRpc("threadWorkspace", { threadId: "thr_new" })).toEqual({ workspace: null });
    await host.harness.behavior.emitThreadEvent("thread.unarchived", { thread: makeThreadResponse({ id: "thr_new" }) });
    expect(await host.harness.callRpc("threadWorkspace", { threadId: "thr_new" })).toEqual({ workspace: null });
  });

  it("the CLI rebind sends a picker thread to Change workspace and leaves it bound where it was", async () => {
    const host = await load(rpc());
    await provider(host).create(createContext());
    const result = await host.harness.behavior.runCli(["rebind", "--thread", "thr_new", "--workspace-machine", "workspace", "--path", "/elsewhere"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/use Change workspace/);
    expect(calls(host, "resolveRoot").some((c) => (c.input as { path: string }).path === "/elsewhere")).toBe(false);
    expect(await host.harness.callRpc("threadWorkspace", { threadId: "thr_new" })).toMatchObject({ workspace: { root: ROOT } });
  });
});

describe("worker start hook", () => {
  it("records the start's model on the inline attempt and again on a reattempt, and lets the thread proceed", async () => {
    const host = await load(rpc());
    expect(await startHook(host, "thr_a", "claude-code", "m1")).toEqual({ action: "proceed" });
    expect(await startHook(host, "thr_a", "claude-code", "m1")).toEqual({ action: "proceed" });
    await provider(host).create(createContext("thr_a"));
    expect(calls(host, "prepareScratch")[0]?.input).toMatchObject({ model: "m1" });
  });

  it("rejects a provider with no worker profile and ignores other environments and joins", async () => {
    const store = new BindingStore(new Database(":memory:"));
    const base = makeMessageDispatchHookContext({
      thread: { id: "thr_b", status: "pending" },
      attempt: "start-turn",
      environmentIntent: { kind: "provider", environmentProviderId: WORKER_PROVIDER_ID, machine: { type: "existing", hostId: WORKER }, inputs: INPUTS },
      requestedExecution: { providerId: "pi", model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
    });
    expect(noteProviderStart(store, base)?.action).toBe("reject");
    expect(noteProviderStart(store, { ...base, environmentIntent: { kind: "provider", environmentProviderId: "git-worktree", machine: { type: "existing", hostId: WORKER }, inputs: null } })).toBeNull();
    expect(noteProviderStart(store, { ...base, attempt: "join-turn" })).toBeNull();
    expect(noteProviderStart(store, { ...base, thread: { ...base.thread, status: "idle" } })).toBeNull();
    expect(store.startModel("thr_b")).toBeNull();
  });
});

describe("create deadline", () => {
  function direct(prepare: (signal: AbortSignal) => Promise<unknown>, deadlineMs: number) {
    const store = new BindingStore(new Database(":memory:"));
    const hostCalls: { method: string; input: unknown }[] = [];
    const deps = {
      store,
      host: {
        call: (async (method: string, input: unknown, options: { signal?: AbortSignal }) => {
          hostCalls.push({ method, input });
          if (method === "resolveRoot") return { ok: true, root: ROOT, hostname: "ws", instructions: [], branch: null };
          if (method === "prepareScratch") return prepare(options.signal!);
          return { ok: true };
        }) as never,
      },
      listHosts: async () => hosts(),
      projectSources: async () => sources,
      refusedMachineEnv: async () => [],
      release: async () => ({ kind: "cleaned" as const }),
      retire: () => undefined,
      changed: () => undefined,
      log: () => undefined,
      deadlineMs,
    };
    return { store, hostCalls, provider: workerProvider(deps), deps };
  }

  it("a worker that hangs past the deadline fails create with the step that hung and cleans up", async () => {
    const hang = (signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const { store, hostCalls, provider } = direct(hang, 50);
    const result = await provider.create(createContext());
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.message).toMatch(/Preparing the claude scratch directory on worker timed out after 0 s/);
    const release = hostCalls.find((c) => c.method === "releaseScratch");
    expect(release?.input).not.toHaveProperty("scratchPath");
    expect(store.recordByThread("thr_new")).toBeNull();
  });

  it("bounds steps whose calls ignore the signal: a hung SDK call or worker still fails at the deadline", async () => {
    const never = () => new Promise<never>(() => undefined);
    const ok = async () => ({ ok: true, path: SCRATCH });
    for (const [step, patch, prepare] of [
      ["Checking machine variables", { refusedMachineEnv: never }, ok],
      ["Resolving the workspace", { projectSources: never }, ok],
      ["Preparing the claude scratch directory on worker", {}, never],
    ] as const) {
      const { store, hostCalls, deps } = direct(prepare, 50);
      const result = await workerProvider({ ...deps, ...patch }).create(createContext());
      expect(result.status === "failed" && result.message).toBe(`account-workers: ${step} timed out after 0 s`);
      expect(store.recordByThread("thr_new")).toBeNull();
      expect(hostCalls.some((c) => c.method === "releaseScratch")).toBe(step.startsWith("Preparing"));
    }
  });

  it("a create cancelled before it starts fails at once, even on a step that ignores the signal", async () => {
    const { store, deps } = direct(async () => ({ ok: true, path: SCRATCH }), 60_000);
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const result = await workerProvider({ ...deps, refusedMachineEnv: () => new Promise<never>(() => undefined) }).create(
      createContext("thr_new", { signal: controller.signal }),
    );
    expect(result.status === "failed" && result.message).toBe("account-workers: Checking machine variables cancelled");
    expect(store.recordByThread("thr_new")).toBeNull();
  });

  it("an aborted create cleans up and does not blame the deadline", async () => {
    const controller = new AbortController();
    const hang = (signal: AbortSignal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("cancelled")));
      controller.abort();
    });
    const { hostCalls, provider } = direct(hang, 60_000);
    const result = await provider.create(createContext("thr_new", { signal: controller.signal }));
    expect(result.status === "failed" && result.message).not.toMatch(/timed out/);
    expect(hostCalls.some((c) => c.method === "releaseScratch")).toBe(true);
  });
});

describe("app RPCs", () => {
  it("lists agent → workspace choices with offline reasons, reports a thread's workspace and branch, and rebinds server-side", async () => {
    const host = await load(rpc(), { workspaceStatus: "disconnected" });
    const { choices } = (await host.harness.callRpc("choices", { projectId: "p1" })) as { choices: { agentHostId: string; disabledReason: string | null }[] };
    expect(choices).toEqual([expect.objectContaining({ agentHostId: WORKER, workspaceHostId: WORKSPACE, root: ROOT, disabledReason: "Workspace machine workspace is disconnected" })]);

    const online = await load(rpc());
    expect(await online.harness.callRpc("threadWorkspace", { threadId: "thr_none" })).toEqual({ workspace: null });
    await provider(online).create(createContext());
    expect(await online.harness.callRpc("threadWorkspace", { threadId: "thr_new" })).toMatchObject({
      workspace: { agentHostId: WORKER, workspaceHostId: WORKSPACE, root: ROOT, branch: "main", issue: null },
    });
    await expect(online.harness.callRpc("rebind", { threadId: "thr_new", workspaceHostId: WORKER })).rejects.toThrow(SAME_HOST);
    expect(await online.harness.callRpc("rebind", { threadId: "thr_new", workspaceHostId: WORKSPACE })).toMatchObject({ workspace: { root: ROOT } });
  });

  it("does not show or rebind a thread bound by the CLI spawn", async () => {
    const host = await load(rpc());
    host.harness.sdk.stub("threads.spawn", async () => makeThreadResponse({ id: "thr_cli" }));
    const spawned = await host.harness.behavior.runCli(
      ["spawn", "--workspace-machine", "workspace", "--path", ROOT, "--machine", "worker", "--prompt", "hi", "--project", "p1", "--json"],
    );
    expect(spawned.exitCode).toBe(0);
    expect(await host.harness.callRpc("threadWorkspace", { threadId: "thr_cli" })).toEqual({ workspace: null });
    expect(await host.harness.callRpc("workspaceOptions", { threadId: "thr_cli" })).toEqual({ options: [] });
    await expect(host.harness.callRpc("rebind", { threadId: "thr_cli", workspaceHostId: WORKSPACE })).rejects.toThrow(/bound by spawn/);
  });

  it("offers the thread's workspace machines, marks the current one and the offline ones", async () => {
    const host = await load(rpc());
    expect(await host.harness.callRpc("workspaceOptions", { threadId: "thr_none" })).toEqual({ options: [] });
    await provider(host).create(createContext());
    const option = { workspaceHostId: WORKSPACE, workspaceHostName: "workspace", root: ROOT, current: true, disabledReason: null };
    expect(await host.harness.callRpc("workspaceOptions", { threadId: "thr_new" })).toEqual({ options: [option] });
    host.harness.sdk.stub("hosts.list", async () => hosts("disconnected"));
    expect(await host.harness.callRpc("workspaceOptions", { threadId: "thr_new" })).toEqual({
      options: [{ ...option, disabledReason: "Workspace machine workspace is disconnected" }],
    });
    const other = makeHostResponse({ id: "host-other", name: "other", status: "connected" });
    host.harness.sdk.stub("hosts.list", async () => [...hosts(), other]);
    host.harness.sdk.stub("projects.get", async () => ({ id: "p1", sources: [...sources, { ...sources[0], id: "src2", hostId: "host-other", path: "/o" }] }) as never);
    expect(await host.harness.callRpc("workspaceOptions", { threadId: "thr_new" })).toEqual({
      options: [option, { workspaceHostId: "host-other", workspaceHostName: "other", root: "/o", current: false, disabledReason: null }],
    });
    host.harness.sdk.stub("hosts.list", async () => hosts().filter((h) => h.id !== WORKER));
    expect(await host.harness.callRpc("workspaceOptions", { threadId: "thr_new" })).toEqual({ options: [] });
  });
});

describe("provider id", () => {
  it("passes the SDK's environment provider validation, which refuses a dotted id", async () => {
    const host = await load(rpc());
    expect([...host.harness.inspection.registrations.environmentProviders.keys()]).toEqual([WORKER_PROVIDER_ID]);
    const declaration = workerProvider({
      store: new BindingStore(new Database(":memory:")),
      host: { call: (async () => ({ ok: true })) as never },
      listHosts: async () => hosts(),
      projectSources: async () => sources,
      refusedMachineEnv: async () => [],
      release: async () => ({ kind: "cleaned" as const }),
      retire: () => undefined,
      changed: () => undefined,
      log: () => undefined,
    });
    const register = (id: string) => {
      const fresh = createFakePluginHost({ pluginId: "account-workers" });
      fresh.bb.experimental_environments.register({ ...declaration, id } as unknown as Parameters<typeof fresh.bb.experimental_environments.register>[0]);
      return [...fresh.harness.inspection.registrations.environmentProviders.keys()];
    };
    expect(register(WORKER_PROVIDER_ID)).toEqual(["account-workers-worker"]);
    expect(() => register("account-workers.worker")).toThrow(/invalid environment provider id/);
  });
});
