import { describe, expect, it } from "vitest";
import { readContext } from "./context.js";
import { fixture } from "./test-fixtures.js";
describe("canonical suggestion context", () => {
  it.each([false, true])(
    "accepts completed conversations independently of summary presence=%s",
    async (turnRow) => {
      const host = fixture({ turnRow });
      try {
        const context = await readContext(host.bb, "thread", 24000);
        expect(context?.turnId).toBe("turn");
        expect(context?.text).toContain("Fix the bug");
      } finally {
        await host.harness.lifecycle.dispose();
      }
    },
  );
  it("allows open conversation questions without reading their status", async () => {
    const host = fixture({ openQuestion: true, interaction: "question" });
    host.bb.sdk.threads.questions.open = async () => {
      throw new Error("Question status is irrelevant");
    };
    try {
      expect((await readContext(host.bb, "thread", 24000))?.eligible).toBe(
        true,
      );
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
  it.each([
    { status: "failed" as const },
    { queued: 1 },
    { interaction: "approval" as const },
  ])("rejects non-actionable state %j", async (options) => {
    const host = fixture(options);
    try {
      expect(await readContext(host.bb, "thread", 24000)).toBeNull();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
