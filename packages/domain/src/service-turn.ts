import { z } from "zod";

export const SERVICE_TURN_REASONS = {
  coordinatorBackground: "coordinator-background",
  helperResult: "helper-result",
  directionResult: "direction-result",
  selfReminder: "self-reminder",
} as const;

export const serviceTurnDescriptorSchema = z
  .object({
    version: z.literal(1),
    visibility: z.literal("hidden"),
    deliveryId: z.string().min(1).optional(),
    automaticRedelivery: z.boolean().optional(),
    reason: z.string().regex(/^[a-z0-9-]{1,64}$/),
    origin: z.object({
      pluginId: z.string().min(1),
      senderThreadId: z.string().min(1).nullable(),
    }),
  })
  .strict();
export type ServiceTurnDescriptor = z.infer<typeof serviceTurnDescriptorSchema>;
