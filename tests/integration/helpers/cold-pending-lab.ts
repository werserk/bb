// Real loopback server transport with a synthetic receiver and an independently
// provisioned empty slot. The caller supplies the fixture assignment before SDK accept.
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { ManagedGuestEnrollment } from "@bb/host-daemon-contract";
import { upsertHost } from "@bb/db";
import {
  createTestDaemonHostKey,
  type RunningTestServer,
} from "../../../apps/server/test/helpers/test-app.js";
import { initializeFixture, observeProcess } from "./managed-guest-fixture.js";
import type { PlacementRuntimeRootIdentity } from "../../../apps/server/src/types.js";
import {
  ColdGuestChannel,
  connectColdGuest,
  type LabManifest,
} from "./cold-guest-channel.js";

export class FixtureEnrollmentRegistry {
  private enrolled: LabManifest | null = null;
  replace(value: LabManifest | null) {
    this.enrolled = value;
  }
  read(identity: PlacementRuntimeRootIdentity) {
    const candidate = this.enrolled;
    if (!candidate) return null;
    const b = candidate.descriptor.binding;
    return b.ownerPluginId === identity.ownerPluginId &&
      b.providerId === identity.providerId &&
      b.workerId === identity.workerId &&
      b.generation === identity.generation &&
      b.agentHostId === identity.agentHostId &&
      b.accountId === identity.accountId
      ? candidate
      : null;
  }
  rootKey = (identity: PlacementRuntimeRootIdentity) =>
    this.read(identity)?.descriptor.runtimeRootKey ?? null;
}

export async function startPendingLabGuest(
  server: RunningTestServer,
  registry: FixtureEnrollmentRegistry,
  manifest: Pick<
    ManagedGuestEnrollment,
    "binding" | "launchProfileId" | "runtimeRootKey"
  >,
  physicalFence: number,
  dropAck: boolean,
) {
  const f = await initializeFixture(manifest);
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const hostId = manifest.binding.agentHostId,
      hostKey = createTestDaemonHostKey({ hostId });
    upsertHost(server.db, server.hub, {
      id: hostId,
      name: "Private first-start fixture",
    });
    const response = await fetch(server.baseUrl + "/internal/session/open", {
      method: "POST",
      headers: {
        authorization: "Bearer " + hostKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        hostId,
        hostName: "Guest",
        instanceId: randomUUID(),
        platform: "linux",
        hasMachineCredential: false,
        dataDir: f.root,
        localApiPort: null,
        protocolVersion: 271,
        activeThreads: [],
        openThreadWork: [],
      }),
    });
    if (response.status !== 201)
      throw Error("Lab session open refused: " + response.status);
    const { sessionId } = await response.json();
    const ids: string[] = [];
    const guest = await connectColdGuest({
      baseUrl: server.baseUrl,
      hostKey,
      sessionId,
      root: f.root,
      pin: f.pin,
      signer: privateKey,
      dropAck,
      slot: {
        inspectEmpty: () => (ids.length === 0 ? { physicalFence } : null),
        createSyntheticSession() {
          if (ids.length !== 0)
            throw Error("Physical fixture already occupied");
          const id = randomUUID();
          ids.push(id);
          return {
            ...observeProcess(process.pid),
            providerThreadId: id,
            physicalFence,
          };
        },
      },
    });
    try {
      registry.replace({ descriptor: f.descriptor, publicKey });
      const channel = new ColdGuestChannel(server.db, server.hub, (b) =>
        registry.read(b),
      );
      if (!(await channel.qualify(manifest.binding)))
        throw Error("No qualified lab receiver");
      let connected = true;
      async function disconnect() {
        if (connected) {
          connected = false;
          await guest.close();
        }
      }
      return {
        disconnect,
        channel,
        guest,
        ids,
        fixture: f,
        sessionId,
        async close() {
          try {
            await disconnect();
          } finally {
            await rm(f.root, { recursive: true, force: true });
          }
        },
      };
    } catch (err) {
      await guest.close();
      throw err;
    }
  } catch (err) {
    await rm(f.root, { recursive: true, force: true });
    throw err;
  }
}
