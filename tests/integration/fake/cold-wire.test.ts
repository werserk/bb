import { generateKeyPairSync, randomUUID } from "node:crypto";
import { once } from "node:events";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalJsonBytes, workspaceBindingRef } from "@bb/domain";
import {
  createConnection,
  upsertHost,
  readPlacementOperation,
  readPlacementDispatchReceipt,
  preparePlacementExecutionCommand,
  claimPlacementExecutionCommand,
} from "@bb/db";
import { buildHostDaemonWebSocketProtocols } from "@bb/host-daemon-contract";
import { guestStartFrame271 } from "@bb/host-daemon-contract/managed-guest-lab";
import {
  createTestDb,
  createTestDaemonHostKey,
  startTestServer,
} from "../../../apps/server/test/helpers/test-app.js";
import { createLiveHostCommandExecution } from "../../../apps/server/src/services/hosts/live-command.js";
import { openPinnedGuest } from "../../../apps/host-daemon/src/managed-guest/journal.js";
import { createNodeWebSocketConstructor } from "../../../apps/host-daemon/src/websocket-constructor.js";
import {
  setupPlacement,
  acceptPrepared,
  attachAndQueue,
  workspace,
} from "../../../packages/db/test/helpers/placement.js";
import {
  appendFixture,
  claimFixture,
} from "../../../packages/db/test/helpers/placement-dispatch.js";
import {
  initializeFixture,
  frame,
  observeProcess,
} from "../helpers/managed-guest-fixture.js";
import {
  ColdGuestChannel,
  connectColdGuest,
  type LabManifest,
} from "../helpers/cold-guest-channel.js";

it.each(["accepted", "lost-ack", "replacement"])(
  "authenticated cold start, diagnostic admission: %s",
  async (mode) => {
    const hostId = "agent-host";
    const binding = {
      ownerPluginId: "workers",
      providerId: "claude",
      accountId: "account",
      workerId: "worker",
      agentHostId: hostId,
      generation: "gen",
      workspace: workspaceBindingRef(workspace),
    };
    const f = await initializeFixture({
      binding,
      runtimeRootKey: "runtime",
      launchProfileId: "fixture-counter",
    });
    const file = join(f.root, "server.sqlite");
    const template = createTestDb();
    try {
      await writeFile(file, template.$client.serialize(), {
        flag: "wx",
        mode: 0o600,
      });
    } finally {
      template.$client.close();
    }
    const db = createConnection(file);
    const server = await startTestServer({ fixtureDb: db });
    const clean: (() => Promise<void>)[] = [];
    let serverOpen = true;
    let guestId: string | null = null;
    let createCount = 0;
    const slot = {
      inspectEmpty: () => (guestId ? null : { physicalFence: 1 }),
      createSyntheticSession() {
        if (guestId) throw Error("Slot is already occupied");
        guestId = randomUUID();
        createCount++;
        return {
          ...observeProcess(process.pid),
          physicalFence: 1,
          providerThreadId: guestId,
        };
      },
    };
    try {
      setupPlacement(db);
      const op = acceptPrepared(db, "cold-wire-fixture");
      attachAndQueue(db, op.id);
      const rows = claimFixture(
        db,
        readPlacementOperation(db, op.id)!.queueReceipt!.queuedMessageId,
      );
      const { guard, receipt, body } = db.transaction(
        (tx) =>
          appendFixture(tx, op.id, rows, "creq_2222222222", {
            source: "spawn",
            target: { kind: "thread-start" },
            request: { method: "thread/start", params: {} },
          }),
        { behavior: "immediate" },
      );
      expect(receipt.binding).toEqual(binding);
      upsertHost(db, server.hub, { id: hostId, name: "Synthetic Agent" });
      const key = createTestDaemonHostKey({ hostId });
      const open = (protocolVersion: number) =>
        fetch(server.baseUrl + "/internal/session/open", {
          method: "POST",
          headers: {
            authorization: "Bearer " + key,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            hostId,
            instanceId: "cold-create-fixture",
            hostName: "Agent",
            hasMachineCredential: false,
            platform: "linux",
            dataDir: "/scratch/fixture",
            localApiPort: null,
            protocolVersion,
            activeThreads: [],
            openThreadWork: [],
          }),
        });
      expect((await open(270)).ok).toBe(false);
      const opened = await open(271);
      expect(opened.status).toBe(201);
      const { sessionId } = await opened.json();
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const guest = await connectColdGuest({
        baseUrl: server.baseUrl,
        hostKey: key,
        sessionId,
        root: f.root,
        pin: f.pin,
        slot,
        signer: privateKey,
        dropAck: mode === "lost-ack",
      });
      clean.push(() => guest.close());
      let manifest: LabManifest | null = {
        descriptor: f.descriptor,
        publicKey,
      };
      const channel = new ColdGuestChannel(db, server.hub, (b) =>
        canonicalJsonBytes(b) === canonicalJsonBytes(binding) ? manifest : null,
      );
      expect(await channel.qualify(binding)).toBe(true);
      const ref = server.hub.captureDaemonConnection(hostId)!;
      const commandId = createLiveHostCommandExecution(hostId).id;
      const identity = {
        ...guard,
        agentHostId: hostId,
        agentSessionId: sessionId,
        commandId,
        nativeExecutionId: commandId,
      };
      expect(preparePlacementExecutionCommand(db, identity).kind).toBe(
        "prepared",
      );
      const claim = () =>
        claimPlacementExecutionCommand(db, {
          ...identity,
          currentAgentSessionId: sessionId,
        }).kind === "won";
      const text = body.input[0];
      if (text?.type !== "text") throw Error("Expected admitted text");
      const start = guestStartFrame271.parse(
        frame(
          {
            type: "managed.thread.start",
            commandId,
            threadId: guard.threadId,
            requestId: guard.requestId,
            binding: receipt.binding,
            epoch: {
              executionOwnerOperationId: guard.executionOwnerOperationId,
              fence: guard.fence,
              transferRevision: 1,
            },
            runtimeRootKey: "runtime",
            launchProfileId: "fixture-counter",
            inputText: text.text,
          },
          sessionId,
        ),
      );
      manifest = {
        descriptor: { ...f.descriptor, runtimeRootKey: "rotated" },
        publicKey,
      };
      expect(await channel.deliver(ref, start, claim)).toBe("held");
      expect(readPlacementDispatchReceipt(db, guard)?.state).toBe("prepared");
      manifest = { descriptor: f.descriptor, publicKey };
      expect(await channel.deliver(ref, start, claim)).toBe("held");
      expect(await channel.qualify(binding)).toBe(true);
      if (mode === "replacement") {
        const url = new URL("/internal/ws", server.baseUrl);
        url.protocol = "ws:";
        url.searchParams.set("sessionId", sessionId);
        const Socket = createNodeWebSocketConstructor({
          authorization: "Bearer " + key,
        });
        const other = new Socket(url, buildHostDaemonWebSocketProtocols());
        let starts = 0,
          challenges = 0;
        const oldProof = guest.previousPublicProof();
        expect(oldProof).toBeTruthy();
        other.on("message", (bytes) => {
          const raw = JSON.parse(String(bytes));
          if (raw.type !== "host-rpc.request") return;
          if (raw.command.type === "managed.thread.start") starts++;
          if (raw.command.type === "managed.lab.qualify") {
            challenges++;
            other.send(
              JSON.stringify({
                type: "host-rpc.response",
                requestId: raw.requestId,
                ok: true,
                commandType: raw.command.type,
                result: {
                  signature: oldProof,
                },
              }),
            );
          }
        });
        await once(other, "open");
        clean.push(async () => {
          if (other.readyState !== 3) {
            const closed = once(other, "close");
            other.close();
            await closed;
          }
        });
        expect(server.hub.captureDaemonConnection(hostId)).not.toBe(ref);
        expect(await channel.qualify(binding)).toBe(false);
        expect(await channel.deliver(ref, start, claim)).toBe("held");
        expect({
          starts,
          challenges,
          createCount,
          originalStarts: guest.starts(),
          state: readPlacementDispatchReceipt(db, guard)?.state,
        }).toEqual({
          starts: 0,
          challenges: 1,
          createCount: 0,
          originalStarts: 0,
          state: "prepared",
        });
        console.info(
          "same session replacement: challenges=1 starts=0 creates=0 state=prepared",
        );
        return;
      }
      const delivery = channel.deliver(ref, start, claim);
      if (mode === "lost-ack") expect(await delivery).toBe("unknown");
      else
        expect(await delivery).toMatchObject({
          disposition: "applied",
          guestSessionId: expect.any(String),
          commandId,
        });
      expect(guest.starts()).toBe(1);
      expect(guest.journal.createdSession(commandId)).toBe(guestId);
      expect(createCount).toBe(1);
      expect(readPlacementDispatchReceipt(db, guard)?.state).toBe(
        "possibly_sent",
      );
      await clean.pop()!();
      await server.close();
      serverOpen = false;
      db.$client.close();
      const later = createConnection(file);
      try {
        expect(readPlacementDispatchReceipt(later, guard)?.state).toBe(
          "possibly_sent",
        );
        expect(
          claimPlacementExecutionCommand(later, {
            ...identity,
            currentAgentSessionId: sessionId,
          }).kind,
        ).toBe("held");
        const reopened = await openPinnedGuest(
          f.root,
          f.pin,
          { hostId, sessionId, protocolVersion: 271 },
          slot,
        );
        if (reopened.kind !== "protected")
          throw Error("Lost enrolled receiver");
        try {
          expect(reopened.journal.createdSession(commandId)).toBe(guestId);
          expect(
            await reopened.journal.receive({
              ...start,
              requestId: randomUUID(),
            }),
          ).toBe("applied");
          expect(createCount).toBe(1);
        } finally {
          reopened.journal.close();
        }
        console.info(
          mode +
            " after reopen: server=possibly_sent guest=applied frames=1 creates=1 secondClaim=held",
        );
      } finally {
        later.$client.close();
      }
    } finally {
      for (const close of clean.reverse()) await close();
      if (serverOpen) {
        await server.close();
        db.$client.close();
      }
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
