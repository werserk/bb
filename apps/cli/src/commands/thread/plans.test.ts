import { Command } from "commander";
import { it, expect, vi } from "vitest";
import { registerPlanCommand } from "./plans.js";
it("reads the SDK batch projection and prints native identity without reinterpretation", async () => {
  const threadId = "thr_23456789ab";
  const view = {
    threadId,
    revision: 7,
    current: {
      sourceSeq: 6,
      updatedAt: 1,
      planId: "work",
      items: [
        {
          id: "step",
          text: "Check",
          status: "needs_input",
          interactionIds: ["pint_23456789ab"],
        },
      ],
    },
    previousPlans: [],
    historyTruncated: false,
    ownAttention: "needs_input",
    attentionInteractionIds: ["pint_23456789ab"],
    unboundInteractionIds: [],
  };
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ plans: { [threadId]: view }, errors: {} }),
    );
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const command = new Command();
    registerPlanCommand(command, () => "http://test");
    await command.parseAsync(["node", "bb", "plan", threadId, "--json"]);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual(view);
    expect(fetch.mock.calls[0]![1]?.body).toBe(
      JSON.stringify({ threadIds: [threadId] }),
    );
  } finally {
    fetch.mockRestore();
    output.mockRestore();
  }
});
