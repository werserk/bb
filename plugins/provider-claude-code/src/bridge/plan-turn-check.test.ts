import type {
  HookInput,
  SyncHookJSONOutput,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  PLAN_TURN_CHECK_REASON,
  buildPlanTurnCheck,
} from "./plan-turn-check.js";

const BB_PLAN_TOOL = "mcp__bb-bridge__bb_update_plan";

type PlanStatus = "pending" | "in_progress" | "completed";

function base() {
  return {
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/tmp",
  };
}

function bbPlanCall(
  statuses: PlanStatus[],
  extra: { agent_id?: string } = {},
): HookInput {
  return {
    ...base(),
    ...extra,
    hook_event_name: "PostToolUse",
    tool_name: BB_PLAN_TOOL,
    tool_input: {
      plan: statuses.map((status, index) => ({
        step: `step ${index + 1}`,
        status,
      })),
    },
    tool_response: "ok",
    tool_use_id: "tu1",
  } as HookInput;
}

function todoWriteCall(statuses: PlanStatus[]): HookInput {
  return {
    ...base(),
    hook_event_name: "PostToolUse",
    tool_name: "TodoWrite",
    tool_input: {
      todos: statuses.map((status, index) => ({
        content: `todo ${index + 1}`,
        status,
        activeForm: `doing ${index + 1}`,
      })),
    },
    tool_response: "ok",
    tool_use_id: "tu2",
  } as HookInput;
}

function stop(
  options: { active?: boolean; promptId?: string } = {},
): HookInput {
  return {
    ...base(),
    hook_event_name: "Stop",
    stop_hook_active: options.active ?? false,
    ...(options.promptId !== undefined ? { prompt_id: options.promptId } : {}),
  } as HookInput;
}

async function run(
  hook: (input: HookInput) => Promise<unknown>,
  input: HookInput,
): Promise<SyncHookJSONOutput> {
  return (await hook(input)) as SyncHookJSONOutput;
}

function makeCheck() {
  const check = buildPlanTurnCheck();
  const call = (input: HookInput) =>
    run(
      (value) =>
        input.hook_event_name === "Stop"
          ? check.checkPlan(value, undefined, {
              signal: new AbortController().signal,
            })
          : check.recordPlan(value, undefined, {
              signal: new AbortController().signal,
            }),
      input,
    );
  return { call };
}

describe("plan turn check", () => {
  it("blocks the first stop of a turn when the bb plan has an open step", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["completed", "in_progress", "pending"]));

    const result = await call(stop({ promptId: "p1" }));

    expect(result.decision).toBe("block");
    expect(result.reason).toBe(PLAN_TURN_CHECK_REASON);
  });

  it("blocks for a native TodoWrite list with an open item", async () => {
    const { call } = makeCheck();
    await call(todoWriteCall(["completed", "pending"]));

    expect((await call(stop())).decision).toBe("block");
  });

  it("does not block again once the stop continues because of this hook", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["in_progress"]));

    expect((await call(stop({ promptId: "p1" }))).decision).toBe("block");
    expect(
      (await call(stop({ active: true, promptId: "p1" }))).decision,
    ).toBeUndefined();
  });

  it("asks at most once per prompt even when the active flag is missing", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["in_progress"]));

    expect((await call(stop({ promptId: "p1" }))).decision).toBe("block");
    expect((await call(stop({ promptId: "p1" }))).decision).toBeUndefined();
    expect((await call(stop({ promptId: "p2" }))).decision).toBe("block");
  });

  it("lets the agent stop when the latest plan is fully completed", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["completed", "in_progress"]));
    await call(bbPlanCall(["completed", "completed"]));

    expect((await call(stop())).decision).toBeUndefined();
  });

  it("lets the agent stop when it cleared the plan", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["pending"]));
    await call(bbPlanCall([]));

    expect((await call(stop())).decision).toBeUndefined();
  });

  it("does nothing when no plan was ever posted", async () => {
    const { call } = makeCheck();

    expect((await call(stop())).decision).toBeUndefined();
  });

  it("follows the latest plan across the two sources", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["pending"]));
    await call(todoWriteCall(["completed"]));

    expect((await call(stop())).decision).toBeUndefined();
  });

  it("ignores plan calls made by a provider subagent", async () => {
    const { call } = makeCheck();
    await call(bbPlanCall(["completed"]));
    await call(bbPlanCall(["pending"], { agent_id: "sub1" }));

    expect((await call(stop())).decision).toBeUndefined();
  });

  it("ignores malformed plan input instead of throwing", async () => {
    const { call } = makeCheck();
    await call({
      ...base(),
      hook_event_name: "PostToolUse",
      tool_name: BB_PLAN_TOOL,
      tool_input: { plan: "nope" },
      tool_response: "bad",
      tool_use_id: "tu3",
    } as HookInput);

    expect((await call(stop())).decision).toBeUndefined();
  });

  it("keeps separate state per check instance", async () => {
    const first = makeCheck();
    const second = makeCheck();
    await first.call(bbPlanCall(["pending"]));

    expect((await second.call(stop())).decision).toBeUndefined();
    expect((await first.call(stop())).decision).toBe("block");
  });
});
