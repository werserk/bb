import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { createService } from "./controller.js";
import { settingsSchema } from "./settings.js";
import { fixture } from "./test-fixtures.js";

const input = {
  threadId: "thread",
  requestId: "request",
  token: "capability",
  automatic: true,
  expectedTurnId: "turn",
};
describe("generation admission and cancellation", () => {
  it.each(["claude-code", "codex", "other"])(
    "uses the same generator for %s and deduplicates a completed turn",
    async (providerId) => {
      let calls = 0;
      const server = createServer((_req, res) => {
        calls++;
        res.end(
          JSON.stringify({
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content: '{"kind":"suggestion","text":"Run the tests."}',
                },
              },
            ],
          }),
        );
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const host = fixture({ providerId });
      const service = createService(host.bb, () =>
        settingsSchema.parse({
          enabled: true,
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          model: "fixture",
        }),
      );
      try {
        expect(await service.suggest(input)).toEqual({
          kind: "suggestion",
          text: "Run the tests.",
        });
        expect(
          await service.suggest({ ...input, requestId: "second" }),
        ).toEqual({ kind: "unavailable", reason: "already_attempted" });
        expect(calls).toBe(1);
        expect(service.observe("request", "shown")).toBe(true);
        expect(service.observe("request", "shown")).toBe(false);
        expect(host.harness.inspection.logEntries).toEqual([]);
        expect(
          host.harness.inspection.sdk.calls.every((call) =>
            [
              "threads.get",
              "threads.timeline",
              "threads.questions.open",
              "threads.interactions.list",
              "threads.events.list",
            ].includes(call.path),
          ),
        ).toBe(true);
      } finally {
        service.reset();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await host.harness.lifecycle.dispose();
      }
    },
  );
  it("rejects a stale expected turn before a model request", async () => {
    const host = fixture();
    const service = createService(host.bb, () =>
      settingsSchema.parse({
        enabled: true,
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fixture",
      }),
    );
    try {
      expect(
        await service.suggest({ ...input, expectedTurnId: "old" }),
      ).toEqual({ kind: "unavailable", reason: "ineligible" });
      expect(service.diagnostics().requests).toBe(0);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
  it("requires the request capability to abort and never returns late content", async () => {
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const server = createServer(() => reached());
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    const host = fixture();
    const service = createService(host.bb, () =>
      settingsSchema.parse({
        enabled: true,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "fixture",
      }),
    );
    try {
      const pending = service.suggest(input);
      await started;
      expect(service.cancel(input.requestId, "wrong")).toBe(false);
      expect(service.cancel(input.requestId, input.token)).toBe(true);
      expect(await pending).toEqual({
        kind: "unavailable",
        reason: "cancelled",
      });
    } finally {
      service.reset();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await host.harness.lifecycle.dispose();
    }
  });
});
