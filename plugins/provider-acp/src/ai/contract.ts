import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const openRouterGenerationSchema = z.object({
  model: z.string().min(1).max(12288),
  routing: z.literal("lowest-latency"),
  messages: z.array(z.object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().max(262144),
  }).strict()).min(1).max(256),
  maxOutputTokens: z.number().int().positive().max(131072).nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  reasoningEffort: z.string().min(1).max(64).nullable(),
  serviceTier: z.string().min(1).max(64).nullable(),
  experimental_sessionAffinity: z.string().min(1).max(256).nullable(),
  timeoutMs: z.number().int().positive().max(60000),
}).strict();
export type OpenRouterGenerationRequest = z.infer<typeof openRouterGenerationSchema>;
export const openRouterModelSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  maxOutputTokens: z.boolean(),
  temperature: z.boolean(),
  reasoningEfforts: z.array(z.string()),
}).strict();
export type OpenRouterModel = z.infer<typeof openRouterModelSchema>;
export const openRouterAiContract = defineRpcContract({
  "openrouter.ai.models": {
    input: z.object({}).strict(),
    output: z.array(openRouterModelSchema),
  },
  "openrouter.ai.generate": {
    input: openRouterGenerationSchema,
    output: z.object({
      text: z.string(),
      model: z.string(),
      actualModel: z.string().nullable(),
      actualServiceTier: z.string().nullable(),
      finishReason: z.enum(["stop", "length"]),
      usage: z.object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedInputTokens: z.number().int().nonnegative().nullable(),
      }).nullable(),
    }).strict(),
  },
});

export const openCodeGoGenerationSchema = openRouterGenerationSchema.omit({ routing: true });
export type OpenCodeGoGenerationRequest = z.infer<typeof openCodeGoGenerationSchema>;
export const openCodeGoAiContract = defineRpcContract({
  "opencodego.ai.models": {
    input: z.object({}).strict(),
    output: z.array(openRouterModelSchema),
  },
  "opencodego.ai.generate": {
    input: openCodeGoGenerationSchema,
    output: openRouterAiContract["openrouter.ai.generate"].output,
  },
});
