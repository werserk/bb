import { createHmac, randomBytes } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readContext } from "./context.js";
import { generate, generateMemory } from "./generate.js";
import { instructionBundle } from "./instruction-bundle.js";
import { createCoordinator } from "./coordinator.js";
import type { Settings } from "./settings.js";

export function createService(bb: BbPluginApi, getSettings: () => Settings) {
  const salt = randomBytes(32);
  const manual = new Map<string, { token: string; threadId: string }>();
  const observed = new Map<string, Set<string>>();
  const counters = { shown: 0, accepted: 0, dismissed: 0 };
  let lastAttachment: { jobId: string; observedToAttachMs: number } | null =
    null;
  let configRevision = 0;
  let affinity: { model: string; supported: boolean } | null = null;
  const coordinator = createCoordinator({
    configuration: getSettings,
    changed: (threadId) =>
      bb.rpc.experimental_invalidate([`companion:${threadId}`]),
    async prepare(threadId, memory, signal) {
      const settings = getSettings();
      if (!settings.enabled || !settings.model) return null;
      const bundle = instructionBundle(bb, settings.instructions);
      const memoryBundle = instructionBundle(bb, settings.instructions, "memory");
      if (!bundle || !memoryBundle) return null;
      const context = await readContext(
        bb,
        threadId,
        settings.contextCharLimit,
        signal,
        { allowActive: true, memory },
      );
      if (!context) return null;
      const projects = settings.projectIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (projects.length && !projects.includes(context.projectId)) return null;
      return {
        context,
        instructions: bundle.content,
        memoryInstructions: memoryBundle.content,
        memoryInstructionRevision: memoryBundle.revision,
        instructionRevision: bundle.revision,
        configKey: JSON.stringify([configRevision, settings]),
      };
    },
    async generateMemory(_threadId, prepared, signal) {
      const settings = getSettings();
      return generateMemory(bb.experimental_aiServices, { ...settings, instructions: prepared.memoryInstructions, outputTokenLimit: settings.memoryOutputTokenLimit }, prepared.context.text, signal);
    },
    async generate(threadId, prepared, signal, measured) {
      const settings = getSettings();
      if (affinity?.model !== settings.model) {
        const models = await bb.experimental_aiServices.experimental_models({
          signal,
        });
        affinity = {
          model: settings.model,
          supported:
            models.find((model) => model.id === settings.model)?.capabilities
              .experimental_sessionAffinity === true,
        };
      }
      const sessionAffinity = affinity.supported
        ? createHmac("sha256", salt)
            .update(
              JSON.stringify([
                bb.pluginId,
                threadId,
                settings.model,
                prepared.configKey,
                prepared.instructionRevision,
              ]),
            )
            .digest("hex")
        : null;
      return generate(
        bb.experimental_aiServices,
        { ...settings, instructions: prepared.instructions, sessionAffinity },
        prepared.context.text,
        signal,
        measured,
      );
    },
  });
  const rememberView = async (threadId: string) => {
    const view = await coordinator.state(threadId);
    if (view.jobId && view.phase === "ready" && !observed.has(view.jobId)) {
      observed.set(view.jobId, new Set());
      if (observed.size > 2048) observed.delete(observed.keys().next().value!);
    }
    return view;
  };
  return {
    async track(threadId: string, clientId: string) {
      await coordinator.track(threadId, clientId);
      return rememberView(threadId);
    },
    state: rememberView,
    detach: coordinator.detach,
    clearCache: coordinator.clearCache,
    inspect: coordinator.inspect,
    wake: coordinator.wake,
    dispose: coordinator.dispose,
    reset() {
      configRevision++;
      affinity = null;
      coordinator.reset();
    },
    async suggest(
      input: {
        threadId: string;
        requestId: string;
        token: string;
        automatic: boolean;
        expectedTurnId: string | null;
      },
      callerSignal?: AbortSignal,
    ) {
      if (input.automatic) {
        const current = await readContext(
          bb,
          input.threadId,
          getSettings().contextCharLimit,
          callerSignal,
        );
        if (current?.turnId !== input.expectedTurnId)
          return { kind: "unavailable" as const, reason: "ineligible" };
      }
      if (callerSignal?.aborted)
        return { kind: "unavailable" as const, reason: "cancelled" };
      if (manual.has(input.requestId))
        return { kind: "unavailable" as const, reason: "duplicate_request" };
      manual.set(input.requestId, {
        token: input.token,
        threadId: input.threadId,
      });
      const detach = () => coordinator.detach(input.threadId, input.requestId);
      callerSignal?.addEventListener("abort", detach, { once: true });
      try {
        const result = await coordinator.suggest(
          input.threadId,
          input.requestId,
          input.automatic ? input.expectedTurnId : null,
        );
        if (result.kind === "suggestion")
          observed.set(input.requestId, new Set());
        if (observed.size > 2048)
          observed.delete(observed.keys().next().value!);
        return callerSignal?.aborted
          ? { kind: "unavailable" as const, reason: "cancelled" }
          : result;
      } finally {
        callerSignal?.removeEventListener("abort", detach);
        manual.delete(input.requestId);
        detach();
      }
    },
    cancel(requestId: string, token: string) {
      const item = manual.get(requestId);
      return (
        !!item &&
        item.token === token &&
        coordinator.cancel(item.threadId, requestId)
      );
    },
    observe(
      requestId: string,
      event: "shown" | "accepted" | "dismissed",
      observedToAttachMs: number | null = null,
    ) {
      const seen = observed.get(requestId);
      if (!seen || seen.has(event)) return false;
      seen.add(event);
      counters[event]++;
      if (event === "shown" && observedToAttachMs !== null)
        lastAttachment = { jobId: requestId, observedToAttachMs };
      return true;
    },
    status() {
      const settings = getSettings();
      const bundle = instructionBundle(bb, settings.instructions);
      return {
        enabled: settings.enabled,
        configured: !!settings.model,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        serviceTier: settings.serviceTier,
        backgroundPreparation: settings.backgroundPreparation,
        instructionsAvailable: bundle !== null,
        instructionRevision: bundle?.ownerRevision ?? null,
        active: coordinator.diagnostics().active,
        tracked: coordinator.diagnostics().tracked,
      };
    },
    diagnostics() {
      return { ...coordinator.diagnostics(), ...counters, lastAttachment };
    },
  };
}
