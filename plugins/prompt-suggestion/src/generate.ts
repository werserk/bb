import type {
  BbPluginApi,
  experimental_AiGenerationResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { taskStateSchema } from "./task-state.js";

export const resultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("suggestion"),
      text: z
        .string()
        .trim()
        .min(1)
        .refine((s) => [...s].length <= 600),
      state: taskStateSchema,
    })
    .strict(),
  z.object({ kind: z.literal("none"), state: taskStateSchema }).strict(),
]);
export type GenerationResult = z.infer<typeof resultSchema>;
export type GeneratorConfig = {
  model: string;
  instructions: string;
  timeoutMs: number;
  outputTokenLimit: number;
  reasoningEffort: string;
  serviceTier: string;
  sessionAffinity?: string | null;
};

export type GenerationMeasurement = Pick<
  experimental_AiGenerationResult,
  "usage" | "actualModel" | "actualServiceTier" | "finishReason"
>;

export class IncompleteGenerationError extends Error {
  readonly code = "output_truncated";
  constructor(readonly outputTokenLimit: number | null) {
    super("Incomplete suggestion");
  }
}

export async function generate(
  ai: BbPluginApi["experimental_aiServices"],
  config: GeneratorConfig,
  context: string,
  signal: AbortSignal,
  measured?: (measurement: GenerationMeasurement) => void,
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
      experimental_sessionAffinity: config.sessionAffinity ?? null,
    },
    { signal },
  );
  measured?.({
    usage: result.usage,
    actualModel: result.actualModel,
    actualServiceTier: result.actualServiceTier ?? null,
    finishReason: result.finishReason,
  });
  if (signal.aborted) throw new Error("Generation cancelled");
  if (result.finishReason !== "stop")
    throw new IncompleteGenerationError(config.outputTokenLimit || null);
  if (new TextEncoder().encode(result.text).length > 65536)
    throw new Error("Suggestion response too large");
  return resultSchema.parse(JSON.parse(result.text));
}
