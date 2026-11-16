import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { piAiContract } from "./contract.js";

export function registerPiAiService(bb: BbPluginApi) {
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
            reasoningEfforts: [],
            serviceTiers: [],
          },
        }));
      },
      generate(request, { signal, model }) {
        if (model.profile !== "default")
          throw new Error("Unsupported Pi profile");
        return host.call(
          "pi.ai.generate",
          { ...request, messages: [...request.messages] },
          { hostId: model.hostId, signal, timeoutMs: request.timeoutMs + 1000 },
        );
      },
    },
  });
}
