import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireDaemonLock,
  createHostDaemonApp,
  persistHostId,
} from "@bb/host-daemon/test";
import { enrollDaemonHost } from "../../../apps/host-daemon/src/enroll.js";
const [serverUrl, root, role, bundleDir] = process.argv.slice(2);
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const send = (obj: object) => process.send!({ ...obj, role, pid: process.pid });
const dataDir = join(root, "data");
await mkdir(join(dataDir, "thread-storage"), { recursive: true });
const response = await fetch(serverUrl + "/internal/hosts/enroll-key", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
if (response.status !== 201)
  throw Error("loopback enrollment failed: " + response.status);
const issued = await response.json();
const { hostKey, hostId } = await enrollDaemonHost({
  hostId: issued.hostId,
  token: issued.enrollKey,
  hostName: role,
  serverUrl,
});
await persistHostId({ dataDir, hostId });
const releaseLock = await acquireDaemonLock(dataDir);
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  if (new URL(String(url)).pathname === "/internal/session/tool-call") {
    const { threadId, tool, callId, turnId } = JSON.parse(String(init?.body));
    const result = await response.clone().json();
    send({
      kind: "provider-tool",
      threadId,
      tool,
      callId,
      turnId,
      status: response.status,
      success: result.success,
      unsupported: result.contentItems?.some(
        (i: { text?: string }) => i.text === "Unsupported tool: workspace_bash",
      ),
    });
  }
  return response;
};
const daemon = await createHostDaemonApp({
  dataDir,
  hostKey,
  hostId,
  hostName: role,
  instanceId: randomUUID(),
  localApiConfig: null,
  releaseLock,
  logger,
  serverUrl,
  bridgeBundleDir: bundleDir,
});
const handle = daemon.router.handleOnlineRpcRequest.bind(daemon.router);
daemon.router.handleOnlineRpcRequest = async (message) => {
  send({
    kind: "received",
    command: message.command.type,
    threadId:
      "threadId" in message.command ? message.command.threadId : undefined,
    hostId,
  });
  return handle(message);
};
await daemon.daemon.start();
send({ kind: "ready", hostId });
process.on("message", async (message: { kind: string }) => {
  if (message.kind === "close") {
    await daemon.daemon.shutdown("dual-proof-complete", 0);
    process.exit(0);
  }
});
