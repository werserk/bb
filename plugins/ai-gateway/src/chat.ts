import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  experimental_AI_MODEL_ID_MAX_LENGTH,
  type experimental_AiGenerationRequest,
  type experimental_AiGenerationResult,
} from "@get-bb/plugin-sdk";

export const MAX_BODY_BYTES = 262144;
export const chatSchema = z
  .object({
    model: z.string().min(1).max(experimental_AI_MODEL_ID_MAX_LENGTH),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string().max(200000),
          })
          .strict(),
      )
      .min(1)
      .max(128),
    max_tokens: z.number().int().min(1).max(32768).optional(),
    max_completion_tokens: z.number().int().min(1).max(32768).optional(),
    temperature: z.number().min(0).max(2).optional(),
    reasoning_effort: z.string().min(1).max(64).optional(),
    stream: z.literal(false).optional(),
    n: z.literal(1).optional(),
  })
  .strict()
  .refine(
    (v) => v.max_tokens === undefined || v.max_completion_tokens === undefined,
  );

export function generationRequest(
  value: z.infer<typeof chatSchema>,
): experimental_AiGenerationRequest {
  return {
    model: value.model,
    messages: value.messages,
    maxOutputTokens: value.max_completion_tokens ?? value.max_tokens ?? null,
    temperature: value.temperature ?? null,
    reasoningEffort: value.reasoning_effort ?? null,
    timeoutMs: 30000,
  };
}

export function chatResponse(result: experimental_AiGenerationResult) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: result.actualModel ?? result.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: result.text },
        finish_reason: result.finishReason,
      },
    ],
    ...(result.usage === null
      ? {}
      : {
          usage: {
            prompt_tokens: result.usage.inputTokens,
            completion_tokens: result.usage.outputTokens,
            total_tokens: result.usage.inputTokens + result.usage.outputTokens,
            ...(result.usage.cachedInputTokens === null
              ? {}
              : {
                  prompt_tokens_details: {
                    cached_tokens: result.usage.cachedInputTokens,
                  },
                }),
          },
        }),
  };
}

export class BodyError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message);
  }
}

export async function readBoundedJson(
  request: Request,
  signal: AbortSignal = request.signal,
): Promise<unknown> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new BodyError(400, "Content-Type must be application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new BodyError(400, "A JSON body is required");
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new BodyError(400, "Request cancelled");
      const next = await reader.read();
      if (signal.aborted) throw new BodyError(400, "Request cancelled");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES)
        throw new BodyError(413, "Request body exceeds 256 KiB");
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BodyError(400, "Invalid JSON body");
  }
}
