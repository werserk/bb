import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ManagedGuestEnrollment } from "@bb/host-daemon-contract";
import { writeHostAuthState } from "../../../apps/host-daemon/src/auth-state.js";
import { persistHostId } from "../../../apps/host-daemon/src/identity.js";
import { enrollmentDigest } from "../../../apps/host-daemon/src/managed-guest/enrollment.js";
import {
  journalFilename,
  journalSchema,
} from "../../../apps/host-daemon/src/managed-guest/journal.js";

export const ingress = {
  hostId: "fixture-guest",
  sessionId: "fixture-session",
  protocolVersion: 271,
};
export const binding = {
  ownerPluginId: "fixture",
  providerId: "fake",
  accountId: "synthetic",
  workerId: "fixture-worker",
  agentHostId: ingress.hostId,
  generation: "g1",
  workspace: {
    workspaceBindingId: "fixture-workspace",
    revision: 1,
    workspaceDigest: "sha256:" + "a".repeat(64),
  },
};
export const ordinary = {
  hostId: ingress.hostId,
  hostKey: "fixture-placeholder",
};
export async function initializeFixture() {
  const root = await mkdtemp(join(tmpdir(), "guest-journal-"));
  const path = join(root, journalFilename);
  await writeFile(path, "", { flag: "wx", mode: 0o600 });
  const db = new DatabaseSync(path);
  const journalId = randomUUID();
  try {
    db.exec(journalSchema);
    db.prepare("INSERT INTO guest(id,journal_id) VALUES(1,?)").run(journalId);
  } finally {
    db.close();
  }
  const inode = await stat(path, { bigint: true });
  const descriptor: ManagedGuestEnrollment = {
    profile: "synthetic-only-v1",
    uid: Number(inode.uid),
    device: String(inode.dev),
    inode: String(inode.ino),
    journalId,
    binding,
    runtimeRootKey: "fixture-root",
    launchProfileId: "fixture-counter",
  };
  await persistHostId({ dataDir: root, hostId: ingress.hostId });
  await writeHostAuthState(root, { ...ordinary, managedGuest: descriptor });
  return {
    root,
    path,
    descriptor,
    pin: {
      hostId: ingress.hostId,
      descriptorDigest: enrollmentDigest(ingress.hostId, descriptor),
    },
  };
}
export const nextId = () => "rpc_" + randomUUID();
export const start = () => ({
  commandId: nextId(),
  type: "managed.thread.start" as const,
  threadId: "fixture-thread",
  requestId: "creq_2222222222",
  binding,
  epoch: {
    executionOwnerOperationId: "owner-a",
    fence: 4,
    transferRevision: 1,
  },
  runtimeRootKey: "fixture-root",
  launchProfileId: "fixture-counter",
  inputText: "synthetic input",
});
export function transfer(
  from: { commandId: string; epoch: { transferRevision: number } },
  suffix: string,
) {
  return {
    ...start(),
    type: "managed.turn.submit" as const,
    commandId: nextId(),
    previousCommandId: from.commandId,
    providerThreadId: "fixture-provider-thread",
    target: "new-turn-when-idle",
    requestId: "creq_" + suffix.repeat(10),
    epoch: {
      executionOwnerOperationId: "owner-" + suffix,
      fence: 4,
      transferRevision: from.epoch.transferRevision + 1,
    },
  };
}
export function stop(
  target: ReturnType<typeof start> | ReturnType<typeof transfer>,
) {
  return {
    type: "managed.thread.stop",
    intent: "interrupt",
    threadId: target.threadId,
    binding,
    commandId: nextId(),
    target: {
      commandId: target.commandId,
      requestId: target.requestId,
      epoch: target.epoch,
    },
  };
}
export function frame(command: unknown, session = ingress.sessionId) {
  return {
    type: "host-rpc.request",
    command,
    requestId: randomUUID(),
    agentSessionId: session,
  };
}
export function observeProcess(pid: number) {
  // stat fields after the closing comm parenthesis start at field 3; starttime is field 22.
  const raw = readFileSync("/proc/" + pid + "/stat", "utf8");
  return {
    pid,
    physicalFence: 4,
    processStart: raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19]!,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    providerThreadId: "fixture-provider-thread",
    idle: true,
  };
}
