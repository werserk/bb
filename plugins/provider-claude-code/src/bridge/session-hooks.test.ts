import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import { expect, it } from "vitest";
import { buildSessionTrackingHooks } from "./bridge.js";
import { PLAN_TURN_CHECK_REASON } from "./plan-turn-check.js";

const signal = new AbortController().signal;

async function fire(
  hooks: ReturnType<typeof buildSessionTrackingHooks>,
  input: HookInput,
): Promise<unknown> {
  const event = input.hook_event_name as "PostToolUse" | "Stop";
  let last: unknown;
  for (const matcher of hooks[event] ?? []) {
    for (const hook of matcher.hooks) {
      last = await hook(input, undefined, { signal });
    }
  }
  return last;
}

it("session hooks stop an agent with an open plan once and release it after", async () => {
  const hooks = buildSessionTrackingHooks({ current: "thr_1" });
  const common = { session_id: "s", transcript_path: "/t", cwd: "/" };
  await fire(hooks, {
    ...common,
    hook_event_name: "PostToolUse",
    tool_name: "mcp__bb-bridge__bb_update_plan",
    tool_input: { plan: [{ step: "Do it", status: "in_progress" }] },
    tool_response: "ok",
    tool_use_id: "tu",
  } as HookInput);

  const first = await fire(hooks, {
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: false,
  } as HookInput);
  const second = await fire(hooks, {
    ...common,
    hook_event_name: "Stop",
    stop_hook_active: true,
  } as HookInput);

  expect(first).toMatchObject({
    decision: "block",
    reason: PLAN_TURN_CHECK_REASON,
  });
  expect(second).toEqual({ continue: true });
});
