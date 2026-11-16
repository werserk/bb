import { emptyTaskState } from "./task-state.js";
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
        return JSON.stringify({
          kind: "suggestion",
          text: "Run the tests.",
          state: emptyTaskState(),
        });
      });
      const service = createService(host.bb, () =>
        settingsSchema.parse({ enabled: true, model }),
      );
      try {
        expect(await service.suggest(input)).toEqual({
          kind: "suggestion",
          text: "Run the tests.",
          state: emptyTaskState(),
        });
        expect(
          await service.suggest({ ...input, requestId: "second" }),
        ).toMatchObject({ kind: "suggestion", text: "Run the tests." });
        expect(calls).toBe(1);
        expect(service.diagnostics().lastAttachment).toBeNull();
        expect(service.observe("request", "shown", 2.5)).toBe(true);
        expect(service.diagnostics().lastAttachment).toEqual({
          jobId: "request",
          observedToAttachMs: 2.5,
        });
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
      finish(
        JSON.stringify({
          kind: "suggestion",
          text: "Late response",
          state: emptyTaskState(),
        }),
      );
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
      finish(JSON.stringify({ kind: "none", state: emptyTaskState() }));
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

it("keeps affinity opaque and stable across turns, scoped to thread, configuration and process", async () => {
  const options = { turnId: "turn" };
  const host = fixture(options);
  const hints: (string | null | undefined)[] = [];
  host.bb.experimental_aiServices.register({
    id: "affinity-fixture",
    displayName: "Affinity fixture",
    experimental_text: {
      models: async () => [
        {
          id: "m",
          displayName: "Model",
          provider: "fixture",
          hostId: "host",
          profile: "default",
          capabilities: {
            maxOutputTokens: true,
            temperature: false,
            reasoningEfforts: [],
            serviceTiers: [],
            experimental_sessionAffinity: true,
          },
        },
      ],
      generate: async (request) => {
        hints.push(request.experimental_sessionAffinity);
        return {
          text: JSON.stringify({ kind: "none", state: emptyTaskState() }),
          model: request.model,
          actualModel: null,
          actualServiceTier: null,
          finishReason: "stop",
          usage: null,
        };
      },
    },
  });
  const model = (
    await host.bb.experimental_aiServices.experimental_models()
  )[0]!.id;
  const settings = settingsSchema.parse({ enabled: true, model });
  const service = createService(host.bb, () => settings);
  try {
    const ask = (threadId: string, requestId: string) =>
      service.suggest({ ...input, threadId, requestId, automatic: false });
    await ask("private-thread-name", "first");
    options.turnId = "second-turn";
    await ask("private-thread-name", "second");
    await ask("another-thread", "third");
    settings.instructions = "Use concise Russian.";
    service.reset();
    await ask("private-thread-name", "fourth");
    expect(hints).toHaveLength(4);
    expect(hints[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(hints[1]).toBe(hints[0]);
    expect(hints[2]).not.toBe(hints[0]);
    expect(hints[3]).not.toBe(hints[0]);
    const restarted = createService(host.bb, () => settings);
    try {
      await restarted.suggest({
        ...input,
        threadId: "private-thread-name",
        requestId: "fifth",
        automatic: false,
      });
      expect(hints[4]).not.toBe(hints[3]);
    } finally {
      restarted.dispose();
    }
  } finally {
    service.dispose();
    await host.harness.lifecycle.dispose();
  }
});
