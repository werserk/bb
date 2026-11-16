import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
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
export const rpcContract = defineRpcContract({
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
      })
      .strict(),
    output: z.boolean(),
  },
  status: {
    input: z.null(),
    output: z.object({
      enabled: z.boolean(),
      configured: z.boolean(),
      model: z.string(),
      baseUrl: z.string(),
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
      scope: z.string(),
    }),
  },
});
