import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

describe("gateway shared dispatch", () => {
  it.each([
    { label: "ordinary", nativeId: "native" },
    { label: "long qualified ID", nativeId: "n".repeat(512) },
  ])("lists and generates with $label", async ({ nativeId }) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "ai-gateway" });
    let calls = 0;
    bb.experimental_aiServices.register({
      id: "fixture",
      displayName: "Fixture",
      experimental_text: {
        models: async () => [
          {
            id: nativeId,
            displayName: "Native",
            provider: "Fixture",
            hostId: "h".repeat(256),
            profile: "p".repeat(256),
            capabilities: {
              maxOutputTokens: true,
              temperature: false,
              reasoningEfforts: [],
            },
          },
        ],
        generate: async (request) => {
          calls++;
          return {
            text: "hello\nworld",
            model: request.model,
            actualModel: null,
            finishReason: "stop",
            usage: null,
          };
        },
      },
    });
    plugin(bb);
    try {
      const listed = await harness.behavior.fetchHttp("GET", "/v1/models");
      const listing = await listed.json();
      const model = listing.data[0].id;
      if (nativeId.length === 512) expect(model.length).toBeGreaterThan(1024);
      const send = (extra: object) =>
        harness.behavior.fetchHttp("POST", "/v1/chat/completions", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: "test" }],
            ...extra,
          }),
        });
      expect((await send({ stream: true })).status).toBe(400);
      expect((await send({ temperature: 1 })).status).toBe(400);
      expect((await send({ service_tier: "priority" })).status).toBe(400);
      expect(
        (
          await send({
            messages: [
              { role: "user", content: "test" },
              { role: "system", content: "late system" },
            ],
          })
        ).status,
      ).toBe(400);
      const unsupportedCli = await harness.behavior.runCli([
        "generate",
        "--model",
        model,
        "--prompt",
        "test",
        "--service-tier",
        "fast",
      ]);
      expect(unsupportedCli.exitCode).not.toBe(0);
      expect(calls).toBe(0);
      const completed = await send({ max_tokens: 8 });
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({
        model,
        choices: [
          { message: { content: "hello\nworld" }, finish_reason: "stop" },
        ],
      });
      expect(calls).toBe(1);
      expect(harness.inspection.logEntries).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });
  it.each(["experimental_models", "experimental_generate"])(
    "refuses an older host without %s before registering routes",
    async (method) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "ai-gateway" });
      Object.defineProperty(bb.experimental_aiServices, method, {
        value: undefined,
      });
      try {
        expect(() => plugin(bb)).toThrow(
          "Update BB before enabling this plugin",
        );
      } finally {
        await harness.lifecycle.dispose();
      }
    },
  );
});
