import { describe, expect, it, vi } from "vitest";
import { completionBody, completionResult, createOpenRouterRuntime, parseCatalog, parseOpenCodeKey } from "./runtime.js";
import type { OpenRouterGenerationRequest } from "./contract.js";

const entry = {
  id: "vendor/exact-model", name: "Exact model",
  supported_parameters: ["max_tokens", "temperature", "reasoning"],
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  reasoning: { mandatory: false, supported_efforts: ["none", "high"] },
};
const catalog = { data: [entry] };
const request: OpenRouterGenerationRequest = {
  model: entry.id, routing: "lowest-latency",
  messages: [{ role: "system", content: "system" }, { role: "user", content: "user" }],
  maxOutputTokens: 64, temperature: null, reasoningEffort: "none",
  serviceTier: null, experimental_sessionAffinity: null, timeoutMs: 1000,
};
const completion = {
  model: "vendor/resolved-model", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Answer" } }],
};
const credential = { integrationID: "openrouter", active: true, value: { type: "key", key: "synthetic-secret" } };
const signal = () => new AbortController().signal;

it("accepts exactly one active OpenRouter key, ignoring inactive and unrelated integrations", () => {
  expect(parseOpenCodeKey([credential, { ...credential, active: false }, { ...credential, integrationID: "other" }])).toBe("synthetic-secret");
});

it.each([
  null, {}, [], [credential, credential], [{ ...credential, active: false }],
  [{ ...credential, value: { type: "oauth", key: "synthetic-secret" } }],
  [{ ...credential, value: { type: "key", key: " " } }],
])("rejects ambiguous or malformed credentials without leaking input", (input) => {
  expect(() => parseOpenCodeKey(input)).toThrow("OpenRouter request failed");
});

it("derives capabilities only from catalog metadata", () => {
  expect(parseCatalog(catalog)[0]).toMatchObject({ id: entry.id, maxOutputTokens: true, reasoningEfforts: ["none", "high"] });
  expect(parseCatalog({ data: [{ ...entry, reasoning: { ...entry.reasoning, mandatory: true } }] })[0]?.reasoningEfforts).toEqual(["high"]);
  expect(parseCatalog({ data: [{ ...entry, supported_parameters: ["max_completion_tokens"] }] })[0]).toMatchObject({ maxOutputTokens: false, temperature: false, reasoningEfforts: [] });
});

it.each([
  { serviceTier: "fast" }, { experimental_sessionAffinity: "session" }, { reasoningEffort: "medium" },
])("rejects unsupported controls", (override) => {
  const model = parseCatalog(catalog)[0]!;
  expect(() => completionBody({ ...request, ...override }, model)).toThrow("Unsupported");
});

it.each([
  { choices: [] },
  { choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "" } }] },
  { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", tool_calls: [{}] } }] },
  { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", refusal: "no" } }] },
  { choices: [{ finish_reason: "unknown", message: { role: "assistant", content: "" } }] },
  { usage: { prompt_tokens: -1, completion_tokens: 2 } },
  { error: { message: "synthetic-secret" } },
])("rejects malformed, tool and refusal completions", (override) => {
  expect(() => completionResult({ ...completion, ...override }, entry.id)).toThrow("OpenRouter request failed");
});

it("preserves actual model, length and nullable usage without inventing a tier", () => {
  expect(completionResult(completion, entry.id)).toMatchObject({ actualModel: completion.model, actualServiceTier: null, usage: null });
  expect(completionResult({ ...completion, choices: [{ ...completion.choices[0], finish_reason: "length" }], usage: { prompt_tokens: 12, completion_tokens: 2 } }, entry.id)).toMatchObject({ finishReason: "length", usage: { inputTokens: 12, outputTokens: 2, cachedInputTokens: null } });
});

describe("host transport", () => {
  it("sends exact bounded stateless requests, caches only catalog, and rereads rotating credentials", async () => {
    const key = vi.fn().mockResolvedValueOnce("first").mockResolvedValueOnce("second");
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => Response.json(options?.method === "POST" ? completion : catalog));
    const runtime = createOpenRouterRuntime({ key, fetch: fetcher });
    await runtime.generate(request, signal());
    await runtime.generate(request, signal());
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(key).toHaveBeenCalledTimes(2);
    const [url, options] = fetcher.mock.calls[1]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer first" } });
    expect(JSON.parse(String(options?.body))).toEqual({ model: entry.id, messages: request.messages, stream: false, max_tokens: 64, reasoning: { effort: "none" }, provider: { sort: "latency", allow_fallbacks: false, require_parameters: true } });
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ headers: { Authorization: "Bearer second" } });
  });

  it("expires catalog and invalidates it on upstream failure without retries or leaked errors", async () => {
    let now = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => options?.method === "POST" ? new Response("synthetic-secret", { status: 401 }) : Response.json(catalog));
    const runtime = createOpenRouterRuntime({ key: async () => "synthetic-secret", fetch: fetcher, now: () => now });
    await runtime.models(signal());
    await runtime.models(signal());
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60001;
    await runtime.models(signal());
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(runtime.generate(request, signal())).rejects.toThrow("OpenRouter request failed");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await runtime.models(signal());
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("rejects unsupported controls before fetching credentials or making paid requests", async () => {
    const key = vi.fn(async () => "synthetic-secret");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(catalog));
    const runtime = createOpenRouterRuntime({ key, fetch: fetcher });
    await expect(runtime.generate({ ...request, reasoningEffort: "medium" }, signal())).rejects.toMatchObject({ code: "unsupported" });
    expect(key).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("cancels before credential export and sanitizes thrown network errors", async () => {
    const key = vi.fn(async () => "secret");
    const runtime = createOpenRouterRuntime({ key, fetch: async () => { throw new Error("synthetic-secret"); } });
    await expect(runtime.models(AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    expect(key).not.toHaveBeenCalled();
    await expect(runtime.models(signal())).rejects.toThrow("OpenRouter request failed");
  });

  it("aborts a stalled response body at the request deadline", async () => {
    let cancelled = false;
    const runtime = createOpenRouterRuntime({ key: async () => "secret", fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
    await expect(runtime.generate({ ...request, timeoutMs: 10 }, signal())).rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
  });

  it("rejects oversized bodies without exposing their content", async () => {
    const runtime = createOpenRouterRuntime({ key: async () => "secret", fetch: async (_url, options) => options?.method === "POST" ? new Response("x".repeat(1024 * 1024 + 1)) : Response.json(catalog) });
    await expect(runtime.generate(request, signal())).rejects.toThrow("OpenRouter request failed");
  });
});

it("keeps mixed catalogs usable when reasoning metadata omits explicit efforts", () => {
  const models = parseCatalog({ data: [entry, {
    ...entry, id: "vendor/implicit-reasoning", reasoning: { mandatory: false, default_enabled: true },
  }] });
  expect(models).toHaveLength(2);
  expect(models[1]?.reasoningEfforts).toEqual([]);
  expect(() => completionBody({ ...request, model: "vendor/implicit-reasoning" }, models[1]!)).toThrow("Unsupported");
});
