import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { generationInput } from "./generation-contract.js";
import {
  buildCodexGenerationRequest,
  readGenerationResponse,
  type CodexGenerationCapabilities,
} from "./responses-request.js";

const POOL_PLUGIN_ID = "account-pool";
const POOL_GENERATION_METHOD = "codex-generation.v1.respond";
const poolGenerationOutput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("not-routed") }),
  z.object({
    kind: z.literal("response"),
    status: z.number().int(),
    body: z.string(),
  }),
]);

type GenerationInput = z.infer<typeof generationInput>;
type GenerationResult = Awaited<ReturnType<typeof readGenerationResponse>>;

export async function generateThroughPool(
  bb: Pick<BbPluginApi, "sdk">,
  input: GenerationInput,
  model: {
    readonly hostId: string;
    readonly capabilities: CodexGenerationCapabilities;
  },
  signal: AbortSignal,
): Promise<GenerationResult | null> {
  if (input.maxOutputTokens !== null) return null;
  const request = buildCodexGenerationRequest(input, model.capabilities);
  let answer: z.infer<typeof poolGenerationOutput>;
  try {
    answer = await bb.sdk.plugins.callRpc({
      pluginId: POOL_PLUGIN_ID,
      method: POOL_GENERATION_METHOD,
      input: {
        hostId: model.hostId,
        body: JSON.stringify(request),
        timeoutMs: input.timeoutMs,
      },
      outputSchema: poolGenerationOutput,
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
  if (answer.kind === "not-routed") return null;
  if (answer.status < 200 || answer.status >= 300)
    throw new Error(`Codex generation HTTP ${answer.status}`);
  const result = await readGenerationResponse(
    new Response(answer.body),
    input.model,
  );
  signal.throwIfAborted();
  return result;
}
