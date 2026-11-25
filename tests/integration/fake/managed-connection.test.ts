import { createNodeWebSocketConstructor } from "../../../apps/host-daemon/src/websocket-constructor.js";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  upsertHost,
  readPlacementOperation,
  readPlacementDispatchReceipt,
  preparePlacementExecutionCommand,
  claimPlacementExecutionCommand,
} from "@bb/db";
import {
  buildHostDaemonWebSocketProtocols,
  HOST_DAEMON_PROTOCOL_VERSION,
} from "@bb/host-daemon-contract";
import {
  startTestServer,
  createTestDaemonHostKey,
} from "../../../apps/server/test/helpers/test-app.js";
import {
  setupPlacement,
  acceptPrepared,
  attachAndQueue,
} from "../../../packages/db/test/helpers/placement.js";
import {
  appendFixture,
  claimFixture,
} from "../../../packages/db/test/helpers/placement-dispatch.js";
import { createLiveHostCommandExecution } from "../../../apps/server/src/services/hosts/live-command.js";

it("pins a claimed request to its original authenticated socket when the logical session reconnects", async () => {
  const server = await startTestServer();
  const hostId = "agent-host",
    peers: InstanceType<ReturnType<typeof createNodeWebSocketConstructor>>[] =
      [];
  try {
    setupPlacement(server.db);
    const op = acceptPrepared(server.db, "socket fixture");
    attachAndQueue(server.db, op.id);
    const rows = claimFixture(
      server.db,
      readPlacementOperation(server.db, op.id)!.queueReceipt!.queuedMessageId,
    );
    const { guard } = server.db.transaction((tx) =>
      appendFixture(tx, op.id, rows, "creq_2222222222"),
    );
    upsertHost(server.db, server.hub, { id: hostId, name: "Synthetic Agent" });
    const key = createTestDaemonHostKey({ hostId });
    const opened = await fetch(server.baseUrl + "/internal/session/open", {
      method: "POST",
      headers: {
        authorization: "Bearer " + key,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hostId,
        instanceId: "pin-fixture",
        hostName: "Agent",
        hasMachineCredential: false,
        platform: "linux",
        dataDir: "/scratch/fixture",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [],
        openThreadWork: [],
      }),
    });
    expect(opened.status).toBe(201);
    const { sessionId } = await opened.json();
    const url = new URL("/internal/ws", server.baseUrl);
    url.protocol = "ws:";
    url.searchParams.set("sessionId", sessionId);
    const FixtureSocket = createNodeWebSocketConstructor({
      authorization: "Bearer " + key,
    });
    async function connect() {
      const received: string[] = [];
      const peer = new FixtureSocket(url, buildHostDaemonWebSocketProtocols());
      peers.push(peer);
      peer.on("message", (data) => {
        const f = JSON.parse(String(data));
        if (f.type !== "host-rpc.request") return;
        received.push(f.requestId);
        peer.send(
          JSON.stringify({
            type: "host-rpc.response",
            requestId: f.requestId,
            commandType: f.command.type,
            ok: false,
            errorCode: "fixture_control",
            errorMessage: "read-only fixture",
          }),
        );
      });
      await once(peer, "open");
      return { peer, received };
    }
    const a = await connect();
    const admitted = server.hub.captureDaemonConnection(hostId)!;
    expect(admitted.sessionId).toBe(sessionId);
    const commandId = createLiveHostCommandExecution(hostId).id;
    const identity = {
      ...guard,
      agentHostId: hostId,
      agentSessionId: admitted.sessionId,
      nativeExecutionId: commandId,
      commandId,
    };
    expect(preparePlacementExecutionCommand(server.db, identity).kind).toBe(
      "prepared",
    );
    expect(
      claimPlacementExecutionCommand(server.db, {
        ...identity,
        currentAgentSessionId: admitted.sessionId,
      }).kind,
    ).toBe("won");
    const b = await connect();
    const replacement = server.hub.captureDaemonConnection(hostId)!;
    expect(replacement.sessionId).toBe(admitted.sessionId);
    expect(replacement).not.toBe(admitted);
    const frame = (requestId: string) => ({
      type: "host-rpc.request" as const,
      requestId,
      command: {
        type: "host.read_file" as const,
        path: "fixture",
        followRootSymlink: false,
      },
    });
    const suppressed = randomUUID(),
      control = randomUUID();
    await expect(
      server.hub.requestHostOnlineRpc({
        hostId,
        expectedConnection: admitted,
        message: frame(suppressed),
        timeoutMs: 1000,
      }),
    ).rejects.toThrow();
    a.peer.close();
    await once(a.peer, "close");
    // A response on the same ordered socket establishes the observation boundary for preceding frames.
    const response = await server.hub.requestHostOnlineRpc({
      hostId,
      message: frame(control),
      timeoutMs: 3000,
    });
    const matching = randomUUID();
    expect(
      (
        await server.hub.requestHostOnlineRpc({
          hostId,
          expectedConnection: replacement,
          message: frame(matching),
          timeoutMs: 3000,
        })
      ).requestId,
    ).toBe(matching);
    expect(b.received.filter((id) => id === matching)).toHaveLength(1);
    expect(response.requestId).toBe(control);
    expect(b.received).toContain(control);
    expect(a.received).not.toContain(suppressed);
    expect(b.received).not.toContain(suppressed);
    console.info("registration replacement", {
      sameSession: replacement.sessionId === admitted.sessionId,
      originalFrames: a.received.length,
      replacementFrames: b.received.length,
      staleFrames: b.received.filter((id) => id === suppressed).length,
    });
    expect(readPlacementDispatchReceipt(server.db, guard)?.state).toBe(
      "possibly_sent",
    );
  } finally {
    for (const peer of peers)
      if (peer.readyState !== WebSocket.CLOSED) {
        const end = once(peer, "close");
        peer.close();
        await end;
      }
    await server.close();
  }
});
