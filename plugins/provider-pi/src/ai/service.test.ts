import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { registerPiAiService } from "./service.js";

it("routes generation to the advertised host even after primary host changes", async () => {
  let primaryHostId = "host_original";
  const { bb, harness } = createFakePluginHost({
    sdk: { system: { config: async () => ({ primaryHostId }) } },
    experimental_callHostRpc: (call) =>
      call.method === "pi.ai.models"
        ? [
            {
              id: "test/m",
              displayName: "M",
              provider: "test",
              maxOutputTokens: true,
              reasoningEfforts: [],
              experimental_sessionAffinity: false,
            },
          ]
        : {
            routingApplied: "inapplicable",
            text: "ok",
            actualModel: null,
            actualServiceTier: null,
            model: "test/m",
            finishReason: "stop",
            usage: null,
          },
  });
  const status = registerPiAiService(bb);
  const service =
    harness.registrations.aiServiceRegistrations[0]?.experimental_text;
  if (!service) throw new Error("Missing text service");
  const signal = new AbortController().signal;
  const models = await service.models({ signal });
  const model = models[0];
  if (!model) throw new Error("Missing model");
  primaryHostId = "host_changed";
  await service.generate(
    {
      model: "test/m",
      messages: [{ role: "user", content: "test" }],
      maxOutputTokens: null,
      temperature: null,
      reasoningEffort: null,
      serviceTier: null,
      experimental_sessionAffinity: null,
      timeoutMs: 1000,
    },
    {
      signal,
      model: {
        ...model,
        capabilities: {
          ...model.capabilities,
          serviceTiers: model.capabilities.serviceTiers ?? [],
          experimental_sessionAffinity: false,
        },
      },
    },
  );
  expect(status()).toEqual({
    requestedRouting: "default",
    last: { model: "test/m", routingApplied: "inapplicable" },
  });
  expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject({
    method: "pi.ai.generate",
    hostId: "host_original",
  });
});
