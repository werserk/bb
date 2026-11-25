import { getActiveStoredTurnId, getThread } from "@bb/db";
import { attachManagedFixture } from "./attach.js";
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createPublicApiClient } from "@bb/server-contract";
import { startIntegrationServer } from "../helpers/harness.js";
import {
  createProject,
  createHostThread,
  getHosts,
  getEnvironment,
  stopThread,
} from "../helpers/api.js";
import { waitForThreadStatus } from "../helpers/assertions.js";
import { createTestGitRepo } from "../helpers/seed.js";

const dir = await mkdtemp(join(tmpdir(), "dual-"));
const trace: any[] = [];
const record = (e: any) => {
  trace.push(e);
  console.log(JSON.stringify(e));
};
const children: any[] = [];
const sessions: string[] = [];
const server = await startIntegrationServer(dir, { fakeProvidersOnly: true });
const api = createPublicApiClient(server.baseUrl);
async function until(check: () => any, label: string, timeoutMs = 20000) {
  const stop = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > stop) throw Error("timeout " + label);
    await new Promise((r) => setTimeout(r, 25));
  }
}
function trees(role: string) {
  return join(dir, role, "project");
}
async function boot(role: string) {
  const root = join(dir, role);
  await mkdir(join(root, "home"), { recursive: true });
  await createTestGitRepo({
    repoDir: trees(role),
    files: [{ relativePath: "same.txt", content: role }],
  });
  const ps = fork(
    resolve("dual-proof/daemon.ts"),
    [
      server.baseUrl,
      root,
      role,
      resolve("../../packages/agent-runtime/dist/test-bridges"),
    ],
    {
      cwd: trees(role),
      execArgv: [
        "--conditions=source",
        "--import",
        resolve("../../node_modules/tsx/dist/loader.mjs"),
      ],
      env: {
        PATH: "/usr/bin:/bin",
        HOME: join(root, "home"),
        BB_DATA_DIR: join(root, "data"),
        TMPDIR: process.env.TMPDIR,
        npm_config_offline: "true",
        TSX_DISABLE_CACHE: "1",
        NODE_ENV: "test",
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  children.push(ps);
  let diagnostic = "";
  ps.stderr?.on("data", (x) => {
    diagnostic += String(x);
  });
  ps.on("message", record);
  const ready = await until(() => {
    if (ps.exitCode !== null)
      throw Error(diagnostic.replace(/Bearer \S+/g, "[omitted]").slice(-1200));
    return trace.find((e) => e.kind === "ready" && e.role === role);
  }, role);
  sessions.push(server.hub.getDaemonSessionIdForHost(ready.hostId)!);
  return { ps, hostId: ready.hostId };
}
try {
  const physical = await boot("Workspace");
  await (
    await import("@bb/host-daemon/test")
  ).persistHostId({ dataDir: server.config.dataDir, hostId: physical.hostId });
  const agent = await boot("Agent");
  const hosts = await getHosts(api);
  assert.equal(hosts.filter((h) => h.status === "connected").length, 2);
  record({
    kind: "hosts",
    serverPid: process.pid,
    hosts: hosts.map((h) => ({ id: h.id, status: h.status, name: h.name })),
  });
  const project = await createProject(api, {
    name: "dual-proof",
    source: {
      type: "local_path",
      hostId: physical.hostId,
      path: trees("Workspace"),
    },
  });
  const t = await createHostThread(api, {
    providerId: "fake",
    projectId: project.id,
    hostId: physical.hostId,
    workspace: { type: "unmanaged", path: trees("Workspace") },
    input: [{ type: "text", text: "hold_turn", mentions: [] }],
  });
  const running = await waitForThreadStatus(api, t.id, "active", 30000);
  const env = await getEnvironment(api, running.environmentId!);
  assert.equal(env.hostId, physical.hostId);
  record({
    kind: "selected",
    threadId: t.id,
    environmentHost: env.hostId,
    workspace: env.path,
    provider: running.providerId,
  });
  const bystander = spawn("/bin/sleep", ["90"], {
    cwd: trees("Workspace"),
    stdio: "ignore",
  });
  try {
    assert.ok(bystander.pid);
    assert.ok(server.hub.hasDaemonForHost(agent.hostId));
    await until(() => getActiveStoredTurnId(server.db, t.id), "held turn");
    const agentProject = await createProject(api, {
      name: "agent-control",
      source: {
        type: "local_path",
        hostId: agent.hostId,
        path: trees("Agent"),
      },
    });
    const control = await createHostThread(api, {
      providerId: "fake",
      projectId: agentProject.id,
      hostId: agent.hostId,
      workspace: { type: "unmanaged", path: trees("Agent") },
      input: [
        {
          type: "text",
          text: "call_tool:workspace_bash delay:2000",
          mentions: [],
        },
      ],
    });
    const observed = await until(
      () =>
        trace.find(
          (e) => e.kind === "provider-tool" && e.threadId === control.id,
        ),
      "normal fake provider tool request",
    );
    assert.equal(observed.role, "Agent");
    assert.equal(observed.status, 200);
    assert.equal(observed.success, false);
    assert.equal(observed.unsupported, true);
    const messagesBefore = trace.length;
    await stopThread(api, t.id);
    const stopped = await waitForThreadStatus(api, t.id, "idle", 15000);
    const received = trace
      .slice(messagesBefore)
      .filter((e) => e.kind === "received");
    assert.ok(
      received.some(
        (e) => e.role === "Workspace" && e.command === "thread.stop",
      ),
    );
    assert.ok(
      !received.some((e) => e.role === "Agent" && e.command === "thread.stop"),
    );
    await waitForThreadStatus(api, control.id, "idle", 15000);
    assert.equal(
      trace.filter(
        (e) => e.kind === "provider-tool" && e.threadId === control.id,
      ).length,
      1,
    );
    record({
      kind: "independent-turn-complete",
      threadId: control.id,
      nativeProviderToolRequests: 1,
    });
    process.kill(bystander.pid, 0);
    for (const role of ["Agent", "Workspace"]) {
      assert.equal(await readFile(join(trees(role), "same.txt"), "utf8"), role);
      await assert.rejects(access(join(trees(role), "dispatch-marker")), {
        code: "ENOENT",
      });
    }
    record({
      kind: "stop-control",
      threadId: t.id,
      status: stopped.status,
      unrelatedPid: bystander.pid,
      unrelatedAlive: true,
      workspaceMarkerAbsent: true,
      agentMarkerAbsent: true,
      workspaceShell: "never admitted",
    });
    const managed = attachManagedFixture(server.db, {
      agentHostId: agent.hostId,
      workspaceHostId: physical.hostId,
      root: trees("Workspace"),
      projectId: project.id,
      environmentId: env.id,
    });
    const before = getThread(server.db, managed)?.status;
    const response = await api.threads[":id"].stop.$post({
      param: { id: managed },
    });
    assert.equal(response.status, 409);
    const reason = JSON.parse(await response.text()).code;
    assert.equal(reason, "managed_execution_unsupported");
    assert.equal(getThread(server.db, managed)?.status, before);
    assert.equal(
      trace.filter((e) => e.kind === "received" && e.threadId === managed)
        .length,
      0,
    );
    record({
      kind: "managed-public-stop",
      threadId: managed,
      status: response.status,
      reason,
      threadState: before,
      daemonCommands: 0,
    });
  } finally {
    bystander.kill();
    await once(bystander, "exit");
  }
} finally {
  for (const ps of children.reverse()) {
    if (ps.exitCode !== null || ps.signalCode) continue;
    const end = once(ps, "exit");
    if (ps.connected) ps.send({ kind: "close" });
    const timer = setTimeout(() => ps.kill("SIGKILL"), 4000);
    await end;
    clearTimeout(timer);
    record({
      kind: "daemon-exit",
      pid: ps.pid,
      exit: ps.exitCode,
      signal: ps.signalCode,
    });
  }
  await server.close();
  for (const session of sessions)
    server.hub.cancelPendingDaemonDisconnect(session);
  server.db.$client.close();
  record({ kind: "teardown", serverClosed: true });
}
