import { experimental_AI_MODEL_ID_MAX_LENGTH } from "../ai-generation.js";
import { describe, expect, it, vi } from "vitest";
import { createAiGenerationDispatcher } from "./ai-generation.js";
import { createFakePluginHost } from "../testing/index.js";
import { validatePluginAiServiceDeclaration } from "./host-policy.js";
import type {
  experimental_AiGenerationRequest,
  experimental_AiModel,
  PluginAiServiceDeclaration,
} from "../backend-contract.js";

const native: experimental_AiModel = {
  id: "native/a",
  displayName: "Test",
  provider: "Test",
  hostId: "host-a",
  profile: "default",
  capabilities: {
    maxOutputTokens: true,
    temperature: false,
    reasoningEfforts: [],
  },
};
const request = (model: string): experimental_AiGenerationRequest => ({
  model,
  messages: [{ role: "user", content: "Hello" }],
  maxOutputTokens: 32,
  temperature: null,
  reasoningEffort: null,
  timeoutMs: 1000,
});

for (const surface of ["dispatcher", "plugin SDK"] as const) {
  describe(surface, () => {
    function setup(
      generate = vi.fn(async () => ({
        text: 'line 1\n{"ok":true}',
        model: native.id,
        actualModel: null as string | null,
        finishReason: "stop" as const,
        usage: null,
      })),
      catalogModel = native,
    ) {
      const declaration: PluginAiServiceDeclaration = {
        id: "test-ai",
        displayName: "Test",
        experimental_text: { models: async () => [catalogModel], generate },
      };
      if (surface === "plugin SDK") {
        const host = createFakePluginHost();
        const registration =
          host.bb.experimental_aiServices.register(declaration);
        return {
          models: host.bb.experimental_aiServices.experimental_models,
          generate: host.bb.experimental_aiServices.experimental_generate,
          dispose: registration.dispose,
          callback: generate,
        };
      }
      const service = {
        ...validatePluginAiServiceDeclaration(declaration),
        pluginId: "test-plugin",
      };
      const services = [service];
      const dispatcher = createAiGenerationDispatcher(() => services);
      return {
        ...dispatcher,
        dispose: () => {
          dispatcher.invalidate("test-plugin/test-ai");
          services.length = 0;
        },
        callback: generate,
      };
    }
    it.each([undefined, null, "group", "  group  ", "", " ", "x".repeat(257)])(
      "validates affinity %s before invoking adapters",
      async (hint) => {
        for (const supported of [false, true]) {
          const service = setup(undefined, {
            ...native,
            capabilities: {
              ...native.capabilities,
              ...(supported ? { experimental_sessionAffinity: true } : {}),
            },
          });
          const [model] = await service.models();
          const pending = service.generate({
            ...request(model!.id),
            experimental_sessionAffinity: hint,
          });
          const invalid =
            hint !== null &&
            hint !== undefined &&
            (hint.trim().length === 0 || hint.trim().length > 256);
          if (invalid || (hint != null && !supported)) {
            await expect(pending).rejects.toMatchObject({
              code: invalid ? "invalid_request" : "unsupported",
            });
            expect(service.callback).not.toHaveBeenCalled();
          } else {
            await pending;
            expect(service.callback).toHaveBeenCalledWith(
              expect.objectContaining({
                experimental_sessionAffinity: hint?.trim() ?? null,
              }),
              expect.objectContaining({
                model: expect.objectContaining({
                  capabilities: expect.objectContaining({
                    experimental_sessionAffinity: supported,
                  }),
                }),
              }),
            );
          }
        }
      },
    );
    it("normalizes omitted tier fields from legacy callers and adapters", async () => {
      const service = setup();
      const [model] = await service.models();
      expect(model!.capabilities.serviceTiers).toEqual([]);
      const result = await service.generate(request(model!.id));
      expect(result.actualServiceTier).toBeNull();
      expect(service.callback).toHaveBeenCalledWith(
        expect.objectContaining({ serviceTier: null }),
        expect.anything(),
      );
    });
    it("rejects unsupported tiers before adapter dispatch", async () => {
      const service = setup();
      const [model] = await service.models();
      await expect(
        service.generate({ ...request(model!.id), serviceTier: "fast" }),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(service.callback).not.toHaveBeenCalled();
    });
    it("passes a supported tier and preserves the provider-reported actual tier", async () => {
      const callback = vi.fn(async () => ({
        text: "ok",
        model: native.id,
        actualModel: null as string | null,
        actualServiceTier: "default",
        finishReason: "stop" as const,
        usage: null,
      }));
      const service = setup(callback, {
        ...native,
        capabilities: { ...native.capabilities, serviceTiers: ["fast"] },
      });
      const [model] = await service.models();
      const result = await service.generate({
        ...request(model!.id),
        serviceTier: "fast",
      });
      expect(result.actualServiceTier).toBe("default");
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ serviceTier: "fast" }),
        expect.anything(),
      );
    });
    it("preserves output and selected host/profile binding", async () => {
      const service = setup();
      const [model] = await service.models();
      const result = await service.generate(request(model!.id));
      expect(result).toEqual({
        text: 'line 1\n{"ok":true}',
        model: model!.id,
        actualModel: null,
        actualServiceTier: null,
        finishReason: "stop",
        usage: null,
      });
      expect(service.callback).toHaveBeenCalledWith(
        expect.objectContaining({ model: native.id }),
        expect.objectContaining({
          model: {
            ...native,
            capabilities: {
              ...native.capabilities,
              serviceTiers: [],
              experimental_sessionAffinity: false,
            },
          },
        }),
      );
    });
    it("rejects unsupported options and unloaded models before invocation", async () => {
      const service = setup();
      const [model] = await service.models();
      await expect(
        service.generate({ ...request(model!.id), temperature: 0 }),
      ).rejects.toMatchObject({ code: "unsupported" });
      service.dispose();
      await expect(service.generate(request(model!.id))).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(service.callback).not.toHaveBeenCalled();
    });
    it("rejects another returned model and never falls back", async () => {
      const callback = vi.fn(async () => ({
        text: "wrong",
        model: "other",
        actualModel: null as string | null,
        finishReason: "stop" as const,
        usage: null,
      }));
      const service = setup(callback);
      const [model] = await service.models();
      await expect(service.generate(request(model!.id))).rejects.toMatchObject({
        code: "failed",
      });
      expect(callback).toHaveBeenCalledTimes(1);
    });
    it("preserves an alias selection separately from the reported snapshot", async () => {
      const service = setup(
        vi.fn(async () => ({
          text: "result",
          model: native.id,
          actualModel: "native-snapshot-2026",
          finishReason: "stop" as const,
          usage: null,
        })),
      );
      const [model] = await service.models();
      await expect(service.generate(request(model!.id))).resolves.toMatchObject(
        { model: model!.id, actualModel: "native-snapshot-2026" },
      );
    });
    it("round-trips long escaped catalog identities through generation", async () => {
      const longModel = {
        ...native,
        id: "界".repeat(512),
        hostId: "機".repeat(256),
        profile: "人".repeat(256),
      };
      const callback = vi.fn(async () => ({
        text: "ok",
        model: longModel.id,
        actualModel: null as string | null,
        finishReason: "stop" as const,
        usage: null,
      }));
      const service = setup(callback, longModel);
      const [model] = await service.models();
      expect(model!.id.length).toBeGreaterThan(4096);
      expect(model!.id.length).toBeLessThanOrEqual(
        experimental_AI_MODEL_ID_MAX_LENGTH,
      );
      await expect(service.generate(request(model!.id))).resolves.toMatchObject(
        { model: model!.id },
      );
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ model: longModel.id }),
        expect.objectContaining({
          model: {
            ...longModel,
            capabilities: {
              ...longModel.capabilities,
              serviceTiers: [],
              experimental_sessionAffinity: false,
            },
          },
        }),
      );
    });
    it("rejects interleaved system messages before dispatch", async () => {
      const service = setup();
      const [model] = await service.models();
      await expect(
        service.generate({
          ...request(model!.id),
          messages: [
            { role: "user", content: "Hello" },
            { role: "system", content: "Late instruction" },
          ],
        }),
      ).rejects.toMatchObject({ code: "unsupported" });
      expect(service.callback).not.toHaveBeenCalled();
    });
    it("rejects malformed requests before invoking the adapter", async () => {
      const service = setup();
      await expect(
        service.generate({
          ...request("unknown"),
          messages: [{ role: "user", content: "x".repeat(262144) }],
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(service.callback).not.toHaveBeenCalled();
    });
  });
}

it("cancels an in-flight adapter on service disposal and rejects its late result", async () => {
  const entered = deferred<void>();
  const response = deferred<{
    text: string;
    model: string;
    actualModel: string | null;
    finishReason: "stop";
    usage: null;
  }>();
  let observed: AbortSignal | null = null;
  const host = createFakePluginHost();
  const registration = host.bb.experimental_aiServices.register({
    id: "slow-ai",
    displayName: "Slow",
    experimental_text: {
      models: async () => [native],
      generate: async (_, options) => {
        observed = options.signal;
        entered.resolve();
        return response.promise;
      },
    },
  });
  const [model] = await host.bb.experimental_aiServices.experimental_models();
  const pending = host.bb.experimental_aiServices.experimental_generate(
    request(model!.id),
  );
  await entered.promise;
  registration.dispose();
  await expect(pending).rejects.toMatchObject({ code: "unavailable" });
  expect(observed!.aborted).toBe(true);
  response.resolve({
    text: "late",
    model: native.id,
    actualModel: null,
    finishReason: "stop",
    usage: null,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("bounds dispatch and aborts a timed-out request without retrying", async () => {
  const host = createFakePluginHost();
  let calls = 0;
  host.bb.experimental_aiServices.register({
    id: "timeout-ai",
    displayName: "Timeout",
    experimental_text: {
      models: async () => [native],
      generate: async (_, { signal }) => {
        calls++;
        return new Promise((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          else
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
        });
      },
    },
  });
  const [model] = await host.bb.experimental_aiServices.experimental_models();
  await expect(
    host.bb.experimental_aiServices.experimental_generate({
      ...request(model!.id),
      timeoutMs: 100,
    }),
  ).rejects.toMatchObject({ code: "timeout" });
  expect(calls).toBe(1);
});
