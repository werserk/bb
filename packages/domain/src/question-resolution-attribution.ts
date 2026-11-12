import { z } from "zod";
import { jsonValueSchema } from "./json-value.js";

export const questionResolutionActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("agent"),
    verification: z.literal("runtime"),
    threadId: z.string().min(1),
    projectId: z.string().min(1),
    name: z.string(),
    role: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal("local-unverified"),
    verification: z.literal("unverified-local"),
  }),
]);
export type QuestionResolutionActor = z.infer<
  typeof questionResolutionActorSchema
>;

export const questionResolutionAttributionSchema = z.strictObject({
  id: z.string().min(1),
  targetKind: z.enum(["qst", "pint"]),
  targetId: z.string().min(1),
  threadId: z.string().min(1),
  revision: z.number().int().positive(),
  operationId: z.string().trim().min(1).max(128),
  action: z.enum(["answer", "withdraw", "dismiss"]),
  actor: questionResolutionActorSchema,
  reason: z.string().trim().min(1).max(2000),
  acceptedAt: z.number().int().nonnegative(),
  answers: jsonValueSchema.nullable(),
  deliveryId: z.string().nullable(),
});
export type QuestionResolutionAttribution = z.infer<
  typeof questionResolutionAttributionSchema
>;

export const questionResolutionHistoryFields = {
  resolutionAttribution: questionResolutionAttributionSchema
    .nullable()
    .default(null),
  resolutionHistory: z.array(questionResolutionAttributionSchema).default([]),
};

export const LOCAL_QUESTION_ACTOR: QuestionResolutionActor = {
  kind: "local-unverified",
  verification: "unverified-local",
};

export function questionResolutionActorLabel(
  actor: QuestionResolutionActor,
): string {
  return actor.kind === "agent"
    ? `${actor.role === "coordinator" ? "Coordinator" : actor.name || "Agent"} (${actor.threadId})`
    : "locally · identity unverified";
}

export function questionResolutionLabel(
  resolution: Pick<QuestionResolutionAttribution, "action" | "actor">,
): string {
  const action = {
    answer: "Answered",
    withdraw: "Withdrawn",
    dismiss: "Dismissed",
  }[resolution.action];
  const actor = resolution.actor;
  return actor.kind === "agent"
    ? `${action} by ${actor.role === "coordinator" ? "Coordinator" : actor.name || "Agent"}`
    : `${action} locally · identity unverified`;
}
