// Isolated .271 composition. No production registration or default provider.
import { randomUUID, verify, sign, type KeyObject } from "node:crypto";
import { canonicalJsonBytes, sha256Digest } from "@bb/domain";
import {
  guestChallenge,
  guestQualificationFrame,
  guestStartFrame271,
  guestReport,
} from "@bb/host-daemon-contract/managed-guest-lab";
import { getSessionById, type DbConnection } from "@bb/db";
import type { ManagedGuestEnrollment } from "@bb/host-daemon-contract";
import type { z } from "zod";
import type {
  DaemonConnectionRef,
  NotificationHub,
} from "../../../apps/server/src/ws/hub.js";
import {
  openPinnedGuest,
  type SyntheticColdSlot,
} from "../../../apps/host-daemon/src/managed-guest/journal.js";
import {
  classifyPinnedEnrollment,
  enrollmentDigest,
  type LocalEnrollmentPin,
} from "../../../apps/host-daemon/src/managed-guest/enrollment.js";
import { createNodeWebSocketConstructor } from "../../../apps/host-daemon/src/websocket-constructor.js";
import { buildHostDaemonWebSocketProtocols } from "@bb/host-daemon-contract";
import { once } from "node:events";

type Start = z.infer<typeof guestStartFrame271>;
type Binding = ManagedGuestEnrollment["binding"];
export type LabManifest = {
  descriptor: ManagedGuestEnrollment;
  publicKey: KeyObject;
};
export class ColdGuestChannel {
  private qualified: {
    ref: DaemonConnectionRef;
    digest: string;
    key: KeyObject;
  } | null = null;
  constructor(
    private db: DbConnection,
    private hub: NotificationHub,
    private readManifest: (binding: Binding) => LabManifest | null,
  ) {}
  async qualify(binding: Binding) {
    const manifest = this.readManifest(binding);
    if (
      !manifest ||
      canonicalJsonBytes(binding) !==
        canonicalJsonBytes(manifest.descriptor.binding)
    )
      return false;
    const hostId = binding.agentHostId;
    const descriptorDigest = enrollmentDigest(hostId, manifest.descriptor);
    const { publicKey } = manifest;
    const ref = this.hub.captureDaemonConnection(hostId);
    if (!ref || !this.sessionMatches(ref)) return false;
    this.qualified = null;
    const challenge = guestChallenge.parse({
      domain: "bb.synthetic-cold-create.271",
      hostId,
      sessionId: ref.sessionId,
      manifestDigest: descriptorDigest,
      registrationNonce: randomUUID(),
      nonce: randomUUID(),
    });
    const frame = guestQualificationFrame.parse({
      type: "host-rpc.request",
      requestId: randomUUID(),
      command: { type: "managed.lab.qualify", challenge },
    });
    const reply = await this.hub.requestHostOnlineRpc({
      hostId,
      expectedConnection: ref,
      message: frame,
      timeoutMs: 3000,
    });
    if (
      !reply?.ok ||
      reply.commandType !== "managed.lab.qualify" ||
      reply.requestId !== frame.requestId ||
      this.hub.captureDaemonConnection(hostId) !== ref ||
      !verify(
        null,
        Buffer.from(canonicalJsonBytes(challenge)),
        publicKey,
        Buffer.from(reply.result.signature, "base64"),
      )
    )
      return false;
    this.qualified = { ref, digest: descriptorDigest, key: publicKey };
    return !!this.readCurrentQualifiedManifest(binding, ref);
  }
  private sessionMatches(ref: DaemonConnectionRef) {
    const row = getSessionById(this.db, { sessionId: ref.sessionId });
    return (
      row?.status === "active" &&
      row.protocolVersion === 271 &&
      row.hostId === ref.hostId
    );
  }
  readCurrentQualifiedManifest(binding: Binding, ref: DaemonConnectionRef) {
    const qualified = this.qualified;
    const live = this.readManifest(binding);
    if (qualified?.ref !== ref) return null;
    if (
      !live ||
      this.hub.captureDaemonConnection(ref.hostId) !== ref ||
      !this.sessionMatches(ref)
    ) {
      this.qualified = null;
      return null;
    }
    if (
      ref.hostId !== binding.agentHostId ||
      canonicalJsonBytes(binding) !==
        canonicalJsonBytes(live.descriptor.binding) ||
      qualified.digest !== enrollmentDigest(ref.hostId, live.descriptor) ||
      !qualified.key.equals(live.publicKey)
    ) {
      this.qualified = null;
      return null;
    }
    return live.descriptor;
  }
  async deliver(ref: DaemonConnectionRef, frame: Start, claim: () => boolean) {
    const parsed = guestStartFrame271.parse(frame);
    const manifest = this.readCurrentQualifiedManifest(
      parsed.command.binding,
      ref,
    );
    if (
      !manifest ||
      parsed.agentSessionId !== ref.sessionId ||
      parsed.command.runtimeRootKey !== manifest.runtimeRootKey ||
      parsed.command.launchProfileId !== manifest.launchProfileId ||
      !claim()
    )
      return "held";
    const request = parsed.command;
    const reply = await this.hub
      .requestHostOnlineRpc({
        hostId: ref.hostId,
        expectedConnection: ref,
        message: parsed,
        timeoutMs: 1500,
      })
      .catch(() => null);
    if (
      !reply?.ok ||
      reply.commandType !== "managed.thread.start" ||
      reply.requestId !== parsed.requestId ||
      !this.readCurrentQualifiedManifest(request.binding, ref)
    )
      return "unknown";
    const result = guestReport.parse(reply.result);
    if (
      result.commandId !== request.commandId ||
      result.threadId !== request.threadId ||
      result.requestId !== request.requestId ||
      canonicalJsonBytes(result.epoch) !== canonicalJsonBytes(request.epoch) ||
      result.agentSessionId !== ref.sessionId ||
      result.manifestDigest !== enrollmentDigest(ref.hostId, manifest) ||
      result.bodyDigest !== sha256Digest(canonicalJsonBytes(request))
    )
      return "unknown";
    return result;
  }
}

export async function connectColdGuest(args: {
  baseUrl: string;
  hostKey: string;
  sessionId: string;
  root: string;
  pin: LocalEnrollmentPin;
  slot: SyntheticColdSlot;
  signer: KeyObject;
  dropAck: boolean;
}) {
  const ingress = {
    hostId: args.pin.hostId,
    sessionId: args.sessionId,
    protocolVersion: 271,
  };
  const opened = await openPinnedGuest(args.root, args.pin, ingress, args.slot);
  if (opened.kind !== "protected") throw Error("Protected enrollment required");
  const journal = opened.journal;
  const url = new URL("/internal/ws", args.baseUrl);
  if (url.hostname !== "127.0.0.1")
    throw Error("Private test endpoint required");
  url.protocol = "ws:";
  url.searchParams.set("sessionId", args.sessionId);
  const Socket = createNodeWebSocketConstructor({
    authorization: "Bearer " + args.hostKey,
  });
  const socket = new Socket(url, buildHostDaemonWebSocketProtocols());
  let starts = 0;
  let qualified = false;
  let priorProof: string | null = null;
  socket.on("message", async (bytes) => {
    const raw = JSON.parse(String(bytes));
    const probe = guestQualificationFrame.safeParse(raw);
    if (probe.success) {
      const challenge = probe.data.command.challenge;
      if (
        challenge.hostId !== ingress.hostId ||
        challenge.sessionId !== ingress.sessionId ||
        challenge.manifestDigest !== args.pin.descriptorDigest
      )
        return;
      try {
        if (
          !(await classifyPinnedEnrollment(args.root, args.pin)) ||
          !args.slot.inspectEmpty()
        )
          return;
        journal.validateCurrent();
      } catch {
        return;
      }
      const signature = sign(
        null,
        Buffer.from(canonicalJsonBytes(challenge)),
        args.signer,
      ).toString("base64");
      priorProof = signature;
      qualified = true;
      socket.send(
        JSON.stringify({
          type: "host-rpc.response",
          requestId: probe.data.requestId,
          commandType: "managed.lab.qualify",
          ok: true,
          result: { signature },
        }),
      );
      return;
    }
    const start = guestStartFrame271.safeParse(raw);
    if (!qualified || !start.success) return;
    starts++;
    const disposition = await journal.receive(start.data);
    const cmd = start.data.command,
      guestSessionId = journal.createdSession(cmd.commandId);
    if (disposition !== "applied" || !guestSessionId || args.dropAck) return;
    const result = guestReport.parse({
      disposition,
      guestSessionId,
      commandId: cmd.commandId,
      requestId: cmd.requestId,
      threadId: cmd.threadId,
      epoch: cmd.epoch,
      bodyDigest: sha256Digest(canonicalJsonBytes(cmd)),
      agentSessionId: ingress.sessionId,
      manifestDigest: args.pin.descriptorDigest,
    });
    socket.send(
      JSON.stringify({
        type: "host-rpc.response",
        requestId: start.data.requestId,
        ok: true,
        commandType: cmd.type,
        result,
      }),
    );
  });
  try {
    await once(socket, "open");
  } catch (error) {
    journal.close();
    throw error;
  }
  return {
    socket,
    journal,
    starts: () => starts,
    previousPublicProof: () => priorProof,
    async close() {
      if (socket.readyState !== 3) {
        const closed = once(socket, "close");
        socket.close();
        await closed;
      }
      journal.close();
    },
  };
}
