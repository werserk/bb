import {
  getThread,
  hasStoredTurnStarted,
  listStoredTurnCompletedKeys,
} from "@bb/db";
import { turnScope, type DynamicTool, type ToolCallResponse } from "@bb/domain";
import { z } from "zod";
import type { AppDeps } from "../../types.js";
import { appendThreadEventInTransaction } from "./thread-events.js";

const planInputSchema = z
  .object({
    plan: z
      .array(
        z
          .object({
            step: z.string().trim().min(1).max(1000),
            status: z.enum(["pending", "in_progress", "completed"]),
          })
          .strict(),
      )
      .max(100),
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
    "Replace this thread's visible progress plan. Send the full list of steps with pending, in_progress or completed status. An empty plan clears the list. Use this tool unless a native plan/todo tool is available.",
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
            id: `plan:${args.turnId}:${args.callId}`,
            status: "completed",
            presentation,
            steps: parsed.data.plan.map(({ step, status }) => ({
              step,
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
