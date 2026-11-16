import { z } from "zod";
import {
  experimental_AI_MODEL_ID_MAX_LENGTH,
  experimental_AiGenerationError as Failure,
  type experimental_AiGenerationRequest,
  type experimental_AiGenerationResult,
  type experimental_AiModel,
} from "../ai-generation.js";
import type { NormalizedPluginAiService } from "./host-policy.js";

type Service = NormalizedPluginAiService & { pluginId: string };
const modelSchema = z
  .object({
    id: z.string().min(1).max(512),
    displayName: z.string().min(1).max(256),
    provider: z.string().min(1).max(256),
    hostId: z.string().min(1).max(256),
    profile: z.string().min(1).max(256),
    capabilities: z
      .object({
        experimental_sessionAffinity: z.boolean().default(false),
        maxOutputTokens: z.boolean(),
        temperature: z.boolean(),
        reasoningEfforts: z.array(z.string().min(1).max(64)).max(32),
        serviceTiers: z.array(z.string().min(1).max(64)).max(32).default([]),
      })
      .strict(),
  })
  .strict();
const requestSchema = z
  .object({
    model: z.string().min(1).max(experimental_AI_MODEL_ID_MAX_LENGTH),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["system", "user", "assistant"]),
            content: z.string(),
          })
          .strict(),
      )
      .min(1)
      .max(256),
    maxOutputTokens: z.number().int().min(1).max(131072).nullable(),
    temperature: z.number().min(0).max(2).nullable(),
    reasoningEffort: z.string().min(1).max(64).nullable(),
    serviceTier: z.string().min(1).max(64).nullable().default(null),
    experimental_sessionAffinity: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .nullable()
      .default(null),
    timeoutMs: z.number().int().min(100).max(60000),
  })
  .strict();
const usageNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const resultSchema = z
  .object({
    text: z.string(),
    model: z.string().min(1),
    actualModel: z.string().min(1).max(512).nullable(),
    actualServiceTier: z.string().min(1).max(64).nullable().default(null),
    finishReason: z.enum(["stop", "length"]),
    usage: z
      .object({
        inputTokens: usageNumber,
        outputTokens: usageNumber,
        cachedInputTokens: usageNumber.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const key = (s: Service) => `${s.pluginId}/${s.id}`;
const qualified = (s: Service, m: experimental_AiModel) =>
  `${key(s)}/${encodeURIComponent(m.hostId)}/${encodeURIComponent(m.profile)}/${encodeURIComponent(m.id)}`;

export function createAiGenerationDispatcher(list: () => readonly Service[]) {
  const active = new Map<AbortController, string>();
  let slots = 0;

  async function bounded<T>(
    owner: string,
    signal: AbortSignal | undefined,
    timeoutMs: number,
    work: (signal: AbortSignal) => Promise<T>,
    sanitize = true,
  ): Promise<T> {
    if (signal?.aborted)
      throw new Failure(
        signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        "AI request ended before dispatch",
      );
    if (slots >= 4) throw new Failure("busy", "AI generation is busy");
    slots++;
    const controller = new AbortController();
    active.set(controller, owner);
    const cancel = () =>
      controller.abort(
        signal?.reason?.name === "TimeoutError"
          ? new Failure("timeout", "AI request timed out")
          : new Failure("cancelled", "Generation was cancelled"),
      );
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Failure("timeout", "AI request timed out")),
      timeoutMs,
    );
    let rejectAbort: ((reason: Failure) => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () =>
      rejectAbort?.(
        controller.signal.reason instanceof Failure
          ? controller.signal.reason
          : new Failure("cancelled", "Generation was cancelled"),
      );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const pending = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted();
        return work(controller.signal);
      })
      .finally(() => {
        slots--;
        active.delete(controller);
      });
    try {
      return await Promise.race([pending, aborted]);
    } catch (error) {
      if (error instanceof Failure || !sanitize) throw error;
      throw new Failure("failed", "AI service request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async function entries(signal?: AbortSignal, owner?: string) {
    if (signal?.aborted)
      throw new Failure(
        signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        "AI request ended before dispatch",
      );
    const found: {
      service: Service;
      native: z.infer<typeof modelSchema>;
      model: z.infer<typeof modelSchema>;
    }[] = [];
    for (const service of list()) {
      if (
        !service.experimental_text ||
        (owner !== undefined && key(service) !== owner)
      )
        continue;
      try {
        const models = await bounded(key(service), signal, 10000, (s) =>
          service.experimental_text!.models({ signal: s }),
        );
        if (!list().includes(service)) continue;
        const parsed = z.array(modelSchema).max(2048).parse(models);
        const ids = new Set<string>();
        for (const native of parsed) {
          const id = qualified(service, native);
          if (id.length > experimental_AI_MODEL_ID_MAX_LENGTH)
            throw new Failure(
              "failed",
              "Qualified model identity exceeds the shared limit",
            );
          if (ids.has(id))
            throw new Failure("failed", "Duplicate model identity");
          ids.add(id);
        }
        found.push(
          ...parsed.map((native) => ({
            service,
            native,
            model: { ...native, id: qualified(service, native) },
          })),
        );
      } catch (error) {
        if (
          signal?.aborted ||
          (error instanceof Failure && error.code === "busy")
        )
          throw error;
      }
    }
    return found;
  }

  return {
    async models(
      options: { signal?: AbortSignal } = {},
    ): Promise<experimental_AiModel[]> {
      const signal = AbortSignal.any([
        AbortSignal.timeout(10000),
        ...(options.signal ? [options.signal] : []),
      ]);
      return (await entries(signal)).map((item) => item.model);
    },
    async generate(
      input: experimental_AiGenerationRequest,
      options: { signal?: AbortSignal } = {},
    ): Promise<experimental_AiGenerationResult> {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success || byteLength(JSON.stringify(input)) > 262144)
        throw new Failure(
          "invalid_request",
          "Invalid or oversized generation request",
        );
      const request = parsed.data;
      const conversationStart = request.messages.findIndex(
        (message) => message.role !== "system",
      );
      if (
        conversationStart !== -1 &&
        request.messages
          .slice(conversationStart)
          .some((message) => message.role === "system")
      ) {
        throw new Failure(
          "unsupported",
          "System messages must precede conversation messages",
        );
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(request.timeoutMs),
        ...(options.signal ? [options.signal] : []),
      ]);
      const selected = (
        await entries(signal, request.model.split("/").slice(0, 2).join("/"))
      ).find((item) => item.model.id === request.model);
      if (!selected)
        throw new Failure("unavailable", "Selected model is unavailable");
      const { service, native } = selected;
      if (
        (request.experimental_sessionAffinity !== null &&
          !native.capabilities.experimental_sessionAffinity) ||
        (request.maxOutputTokens !== null &&
          !native.capabilities.maxOutputTokens) ||
        (request.temperature !== null && !native.capabilities.temperature) ||
        (request.serviceTier !== null &&
          !native.capabilities.serviceTiers.includes(request.serviceTier)) ||
        (request.reasoningEffort !== null &&
          !native.capabilities.reasoningEfforts.includes(
            request.reasoningEffort,
          ))
      )
        throw new Failure(
          "unsupported",
          "Selected model does not support the requested options",
        );
      return bounded(
        key(service),
        signal,
        request.timeoutMs,
        async (signal) => {
          if (!list().includes(service) || !service.experimental_text)
            throw new Failure("unavailable", "Selected service is unavailable");
          const raw = await service.experimental_text.generate(
            { ...request, model: native.id },
            { signal, model: native },
          );
          const result = resultSchema.parse(raw);
          if (!list().includes(service))
            throw new Failure("unavailable", "Selected service was replaced");
          if (result.model !== native.id || byteLength(result.text) > 1048576)
            throw new Failure(
              "failed",
              "AI service returned an invalid result",
            );
          if (
            result.usage?.cachedInputTokens != null &&
            result.usage.cachedInputTokens > result.usage.inputTokens
          )
            throw new Failure("failed", "AI service returned invalid usage");
          return { ...result, model: request.model };
        },
      );
    },
    complete(
      service: Service,
      prompt: string,
      signal: AbortSignal,
    ): Promise<string> {
      return bounded(
        key(service),
        signal,
        60000,
        async (current) => {
          if (!list().includes(service) || !service.complete)
            throw new Failure("unavailable", "AI service is unavailable");
          if (byteLength(prompt) > 262144)
            throw new Failure("invalid_request", "Prompt is too large");
          const text = await service.complete(prompt, { signal: current });
          if (typeof text !== "string" || byteLength(text) > 1048576)
            throw new Failure(
              "failed",
              "AI service returned an invalid result",
            );
          return text;
        },
        false,
      );
    },
    invalidate(owner: string) {
      for (const [controller, id] of active)
        if (id === owner)
          controller.abort(
            new Failure("unavailable", "AI service was unloaded"),
          );
    },
  };
}
