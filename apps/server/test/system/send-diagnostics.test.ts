import { describe, expect, it, vi } from "vitest";
import {
  markSendDiagnostic,
  runWithSendDiagnostics,
  traceSendStage,
} from "../../src/services/system/send-diagnostics.js";

describe("numeric send diagnostics", () => {
  it("keeps a delayed detached ack correlated after HTTP acceptance without logging values or errors", async () => {
    const info = vi.fn();
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ack!: Promise<string>;
    const secret = "prompt-body-env-provider-secret";
    await runWithSendDiagnostics(
      { logger: { info } },
      { threadId: "thr-test", service: 1 },
      async () => {
        ack = traceSendStage("daemon.ack", async () => {
          await delayed;
          return secret;
        });
        markSendDiagnostic("enqueue.done", "queue-test");
        return secret;
      },
    );
    expect(
      info.mock.calls
        .map(([fields]) => fields.sendDiagnostic)
        .filter((span) => span.stage === "daemon.ack"),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await ack;
    const spans = info.mock.calls.map(([fields]) => fields.sendDiagnostic);
    expect(new Set(spans.map((span) => span.correlationId)).size).toBe(1);
    expect(
      spans.find((span) => span.stage === "request" && span.status === 1),
    ).toBeDefined();
    expect(spans.at(-1)).toMatchObject({
      stage: "daemon.ack",
      status: 1,
      durationMs: expect.any(Number),
    });
    expect(spans.at(-1).durationMs).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(spans)).not.toContain(secret);
    for (const span of spans)
      expect(Object.keys(span).sort()).toEqual(
        [
          "correlationId",
          "durationMs",
          "elapsedMs",
          "messageId",
          "service",
          "stage",
          "status",
          "threadId",
        ].sort(),
      );
  });

  it("preserves thrown errors, isolates concurrent requests and records failed spans", async () => {
    const info = vi.fn();
    const error = new Error("sensitive error body");
    await Promise.all(
      [0, 1].map(async (service) => {
        await expect(
          runWithSendDiagnostics(
            { logger: { info } },
            { threadId: "thr-test", service: service as 0 | 1 },
            async () => {
              return traceSendStage("execution", async () => {
                await Promise.resolve();
                throw error;
              });
            },
          ),
        ).rejects.toBe(error);
      }),
    );
    const spans = info.mock.calls.map(([fields]) => fields.sendDiagnostic);
    expect(new Set(spans.map((span) => span.correlationId)).size).toBe(2);
    expect(
      spans.filter((span) => span.stage === "execution" && span.status === 2),
    ).toHaveLength(2);
    expect(JSON.stringify(spans)).not.toContain(error.message);
  });

  it("has no output without a send scope and reuses nested scopes", async () => {
    expect(await traceSendStage("execution", async () => 42)).toBe(42);
    const info = vi.fn();
    await runWithSendDiagnostics(
      { logger: { info } },
      { threadId: "thr-test", service: 0 },
      () =>
        runWithSendDiagnostics(
          { logger: { info } },
          { threadId: "thr-test", service: 0 },
          async () => 42,
        ),
    );
    expect(info).toHaveBeenCalledTimes(2);
  });
});
