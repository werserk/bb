import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { generate } from "./generate.js";
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
        });
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
      finish(JSON.stringify({ kind: "none" }));
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
          text: JSON.stringify({ kind: "none" }),
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

it("cancels memory, reports shared saturation without retry, and admits a new turn after cleanup", async () => {
  const options = { turnId: "turn" };
  const host = fixture(options);
  const memorySignal: { current: AbortSignal | null } = { current: null };
  let occupied = 0;
  let foregroundCalls = 0;
  let releaseMemory!: () => void;
  const memoryCleanup = new Promise<void>((resolve) => { releaseMemory = resolve; });
  const external = new AbortController();
  const blockers: Promise<unknown>[] = [];
  let memoryStarted!: () => void;
  const started = new Promise<void>((resolve) => { memoryStarted = resolve; });
  const model = await installGenerator(host.bb, async (request, signal) => {
    if (request.messages[0]?.content === "occupied") {
      occupied++;
      return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    if (request.messages[0]?.content.startsWith("Maintain only revisable")) {
      memorySignal.current = signal;
      memoryStarted();
      await memoryCleanup;
      signal.throwIfAborted();
      return JSON.stringify({ kind: "none" });
    }
    foregroundCalls++;
    return JSON.stringify({ kind: "suggestion", text: "Verify the result." });
  });
  const service = createService(host.bb, () => settingsSchema.parse({ enabled: true, model, backgroundPreparation: true }));
  try {
    await service.track("thread", "client");
    await started;
    for (let index = 0; index < 3; index++) blockers.push(generate(host.bb.experimental_aiServices, { model, instructions: "occupied", outputTokenLimit: 0, reasoningEffort: "default", serviceTier: "default", timeoutMs: 30000 }, "external request", external.signal).catch(() => null));
    await expect.poll(() => occupied).toBe(3);
    const first = await service.state("thread");
    expect(first.phase).toBe("ready");
    options.turnId = "next";
    await service.wake("thread");
    expect(memorySignal.current?.aborted).toBe(true);
    await expect.poll(() => service.state("thread")).toMatchObject({ phase: "error", result: { kind: "unavailable", reason: "busy" } });
    const blocked = await service.state("thread");
    await service.wake("thread");
    expect((await service.state("thread")).jobId).toBe(blocked.jobId);
    expect(foregroundCalls).toBe(1);
    expect(service.diagnostics().requests).toBe(3);
    releaseMemory();
    await memoryCleanup;
    await setImmediate();
    expect(service.inspect("thread")).toBeNull();
    options.turnId = "after-cleanup";
    await service.wake("thread");
    await expect.poll(async () => (await service.state("thread")).phase).toBe("ready");
    expect((await service.state("thread")).jobId).not.toBe(first.jobId);
    expect(foregroundCalls).toBe(2);
    expect(occupied).toBe(3);
  } finally {
    releaseMemory();
    external.abort();
    service.dispose();
    await Promise.all(blockers);
    await host.harness.lifecycle.dispose();
  }
});
