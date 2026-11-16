import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
export const generationInput = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string().max(262144),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    maxOutputTokens: z.number().int().positive().max(131072).nullable(),
    temperature: z.number().nullable(),
    reasoningEffort: z.string().nullable(),
    timeoutMs: z.number().int().positive().max(60000),
  })
  .strict();
export const codexGenerationContract = defineRpcContract({
  "codex.ai.models": {
    input: z.object({}).strict(),
    output: z.array(
      z
        .object({
          id: z.string(),
          displayName: z.string(),
          reasoningEfforts: z.array(z.string()),
          maxOutputTokens: z.boolean(),
        })
        .strict(),
    ),
  },
  "codex.ai.generate": {
    input: generationInput,
    output: z
      .object({
        text: z.string(),
        model: z.string(),
        actualModel: z.string().nullable(),
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
