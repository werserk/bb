import { describe, expect, it } from "vitest";
import { readGenerationResponse } from "./generation.js";

function response(overrides: Record<string, unknown> = {}) {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        model: "selected",
        status: "completed",
        output: [
          { type: "message", content: [{ type: "output_text", text: "a\nb" }] },
        ],
        usage: {
          input_tokens: 9,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 3 },
        },
        ...overrides,
      },
    })}\n\n`,
  );
}
describe("Codex explicit generation response", () => {
  it("retains multiline text, actual usage and model", async () => {
    expect(await readGenerationResponse(response(), "selected")).toEqual({
      text: "a\nb",
      model: "selected",
      actualModel: "selected",
      actualServiceTier: null,
      finishReason: "stop",
      usage: { inputTokens: 9, outputTokens: 2, cachedInputTokens: 3 },
    });
  });
  it("does not invent usage and preserves truncation", async () => {
    expect(
      await readGenerationResponse(
        response({
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
          usage: null,
        }),
        "selected",
      ),
    ).toMatchObject({ finishReason: "length", usage: null });
  });
  it("reports the served tier without assuming the requested tier was honored", async () => {
    for (const serviceTier of ["priority", "fast", "default", null]) {
      const result = await readGenerationResponse(
        response({ service_tier: serviceTier }),
        "selected",
      );
      expect(result.actualServiceTier).toBe(serviceTier);
    }
  });
  it("preserves alias resolution and rejects tools or missing terminal event", async () => {
    expect(
      await readGenerationResponse(response({ model: "snapshot" }), "selected"),
    ).toMatchObject({ model: "selected", actualModel: "snapshot" });
    await expect(
      readGenerationResponse(
        response({ output: [{ type: "function_call" }] }),
        "selected",
      ),
    ).rejects.toThrow("tool");
    await expect(
      readGenerationResponse(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"unfinished"}\n\n',
        ),
        "selected",
      ),
    ).rejects.toThrow("Missing");
  });
  it("bounds upstream bytes", async () => {
    await expect(
      readGenerationResponse(
        new Response("x".repeat(2 * 1024 * 1024 + 1)),
        "selected",
      ),
    ).rejects.toThrow("limit");
  });
});
