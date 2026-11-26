import { execFile } from "node:child_process";
import type { experimental_AiGenerationErrorCode } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { openRouterGenerationSchema, type OpenRouterGenerationRequest, type OpenRouterModel } from "./contract.js";

const BASE_URL = "https://openrouter.ai/api/v1";
const CATALOG_TTL_MS = 60000;
const credentialSchema = z.array(z.object({
  integrationID: z.string(),
  active: z.boolean(),
  value: z.unknown(),
}));
const keySchema = z.object({ type: z.literal("key"), key: z.string().trim().min(1) });
const catalogSchema = z.object({ data: z.array(z.object({
  id: z.string().min(1).max(12288),
  name: z.string().min(1).max(2048),
  supported_parameters: z.array(z.string()),
  architecture: z.object({ input_modalities: z.array(z.string()), output_modalities: z.array(z.string()) }),
  endpoints: z.array(z.string()).optional(),
  reasoning: z.object({ mandatory: z.boolean(), supported_efforts: z.array(z.string()).default([]) }).nullish(),
})) });
const completionSchema = z.object({
  model: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.enum(["stop", "length"]),
    message: z.object({
      role: z.literal("assistant"),
      content: z.string(),
      refusal: z.null().optional(),
      tool_calls: z.array(z.never()).optional(),
      function_call: z.null().optional(),
    }),
  })).length(1),
  usage: z.object({
    prompt_tokens: z.number().int().nonnegative(),
    completion_tokens: z.number().int().nonnegative(),
    prompt_tokens_details: z.object({ cached_tokens: z.number().int().nonnegative().nullish() }).nullish(),
  }).nullish(),
  error: z.never().optional(),
});

class OpenRouterError extends Error {
  constructor(readonly code: experimental_AiGenerationErrorCode, message: string) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function failure(): OpenRouterError {
  return new OpenRouterError("failed", "OpenRouter request failed");
}

export function parseOpenCodeKey(value: unknown): string {
  const result = credentialSchema.safeParse(value);
  if (!result.success) throw failure();
  const active = result.data.filter((item) => item.active && item.integrationID === "openrouter");
  if (active.length !== 1) throw failure();
  const key = keySchema.safeParse(active[0]?.value);
  if (!key.success) throw failure();
  return key.data.key;
}

export function exportOpenCodeKey(signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("opencode", ["auth", "export", "openrouter"], {
      encoding: "utf8", signal, timeout: 5000, maxBuffer: 65536, killSignal: "SIGKILL",
    }, (error, stdout) => {
      if (error) { reject(failure()); return; }
      try { resolve(parseOpenCodeKey(JSON.parse(stdout))); }
      catch { reject(failure()); }
    });
  });
}

export function parseCatalog(value: unknown): OpenRouterModel[] {
  const result = catalogSchema.safeParse(value);
  if (!result.success) throw failure();
  const seen = new Set<string>();
  return result.data.data.filter((model) => {
    if (seen.has(model.id)) throw failure();
    seen.add(model.id);
    return model.architecture.input_modalities.includes("text") &&
      model.architecture.output_modalities.includes("text") &&
      (!model.endpoints || model.endpoints.includes("/api/v1/chat/completions"));
  }).map((model) => ({
    id: model.id,
    displayName: model.name,
    maxOutputTokens: model.supported_parameters.includes("max_tokens"),
    temperature: model.supported_parameters.includes("temperature"),
    reasoningEfforts: model.supported_parameters.includes("reasoning")
      ? (model.reasoning?.supported_efforts ?? []).filter((effort) => effort !== "none" || !model.reasoning?.mandatory)
      : [],
  }));
}

export function completionResult(value: unknown, model: string) {
  const parsed = completionSchema.safeParse(value);
  if (!parsed.success) throw failure();
  const { choices, usage } = parsed.data;
  const choice = choices[0];
  if (!choice) throw failure();
  return {
    text: choice.message.content,
    model,
    actualModel: parsed.data.model,
    actualServiceTier: null,
    finishReason: choice.finish_reason,
    usage: usage ? {
      inputTokens: usage.prompt_tokens,
      outputTokens: usage.completion_tokens,
      cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    } : null,
  };
}

export function completionBody(request: OpenRouterGenerationRequest, model: OpenRouterModel) {
  if ((request.maxOutputTokens !== null && !model.maxOutputTokens) ||
      (request.temperature !== null && !model.temperature) ||
      (request.reasoningEffort !== null && !model.reasoningEfforts.includes(request.reasoningEffort)) ||
      request.serviceTier !== null || request.experimental_sessionAffinity !== null) {
    throw new OpenRouterError("unsupported", "Unsupported OpenRouter generation option");
  }
  return {
    model: model.id,
    messages: request.messages,
    stream: false,
    provider: { sort: "latency", allow_fallbacks: false, require_parameters: true },
    ...(request.maxOutputTokens === null ? {} : { max_tokens: request.maxOutputTokens }),
    ...(request.temperature === null ? {} : { temperature: request.temperature }),
    ...(request.reasoningEffort === null ? {} : { reasoning: { effort: request.reasoningEffort } }),
  };
}

export async function readJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw failure();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw failure();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createOpenRouterRuntime(dependencies: {
  key?: (signal: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  now?: () => number;
} = {}) {
  const key = dependencies.key ?? exportOpenCodeKey;
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  let cached: { expires: number; models: OpenRouterModel[] } | null = null;

  async function bounded<T>(signal: AbortSignal, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      combined.throwIfAborted();
      const result = await run(combined);
      combined.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted) throw new OpenRouterError("cancelled", "OpenRouter request cancelled");
      if (controller.signal.aborted) throw new OpenRouterError("timeout", "OpenRouter request timed out");
      if (error instanceof OpenRouterError) throw error;
      throw failure();
    } finally { clearTimeout(timer); }
  }

  async function catalog(signal: AbortSignal): Promise<OpenRouterModel[]> {
    if (cached && cached.expires > now()) return cached.models;
    cached = null;
    const response = await fetcher(`${BASE_URL}/models`, { signal, redirect: "error" });
    if (!response.ok) { await response.body?.cancel(); throw failure(); }
    const models = parseCatalog(await readJson(response, 8 * 1024 * 1024, signal));
    cached = { models, expires: now() + CATALOG_TTL_MS };
    return models;
  }

  return {
    models: (signal: AbortSignal) => bounded(signal, 15000, async (boundedSignal) => {
      await key(boundedSignal);
      return catalog(boundedSignal);
    }),
    generate: (input: OpenRouterGenerationRequest, signal: AbortSignal) => bounded(signal, input.timeoutMs, async (boundedSignal) => {
      const parsed = openRouterGenerationSchema.safeParse(input);
      if (!parsed.success) throw new OpenRouterError("invalid_request", "Invalid OpenRouter generation request");
      const models = await catalog(boundedSignal);
      const model = models.find((item) => item.id === parsed.data.model);
      if (!model) throw new OpenRouterError("unsupported", "OpenRouter model unavailable");
      const body = completionBody(parsed.data, model);
      const token = await key(boundedSignal);
      const response = await fetcher(`${BASE_URL}/chat/completions`, {
        method: "POST", redirect: "error", signal: boundedSignal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        cached = null;
        await response.body?.cancel();
        throw failure();
      }
      return completionResult(await readJson(response, 1024 * 1024, boundedSignal), model.id);
    }),
  };
}
