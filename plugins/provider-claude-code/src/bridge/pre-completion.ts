import { experimental_PRE_COMPLETION_LIMITS as limits } from "@get-bb/plugin-sdk/provider-bridge";
import type { HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

/**
 * Provider-side activation is off unless the daemon (or the session
 * environment) sets BB_PRE_COMPLETION_HOOKS to 1 or true. With it off the
 * bridge does no config probe, hook install, restart or Stop round-trip.
 */
export const PRE_COMPLETION_HOOKS_ENV = "BB_PRE_COMPLETION_HOOKS";

export function preCompletionHooksEnabled(
  envVars?: Readonly<Record<string, string | undefined>>,
): boolean {
  const value =
    envVars?.[PRE_COMPLETION_HOOKS_ENV] ??
    process.env[PRE_COMPLETION_HOOKS_ENV];
  return value === "1" || value === "true";
}

const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow") }).passthrough(),
  z.object({
    action: z.literal("continue"),
    instruction: z.string().trim().min(1).max(limits.instructionLimit),
  }),
]);

export async function checkNativePreCompletion(args: {
  finalText: string;
  signal: AbortSignal;
  request: (input: {
    finalText: string;
    truncated: boolean;
  }) => Promise<{ content: string; isError?: boolean }>;
}): Promise<HookJSONOutput> {
  if (args.signal.aborted) return { continue: true };
  const controller = new AbortController();
  const signal = AbortSignal.any([args.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      args.request({
        finalText: args.finalText.slice(0, limits.finalTextLimit),
        truncated: args.finalText.length > limits.finalTextLimit,
      }),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        timer = setTimeout(() => controller.abort(), limits.bridgeDeadlineMs);
      }),
    ]);
    if (args.signal.aborted || response.isError) return { continue: true };
    const decision = decisionSchema.parse(JSON.parse(response.content));
    return decision.action === "continue"
      ? { decision: "block", reason: decision.instruction }
      : { continue: true };
  } catch {
    return { continue: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
