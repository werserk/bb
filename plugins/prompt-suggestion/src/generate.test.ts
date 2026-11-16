import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { generate } from "./generate.js";
import { installGenerator } from "./generator-fixture.js";

const config = {
  instructions: "Predict",
  reasoningEffort: "default",
  serviceTier: "default",
  timeoutMs: 1000,
  outputTokenLimit: 256,
};
describe("native generation boundary", () => {
  it("passes ordered context and the exact selected model without tools", async () => {
    const host = createFakePluginHost({ pluginId: "prompt-suggestion" });
    let calls = 0;
    const model = await installGenerator(host.bb, async (request) => {
      calls++;
      expect(request.model).toBe("fixture-model");
      expect(request.messages).toEqual([
        { role: "system", content: "Predict" },
        { role: "user", content: "context" },
      ]);
      expect(request.maxOutputTokens).toBe(256);
      expect(request.reasoningEffort).toBe("none");
      expect(request.serviceTier).toBe("fast");
      expect(request).not.toHaveProperty("tools");
      return '{"kind":"suggestion","text":"Run the tests."}';
    });
    try {
      expect(
        await generate(
          host.bb.experimental_aiServices,
          { ...config, model, reasoningEffort: "none", serviceTier: "fast" },
          "context",
          new AbortController().signal,
        ),
      ).toEqual({ kind: "suggestion", text: "Run the tests." });
      expect(calls).toBe(1);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
  it.each([
    { name: "malformed JSON", text: "not JSON" },
    {
      name: "long suggestion",
      text: '{"kind":"suggestion","text":"' + "x".repeat(601) + '"}',
    },
    { name: "large response", text: "x".repeat(65537) },
  ])("rejects $name", async ({ text }) => {
    const host = createFakePluginHost({ pluginId: "prompt-suggestion" });
    const model = await installGenerator(host.bb, async () => text);
    try {
      await expect(
        generate(
          host.bb.experimental_aiServices,
          { ...config, model },
          "context",
          new AbortController().signal,
        ),
      ).rejects.toThrow();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
  it("rejects a truncated completion even when its JSON parses", async () => {
    const host = createFakePluginHost({ pluginId: "prompt-suggestion" });
    const model = await installGenerator(
      host.bb,
      async () => '{"kind":"none"}',
      "length",
    );
    try {
      await expect(
        generate(
          host.bb.experimental_aiServices,
          { ...config, model },
          "context",
          new AbortController().signal,
        ),
      ).rejects.toThrow("Incomplete suggestion");
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
