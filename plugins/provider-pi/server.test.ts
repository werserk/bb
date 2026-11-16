import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import piPlugin from "./server.js";
import { piGenerationSchema } from "./src/ai/contract.js";

async function registeredDeclaration() {
  const host = createFakePluginHost({ pluginId: "provider-pi" });
  await piPlugin(host.bb);
  const declaration = host.harness.registrations.providerRegistrations.find(
    (entry) => entry.id === "pi",
  );
  if (declaration === undefined)
    throw new Error("expected pi to be registered");
  return declaration;
}

describe("the pi plugin's environment passthrough", () => {
  it("declares the bridge command override variables so a host-set value reaches the bridge", async () => {
    expect((await registeredDeclaration()).env).toEqual({
      passthrough: ["BB_PI_BRIDGE_COMMAND", "BB_PI_BRIDGE_ARGS"],
    });
  });
});

describe("the pi plugin's skill roots", () => {
  it("declares pi's directories as recursive, walks ancestors for .agents/skills only, and resolves the rest per host", async () => {
    const declaration = await registeredDeclaration();
    expect(declaration.experimental_nativeSkillRoots).toMatchObject({
      user: [
        { path: ".pi/agent/skills", recursive: true },
        { path: ".agents/skills", recursive: true },
      ],
      project: [
        { path: ".pi/skills", recursive: true, ancestors: false },
        { path: ".agents/skills", recursive: true, ancestors: true },
      ],
    });
    expect(declaration.experimental_resolvesNativeRoots).toBe(true);
  });
});

it("normalizes native routing once and uses live setting changes on host requests", async () => {
  const { bb, harness } = createFakePluginHost({
    pluginId: "provider-pi",
    sdk: { system: { config: async () => ({ primaryHostId: "host" }) } },
    experimental_callHostRpc: (call) =>
      call.method === "pi.ai.models"
        ? [
            {
              id: "openrouter/m",
              displayName: "M",
              provider: "openrouter",
              maxOutputTokens: true,
              reasoningEfforts: ["none"],
              experimental_sessionAffinity: true,
            },
          ]
        : {
            model: "openrouter/m",
            routingApplied: piGenerationSchema.parse(call.input).routing,
            text: "ok",
            actualModel: null,
            actualServiceTier: null,
            finishReason: "stop",
            usage: null,
          },
  });
  await piPlugin(bb);
  try {
    expect(await harness.behavior.callRpc("nativeGenerationStatus")).toEqual({
      requestedRouting: "default",
      last: null,
    });
    const [model] = await bb.experimental_aiServices.experimental_models();
    for (const routing of ["default", "lowest-latency", "default"]) {
      if (
        routing !== "default" ||
        harness.inspection.experimental_hostRpcCalls.length > 1
      )
        await harness.behavior.setSettings({
          nativeGenerationRouting: routing,
        });
      await bb.experimental_aiServices.experimental_generate({
        model: model!.id,
        messages: [{ role: "user", content: "test" }],
        maxOutputTokens: null,
        temperature: null,
        reasoningEffort: null,
        timeoutMs: 1000,
      });
      const status = {
        requestedRouting: routing,
        last: { model: "openrouter/m", routingApplied: routing },
      };
      expect(await harness.behavior.callRpc("nativeGenerationStatus")).toEqual(
        status,
      );
      expect(
        JSON.parse(
          (await harness.behavior.runCli(["status"])).stdout ?? "null",
        ),
      ).toEqual(status);
      expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toMatchObject(
        {
          method: "pi.ai.generate",
          input: { routing, experimental_sessionAffinity: null },
        },
      );
    }
    await expect(
      harness.behavior.setSettings({ nativeGenerationRouting: "invalid" }),
    ).rejects.toThrow();
  } finally {
    await harness.lifecycle.dispose();
  }
});
