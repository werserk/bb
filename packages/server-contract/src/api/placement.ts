import { z } from "zod";
import {
  agentSelectionSchema,
  placementOperationSchema,
  placementIdSchema,
  placementDigestSchema,
  resolvedThreadExecutionOptionsSchema,
} from "@bb/domain";
import {
  createThreadRequestSchema,
  sendMessageRequestSchema,
  forkThreadRequestSchema,
  threadResponseSchema,
} from "./threads.js";
export const placementRequestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  submissionKey: placementIdSchema,
  intent: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("independent"),
      selection: agentSelectionSchema,
      request: createThreadRequestSchema,
    }),
    z.strictObject({
      kind: z.literal("continuation"),
      threadId: placementIdSchema,
      request: sendMessageRequestSchema,
    }),
    z.strictObject({
      kind: z.literal("fork"),
      request: forkThreadRequestSchema,
    }),
    z.strictObject({
      kind: z.literal("retry"),
      failedOperationId: placementIdSchema,
      consentId: placementIdSchema,
    }),
  ]),
});
export const placementAcceptanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("placed"),
    operation: placementOperationSchema,
    thread: threadResponseSchema,
  }),
  z.strictObject({
    kind: z.literal("pending"),
    operation: placementOperationSchema,
  }),
  z.strictObject({
    kind: z.literal("refused"),
    operation: placementOperationSchema,
    outcome: z.literal("not-created"),
  }),
]);
export const placementDraftRecoverySchema = z.strictObject({
  operation: placementOperationSchema,
  originalRequest: placementRequestV1Schema,
  preparedExecution: resolvedThreadExecutionOptionsSchema.nullable(),
  attachmentReceipts: z.array(
    z.strictObject({
      attachmentId: placementIdSchema,
      digest: placementDigestSchema,
      sourceHostId: placementIdSchema.nullable(),
    }),
  ),
});
export type PlacementRequestV1 = z.infer<typeof placementRequestV1Schema>;
export type PlacementAcceptance = z.infer<typeof placementAcceptanceSchema>;
export type PlacementDraftRecovery = z.infer<
  typeof placementDraftRecoverySchema
>;
