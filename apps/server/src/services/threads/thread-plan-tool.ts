import {
  getThread,
  hasStoredTurnStarted,
  listStoredTurnCompletedKeys,
} from "@bb/db";
import {
  turnScope,
  planIdentifierSchema,
  threadEventPlanStepSchema,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { appendThreadEventInTransaction } from "./thread-events.js";

const planInputSchema = z
  .object({
    planId: planIdentifierSchema.optional(),
    plan: z
      .array(
        z
          .object({
            id: planIdentifierSchema.optional(),
            step: z.string().trim().min(1).max(1000),
            status: z.enum(["pending", "in_progress", "completed", "failed"]),
            note: threadEventPlanStepSchema.shape.note,
            actor: threadEventPlanStepSchema.shape.actor,
          })
          .strict(),
      )
      .max(100)
      .refine(
        (steps) =>
          new Set(steps.flatMap((step) => (step.id ? [step.id] : []))).size ===
          steps.filter((step) => step.id).length,
        "Duplicate step IDs",
      ),
    explanation: z.string().max(4000).optional(),
  })
  .strict();

const presentation = {
  label: { pending: "Updating plan", completed: "Updated plan" },
  icon: { glyph: "ListTodo" as const },
  suppress: true,
};

const inputSchema = z.toJSONSchema(planInputSchema, { io: "input" });
delete inputSchema.$schema;

export const BB_UPDATE_PLAN_TOOL: DynamicTool = {
  name: "bb_update_plan",
  description:
    "Replace this thread's visible progress plan. Send the full list of steps with pending, in_progress, completed or failed status. Optional planId and step id preserve identity across updates (1-128 trimmed single-line characters; unique step IDs). Optional note describes the current action and actor tags the helper, both single-line. The plan stays visible after the turn until replaced; an empty plan clears the list. Use this tool unless a native plan/todo tool is available.",
  inputSchema,
  presentation,
};

export function handleUpdatePlanToolCall(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    threadId: string;
    turnId: string;
    providerThreadId: string;
    callId: string;
    input: unknown;
  },
): ToolCallResponse {
  const parsed = planInputSchema.safeParse(args.input);
  if (!parsed.success) {
    return {
      success: false,
      contentItems: [
        { type: "inputText", text: `Invalid plan: ${parsed.error.message}` },
      ],
    };
  }
  const sequence = deps.db.transaction(
    (tx) => {
      const thread = getThread(tx, args.threadId);
      if (
        !thread ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        !hasStoredTurnStarted(tx, args) ||
        listStoredTurnCompletedKeys(tx, { keys: [args] }).length > 0
      ) {
        return null;
      }
      return appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: args.providerThreadId,
        type: "item/completed",
        scope: turnScope(args.turnId),
        data: {
          providerThreadId: args.providerThreadId,
          item: {
            type: "planSteps",
            ...(parsed.data.planId ? { planId: parsed.data.planId } : {}),
            id: `plan:${args.turnId}:${args.callId}`,
            status: "completed",
            presentation,
            steps: parsed.data.plan.map(({ status, ...step }) => ({
              ...step,
              status: status === "in_progress" ? ("active" as const) : status,
            })),
            ...(parsed.data.explanation === undefined
              ? {}
              : { explanation: parsed.data.explanation }),
          },
        },
      });
    },
    { behavior: "immediate" },
  );
  if (sequence === null) {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: "Cannot update the plan for an unavailable thread or a missing/completed turn.",
        },
      ],
    };
  }
  deps.hub.notifyThread(args.threadId, ["events-appended"], {
    timelineSequence: sequence,
    eventTypes: ["item/completed"],
  });
  return {
    success: true,
    contentItems: [{ type: "inputText", text: "Plan updated" }],
  };
}
