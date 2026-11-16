import { z } from "zod";

export const codexAiConfigSchema = z.object({
  config: z.object({
    model_provider: z.string().nullish(),
    model_providers: z.record(z.string(), z.object({}).passthrough()).nullish(),
  }),
});

export function assertDefaultCodexAiRoute(
  effective: z.infer<typeof codexAiConfigSchema>,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (
    (effective.config.model_provider &&
      effective.config.model_provider !== "openai") ||
    effective.config.model_providers?.openai !== undefined ||
    env.OPENAI_BASE_URL !== undefined ||
    env.CODEX_API_KEY !== undefined ||
    env.OPENAI_API_KEY !== undefined
  )
    throw new Error(
      "Custom Codex provider routes are unsupported by text generation",
    );
}
