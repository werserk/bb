import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const CODEX_GENERATION_CALLER = "provider-codex";
export const codexGenerationRespondMethod = "codex-generation.v1.respond";
export const CODEX_GENERATION_MAX_BYTES = 2 * 1024 * 1024;

export const codexGenerationRespondContract = defineRpcContract({
  [codexGenerationRespondMethod]: {
    input: z
      .object({
        hostId: z.string().min(1),
        body: z.string().min(2).max(CODEX_GENERATION_MAX_BYTES),
        timeoutMs: z.number().int().min(1).max(300_000),
      })
      .strict(),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("not-routed") }).strict(),
      z
        .object({
          kind: z.literal("response"),
          status: z.number().int(),
          body: z.string(),
        })
        .strict(),
    ]),
    experimental_description:
      "Sends one Codex Responses request through the pool's Codex accounts for provider-codex text generation. Not-routed means Codex routing is off or no account can serve.",
  },
});
