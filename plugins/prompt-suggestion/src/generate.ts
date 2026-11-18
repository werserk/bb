import type {
  BbPluginApi,
  experimental_AiGenerationResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { helperResultSchema } from "./helper.js";
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
    })
    .strict(),
  z.object({ kind: z.literal("none") }).strict(),
]);
export type GenerationResult = z.infer<typeof resultSchema>;
export type GeneratorConfig = {
  model: string;
  /** Tried once, with provider defaults, when the model's request fails. */
  fallbackModel?: string;
  instructions: string;
  timeoutMs: number;
  outputTokenLimit: number;
  reasoningEffort: string;
  serviceTier: string;
  responseByteLimit?: number;
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

// A failing primary (an exhausted quota answers slowly) is skipped for a while
// so the fallback gets the whole deadline instead of what the primary left.
const PRIMARY_COOLDOWN_MS = 5 * 60_000;
const primaryFailedAt = new Map<string, number>();

async function generateValue(
  ai: BbPluginApi["experimental_aiServices"],
  config: GeneratorConfig,
  context: string,
  signal: AbortSignal,
  measured?: (measurement: GenerationMeasurement) => void,
): Promise<unknown> {
  const request = (model: string, primary: boolean) =>
    ai.experimental_generate(
      {
        model,
        messages: [
          { role: "system", content: config.instructions },
          { role: "user", content: context },
        ],
        maxOutputTokens:
          config.outputTokenLimit === 0 ? null : config.outputTokenLimit,
        temperature: null,
        reasoningEffort:
          !primary || config.reasoningEffort === "default"
            ? null
            : config.reasoningEffort,
        serviceTier:
          !primary || config.serviceTier === "default"
            ? null
            : config.serviceTier,
        timeoutMs: config.timeoutMs,
        // Affinity was derived for the primary model; another model may not accept it.
        experimental_sessionAffinity: primary
          ? (config.sessionAffinity ?? null)
          : null,
      },
      { signal },
    );
  const fallback = config.fallbackModel?.trim();
  const usable = !!fallback && fallback !== config.model;
  const failedAt = primaryFailedAt.get(config.model);
  const cooling =
    failedAt !== undefined && Date.now() - failedAt < PRIMARY_COOLDOWN_MS;
  const result =
    usable && cooling
      ? await request(fallback, false)
      : await request(config.model, true).then(
          (value) => {
            primaryFailedAt.delete(config.model);
            return value;
          },
          (error: unknown) => {
            if (signal.aborted) throw error;
            primaryFailedAt.set(config.model, Date.now());
            if (!usable) throw error;
            return request(fallback, false);
          },
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
  if (
    new TextEncoder().encode(result.text).length >
    (config.responseByteLimit ?? 65536)
  )
    throw new Error("Suggestion response too large");
  return JSON.parse(result.text);
}

/** Test seam: forget remembered primary failures. */
export function resetPrimaryCooldown() {
  primaryFailedAt.clear();
}

export async function generate(
  ...args: Parameters<typeof generateValue>
): Promise<GenerationResult> {
  return resultSchema.parse(await generateValue(...args));
}

export async function generateMemory(
  ...args: Parameters<typeof generateValue>
) {
  return taskStateSchema.parse(await generateValue(...args));
}

export async function generateHelper(
  ...args: Parameters<typeof generateValue>
) {
  return helperResultSchema.parse(await generateValue(...args));
}
