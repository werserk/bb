import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireDaemonLock,
  createHostDaemonApp,
  persistHostId,
} from "@bb/host-daemon/test";
import { enrollDaemonHost } from "../../../apps/host-daemon/src/enroll.js";
import {
  createServerClient,
  ServerResponseError,
} from "../../../apps/host-daemon/src/server-client.js";

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
const probe = createServerClient({
  serverUrl,
  hostKey,
  logger,
  getSessionId: () => daemon.connection.sessionId!,
  fetchFn: async (url, init) => {
    const res = await fetch(url, init);
    send({
      kind: "probe-http",
      hostId,
      method: init?.method,
      path: new URL(String(url)).pathname,
      status: res.status,
    });
    return res;
  },
});
send({ kind: "ready", hostId });
process.on("message", async (message: any) => {
  if (message.kind === "close") {
    await daemon.daemon.shutdown("dual-proof-complete", 0);
    process.exit(0);
  }
  if (message.kind !== "probe") return;
  try {
    await probe.callTool({
      threadId: message.threadId,
      providerThreadId: message.providerThreadId,
      turnId: message.turnId,
      callId: "dual-proof-shell-1",
      tool: "workspace_bash",
      arguments: {
        command:
          "printf invoked >> dispatch-marker; /bin/sh -c 'sleep 15 & wait'",
      },
    });
    send({ kind: "probe-result", unexpected: "resolved" });
  } catch (e) {
    if (e instanceof ServerResponseError) {
      send({
        kind: "probe-result",
        hostId,
        status: e.status,
        code: e.code,
        reason: e.bodyMessage,
        retryable: e.retryable,
      });
    } else send({ kind: "probe-result", unexpected: "client error" });
  }
});
