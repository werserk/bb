import { z } from "zod";
import {
  permissionModeSchema,
  permissionEscalationValues,
} from "./shared-types.js";
import { startedOnBehalfOfSchema } from "./started-on-behalf-of.js";
import { threadCreateOriginSchema } from "./thread-create-origin.js";
import { threadTurnInitiatorSchema } from "./thread-events.js";
import { serviceTurnDescriptorSchema } from "./service-turn.js";
import { placementIdSchema } from "./placement.js";

export const placementAuthoritySchema = z.strictObject({
  principal: placementIdSchema,
  actor: z.enum(["local-unverified", "agent", "plugin", "system"]),
  origin: threadCreateOriginSchema.nullable(),
  plugin: placementIdSchema.nullable(),
  requestedBy: startedOnBehalfOfSchema.nullable(),
  sender: placementIdSchema.nullable(),
  initiator: threadTurnInitiatorSchema,
  escalation: z.enum(permissionEscalationValues).nullable(),
  permission: permissionModeSchema,
  serviceTurn: serviceTurnDescriptorSchema.nullable(),
});
export type PlacementAuthority = z.infer<typeof placementAuthoritySchema>;
export const placementStepKinds = [
  "compact",
  "input",
  "retry",
  "answer",
  "clear",
] as const;
export const placementEffectStates = [
  "prepared",
  "possibly_sent",
  "succeeded",
  "failed_accepted",
  "refused",
  "refused_unsent",
  "cancelled",
] as const;
export const placementRetryStates = [
  "held",
  "scheduled",
  "spent",
  "revoked",
  "expired",
  "superseded",
] as const;

export const placementQuestionProtocolSchema = z.strictObject({
  kind: z.literal("questionResponse"),
  questionId: placementIdSchema,
  revision: z.number().int().positive(),
});
export type PlacementQuestionProtocol = z.infer<
  typeof placementQuestionProtocolSchema
>;
