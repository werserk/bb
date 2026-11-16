import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { readContext } from "./context.js";
import { generate } from "./generate.js";
import type { Settings } from "./settings.js";

export function createService(bb: BbPluginApi, getSettings: () => Settings) {
  const active = new Map<
    string,
    { token: string; controller: AbortController }
  >();
  const attempted = new Set<string>();
  const observed = new Map<string, Set<string>>();
  let requests: number[] = [];
  let configRevision = 0;
  const counters = {
    requests: 0,
    suggestions: 0,
    none: 0,
    errors: 0,
    cancelled: 0,
    shown: 0,
    accepted: 0,
    dismissed: 0,
    lastLatencyMs: 0,
  };
  function reset() {
    for (const item of active.values()) item.controller.abort();
    attempted.clear();
    configRevision++;
  }
  async function suggest(
    input: {
      threadId: string;
      requestId: string;
      token: string;
      automatic: boolean;
      expectedTurnId: string | null;
    },
    callerSignal?: AbortSignal,
  ) {
    const settings = getSettings();
    if (!settings.enabled || !settings.model)
      return { kind: "unavailable" as const, reason: "not_configured" };
    if (active.size >= 1)
      return { kind: "unavailable" as const, reason: "busy" };
    const now = Date.now();
    requests = requests.filter((time) => now - time < 3600000);
    if (requests.length >= settings.maxRequestsPerHour)
      return { kind: "unavailable" as const, reason: "rate_limited" };
    const controller = new AbortController();
    active.set(input.requestId, { token: input.token, controller });
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(settings.timeoutMs),
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const revision = configRevision;
    try {
      const context = await readContext(
        bb,
        input.threadId,
        settings.contextCharLimit,
        signal,
      );
      if (
        !context ||
        (input.automatic && context.turnId !== input.expectedTurnId)
      )
        return { kind: "unavailable" as const, reason: "ineligible" };
      const projects = settings.projectIds
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (projects.length && !projects.includes(context.projectId))
        return { kind: "unavailable" as const, reason: "project_disabled" };
      const key = JSON.stringify([input.threadId, context.turnId, revision]);
      if (input.automatic && attempted.has(key))
        return { kind: "unavailable" as const, reason: "already_attempted" };
      if (signal.aborted || revision !== configRevision)
        return { kind: "unavailable" as const, reason: "cancelled" };
      attempted.add(key);
      if (attempted.size > 2048)
        attempted.delete(attempted.values().next().value!);
      requests.push(Date.now());
      counters.requests++;
      const began = Date.now();
      const result = await generate(
        bb.experimental_aiServices,
        settings,
        context.text,
        signal,
      );
      counters.lastLatencyMs = Date.now() - began;
      const current = await readContext(
        bb,
        input.threadId,
        settings.contextCharLimit,
        signal,
      );
      if (
        signal.aborted ||
        revision !== configRevision ||
        current?.revision !== context.revision
      )
        return { kind: "unavailable" as const, reason: "stale" };
      if (result.kind === "suggestion") {
        counters.suggestions++;
        observed.set(input.requestId, new Set());
        if (observed.size > 2048)
          observed.delete(observed.keys().next().value!);
      } else counters.none++;
      return result;
    } catch {
      if (signal.aborted) counters.cancelled++;
      else counters.errors++;
      return {
        kind: "unavailable" as const,
        reason: signal.aborted ? "cancelled" : "generation_failed",
      };
    } finally {
      active.delete(input.requestId);
    }
  }
  return {
    suggest,
    reset,
    observe(requestId: string, event: "shown" | "accepted" | "dismissed") {
      const seen = observed.get(requestId);
      if (!seen || seen.has(event)) return false;
      seen.add(event);
      counters[event]++;
      return true;
    },
    cancel(requestId: string, token: string) {
      const item = active.get(requestId);
      if (!item || item.token !== token) return false;
      item.controller.abort();
      return true;
    },
    status() {
      const s = getSettings();
      return {
        enabled: s.enabled,
        configured: !!s.model,
        model: s.model,
        active: active.size,
      };
    },
    diagnostics() {
      return { ...counters, scope: "current plugin session" };
    },
  };
}
