import { experimental_AI_MODEL_ID_MAX_LENGTH } from "@get-bb/plugin-sdk";
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { taskStateSchema } from "./task-state.js";
import { resultSchema } from "./generate.js";
export const requestSchema = z
  .object({
    threadId: z.string().min(1).max(128),
    requestId: z.string().uuid(),
    token: z.string().uuid(),
    automatic: z.boolean(),
    expectedTurnId: z.string().min(1).nullable(),
  })
  .strict();
export const responseSchema = z.union([
  resultSchema,
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
]);
export const modelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  provider: z.string(),
  hostId: z.string(),
  profile: z.string(),
  supportsOutputLimit: z.boolean(),
  reasoningEfforts: z.array(z.string()),
  serviceTiers: z.array(z.string()),
});
export const threadSchema = z
  .object({ threadId: z.string().min(1).max(128) })
  .strict();
export const clientSchema = threadSchema
  .extend({ clientId: z.string().uuid() })
  .strict();
export const jobViewSchema = z
  .object({
    phase: z.enum([
      "prepared",
      "queued",
      "pending",
      "ready",
      "none",
      "error",
      "unavailable",
    ]),
    jobId: z.string().uuid().nullable(),
    turnId: z.string().min(1).nullable(),
    result: responseSchema.nullable(),
    queueMs: z.number().nonnegative(),
    preparationMs: z.number().nonnegative(),
    modelMs: z.number().nonnegative(),
    validationMs: z.number().nonnegative(),
    serverMs: z.number().nonnegative().nullable(),
    usage: z
      .object({
        inputTokens: z.number(),
        outputTokens: z.number(),
        cachedInputTokens: z.number().nullable(),
      })
      .nullable(),
    actualModel: z.string().nullable(),
    actualServiceTier: z.string().nullable(),
    finishReason: z.enum(["stop", "length"]).nullable(),
    outputTokenLimit: z.number().int().positive().nullable(),
  })
  .strict();
export const taskMemorySchema = z
  .object({
    state: taskStateSchema,
    sources: z.array(
      z
        .object({
          messageId: z.string().min(1),
          revision: z.string().regex(/^[a-f0-9]{64}$/),
          role: z.enum(["user", "assistant"]),
          text: z.string(),
          sequence: z.number(),
        })
        .strict(),
    ),
    boundary: z.number().nullable(),
  })
  .strict();
export const rpcContract = defineRpcContract({
  track: { input: clientSchema, output: jobViewSchema },
  state: {
    input: threadSchema,
    output: jobViewSchema,
    tags: ({ threadId }) => [`companion:${threadId}`],
  },
  detach: { input: clientSchema, output: z.boolean() },
  clearCache: { input: threadSchema, output: z.null() },
  inspect: {
    input: threadSchema,
    output: taskMemorySchema.nullable(),
    tags: ({ threadId }) => [`companion:${threadId}`],
  },
  models: { input: z.null(), output: z.array(modelSchema) },
  selectModel: {
    input: z
      .object({ model: z.string().max(experimental_AI_MODEL_ID_MAX_LENGTH) })
      .strict(),
    output: z.object({ model: z.string() }),
  },
  suggest: { input: requestSchema, output: responseSchema },
  cancel: {
    input: z
      .object({ requestId: z.string().uuid(), token: z.string().uuid() })
      .strict(),
    output: z.boolean(),
  },
  observe: {
    input: z
      .object({
        requestId: z.string().uuid(),
        event: z.enum(["shown", "accepted", "dismissed"]),
        observedToAttachMs: z
          .number()
          .nonnegative()
          .finite()
          .nullable()
          .default(null),
      })
      .strict(),
    output: z.boolean(),
  },
  status: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      backgroundPreparation: z.boolean(),
      instructionsAvailable: z.boolean(),
      instructionRevision: z.string().nullable(),
      tracked: z.number(),
      reasoningEffort: z.string(),
      serviceTier: z.string(),
      model: z.string(),
      active: z.number(),
    }),
  },
  diagnostics: {
    input: z.null(),
    output: z.object({
      requests: z.number(),
      suggestions: z.number(),
      none: z.number(),
      errors: z.number(),
      cancelled: z.number(),
      shown: z.number(),
      accepted: z.number(),
      dismissed: z.number(),
      lastLatencyMs: z.number(),
      lastAttachment: z
        .object({
          jobId: z.string().uuid(),
          observedToAttachMs: z.number().nonnegative(),
        })
        .nullable(),
      tracked: z.number(),
      queued: z.number(),
      admitted: z.number(),
      memory: z.object({
        completed: z.number(),
        errors: z.number(),
        cancelled: z.number(),
        active: z.number(),
        queued: z.number(),
      }),
      active: z.number(),
      scope: z.string(),
    }),
  },
});
