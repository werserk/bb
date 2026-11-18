import type { z } from "zod";
import { readCodexAuthCredentials } from "./codex-auth.js";
import { fetchExplicitCodexResponse } from "./chatgpt-client.js";
import {
  buildCodexGenerationRequest,
  readGenerationResponse,
} from "./responses-request.js";
import type { generationInput } from "./generation-contract.js";

export async function listCodexTextModels(signal: AbortSignal) {
  const { readDefaultCodexAiCatalog } = await import("../bridge/bridge.js");
  const auth = await readCodexAuthCredentials();
  const catalog = await readDefaultCodexAiCatalog(signal);
  return catalog.map((model) => ({
    ...model,
    maxOutputTokens: auth.type === "apiKey",
  }));
}

export { readGenerationResponse };

export async function generateCodexText(
  input: z.infer<typeof generationInput>,
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
  const models = await listCodexTextModels(signal);
  const model = models.find((candidate) => candidate.id === input.model);
  if (!model) throw new Error("Selected Codex model is unavailable");
  const request = buildCodexGenerationRequest(input, model);
  const result = await readGenerationResponse(
    await fetchExplicitCodexResponse(request, input.timeoutMs, signal),
    input.model,
  );
  signal.throwIfAborted();
  return result;
}
