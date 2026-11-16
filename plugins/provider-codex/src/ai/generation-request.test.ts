import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateCodexText } from "./generation.js";
import { generationInput } from "./generation-contract.js";
import type { CodexAuthCredentials } from "./codex-auth.js";
import type { CodexResponsesRequest } from "./chatgpt-client.js";

const mocks = vi.hoisted(() => ({
  catalog: vi.fn<
    () => Promise<
      {
        id: string;
        displayName: string;
        reasoningEfforts: string[];
        serviceTiers: string[];
      }[]
    >
  >(),
  auth: vi.fn<() => Promise<CodexAuthCredentials>>(),
  fetch: vi.fn<(request: CodexResponsesRequest) => Promise<Response>>(),
}));

vi.mock("../bridge/bridge.js", () => ({
  readDefaultCodexAiCatalog: mocks.catalog,
}));
vi.mock("./codex-auth.js", () => ({ readCodexAuthCredentials: mocks.auth }));
vi.mock("./chatgpt-client.js", () => ({
  fetchExplicitCodexResponse: mocks.fetch,
}));

const request = generationInput.parse({
  model: "sample",
  messages: [{ role: "user", content: "Continue" }],
  maxOutputTokens: null,
  temperature: null,
  reasoningEffort: null,
  timeoutMs: 1000,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog.mockResolvedValue([
    {
      id: "sample",
      displayName: "Sample",
      reasoningEfforts: ["low"],
      serviceTiers: ["fast"],
    },
  ]);
  mocks.auth.mockResolvedValue({ type: "apiKey", apiKey: "test-only" });
  mocks.fetch.mockImplementation(
    async () =>
      new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            model: "sample",
            service_tier: "priority",
            status: "completed",
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "Next" }],
              },
            ],
          },
        })}\n\n`,
      ),
  );
});

describe("Codex explicit generation controls", () => {
  it("sends advertised reasoning and Fast while preserving the served tier", async () => {
    const result = await generateCodexText(
      { ...request, reasoningEffort: "low", serviceTier: "fast" },
      new AbortController().signal,
    );
    expect(mocks.fetch.mock.calls[0]?.[0]).toMatchObject({
      model: "sample",
      reasoning: { effort: "low" },
      service_tier: "priority",
    });
    expect(result.actualServiceTier).toBe("priority");
  });

  it("omits unset controls from the provider request", async () => {
    await generateCodexText(request, new AbortController().signal);
    expect(mocks.fetch.mock.calls[0]?.[0]).not.toHaveProperty("service_tier");
    expect(mocks.fetch.mock.calls[0]?.[0]).not.toHaveProperty("reasoning");
  });

  it.each([
    { serviceTier: "priority" },
    { serviceTier: "unknown" },
    { reasoningEffort: "none" },
  ])("rejects an unadvertised option before inference: %j", async (option) => {
    await expect(
      generateCodexText(
        { ...request, ...option },
        new AbortController().signal,
      ),
    ).rejects.toThrow("Unsupported");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("validates current credentials and route again for the next request", async () => {
    await generateCodexText(request, new AbortController().signal);
    mocks.fetch.mockClear();
    mocks.catalog.mockRejectedValueOnce(new Error("Custom route rejected"));
    await expect(
      generateCodexText(request, new AbortController().signal),
    ).rejects.toThrow("Custom route rejected");
    expect(mocks.auth).toHaveBeenCalledTimes(2);
    expect(mocks.catalog).toHaveBeenCalledTimes(2);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
