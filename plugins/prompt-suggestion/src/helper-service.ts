import {
  experimental_AiGenerationError,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { readContext } from "./context.js";
import { textRevision } from "./context-input.js";
import type { createCoordinator } from "./coordinator.js";
import { generateHelper, IncompleteGenerationError } from "./generate.js";
import {
  helperRequestSchema,
  validProtectedMentions,
  type HelperRequest,
  type HelperResponse,
} from "./helper.js";
import { instructionBundle } from "./instruction-bundle.js";
import type { Settings } from "./settings.js";

export function createHelperService(
  bb: BbPluginApi,
  getSettings: () => Settings,
  coordinator: ReturnType<typeof createCoordinator>,
) {
  const active = new Map<
    string,
    { token: string; threadId: string; controller: AbortController }
  >();
  let disposed = false;
  let revision = 0;
  async function prepare(threadId: string, signal?: AbortSignal) {
    const settings = getSettings();
    if (disposed || !settings.model) return null;
    const bundle = instructionBundle(bb, settings.instructions, "helper");
    if (!bundle) return null;
    const context = await readContext(
      bb,
      threadId,
      settings.contextCharLimit,
      signal,
      {
        allowActive: true,
        helper: true,
        memory: coordinator.inspect(threadId),
      },
    );
    if (!context || signal?.aborted) return null;
    const projects = settings.projectIds
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (projects.length && !projects.includes(context.projectId)) return null;
    return {
      settings,
      bundle,
      context,
      revision: textRevision(
        JSON.stringify([
          revision,
          context.revision,
          context.text,
          bundle.revision,
          settings,
        ]),
      ),
    };
  }
  const unavailable = (reason: string): HelperResponse => ({
    kind: "unavailable",
    reason,
  });
  return {
    async context(threadId: string, signal?: AbortSignal) {
      return {
        revision:
          (await prepare(threadId, signal).catch(() => null))?.revision ?? null,
      };
    },
    async generate(
      input: HelperRequest,
      callerSignal?: AbortSignal,
    ): Promise<HelperResponse> {
      const parsed = helperRequestSchema.safeParse(input);
      if (!parsed.success) return unavailable("invalid_input");
      if (disposed || callerSignal?.aborted) return unavailable("cancelled");
      if (active.has(input.requestId)) return unavailable("duplicate_request");
      if (!getSettings().model) return unavailable("not_configured");
      const lease = coordinator.beginHelper(input.requestId);
      if (!lease) return unavailable("busy");
      const controller = new AbortController();
      active.set(input.requestId, {
        token: input.token,
        threadId: input.threadId,
        controller,
      });
      const deadline = AbortSignal.timeout(getSettings().timeoutMs);
      const signal = AbortSignal.any([
        controller.signal,
        deadline,
        ...(callerSignal ? [callerSignal] : []),
      ]);
      let outcome: HelperResponse = unavailable("generation_failed");
      try {
        const prepared = await prepare(input.threadId, signal);
        if (!prepared)
          return (outcome = unavailable(
            signal.aborted ? "cancelled" : "ineligible",
          ));
        if (
          input.expectedContextRevision !== null &&
          prepared.revision !== input.expectedContextRevision
        )
          return (outcome = unavailable("stale"));
        if (!input.draft.trim() && prepared.context.messages.length === 0)
          return (outcome = {
            kind: "none",
            contextRevision: prepared.revision,
          });
        if (!lease.admit()) return (outcome = unavailable("rate_limited"));
        const result = await generateHelper(
          bb.experimental_aiServices,
          {
            ...prepared.settings,
            instructions: prepared.bundle.content,
            outputTokenLimit: 0,
            responseByteLimit: 262144,
          },
          JSON.stringify({
            conversation: prepared.context.text,
            unsentDraft: input.draft,
            protectedMentions: input.protectedMentions,
          }),
          signal,
        );
        if (
          result.kind === "helper" &&
          (!validProtectedMentions(result.text, input.protectedMentions) ||
            result.advice?.includes("<<BB_MENTION_"))
        )
          return (outcome = unavailable("invalid_mentions"));
        const current = await prepare(input.threadId, signal);
        if (signal.aborted)
          return (outcome = unavailable(
            deadline.aborted ? "timeout" : "cancelled",
          ));
        if (!current || current.revision !== prepared.revision)
          return (outcome = unavailable("stale"));
        return (outcome = { ...result, contextRevision: prepared.revision });
      } catch (error) {
        return (outcome = unavailable(
          deadline.aborted
            ? "timeout"
            : signal.aborted
              ? "cancelled"
              : error instanceof IncompleteGenerationError
                ? error.code
                : error instanceof experimental_AiGenerationError &&
                    error.code === "busy"
                  ? "busy"
                  : "generation_failed",
        ));
      } finally {
        active.delete(input.requestId);
        lease.finish(outcome.kind, signal.aborted && !deadline.aborted);
      }
    },
    has(requestId: string) {
      return active.has(requestId);
    },
    cancel(requestId: string, token: string) {
      const request = active.get(requestId);
      if (!request || request.token !== token) return false;
      request.controller.abort();
      return true;
    },
    clear(threadId: string) {
      for (const request of active.values())
        if (request.threadId === threadId) request.controller.abort();
    },
    reset() {
      revision++;
      for (const request of active.values()) request.controller.abort();
    },
    dispose() {
      disposed = true;
      for (const request of active.values()) request.controller.abort();
    },
  };
}
