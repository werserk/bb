import { it, expect } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerCodexAiService } from "../ai-service.js";
import { generationInput } from "./generation-contract.js";

it("keeps new nullable affinity out of the unchanged strict Codex host wire", async () => {
  let calls = 0;
  const { bb, harness } = createFakePluginHost({
    sdk: { system: { config: async () => ({ primaryHostId: "host" }) } },
    experimental_callHostRpc(call) {
      if (call.method === "codex.ai.models")
        return [
          {
            id: "terra",
            displayName: "Terra",
            reasoningEfforts: ["low"],
            serviceTiers: ["fast"],
            maxOutputTokens: false,
          },
        ];
      const input = generationInput.parse(call.input);
      calls++;
      expect(call.input).not.toHaveProperty("experimental_sessionAffinity");
      return {
        text: "ok",
        model: input.model,
        actualModel: null,
        actualServiceTier: null,
        finishReason: "stop",
        usage: null,
      };
    },
  });
  registerCodexAiService(bb);
  try {
    const model = (await bb.experimental_aiServices.experimental_models())[0]!;
    const input = {
      model: model.id,
      messages: [{ role: "user" as const, content: "test" }],
      maxOutputTokens: null,
      temperature: null,
      reasoningEffort: "low",
      serviceTier: "fast",
      experimental_sessionAffinity: null,
      timeoutMs: 1000,
    };
    expect(
      (await bb.experimental_aiServices.experimental_generate(input)).text,
    ).toBe("ok");
    await expect(
      bb.experimental_aiServices.experimental_generate({
        ...input,
        experimental_sessionAffinity: "explicit",
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(calls).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});
