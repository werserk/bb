import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const resultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("suggestion"),
      text: z
        .string()
        .trim()
        .min(1)
        .refine((s) => [...s].length <= 600),
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type GenerationResult = z.infer<typeof resultSchema>;
export type GeneratorConfig = {
  model: string;
  instructions: string;
  timeoutMs: number;
  outputTokenLimit: number;
  reasoningEffort: string;
  serviceTier: string;
};

export async function generate(
  ai: BbPluginApi["experimental_aiServices"],
  config: GeneratorConfig,
  context: string,
  signal: AbortSignal,
): Promise<GenerationResult> {
  const result = await ai.experimental_generate(
    {
      model: config.model,
      messages: [
        { role: "system", content: config.instructions },
        { role: "user", content: context },
      ],
      maxOutputTokens:
        config.outputTokenLimit === 0 ? null : config.outputTokenLimit,
      temperature: null,
      reasoningEffort:
        config.reasoningEffort === "default" ? null : config.reasoningEffort,
      serviceTier: config.serviceTier === "default" ? null : config.serviceTier,
      timeoutMs: config.timeoutMs,
    },
    { signal },
  );
  if (signal.aborted) throw new Error("Generation cancelled");
  if (result.finishReason !== "stop") throw new Error("Incomplete suggestion");
  if (new TextEncoder().encode(result.text).length > 65536)
    throw new Error("Suggestion response too large");
  return resultSchema.parse(JSON.parse(result.text));
}
