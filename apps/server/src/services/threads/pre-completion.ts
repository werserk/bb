import { toPendingInteraction } from "../interactions/pending-interaction-serialization.js";
import { and, eq } from "drizzle-orm";
import {
  getThread,
  hasStoredTurnStarted,
  listStoredTurnCompletedKeys,
  pluginKv,
  listPendingInteractionsByThread,
} from "@bb/db";
import {
  type PendingInteraction,
  BB_PRE_COMPLETION_TOOL_NAME,
  BB_PRE_COMPLETION_LIMITS,
  threadScope,
  turnScope,
  type ToolCallResponse,
} from "@bb/domain";
import type {
  PluginPreCompletionHandler,
  PluginPreCompletionGap,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { appendThreadEvent } from "./thread-events.js";

export const PRE_COMPLETION_TOOL_NAME = BB_PRE_COMPLETION_TOOL_NAME;
const guardNamespace = "__bb_pre_completion_v1__";
const policies = new Map<
  string,
  { pluginId: string; handler: PluginPreCompletionHandler }
>();
const inputSchema = z
  .object({
    finalText: z.string().min(1).max(BB_PRE_COMPLETION_LIMITS.finalTextLimit),
    truncated: z.boolean(),
  })
  .strict();
const decisionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("allow") }).strict(),
  z
    .object({
      action: z.literal("continue"),
      instruction: z
        .string()
        .trim()
        .min(1)
        .max(BB_PRE_COMPLETION_LIMITS.instructionLimit),
    })
    .strict(),
]);

export function setPreCompletionPolicy(
  pluginId: string,
  threadId: string,
  handler: PluginPreCompletionHandler | null,
): void {
  if (handler !== null && typeof handler !== "function")
    throw new Error("A policy handler is required");
  if (!threadId.trim()) throw new Error("A thread ID is required");
  const existing = policies.get(threadId);
  if (existing && existing.pluginId !== pluginId)
    throw new Error("Pre-completion policy is already owned by another plugin");
  if (handler === null) policies.delete(threadId);
  else policies.set(threadId, { pluginId, handler });
}

export function clearPreCompletionPolicies(pluginId: string): void {
  for (const [threadId, policy] of policies)
    if (policy.pluginId === pluginId) policies.delete(threadId);
}

type PreCompletionDeps = Pick<AppDeps, "db" | "hub" | "providerRegistry">;
type PreCompletionArgs = {
  threadId: string;
  providerThreadId: string;
  turnId?: string;
  turnOrigin?: "provider" | "arrival";
  input: unknown;
  signal: AbortSignal;
};
type PreCompletionResult = {
  action: "allow" | "continue";
  reason?: string;
  gap?: PluginPreCompletionGap;
  instruction?: string;
};
function toolResponse(value: PreCompletionResult): ToolCallResponse {
  return {
    success: true,
    contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
  };
}
export async function checkPreCompletion(
  deps: PreCompletionDeps,
  args: PreCompletionArgs,
): Promise<ToolCallResponse> {
  try {
    return await evaluatePreCompletion(deps, args);
  } catch {
    return toolResponse({ action: "allow", gap: "observation_unavailable" });
  }
}
function observePreCompletion(
  deps: PreCompletionDeps,
  args: PreCompletionArgs,
  value: PreCompletionResult,
): ToolCallResponse {
  const thread = getThread(deps.db, args.threadId);
  if (thread) {
    appendThreadEvent(deps, {
      threadId: args.threadId,
      environmentId: thread.environmentId,
      providerThreadId: args.providerThreadId,
      type: "system/operation",
      scope:
        args.turnId &&
        args.turnOrigin === "provider" &&
        hasStoredTurnStarted(deps.db, {
          threadId: args.threadId,
          turnId: args.turnId,
        })
          ? turnScope(args.turnId)
          : threadScope(),
      data: {
        operation: "pre_completion",
        status: value.gap ? "coverage_gap" : value.action,
        message: "Pre-completion policy observation",
        operationId:
          args.turnId && args.turnOrigin === "provider"
            ? `pre-completion:${args.turnId}`
            : "pre-completion:unbound",
        metadata: {
          version: 1,
          action: value.action,
          ...(value.gap ? { gap: value.gap } : {}),
          ...(value.reason ? { reason: value.reason } : {}),
        },
      },
    });
  }
  return toolResponse(value);
}
// Codex raises its model questions through the host-native provider-codex
// async-question renderer, a plugin-origin interaction rather than a
// user_question. Origin, payload shape and thread provider must all match;
// approvals, other plugins' forms and other renderers never count.
// Mirrors plugins/provider-codex extension-kinds.ts codexAsyncQuestionSchema,
// the shape its renderer displays (the server has no dependency on the plugin
// package): trimmed non-empty title, options absent, null or a non-empty array
// of trimmed non-empty strings.
const codexAsyncQuestionDataSchema = z.object({
  questions: z
    .array(
      z.object({
        title: z.string().trim().min(1),
        options: z.array(z.string().trim().min(1)).min(1).nullable().optional(),
      }),
    )
    .min(1),
});
function isNativeUserQuestion(
  interaction: PendingInteraction,
  providerPluginId: string | null,
): boolean {
  if (interaction.payload.kind === "user_question") return true;
  const origin = interaction.origin;
  return (
    origin?.kind === "plugin" &&
    origin.pluginId === "provider-codex" &&
    origin.pluginId === providerPluginId &&
    origin.rendererId === "async-question" &&
    interaction.payload.kind === "plugin" &&
    codexAsyncQuestionDataSchema.safeParse(interaction.payload.data).success
  );
}
async function evaluatePreCompletion(
  deps: PreCompletionDeps,
  args: PreCompletionArgs,
): Promise<ToolCallResponse> {
  const policy = policies.get(args.threadId);
  const thread = getThread(deps.db, args.threadId);
  const reply = (value: PreCompletionResult) =>
    policy ? observePreCompletion(deps, args, value) : toolResponse(value);
  if (!policy) return reply({ action: "allow", reason: "disabled" });
  const parsed = inputSchema.safeParse(args.input);
  if (!parsed.success) return reply({ action: "allow", gap: "invalid_input" });
  if (
    !thread ||
    !args.turnId ||
    args.turnOrigin !== "provider" ||
    !hasStoredTurnStarted(deps.db, {
      threadId: args.threadId,
      turnId: args.turnId,
    })
  )
    return reply({ action: "allow", gap: "missing_identity" });
  const turnId = args.turnId;
  const providerPluginId =
    deps.providerRegistry.get(thread.providerId)?.pluginId ?? null;
  const ended = () =>
    args.signal.aborted ||
    !getThread(deps.db, thread.id) ||
    getThread(deps.db, thread.id)?.status !== "active" ||
    listStoredTurnCompletedKeys(deps.db, {
      keys: [{ threadId: thread.id, turnId }],
    }).length > 0;
  if (ended()) return reply({ action: "allow", reason: "ended" });
  const key = JSON.stringify([thread.id, turnId]);
  const corrected = () =>
    deps.db
      .select({ key: pluginKv.key })
      .from(pluginKv)
      .where(and(eq(pluginKv.pluginId, guardNamespace), eq(pluginKv.key, key)))
      .get() !== undefined;
  if (corrected())
    return reply({ action: "allow", reason: "already_corrected" });
  const pending = () =>
    listPendingInteractionsByThread(deps.db, {
      threadId: thread.id,
      statuses: ["pending", "resolving"],
    })
      .map(toPendingInteraction)
      .filter((i) => isNativeUserQuestion(i, providerPluginId))
      .map((i) => i.id);
  let pendingUserQuestionIds: string[];
  try {
    pendingUserQuestionIds = pending();
  } catch {
    return reply({ action: "allow", gap: "pending_questions_unavailable" });
  }
  if (pendingUserQuestionIds.length)
    return reply({ action: "allow", reason: "pending_question" });
  const controller = new AbortController();
  const signal = AbortSignal.any([args.signal, controller.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(() =>
        policy.handler({
          projectId: thread.projectId,
          threadId: thread.id,
          turnId,
          turnOrigin: "provider",
          providerId: thread.providerId,
          ...parsed.data,
          pendingUserQuestionIds,
          correctionAttempt: 0,
          signal,
        }),
      ),
      new Promise<never>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        timer = setTimeout(
          () => controller.abort(),
          BB_PRE_COMPLETION_LIMITS.deadlineMs,
        );
      }),
    ]);
    const decision = decisionSchema.parse(value);
    if (ended()) return reply({ action: "allow", reason: "ended" });
    if (policies.get(thread.id) !== policy)
      return reply({ action: "allow", gap: "policy_unavailable" });
    if (decision.action === "allow") return reply(decision);
    let admission:
      | "ended"
      | "pending_question"
      | "questions_unavailable"
      | "already_corrected"
      | "reserved";
    try {
      admission = deps.db.transaction(
        (tx) => {
          if (ended()) return "ended" as const;
          try {
            if (pending().length) return "pending_question" as const;
          } catch {
            return "questions_unavailable" as const;
          }
          const claimed = tx
            .insert(pluginKv)
            .values({
              pluginId: guardNamespace,
              key,
              value: "1",
              updatedAt: Date.now(),
            })
            .onConflictDoNothing()
            .returning({ key: pluginKv.key })
            .get();
          return claimed
            ? ("reserved" as const)
            : ("already_corrected" as const);
        },
        { behavior: "immediate" },
      );
    } catch {
      return reply({ action: "allow", gap: "durable_guard_unavailable" });
    }
    if (admission === "questions_unavailable")
      return reply({ action: "allow", gap: "pending_questions_unavailable" });
    return reply(
      admission === "reserved"
        ? decision
        : { action: "allow", reason: admission },
    );
  } catch {
    return reply(
      args.signal.aborted
        ? { action: "allow", reason: "ended" }
        : {
            action: "allow",
            gap: controller.signal.aborted ? "policy_timeout" : "policy_failed",
          },
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
