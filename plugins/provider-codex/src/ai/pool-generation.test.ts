import { describe, expect, it, vi } from "vitest";
import { generateThroughPool } from "./pool-generation.js";

const sse = `data: ${JSON.stringify({
  type: "response.completed",
  response: {
    model: "gpt-6.2-sol",
    status: "completed",
    output: [
      { type: "message", content: [{ type: "output_text", text: "Ship it." }] },
    ],
    usage: { input_tokens: 900, output_tokens: 12 },
  },
})}\n\n`;

const input = {
  model: "gpt-6.2-sol",
  messages: [
    { role: "system" as const, content: "Be brief." },
    { role: "user" as const, content: "Next?" },
  ],
  maxOutputTokens: null,
  temperature: null,
  reasoningEffort: "low",
  serviceTier: null,
  timeoutMs: 20_000,
};
const model = {
  hostId: "host_a",
  capabilities: {
    maxOutputTokens: false,
    reasoningEfforts: ["low"],
    serviceTiers: ["fast"],
  },
};

function pool(answer: unknown) {
  const callRpc = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  return { bb: { sdk: { plugins: { callRpc } } } as never, callRpc };
}

describe("Codex generation through the account pool", () => {
  it("sends the built Responses request and reads the pooled answer", async () => {
    const { bb, callRpc } = pool({ kind: "response", status: 200, body: sse });
    const result = await generateThroughPool(
      bb,
      input,
      model,
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      text: "Ship it.",
      actualModel: "gpt-6.2-sol",
      usage: { inputTokens: 900, outputTokens: 12, cachedInputTokens: null },
    });
    const call = (
      callRpc.mock.calls[0] as unknown as [
        {
          pluginId: string;
          method: string;
          input: { hostId: string; body: string };
        },
      ]
    )[0];
    expect(call.pluginId).toBe("account-pool");
    expect(call.method).toBe("codex-generation.v1.respond");
    expect(call.input.hostId).toBe("host_a");
    expect(JSON.parse(call.input.body)).toMatchObject({
      model: "gpt-6.2-sol",
      instructions: "Be brief.\n\n",
      reasoning: { effort: "low" },
      stream: true,
    });
  });

  it("falls back when the pool does not route Codex or is not installed", async () => {
    for (const answer of [{ kind: "not-routed" }, new Error("no plugin")]) {
      const { bb } = pool(answer);
      await expect(
        generateThroughPool(bb, input, model, new AbortController().signal),
      ).resolves.toBeNull();
    }
  });

  it("surfaces a pooled HTTP failure instead of silently using the machine login", async () => {
    const { bb } = pool({ kind: "response", status: 429, body: "" });
    await expect(
      generateThroughPool(bb, input, model, new AbortController().signal),
    ).rejects.toThrow("Codex generation HTTP 429");
  });

  it("keeps output limits on the machine login", async () => {
    const { bb, callRpc } = pool({ kind: "not-routed" });
    await expect(
      generateThroughPool(
        bb,
        { ...input, maxOutputTokens: 100 },
        model,
        new AbortController().signal,
      ),
    ).resolves.toBeNull();
    expect(callRpc).not.toHaveBeenCalled();
  });
});
