import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { hostDaemonRpcCommandSchema } from "../src/commands.js";
import {
  decodeForProtectedGuest,
  managedFrame271,
} from "../src/managed-guest-lab.js";

const ingress = { hostId: "guest", sessionId: "first", protocolVersion: 271 };
const commandId = "rpc_" + randomUUID();
const launch = {
  type: "managed.thread.start",
  commandId,
  requestId: "creq_2222222222",
  threadId: "thread",
  binding: {
    ownerPluginId: "fixture",
    providerId: "fake",
    accountId: "synthetic",
    workerId: "test-worker",
    agentHostId: "guest",
    generation: "g1",
    workspace: {
      workspaceBindingId: "workspace",
      revision: 1,
      workspaceDigest: "sha256:" + "a".repeat(64),
    },
  },
  epoch: {
    executionOwnerOperationId: "owner-a",
    fence: 1,
    transferRevision: 2,
  },
  runtimeRootKey: "root-key",
  launchProfileId: "profile-key",
  inputText: "local fixture",
};
function frame(command: unknown) {
  return {
    type: "host-rpc.request",
    agentSessionId: ingress.sessionId,
    requestId: randomUUID(),
    command,
  };
}
const resume = {
  ...launch,
  type: "managed.turn.submit",
  commandId: "rpc_" + randomUUID(),
  previousCommandId: commandId,
  providerThreadId: "native",
  target: "new-turn-when-idle",
};
const stop = {
  type: "managed.thread.stop",
  threadId: launch.threadId,
  commandId: "rpc_" + randomUUID(),
  binding: launch.binding,
  intent: "interrupt",
  target: { commandId, requestId: launch.requestId, epoch: launch.epoch },
};
it.each([launch, resume, stop])(
  "strict protected $type is inert in native 270",
  (cmd) => {
    expect(decodeForProtectedGuest(frame(cmd), ingress).command).toEqual(cmd);
    expect(hostDaemonRpcCommandSchema.safeParse(cmd).success).toBe(false);
  },
);
it("a new frame preserves command identity across transport attempts", () => {
  const a = decodeForProtectedGuest(frame(launch), ingress),
    b = decodeForProtectedGuest(frame(launch), ingress);
  expect(a.requestId).not.toBe(b.requestId);
  expect(a.command.commandId).toBe(b.command.commandId);
});
it.each([
  { ...launch, type: "thread.start" },
  { ...launch, bridgeLaunch: {} },
  { ...launch, workspaceContext: { path: "/tmp" } },
  { ...launch, commandId: launch.requestId },
  { ...launch, requestId: commandId },
  { ...launch, epoch: { fence: 1, executionOwnerOperationId: "owner-a" } },
  { ...launch, binding: { ...launch.binding, ownerPluginId: undefined } },
  { ...resume, target: "steer" },
  { ...resume, commandId: commandId },
  { ...stop, commandId: commandId },
  { ...stop, intent: "release" },
  { ...stop, target: { ...stop.target, epoch: undefined } },
])("refuses missing or mixed managed command fields", (cmd) => {
  expect(managedFrame271.safeParse(frame(cmd)).success).toBe(false);
});
it.each([
  { ...ingress, sessionId: "replacement" },
  { ...ingress, hostId: "workspace" },
  { ...ingress, protocolVersion: 270 },
])("checks the actual receiving connection", (current) => {
  expect(() => decodeForProtectedGuest(frame(launch), current)).toThrow();
});
