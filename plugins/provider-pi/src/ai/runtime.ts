import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import type { z } from "zod";
import type { piGenerationSchema } from "./contract.js";

type Runtime = Pick<ModelRuntime, "getAvailable" | "completeSimple">;
const identity = (model: Model<Api>) => `${model.provider}/${model.id}`;
const outputLimitSupported = (model: Model<Api>) =>
  model.api !== "openai-codex-responses";

function contextFor(
  input: z.infer<typeof piGenerationSchema>,
  model: Model<Api>,
): Context {
  const system: string[] = [];
  const messages: Context["messages"] = [];
  for (const message of input.messages) {
    if (message.role === "system") {
      if (messages.length)
        throw new Error("System messages must precede conversation messages");
      system.push(message.content);
    } else if (message.role === "user") {
      messages.push({ role: "user", content: message.content, timestamp: 0 });
    } else {
      messages.push({
        role: "assistant",
        content: [{ type: "text", text: message.content }],
        api: model.api,
        model: model.id,
        provider: model.provider,
        stopReason: "stop",
        timestamp: 0,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
    }
  }
  return { systemPrompt: system.join("\n\n"), messages, tools: [] };
}

export function createPiAiRuntime(
  create: (signal: AbortSignal) => Promise<Runtime> = async (signal) => {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    return ModelRuntime.create({ allowModelNetwork: false, signal });
  },
) {
  return {
    async models(signal: AbortSignal) {
      const runtime = await create(signal);
      return (await runtime.getAvailable(undefined, { signal })).map(
        (model) => ({
          id: identity(model),
          displayName: model.name,
          provider: model.provider,
          maxOutputTokens: outputLimitSupported(model),
        }),
      );
    },
    async generate(
      input: z.infer<typeof piGenerationSchema>,
      signal: AbortSignal,
    ) {
      if (
        input.temperature !== null ||
        input.reasoningEffort !== null ||
        input.serviceTier !== null
      )
        throw new Error("Unsupported generation option");
      signal.throwIfAborted();
      const runtime = await create(signal);
      const model = (await runtime.getAvailable(undefined, { signal })).find(
        (candidate) => identity(candidate) === input.model,
      );
      if (!model) throw new Error("The selected Pi model is unavailable");
      if (input.maxOutputTokens !== null && !outputLimitSupported(model))
        throw new Error("Output token limit is unsupported by this model");
      const result = await runtime.completeSimple(
        model,
        contextFor(input, model),
        {
          signal,
          timeoutMs: input.timeoutMs,
          maxRetries: 0,
          ...(input.maxOutputTokens === null
            ? {}
            : { maxTokens: input.maxOutputTokens }),
        },
      );
      signal.throwIfAborted();
      if (result.model !== model.id || result.provider !== model.provider)
        throw new Error("Provider returned a different model");
      if (result.stopReason !== "stop" && result.stopReason !== "length")
        throw new Error("Pi generation did not complete successfully");
      if (result.content.some((part) => part.type === "toolCall"))
        throw new Error("Tool calls are unsupported");
      return {
        text: result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
        model: input.model,
        actualModel: result.responseModel ?? null,
        actualServiceTier: null,
        finishReason: result.stopReason,
        usage:
          result.usage.totalTokens > 0
            ? {
                inputTokens:
                  result.usage.input +
                  result.usage.cacheRead +
                  result.usage.cacheWrite,
                outputTokens: result.usage.output,
                cachedInputTokens: result.usage.cacheRead,
              }
            : null,
      };
    },
  };
}
