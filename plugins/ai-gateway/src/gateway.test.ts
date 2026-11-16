import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

describe("gateway shared dispatch", () => {
  it.each([undefined, " group ", "x".repeat(257), " "])(
    "shares HTTP and CLI affinity admission: %s",
    async (hint) => {
      for (const supported of [false, true]) {
        const { bb, harness } = createFakePluginHost({
          pluginId: "ai-gateway",
        });
        const hints: (string | null)[] = [];
        bb.experimental_aiServices.register({
          id: "fixture",
          displayName: "Fixture",
          experimental_text: {
            models: async () => [
              {
                id: "m",
                displayName: "M",
                provider: "test",
                hostId: "h",
                profile: "default",
                capabilities: {
                  maxOutputTokens: true,
                  temperature: false,
                  reasoningEfforts: [],
                  experimental_sessionAffinity: supported,
                },
              },
            ],
            generate: async (request) => {
              hints.push(request.experimental_sessionAffinity);
              return {
                text: "ok",
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
          const [model] =
            await bb.experimental_aiServices.experimental_models();
          const valid =
            hint === undefined ||
            (supported && hint.trim().length > 0 && hint.trim().length <= 256);
          const http = await harness.behavior.fetchHttp(
            "POST",
            "/v1/chat/completions",
            {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: model!.id,
                messages: [{ role: "user", content: "test" }],
                prompt_cache_key: hint,
              }),
            },
          );
          const cli = await harness.behavior.runCli([
            "generate",
            "--model",
            model!.id,
            "--prompt",
            "test",
            ...(hint === undefined ? [] : ["--session-affinity", hint]),
          ]);
          expect(http.status).toBe(valid ? 200 : 400);
          expect(cli.exitCode === 0).toBe(valid);
          expect(hints).toEqual(
            valid ? [hint?.trim() ?? null, hint?.trim() ?? null] : [],
          );
        } finally {
          await harness.lifecycle.dispose();
        }
      }
    },
  );
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
