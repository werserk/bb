import { z } from "zod";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  BodyError,
  chatResponse,
  chatSchema,
  generationRequest,
  readBoundedJson,
} from "./src/chat.js";
import { gatewayContract } from "./src/contracts.js";

export default function plugin(bb: BbPluginApi) {
  if (
    typeof bb.experimental_aiServices?.experimental_models !== "function" ||
    typeof bb.experimental_aiServices?.experimental_generate !== "function"
  ) {
    throw new Error(
      "AI Gateway requires a BB build with shared AI generation support. Update BB before enabling this plugin.",
    );
  }
  const lifetime = new AbortController();
  bb.onDispose(() => lifetime.abort());
  const signalFor = (signal?: AbortSignal) =>
    AbortSignal.any([
      lifetime.signal,
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ]);
  const models = (signal?: AbortSignal) =>
    bb.experimental_aiServices.experimental_models({
      signal: signalFor(signal),
    });
  const baseUrl = () =>
    new URL(
      "/api/v1/plugins/ai-gateway/http/v1",
      bb.server.experimental_appUrl ?? bb.server.loopbackBaseUrl,
    ).toString();
  bb.rpc.register(gatewayContract, {
    status: async (_input, context) => ({
      baseUrl: baseUrl(),
      models: await models(context.experimental_signal),
    }),
  });
  function failure(error: unknown): Response {
    const known = z
      .object({
        name: z.literal("AiGenerationError"),
        code: z.enum([
          "invalid_request",
          "unsupported",
          "unavailable",
          "busy",
          "cancelled",
          "timeout",
          "failed",
        ]),
      })
      .safeParse(error);
    const code = known.success
      ? known.data.code
      : error instanceof BodyError
        ? "invalid_request"
        : "failed";
    const status =
      error instanceof BodyError
        ? error.status
        : code === "invalid_request" || code === "unsupported"
          ? 400
          : code === "busy"
            ? 429
            : code === "timeout"
              ? 504
              : code === "unavailable"
                ? 503
                : code === "cancelled"
                  ? 408
                  : 502;
    const message =
      error instanceof BodyError
        ? error.message
        : known.success
          ? `Generation ${code}`
          : "Generation failed";
    return Response.json(
      {
        error: {
          message,
          type:
            status === 400 || status === 413
              ? "invalid_request_error"
              : "server_error",
          param: null,
          code,
        },
      },
      { status },
    );
  }
  bb.http.route(
    "GET",
    "/v1/models",
    async (context) => {
      try {
        return context.json({
          object: "list",
          data: (await models(context.req.raw.signal)).map((model) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: model.provider,
          })),
        });
      } catch (error) {
        return failure(error);
      }
    },
    { auth: "token" },
  );
  bb.http.route(
    "POST",
    "/v1/chat/completions",
    async (context) => {
      try {
        const signal = signalFor(context.req.raw.signal);
        const parsed = chatSchema.safeParse(
          await readBoundedJson(context.req.raw, signal),
        );
        if (!parsed.success)
          throw new BodyError(
            400,
            "Unsupported or invalid request. Use one non-streaming text completion with system, user or assistant messages; tools, images and other options are unsupported.",
          );
        const result = await bb.experimental_aiServices.experimental_generate(
          generationRequest(parsed.data),
          { signal },
        );
        return context.json(chatResponse(result));
      } catch (error) {
        return failure(error);
      }
    },
    { auth: "token" },
  );
  bb.cli.register(
    defineCli({
      name: "ai-gateway",
      summary: "Access connected BB text models",
      commands: {
        models: cliCommand({
          summary: "List supported models",
          run: async () => ({
            stdout: JSON.stringify(await models()),
            exitCode: 0,
          }),
        }),
        status: cliCommand({
          summary: "Show gateway URL and models",
          run: async () => ({
            stdout: JSON.stringify({
              baseUrl: baseUrl(),
              models: await models(),
            }),
            exitCode: 0,
          }),
        }),
        generate: cliCommand({
          summary: "Generate text with an explicitly selected model",
          options: {
            model: {
              type: "string",
              required: true,
              description: "Exact model ID from models",
            },
            "service-tier": {
              type: "string",
              description: "default, fast or priority; requires model support",
            },
            "reasoning-effort": {
              type: "string",
              description: "Exact reasoning effort advertised by the model",
            },
            prompt: {
              type: "string",
              required: true,
              stdin: true,
              description: "Prompt text; --prompt-stdin reads stdin",
            },
          },
          run: async (input) => {
            const request = chatSchema.parse({
              model: input.options.model,
              messages: [{ role: "user", content: input.options.prompt }],
              service_tier: input.options["service-tier"],
              reasoning_effort: input.options["reasoning-effort"],
            });
            const result =
              await bb.experimental_aiServices.experimental_generate(
                generationRequest(request),
                { signal: signalFor() },
              );
            return {
              stdout: JSON.stringify(chatResponse(result)),
              exitCode: 0,
            };
          },
        }),
      },
    }),
  );
}
