import { describe, expect, it } from "vitest";
import { createService } from "./controller.js";
import { settingsSchema } from "./settings.js";
import { fixture } from "./test-fixtures.js";
import { installGenerator } from "./generator-fixture.js";

const input = {
  threadId: "thread",
  requestId: "request",
  token: "capability",
  automatic: true,
  expectedTurnId: "turn",
};
describe("generation admission and cancellation", () => {
  it.each(["claude-code", "codex", "other"])(
    "uses the selected BB model for %s and deduplicates a completed turn",
    async (providerId) => {
      const host = fixture({ providerId });
      let calls = 0;
      const model = await installGenerator(host.bb, async () => {
        calls++;
        return '{"kind":"suggestion","text":"Run the tests."}';
      });
      const service = createService(host.bb, () =>
        settingsSchema.parse({ enabled: true, model }),
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
      } finally {
        service.reset();
        await host.harness.lifecycle.dispose();
      }
    },
  );
  it("rejects a stale expected turn before a model request", async () => {
    const host = fixture();
    const service = createService(host.bb, () =>
      settingsSchema.parse({ enabled: true, model: "fixture" }),
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
  it("requires the cancellation capability and never returns late content", async () => {
    const host = fixture();
    let reached!: () => void;
    let finish!: (value: string) => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const response = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const model = await installGenerator(host.bb, async () => {
      reached();
      return response;
    });
    const service = createService(host.bb, () =>
      settingsSchema.parse({ enabled: true, model }),
    );
    try {
      const pending = service.suggest(input);
      await started;
      expect(service.cancel(input.requestId, "wrong")).toBe(false);
      expect(service.cancel(input.requestId, input.token)).toBe(true);
      finish('{"kind":"suggestion","text":"Late response"}');
      expect(await pending).toEqual({
        kind: "unavailable",
        reason: "cancelled",
      });
    } finally {
      service.reset();
      await host.harness.lifecycle.dispose();
    }
  });
  it("invalidates a response when the selected model changes", async () => {
    const host = fixture();
    let reached!: () => void;
    let finish!: (value: string) => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const response = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const model = await installGenerator(host.bb, async () => {
      reached();
      return response;
    });
    let settings = settingsSchema.parse({ enabled: true, model });
    const service = createService(host.bb, () => settings);
    try {
      const pending = service.suggest(input);
      await started;
      settings = { ...settings, model: "replacement" };
      service.reset();
      finish('{"kind":"none"}');
      expect((await pending).kind).toBe("unavailable");
    } finally {
      service.reset();
      await host.harness.lifecycle.dispose();
    }
  });
});

it("reports the server deadline as timeout rather than explicit cancellation", async () => {
  const host = fixture();
  const model = await installGenerator(
    host.bb,
    async (_request, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
  const service = createService(host.bb, () =>
    settingsSchema.parse({ enabled: true, model, timeoutMs: 100 }),
  );
  try {
    expect(await service.suggest(input)).toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
    expect(service.status().active).toBe(0);
  } finally {
    service.reset();
    await host.harness.lifecycle.dispose();
  }
});
