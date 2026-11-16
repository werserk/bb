import {
  getSupportedThinkingLevels,
  hasApi,
  type Api,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { z } from "zod";
import type { piGenerationSchema } from "./contract.js";

export function resolvePiOptions(
  model: Model<Api>,
  input?: z.infer<typeof piGenerationSchema>,
) {
  const openRouter =
    hasApi(model, "openai-completions") &&
    model.provider === "openrouter" &&
    new URL(model.baseUrl).hostname === "openrouter.ai" &&
    (model.compat?.thinkingFormat === undefined ||
      model.compat.thinkingFormat === "openrouter");
  const levels =
    openRouter && model.reasoning ? getSupportedThinkingLevels(model) : [];
  const canDisable =
    levels.includes("off") &&
    (model.thinkingLevelMap?.off === undefined ||
      model.thinkingLevelMap.off === "none");
  const reasoningEfforts = levels.filter((level) => level !== "off");
  const affinity =
    openRouter &&
    hasApi(model, "openai-completions") &&
    model.compat?.sendSessionAffinityHeaders !== false &&
    (model.compat?.sessionAffinityFormat === undefined ||
      model.compat.sessionAffinityFormat === "openrouter");
  const capabilities = {
    maxOutputTokens: model.api !== "openai-codex-responses",
    reasoningEfforts: [...(canDisable ? ["none"] : []), ...reasoningEfforts],
    experimental_sessionAffinity: affinity,
  };
  const options: SimpleStreamOptions = {};
  let requestModel = model;
  if (input) {
    if (input.maxOutputTokens !== null && !capabilities.maxOutputTokens)
      throw new Error("Output token limit is unsupported by this model");
    if (input.reasoningEffort !== null) {
      if (!capabilities.reasoningEfforts.includes(input.reasoningEffort))
        throw new Error("Unsupported reasoning effort");
      const level = reasoningEfforts.find(
        (level) => level === input.reasoningEffort,
      );
      if (level) options.reasoning = level;
    }
    if (input.experimental_sessionAffinity !== null) {
      if (!affinity) throw new Error("Unsupported session affinity");
      options.sessionId = input.experimental_sessionAffinity;
      options.cacheRetention = "short";
      if (hasApi(requestModel, "openai-completions"))
        requestModel = {
          ...requestModel,
          compat: {
            ...requestModel.compat,
            sendSessionAffinityHeaders: true,
            sessionAffinityFormat: "openrouter",
          },
        };
    }
    if (
      openRouter &&
      input.routing === "lowest-latency" &&
      hasApi(requestModel, "openai-completions")
    ) {
      requestModel = {
        ...requestModel,
        compat: {
          ...requestModel.compat,
          openRouterRouting: {
            sort: "latency",
            require_parameters: true,
            allow_fallbacks: false,
          },
        },
      };
    }
  }
  return {
    capabilities,
    model: requestModel,
    options,
    routingApplied: openRouter
      ? (input?.routing ?? "default")
      : ("inapplicable" as const),
  };
}
