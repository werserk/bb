import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const message = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(262144),
  })
  .strict();
export const piGenerationSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(message).min(1).max(256),
    maxOutputTokens: z.number().int().positive().max(131072).nullable(),
    temperature: z.number().nullable(),
    reasoningEffort: z.string().nullable(),
    serviceTier: z.string().min(1).max(64).nullable().default(null),
    timeoutMs: z.number().int().positive().max(60000),
  })
  .strict();
const model = z
  .object({
    id: z.string(),
    displayName: z.string(),
    provider: z.string(),
    maxOutputTokens: z.boolean(),
  })
  .strict();
export const piAiContract = defineRpcContract({
  "pi.ai.models": { input: z.object({}).strict(), output: z.array(model) },
  "pi.ai.generate": {
    input: piGenerationSchema,
    output: z
      .object({
        text: z.string(),
        model: z.string(),
        actualModel: z.string().nullable(),
        actualServiceTier: z.string().nullable(),
        finishReason: z.enum(["stop", "length"]),
        usage: z
          .object({
            inputTokens: z.number(),
            outputTokens: z.number(),
            cachedInputTokens: z.number().nullable(),
          })
          .nullable(),
      })
      .strict(),
  },
});
