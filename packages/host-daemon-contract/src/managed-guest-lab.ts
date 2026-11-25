// Isolated receiver only. This schema is outside the negotiated daemon RPC union.
import { clientTurnRequestIdSchema, placementBindingSchema } from "@bb/domain";
import { z } from "zod";

const id = z.string().min(1);
const commandId = z.templateLiteral(["rpc_", z.uuid()]);
const epoch = z.strictObject({
  executionOwnerOperationId: id,
  fence: z.number().int().positive(),
  transferRevision: z.number().int().positive(),
});
const launch = {
  threadId: id,
  requestId: clientTurnRequestIdSchema,
  commandId,
  binding: placementBindingSchema,
  epoch,
  runtimeRootKey: id,
  launchProfileId: id,
  // Inert text-only profile. Delivering grouped input, skills or attachments needs separately qualified semantics.
  inputText: z.string().min(1),
};
const managedCommand = z
  .discriminatedUnion("type", [
    z.strictObject({ type: z.literal("managed.thread.start"), ...launch }),
    z.strictObject({
      type: z.literal("managed.turn.submit"),
      ...launch,
      previousCommandId: commandId,
      providerThreadId: id,
      target: z.literal("new-turn-when-idle"),
    }),
    z.strictObject({
      type: z.literal("managed.thread.stop"),
      threadId: id,
      commandId,
      intent: z.literal("interrupt"),
      binding: placementBindingSchema,
      target: z.strictObject({
        commandId,
        requestId: clientTurnRequestIdSchema,
        epoch,
      }),
    }),
  ])
  .superRefine((value, ctx) => {
    const prior =
      value.type === "managed.thread.stop"
        ? value.target.commandId
        : value.type === "managed.turn.submit"
          ? value.previousCommandId
          : undefined;
    if (value.commandId === prior)
      ctx.addIssue({
        code: "custom",
        message: "Distinct commands require distinct IDs",
      });
  });

export const managedFrame271 = z.strictObject({
  type: z.literal("host-rpc.request"),
  requestId: z.uuid(),
  agentSessionId: id,
  command: managedCommand,
});

export function decodeForProtectedGuest(
  frame: unknown,
  ingress: { hostId: string; sessionId: string; protocolVersion: number },
) {
  if (ingress.protocolVersion !== 271)
    throw new Error("Unsupported managed protocol");
  const parsed = managedFrame271.parse(frame);
  if (
    parsed.agentSessionId !== ingress.sessionId ||
    parsed.command.binding.agentHostId !== ingress.hostId
  )
    throw new Error("Managed command destination changed");
  // Decoding is not admission. Enrollment, journal, custody and permission checks still precede execution.
  return parsed;
}

export type ManagedGuestCommand = z.infer<typeof managedCommand>;

// Only the disposable 271 test composition installs these variants in the WS union.
export const guestStartFrame271 = managedFrame271.extend({
  command: z.strictObject({
    type: z.literal("managed.thread.start"),
    ...launch,
  }),
});
export const guestChallenge = z.strictObject({
  domain: z.literal("bb.synthetic-cold-create.271"),
  hostId: id,
  sessionId: id,
  manifestDigest: id,
  registrationNonce: z.uuid(),
  nonce: z.uuid(),
});
export const guestQualificationFrame = z.strictObject({
  type: z.literal("host-rpc.request"),
  requestId: z.uuid(),
  command: z.strictObject({
    type: z.literal("managed.lab.qualify"),
    challenge: guestChallenge,
  }),
});
export const guestReport = z.strictObject({
  commandId,
  threadId: id,
  requestId: clientTurnRequestIdSchema,
  epoch,
  agentSessionId: id,
  manifestDigest: id,
  bodyDigest: id,
  disposition: z.literal("applied"),
  guestSessionId: id,
});
export const labRpcResponse = z.discriminatedUnion("commandType", [
  z.strictObject({
    type: z.literal("host-rpc.response"),
    requestId: z.uuid(),
    ok: z.literal(true),
    commandType: z.literal("managed.lab.qualify"),
    result: z.strictObject({ signature: z.string().min(1).max(256) }),
  }),
  z.strictObject({
    type: z.literal("host-rpc.response"),
    requestId: z.uuid(),
    ok: z.literal(true),
    commandType: z.literal("managed.thread.start"),
    result: guestReport,
  }),
]);
