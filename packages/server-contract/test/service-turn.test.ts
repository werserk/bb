import { describe, expect, it } from "vitest";
import { sendMessageRequestSchema } from "../src/api/threads.js";

const serviceTurn = {
  version: 1,
  visibility: "hidden",
  reason: "helper-result",
  origin: { pluginId: "wprojects", senderThreadId: "helper" },
};
describe("typed service input", () => {
  it("retains the descriptor independently of message content", () => {
    const request = sendMessageRequestSchema.parse({
      input: [{ type: "text", text: "ordinary wording" }],
      mode: "queue-if-active",
      serviceTurn,
    });
    expect(request).toHaveProperty("serviceTurn", serviceTurn);
  });
  it("accepts new reason tokens and rejects malformed reasons", () => {
    for (const reason of ["rotation", "restart-seed", "future-2g-1"])
      expect(
        sendMessageRequestSchema.parse({
          input: [{ type: "text", text: "x" }],
          mode: "auto",
          serviceTurn: { ...serviceTurn, reason },
        }).serviceTurn?.reason,
      ).toBe(reason);
    for (const reason of ["", "Upper", "space reason", "x".repeat(65)])
      expect(() =>
        sendMessageRequestSchema.parse({
          input: [{ type: "text", text: "x" }],
          mode: "auto",
          serviceTurn: { ...serviceTurn, reason },
        }),
      ).toThrow();
  });
  it("rejects unknown descriptor versions instead of silently downgrading", () => {
    expect(() =>
      sendMessageRequestSchema.parse({
        input: [{ type: "text", text: "x" }],
        mode: "auto",
        serviceTurn: { ...serviceTurn, version: 2 },
      }),
    ).toThrow();
  });
});
