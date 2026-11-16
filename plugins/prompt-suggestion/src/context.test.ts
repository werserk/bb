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
  it.each([
    { status: "failed" as const },
    { queued: 1 },
    { openQuestion: true },
  ])("rejects non-actionable state %j", async (options) => {
    const host = fixture(options);
    try {
      expect(await readContext(host.bb, "thread", 24000)).toBeNull();
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
});
