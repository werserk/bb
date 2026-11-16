import { it, expect } from "vitest";
import { fixture } from "./test-fixtures.js";
import { instructionBundle } from "./instruction-bundle.js";
import { LEGACY_INSTRUCTIONS, DEFAULT_INSTRUCTIONS } from "./instructions.js";

it("preserves the full owner source and invalidates same-size changes", async () => {
  const host = fixture();
  let text = "\n# BIBLE\nKeep the goal.\n";
  host.bb.experimental_userInstructions.read = () => ({
    kind: "ready",
    content: text,
    revision: text,
  });
  try {
    const a = instructionBundle(host.bb, "Use Russian");
    expect(a?.content).toContain(text);
    expect(a?.content).toContain(DEFAULT_INSTRUCTIONS);
    expect(a?.content).toContain("Use Russian");
    text = text.replace("goal", "task");
    expect(instructionBundle(host.bb, "Use Russian")?.revision).not.toBe(
      a?.revision,
    );
    expect(
      instructionBundle(host.bb, LEGACY_INSTRUCTIONS)?.content,
    ).not.toContain(LEGACY_INSTRUCTIONS);
    host.bb.experimental_userInstructions.read = () => ({
      kind: "unavailable",
      reason: "missing",
    });
    expect(instructionBundle(host.bb, "")).toBeNull();
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
