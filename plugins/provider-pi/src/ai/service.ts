import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piAiContract } from "./contract.js";

export function registerPiAiService(
  bb: BbPluginApi,
  routing: () => "default" | "lowest-latency" = () => "default",
) {
  let last: {
    model: string;
    routingApplied: "default" | "lowest-latency" | "inapplicable";
  } | null = null;
  const host = bb.hosts.experimental_client({ contract: piAiContract });
  bb.experimental_aiServices.register({
    id: "pi",
    displayName: "Pi · default profile",
    experimental_text: {
      async models({ signal }) {
        const hostId = (await bb.sdk.system.config()).primaryHostId;
        if (!hostId) return [];
        const models = await host.call(
          "pi.ai.models",
          {},
          { hostId, signal, timeoutMs: 15000 },
        );
        return models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          provider: model.provider,
          hostId,
          profile: "default",
          capabilities: {
            maxOutputTokens: model.maxOutputTokens,
            temperature: false,
            reasoningEfforts: model.reasoningEfforts,
            experimental_sessionAffinity: model.experimental_sessionAffinity,
            serviceTiers: [],
          },
        }));
      },
      async generate(request, { signal, model }) {
        if (model.profile !== "default")
          throw new Error("Unsupported Pi profile");
        const { routingApplied, ...result } = await host.call(
          "pi.ai.generate",
          { ...request, messages: [...request.messages], routing: routing() },
          { hostId: model.hostId, signal, timeoutMs: request.timeoutMs + 1000 },
        );
        last = { model: result.model, routingApplied };
        return result;
      },
    },
  });
  return () => ({ requestedRouting: routing(), last });
}
