import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { expect, it, vi } from "vitest";
import {
  buildHostDaemonWebSocketProtocols,
  HOST_DAEMON_PROTOCOL_VERSION,
} from "@bb/host-daemon-contract";
import { createNodeWebSocketConstructor } from "../../../apps/host-daemon/src/websocket-constructor.js";
import { handleHostRemoved } from "../../../apps/server/src/internal/session-owner-side-effects.js";
import {
  startTestServer,
  createTestDaemonHostKey,
} from "../../../apps/server/test/helpers/test-app.js";

async function withHost(
  run: (host: ReturnType<typeof sessionFixture>) => Promise<void>,
) {
  const server = await startTestServer();
  const host = sessionFixture(server);
  try {
    await run(host);
  } finally {
    host.cleanup();
    await server.close();
  }
}

function sessionFixture(server: Awaited<ReturnType<typeof startTestServer>>) {
  const hostId = "ordinary-host";
  const authorization = "Bearer " + createTestDaemonHostKey({ hostId });
  const Socket = createNodeWebSocketConstructor({ authorization });
  const sockets = new Set<InstanceType<typeof Socket>>();
  const ports = server.deps.sharedPorts;
  const labels = () =>
    ports.listNextTunnelStatuses().map((entry) => entry.status.label);
  const changes: ReturnType<typeof labels>[] = [];
  const unsubscribe = ports.onNextTunnelStatusChange(() =>
    changes.push(labels()),
  );
  async function open(instanceId: string): Promise<string> {
    const response = await fetch(server.baseUrl + "/internal/session/open", {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        hostId,
        instanceId,
        hostName: "Ordinary fixture",
        hasMachineCredential: false,
        platform: "linux",
        dataDir: "/synthetic",
        localApiPort: null,
        protocolVersion: HOST_DAEMON_PROTOCOL_VERSION,
        activeThreads: [],
        openThreadWork: [],
      }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).sessionId;
  }
  async function connect(sessionId: string) {
    const url = new URL("/internal/ws", server.baseUrl);
    url.protocol = "ws:";
    url.searchParams.set("sessionId", sessionId);
    const peer = new Socket(url, buildHostDaemonWebSocketProtocols());
    sockets.add(peer);
    const [[response]] = await Promise.all([
      once(peer, "upgrade"),
      once(peer, "open"),
    ]);
    return {
      peer,
      transport: (response as IncomingMessage).socket,
      async report(label: string) {
        peer.send(
          JSON.stringify({
            type: "connect-next.status",
            status: {
              state: "connecting",
              label,
              lastError: null,
              nextRetryAt: null,
              since: 1,
              shares: [],
            },
          }),
        );
        await expect.poll(labels).toEqual([label]);
      },
    };
  }
  // The close decision is synchronous in this callback. Observe the server handling it before asserting.
  // Arm only after all fixture messages have been consumed, with no other frames in flight.
  async function observeClose(trigger: () => void) {
    const capture = server.hub.captureDaemonConnection.bind(server.hub);
    let observed!: () => void;
    const done = new Promise<void>((resolve) => {
      observed = resolve;
    });
    const spy = vi
      .spyOn(server.hub, "captureDaemonConnection")
      .mockImplementationOnce((host) => {
        const ref = capture(host);
        observed();
        return ref;
      });
    try {
      trigger();
      await done;
    } finally {
      spy.mockRestore();
    }
  }
  return {
    open,
    connect,
    labels,
    changes,
    observeClose,
    remove(sessionId: string) {
      handleHostRemoved(server.deps, { hostId, sessionId });
    },
    cleanup() {
      unsubscribe();
      for (const socket of sockets) socket.terminate();
    },
  };
}

it.each(["same-instance", "new-instance"])(
  "retires a distinct session before its successor reports (%s)",
  (mode) =>
    withHost(async (h) => {
      const session = await h.open("first");
      const a = await h.connect(session);
      await a.report("A");
      a.transport.pause();
      const successor = await h.open(
        mode === "same-instance" ? "first" : "second",
      );
      expect(successor).not.toBe(session);
      expect(h.labels()).toEqual([]);
      expect(h.changes).toEqual([["A"], []]);
      const b = await h.connect(successor);
      await b.report("B");
      await h.observeClose(() => a.transport.resume());
      expect(h.labels()).toEqual(["B"]);
      expect(h.changes).toEqual([["A"], [], ["B"]]);
      await b.report("B still connected");
    }),
);

it("keeps successor status across a late close within the same logical session", () =>
  withHost(async (h) => {
    const session = await h.open("instance");
    const a = await h.connect(session);
    await a.report("A");
    const b = await h.connect(session);
    expect(h.labels()).toEqual(["A"]);
    await b.report("B");
    await h.observeClose(() => a.peer.close());
    expect(h.labels()).toEqual(["B"]);
    expect(h.changes).toEqual([["A"], ["B"]]);
    await b.report("B still connected");
  }));

it("closes A before reconnect and removes B while its socket close is pending", () =>
  withHost(async (h) => {
    const a = await h.connect(await h.open("first"));
    await a.report("A");
    await h.observeClose(() => a.peer.close());
    expect(h.labels()).toEqual([]);
    const successor = await h.open("second");
    const b = await h.connect(successor);
    await b.report("B");
    b.transport.pause();
    h.remove(successor);
    expect(h.labels()).toEqual([]);
    await h.observeClose(() => b.transport.resume());
    expect(h.changes).toEqual([["A"], [], ["B"], []]);
  }));
