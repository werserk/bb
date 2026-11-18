import type { HookCallback } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadEventPlanStep } from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";
import {
  BB_BRIDGE_MCP_SERVER_NAME,
  todoWritePlanSteps,
} from "../tool-classification.js";

const BB_UPDATE_PLAN_TOOL_NAME = `mcp__${BB_BRIDGE_MCP_SERVER_NAME}__bb_update_plan`;
const TODO_WRITE_TOOL_NAME = "TodoWrite";

export const PLAN_TURN_CHECK_REASON =
  "Your plan still has open steps. Update it now with your plan tool: mark finished steps completed, and if you are waiting on the user or another agent keep exactly that one step in_progress. Then finish.";

const bbPlanInputSchema = z
  .object({
    plan: z.array(
      z
        .object({
          step: z.string(),
          status: z.enum(["pending", "in_progress", "completed", "failed"]),
        })
        .passthrough(),
    ),
  })
  .passthrough();

function planStepsOf(
  toolName: string,
  toolInput: unknown,
): ThreadEventPlanStep[] | null {
  if (toolName === TODO_WRITE_TOOL_NAME) {
    return todoWritePlanSteps(toolInput);
  }
  if (toolName !== BB_UPDATE_PLAN_TOOL_NAME) {
    return null;
  }
  const parsed = bbPlanInputSchema.safeParse(toolInput);
  if (!parsed.success) {
    return null;
  }
  return parsed.data.plan.map(({ step, status }) => ({
    step,
    status: status === "in_progress" ? "active" : status,
  }));
}

export interface PlanTurnCheck {
  recordPlan: HookCallback;
  checkPlan: HookCallback;
}

export interface PlanTurnCheckOptions {
  hasOpenBackgroundTasks?: () => boolean;
}

function isPlanOpen(plan: readonly ThreadEventPlanStep[]): boolean {
  let active = 0;
  for (const step of plan) {
    if (step.status === "active") {
      active += 1;
    } else if (step.status !== "completed" && step.status !== "failed") {
      return true;
    }
  }
  return active > 1;
}

export function buildPlanTurnCheck(
  options: PlanTurnCheckOptions = {},
): PlanTurnCheck {
  let latestPlan: ThreadEventPlanStep[] = [];
  let askedPromptId: string | undefined;

  const recordPlan: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse" || input.agent_id) {
      return { continue: true };
    }
    const steps = planStepsOf(input.tool_name, input.tool_input);
    if (steps !== null) {
      latestPlan = steps;
    }
    return { continue: true };
  };

  const checkPlan: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop" || input.stop_hook_active) {
      return { continue: true };
    }
    const promptId = input.prompt_id;
    if (
      !isPlanOpen(latestPlan) ||
      (promptId !== undefined && promptId === askedPromptId) ||
      options.hasOpenBackgroundTasks?.() === true
    ) {
      return { continue: true };
    }
    askedPromptId = promptId;
    return { decision: "block", reason: PLAN_TURN_CHECK_REASON };
  };

  return { recordPlan, checkPlan };
}
