import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { openCodeGoAiContract, openRouterAiContract } from "./contract.js";

export function registerOpenCodeOpenRouterService(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: openRouterAiContract });
  bb.experimental_aiServices.register({
    id: "opencode-openrouter",
    displayName: "OpenCode credential · OpenRouter direct",
    experimental_text: {
      async models({ signal }) {
        const hostId = (await bb.sdk.system.config()).primaryHostId;
        if (!hostId) return [];
        const models = await host.call("openrouter.ai.models", {}, {
          hostId, signal, timeoutMs: 16000,
        });
        return models.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          provider: "openrouter",
          hostId,
          profile: "opencode",
          capabilities: {
            maxOutputTokens: model.maxOutputTokens,
            temperature: model.temperature,
            reasoningEfforts: model.reasoningEfforts,
            serviceTiers: [],
            experimental_sessionAffinity: false,
          },
        }));
      },
      async generate(request, { signal, model }) {
        if (model.profile !== "opencode" || model.provider !== "openrouter") {
          throw new Error("Unsupported OpenCode profile");
        }
        return host.call("openrouter.ai.generate", {
          ...request, messages: [...request.messages], routing: "lowest-latency",
        }, { hostId: model.hostId, signal, timeoutMs: request.timeoutMs + 1000 });
      },
    },
  });
}

export function registerOpenCodeGoService(bb: BbPluginApi): void {
  const host = bb.hosts.experimental_client({ contract: openCodeGoAiContract });
  bb.experimental_aiServices.register({
    id: "opencode-go",
    displayName: "OpenCode Go subscription",
    experimental_text: {
      async models({ signal }) {
        const hostId = (await bb.sdk.system.config()).primaryHostId;
        if (!hostId) return [];
        const models = await host.call("opencodego.ai.models", {}, {
          hostId, signal, timeoutMs: 16000,
        });
        return models.map((model) => ({
          id: model.id,
          displayName: `OpenCode Go: ${model.displayName}`,
          provider: "opencode-go",
          hostId,
          profile: "opencode",
          capabilities: {
            maxOutputTokens: model.maxOutputTokens,
            temperature: model.temperature,
            reasoningEfforts: model.reasoningEfforts,
            serviceTiers: [],
            experimental_sessionAffinity: true,
          },
        }));
      },
      async generate(request, { signal, model }) {
        if (model.profile !== "opencode" || model.provider !== "opencode-go") {
          throw new Error("Unsupported OpenCode Go profile");
        }
        return host.call("opencodego.ai.generate", {
          ...request, messages: [...request.messages],
        }, { hostId: model.hostId, signal, timeoutMs: request.timeoutMs + 1000 });
      },
    },
  });
}
