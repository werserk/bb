import { z } from "zod";
import { readCodexAuthCredentials } from "./codex-auth.js";
import {
  fetchExplicitCodexResponse,
  type CodexResponsesRequest,
} from "./chatgpt-client.js";
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

const completion = z.object({
  model: z.string(),
  service_tier: z.string().min(1).max(64).nullish(),
  status: z.enum(["completed", "incomplete"]),
  incomplete_details: z.object({ reason: z.string() }).nullish(),
  output: z.array(
    z.object({
      type: z.string(),
      content: z
        .array(z.object({ type: z.string(), text: z.string().optional() }))
        .optional(),
    }),
  ),
  usage: z
    .object({
      input_tokens: z.number(),
      output_tokens: z.number(),
      input_tokens_details: z
        .object({ cached_tokens: z.number().optional() })
        .optional(),
    })
    .nullish(),
});

export async function readGenerationResponse(
  response: Response,
  expectedModel: string,
) {
  if (!response.body) throw new Error("Missing Codex response stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let size = 0;
  let result: z.infer<typeof completion> | null = null;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024)
        throw new Error("Codex response exceeds limit");
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(
        /\r\n/g,
        "\n",
      );
      for (;;) {
        const end = buffer.indexOf("\n\n");
        if (end < 0) break;
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") continue;
        const event = z
          .object({ type: z.string(), response: z.unknown().optional() })
          .parse(JSON.parse(data));
        if (
          event.type === "response.completed" ||
          event.type === "response.incomplete"
        )
          result = completion.parse(event.response);
        if (event.type === "response.failed" || event.type === "error")
          throw new Error("Codex generation failed");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!result) throw new Error("Missing Codex completion");
  if (
    result.status === "incomplete" &&
    result.incomplete_details?.reason !== "max_output_tokens"
  )
    throw new Error("Codex generation incomplete");
  if (
    result.output.some(
      (item) => item.type !== "message" && item.type !== "reasoning",
    )
  )
    throw new Error("Unexpected Codex tool output");
  const text = result.output
    .flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("");
  return {
    text,
    model: expectedModel,
    actualModel: result.model,
    actualServiceTier: result.service_tier ?? null,
    finishReason:
      result.status === "completed" ? ("stop" as const) : ("length" as const),
    usage: result.usage
      ? {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          cachedInputTokens:
            result.usage.input_tokens_details?.cached_tokens ?? null,
        }
      : null,
  };
}

export async function generateCodexText(
  input: z.infer<typeof generationInput>,
  signal: AbortSignal,
) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
  const models = await listCodexTextModels(signal);
  const model = models.find((candidate) => candidate.id === input.model);
  if (!model) throw new Error("Selected Codex model is unavailable");
  if (
    input.temperature !== null ||
    (input.maxOutputTokens !== null && !model.maxOutputTokens) ||
    (input.reasoningEffort !== null &&
      !model.reasoningEfforts.includes(input.reasoningEffort)) ||
    (input.serviceTier !== null &&
      !model.serviceTiers.includes(input.serviceTier))
  )
    throw new Error("Unsupported Codex generation option");
  const request: CodexResponsesRequest = {
    model: input.model,
    instructions: "",
    store: false,
    stream: true,
    input: [],
  };
  for (const message of input.messages) {
    if (message.role === "system") {
      if (request.input.length)
        throw new Error("System messages must precede conversation messages");
      request.instructions += `${message.content}\n\n`;
    } else
      request.input.push({
        role: message.role,
        content: [
          {
            type: message.role === "assistant" ? "output_text" : "input_text",
            text: message.content,
          },
        ],
      });
  }
  if (input.reasoningEffort !== null)
    request.reasoning = { effort: input.reasoningEffort };
  if (input.serviceTier !== null)
    request.service_tier =
      input.serviceTier === "fast" ? "priority" : input.serviceTier;
  if (input.maxOutputTokens !== null)
    request.max_output_tokens = input.maxOutputTokens;
  const result = await readGenerationResponse(
    await fetchExplicitCodexResponse(request, input.timeoutMs, signal),
    input.model,
  );
  signal.throwIfAborted();
  return result;
}
