import { randomUUID } from "node:crypto";
import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import {
  rpcContract,
  requestSchema,
  clientSchema,
  threadSchema,
} from "./src/contracts.js";
import { createService } from "./src/controller.js";
import { settingDescriptors, settingsSchema } from "./src/settings.js";
export default async function plugin(bb: BbPluginApi) {
  if (
    typeof bb.experimental_aiServices.experimental_generate !== "function" ||
    typeof bb.experimental_aiServices.experimental_models !== "function" ||
    typeof bb.experimental_userInstructions?.read !== "function"
  )
    throw new Error(
      "Prompt Suggestion requires a BB build with shared AI generation and owner instructions",
    );
  const handle = bb.settings.define(settingDescriptors);
  const normalize = (value: unknown) => {
    const parsed = settingsSchema.safeParse(value);
    return parsed.success ? parsed.data : settingsSchema.parse({});
  };
  let settings = normalize(await handle.get());
  const service = createService(bb, () => settings);
  handle.onChange((next) => {
    settings = normalize(next);
    service.reset();
  });
  bb.onDispose(() => service.dispose());
  for (const event of [
    "thread.active",
    "thread.idle",
    "thread.failed",
    "experimental_thread.events",
    "interaction.pending",
  ] as const)
    bb.events.on(event, ({ thread }) => service.wake(thread.id));
  for (const event of ["thread.archived", "thread.deleted"] as const)
    bb.events.on(event, ({ thread }) => service.clearCache(thread.id));
  for (const event of [
    "message.queued",
    "message.dispatched",
    "message.cancelled",
  ] as const)
    bb.events.on(event, ({ entry }) => service.wake(entry.threadId));
  const models = async (signal?: AbortSignal) =>
    (await bb.experimental_aiServices.experimental_models({ signal })).map(
      (model) => ({
        id: model.id,
        displayName: model.displayName,
        provider: model.provider,
        hostId: model.hostId,
        profile: model.profile,
        supportsOutputLimit: model.capabilities.maxOutputTokens,
        reasoningEfforts: [...model.capabilities.reasoningEfforts],
        serviceTiers: [...(model.capabilities.serviceTiers ?? [])],
      }),
    );
  bb.rpc.register(rpcContract, {
    models: (_input, ctx) => models(ctx.experimental_signal),
    selectModel: async (input, ctx) => {
      if (
        input.model &&
        !(await models(ctx.experimental_signal)).some(
          (model) => model.id === input.model,
        )
      )
        throw new Error("The selected model is no longer available");
      await handle.experimental_set({ model: input.model });
      return { model: input.model };
    },
    track: (input) => service.track(input.threadId, input.clientId),
    state: (input) => service.state(input.threadId),
    detach: (input) => service.detach(input.threadId, input.clientId),
    clearCache: (input) => {
      service.clearCache(input.threadId);
      return null;
    },
    inspect: (input) => service.inspect(input.threadId),
    suggest: (input, ctx) => service.suggest(input, ctx.experimental_signal),
    observe: (input) =>
      service.observe(input.requestId, input.event, input.observedToAttachMs),
    cancel: (input) => service.cancel(input.requestId, input.token),
    status: () => service.status(),
    diagnostics: () => service.diagnostics(),
  });
  bb.cli.register(
    defineCli({
      name: "prompt-suggestion",
      summary: "Suggest the next user message",
      description:
        "Prompt Suggestion generates a draft suggestion without sending or modifying a thread.",
      commands: {
        track: cliCommand({
          summary: "Track a thread for ten minutes without sending",
          options: {
            thread: {
              type: "string",
              required: true,
              description: "Thread ID",
            },
            client: { type: "string", description: "Client UUID" },
          },
          run: async (input) => {
            const args = clientSchema.parse({
              threadId: input.options.thread,
              clientId: input.options.client ?? randomUUID(),
            });
            const view = await service.track(args.threadId, args.clientId);
            service.detach(args.threadId, args.clientId);
            return { stdout: JSON.stringify(view), exitCode: 0 };
          },
        }),
        ...Object.fromEntries(
          (["state", "inspect", "clear-cache"] as const).map((method) => [
            method,
            cliCommand({
              summary:
                method === "inspect"
                  ? "Inspect task state and its sources"
                  : method === "state"
                    ? "Read current companion state"
                    : "Clear prepared data; retain admission history",
              options: {
                thread: {
                  type: "string",
                  required: true,
                  description: "Thread ID",
                },
              },
              run: async (input) => {
                const { threadId } = threadSchema.parse({
                  threadId: input.options.thread,
                });
                const result =
                  method === "state"
                    ? await service.state(threadId)
                    : method === "inspect"
                      ? service.inspect(threadId)
                      : (service.clearCache(threadId), null);
                return { stdout: JSON.stringify(result), exitCode: 0 };
              },
            }),
          ]),
        ),
        models: cliCommand({
          summary: "List available BB generation models",
          run: async () => ({
            stdout: JSON.stringify(await models()),
            exitCode: 0,
          }),
        }),
        status: cliCommand({
          summary: "Show configuration readiness",
          run: () => ({
            stdout: JSON.stringify(service.status()),
            exitCode: 0,
          }),
        }),
        diagnostics: cliCommand({
          summary: "Show session-only counters",
          run: () => ({
            stdout: JSON.stringify(service.diagnostics()),
            exitCode: 0,
          }),
        }),
        suggest: cliCommand({
          summary: "Generate once for an idle thread",
          options: {
            thread: {
              type: "string",
              required: true,
              description: "Thread ID",
            },
            request: {
              type: "string",
              description: "Optional request UUID for cancellation",
            },
            token: {
              type: "string",
              description: "Optional cancellation capability UUID",
            },
          },
          run: async (input) => ({
            stdout: JSON.stringify(
              await service.suggest(
                requestSchema.parse({
                  threadId: input.options.thread,
                  requestId: input.options.request ?? randomUUID(),
                  token: input.options.token ?? randomUUID(),
                  automatic: false,
                  expectedTurnId: null,
                }),
              ),
            ),
            exitCode: 0,
          }),
        }),
        cancel: cliCommand({
          summary: "Cancel a request using its capability",
          options: {
            request: {
              type: "string",
              required: true,
              description: "Request ID",
            },
            token: {
              type: "string",
              required: true,
              description: "Request cancellation capability",
            },
          },
          run: (input) => ({
            stdout: JSON.stringify({
              cancelled: service.cancel(
                input.options.request,
                input.options.token,
              ),
            }),
            exitCode: 0,
          }),
        }),
      },
    }),
  );
}
