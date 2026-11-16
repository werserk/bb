import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createPiAiRuntime } from "./runtime.js";

const model: Model<Api> = {
  id: "sample",
  name: "Sample",
  provider: "test",
  api: "openai-completions",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 32000,
  maxTokens: 4096,
};
const request = {
  model: "test/sample",
  messages: [{ role: "user" as const, content: "Hello" }],
  maxOutputTokens: 32,
  temperature: null,
  reasoningEffort: null,
  serviceTier: null,
  experimental_sessionAffinity: null,
  routing: "default" as const,
  timeoutMs: 1000,
};
function fixture() {
  const answer: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "first\nsecond" }],
    provider: "test",
    model: "sample",
    api: "openai-completions",
    stopReason: "length",
    timestamp: 0,
    usage: {
      input: 5,
      output: 2,
      cacheRead: 3,
      cacheWrite: 1,
      totalTokens: 11,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const getAvailable = vi.fn(async () => [model]);
  const completeSimple = vi.fn(async () => answer);
  const create = vi.fn(async () => ({ getAvailable, completeSimple }));
  return {
    ai: createPiAiRuntime(create),
    create,
    getAvailable,
    completeSimple,
    answer,
  };
}
describe("Pi direct AI", () => {
  it("uses exact native model, no tools, bounded options and reported usage", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    expect(await f.ai.generate(request, signal)).toEqual({
      routingApplied: "inapplicable",
      text: "first\nsecond",
      model: "test/sample",
      actualModel: null,
      actualServiceTier: null,
      finishReason: "length",
      usage: { inputTokens: 9, outputTokens: 2, cachedInputTokens: 3 },
    });
    expect(f.completeSimple).toHaveBeenCalledWith(
      model,
      expect.objectContaining({ tools: [] }),
      { signal, timeoutMs: 1000, maxRetries: 0, maxTokens: 32 },
    );
  });
  it("rejects unavailable model and controls before inference", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    await expect(
      f.ai.generate({ ...request, model: "other/sample" }, signal),
    ).rejects.toThrow("unavailable");
    await expect(
      f.ai.generate({ ...request, temperature: 0.5 }, signal),
    ).rejects.toThrow("Unsupported");
    await expect(
      f.ai.generate({ ...request, reasoningEffort: "high" }, signal),
    ).rejects.toThrow("Unsupported");
    await expect(
      f.ai.generate({ ...request, serviceTier: "fast" }, signal),
    ).rejects.toThrow("Unsupported");
    expect(f.completeSimple).not.toHaveBeenCalled();
  });
  it("rejects cancellation and misplaced system messages without inference", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(f.ai.generate(request, controller.signal)).rejects.toThrow();
    expect(f.create).not.toHaveBeenCalled();
    await expect(
      f.ai.generate(
        {
          ...request,
          messages: [...request.messages, { role: "system", content: "late" }],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("precede");
    expect(f.completeSimple).not.toHaveBeenCalled();
  });
  it("never accepts a tool call or silently changed model", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.answer.content = [
      { type: "toolCall", id: "1", name: "shell", arguments: {} },
    ];
    await expect(f.ai.generate(request, signal)).rejects.toThrow("Tool calls");
    f.answer.model = "other";
    await expect(f.ai.generate(request, signal)).rejects.toThrow(
      "different model",
    );
  });
  it("does not invent usage and preserves upstream model snapshot", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.answer.usage.totalTokens = 0;
    expect((await f.ai.generate(request, signal)).usage).toBeNull();
    f.answer.responseModel = "other";
    expect((await f.ai.generate(request, signal)).actualModel).toBe("other");
  });
  it("advertises and enforces missing Codex output cap", async () => {
    const f = fixture();
    const signal = new AbortController().signal;
    f.getAvailable.mockResolvedValue([
      { ...model, api: "openai-codex-responses" },
    ]);
    expect(await f.ai.models(signal)).toEqual([
      {
        id: "test/sample",
        displayName: "Sample",
        provider: "test",
        maxOutputTokens: false,
        reasoningEfforts: [],
        experimental_sessionAffinity: false,
      },
    ]);
    await expect(f.ai.generate(request, signal)).rejects.toThrow("unsupported");
    expect(f.completeSimple).not.toHaveBeenCalled();
  });
});

it.each(["default", "lowest-latency"] as const)(
  "serializes exact OpenRouter options through authenticated ModelRuntime: %s",
  async (routing) => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    await runtime.setRuntimeApiKey("openrouter", "test-only-not-a-secret");
    const selected: Model<Api> = {
      ...model,
      provider: "openrouter",
      id: "vendor/exact-model",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      thinkingLevelMap: { low: null },
    };
    const original = structuredClone(selected);
    const bodies: unknown[] = [];
    const headers: Headers[] = [];
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      headers.push(new Headers(init?.headers));
      return new Response(
        'data: {"id":"test","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const ai = createPiAiRuntime(async () => ({
      getAvailable: async () => [selected],
      completeSimple: (m, c, o) =>
        runtime.completeSimple(m, c, { ...o, fetch }),
    }));
    const signal = new AbortController().signal;
    const catalog = await ai.models(signal);
    expect(catalog[0]?.reasoningEfforts).toContain("none");
    expect(catalog[0]?.reasoningEfforts).not.toContain("low");
    for (const reasoningEffort of ["none", null]) {
      await ai.generate(
        {
          ...request,
          model: "openrouter/vendor/exact-model",
          reasoningEffort,
          experimental_sessionAffinity: "thread-test",
          routing,
        },
        signal,
      );
    }
    for (const body of bodies) {
      expect(body).toMatchObject({
        model: "vendor/exact-model",
        reasoning: { effort: "none" },
      });
      expect(body).not.toHaveProperty("tools");
      if (routing === "lowest-latency")
        expect(body).toHaveProperty("provider", {
          sort: "latency",
          require_parameters: true,
          allow_fallbacks: false,
        });
      else expect(body).not.toHaveProperty("provider");
    }
    expect(bodies).toHaveLength(2);
    expect(
      headers.every((header) => header.get("x-session-id") === "thread-test"),
    ).toBe(true);
    expect(selected).toEqual(original);
    await expect(
      ai.generate(
        {
          ...request,
          model: "openrouter/vendor/exact-model",
          reasoningEffort: "low",
        },
        signal,
      ),
    ).rejects.toThrow("Unsupported");
    expect(bodies).toHaveLength(2);
  },
);
