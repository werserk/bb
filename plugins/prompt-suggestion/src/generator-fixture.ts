import type {
  BbPluginApi,
  experimental_AiGenerationRequest,
} from "@get-bb/plugin-sdk";

export async function installGenerator(
  bb: BbPluginApi,
  generate: (
    request: experimental_AiGenerationRequest,
    signal: AbortSignal,
  ) => Promise<string>,
  finishReason: "stop" | "length" = "stop",
) {
  bb.experimental_aiServices.register({
    id: "fixture",
    displayName: "Fixture",
    experimental_text: {
      models: async () => [
        {
          id: "fixture-model",
          displayName: "Fixture model",
          provider: "Fixture",
          hostId: "fixture-host",
          profile: "default",
          capabilities: {
            maxOutputTokens: true,
            temperature: false,
            reasoningEfforts: [],
          },
        },
      ],
      generate: async (request, options) => ({
        text: await generate(request, options.signal),
        model: request.model,
        actualModel: null,
        finishReason,
        usage: null,
      }),
    },
  });
  const model = (await bb.experimental_aiServices.experimental_models())[0];
  if (!model) throw new Error("Missing fixture model");
  return model.id;
}
