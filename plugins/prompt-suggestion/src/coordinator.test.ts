import { describe, it, expect, vi } from "vitest";
import {
  createCoordinator,
  type CoordinatorDeps,
  type Prepared,
} from "./coordinator.js";
import { IncompleteGenerationError } from "./generate.js";
import { sourceMessage } from "./context-input.js";
import { emptyTaskState } from "./task-state.js";

function setup() {
  let time = 0;
  let version = "one";
  let eligible = true;
  let enabled = true;
  let calls = 0;
  let finish: (() => void) | null = null;
  const generate = vi.fn<CoordinatorDeps["generate"]>(async () => {
    calls++;
    return { kind: "none" as const };
  });
  const prepared = (): Prepared => ({
    context: {
      projectId: "p",
      turnId: version,
      revision: version,
      eligible,
      boundary: null,
      text: "{}",
      messages: [sourceMessage("u", "user", "Fix it", 1)],
      contextComplete: true,
    },
    instructionRevision: "instructions",
    instructions: "BIBLE",
    memoryInstructions: "BIBLE memory",
    memoryInstructionRevision: "memory-instructions",
    configKey: "config",
  });
  const prepare = vi.fn(async () => prepared());
  const coordinator = createCoordinator({
    now: () => time,
    prepare,
    generate,
    generateMemory: async () => emptyTaskState(),
    configuration: () => ({
      enabled,
      backgroundPreparation: true,
      maxRequestsPerHour: 60,
      timeoutMs: 1000,
      outputTokenLimit: 0,
    }),
    changed: vi.fn(),
  });
  return {
    coordinator,
    generate,
    prepare,
    prepared,
    calls: () => calls,
    advance: (ms: number) => {
      time += ms;
    },
    version: (value: string) => {
      version = value;
    },
    eligible: (value: boolean) => {
      eligible = value;
    },
    enabled: (value: boolean) => {
      enabled = value;
    },
    defer() {
      generate.mockImplementationOnce(async () => {
        calls++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { kind: "none" };
      });
    },
    finish() {
      finish?.();
    },
  };
}
const waitPending = async (s: ReturnType<typeof setup>) =>
  vi.waitFor(() => expect(s.calls()).toBe(1));

describe("server-owned companion", () => {
  it("coalesces concurrent callers and retains none through detach, clear and re-open", async () => {
    const s = setup();
    s.defer();
    try {
      await s.coordinator.track("t", "a");
      const a = s.coordinator.suggest("t", "a");
      const b = s.coordinator.suggest("t", "b");
      await waitPending(s);
      s.coordinator.detach("t", "a");
      s.coordinator.detach("t", "b");
      s.finish();
      expect((await a).kind).toBe("none");
      expect((await b).kind).toBe("none");
      const id = (await s.coordinator.state("t")).jobId;
      s.coordinator.clearCache("t");
      await s.coordinator.track("t", "c");
      expect((await s.coordinator.state("t")).jobId).toBe(id);
      expect(s.calls()).toBe(1);
    } finally {
      s.coordinator.dispose();
    }
  });
  it("does not retry errors, including cache clearing or a new client", async () => {
    const s = setup();
    s.generate.mockRejectedValueOnce(new Error("provider failed"));
    try {
      expect(await s.coordinator.suggest("t", "a")).toEqual({
        kind: "unavailable",
        reason: "generation_failed",
      });
      s.coordinator.clearCache("t");
      expect(await s.coordinator.suggest("t", "b")).toEqual({
        kind: "unavailable",
        reason: "generation_failed",
      });
      expect(s.generate).toHaveBeenCalledTimes(1);
    } finally {
      s.coordinator.dispose();
    }
  });
  it("rejects a late completion and never commits its task memory", async () => {
    const s = setup();
    s.defer();
    try {
      const result = s.coordinator.suggest("t", "a");
      await waitPending(s);
      s.eligible(false);
      await s.coordinator.wake("t");
      s.finish();
      expect((await result).kind).toBe("unavailable");
      expect(s.coordinator.inspect("t")).toBeNull();
    } finally {
      s.coordinator.dispose();
    }
  });
  it("admits a new attempt only after the window and a fresh foreground request", async () => {
    const s = setup();
    try {
      await s.coordinator.suggest("t", "a");
      s.advance(3600001);
      expect(s.calls()).toBe(1);
      await s.coordinator.suggest("t", "b");
      expect(s.calls()).toBe(2);
    } finally {
      s.coordinator.dispose();
    }
  });
  it("prepares an active thread without inference and wakes on completion", async () => {
    const s = setup();
    s.eligible(false);
    try {
      expect((await s.coordinator.track("t", "a")).phase).toBe("prepared");
      expect(s.calls()).toBe(0);
      s.eligible(true);
      await s.coordinator.wake("t");
      await vi.waitFor(async () =>
        expect((await s.coordinator.state("t")).phase).toBe("none"),
      );
      expect(s.calls()).toBe(1);
    } finally {
      s.coordinator.dispose();
    }
  });
  it("preserves hourly accounting across reset and foreground cache loss", async () => {
    const s = setup();
    try {
      await s.coordinator.suggest("t", "a");
      s.coordinator.reset();
      await s.coordinator.suggest("t", "b");
      expect(s.calls()).toBe(1);
      expect(s.coordinator.diagnostics().admitted).toBe(2);
    } finally {
      s.coordinator.dispose();
    }
  });
});

it("cancels a manual request when its last waiter detaches even with background enabled", async () => {
  const s = setup();
  s.defer();
  try {
    const result = s.coordinator.suggest("manual", "owner");
    await waitPending(s);
    s.coordinator.detach("manual", "owner");
    expect((await result).kind).toBe("unavailable");
    expect(s.coordinator.inspect("manual")).toBeNull();
    s.finish();
  } finally {
    s.coordinator.dispose();
  }
});

it("retains the truncation reason and configured output budget without retry", async () => {
  const s = setup();
  s.generate.mockRejectedValueOnce(new IncompleteGenerationError(128));
  try {
    expect(await s.coordinator.suggest("limited", "a")).toEqual({
      kind: "unavailable",
      reason: "output_truncated",
    });
    expect(await s.coordinator.state("limited")).toMatchObject({
      phase: "error",
      outputTokenLimit: 128,
    });
    expect(await s.coordinator.suggest("limited", "b")).toEqual({
      kind: "unavailable",
      reason: "output_truncated",
    });
    expect(s.generate).toHaveBeenCalledTimes(1);
  } finally {
    s.coordinator.dispose();
  }
});

describe("bounded companion scheduling", () => {
  it("evicts the oldest detached thread on the ninth visit and reuses its admitted outcome", async () => {
    const s = setup();
    let firstJobId: string | null = null;
    try {
      for (let index = 0; index < 9; index++) {
        const threadId = `thread-${index}`;
        s.advance(1);
        await s.coordinator.track(threadId, "foreground");
        expect((await s.coordinator.suggest(threadId, "foreground")).kind).toBe(
          "none",
        );
        if (index === 0)
          firstJobId = (await s.coordinator.state(threadId)).jobId;
        s.coordinator.detach(threadId, "foreground");
      }
      expect(firstJobId).not.toBeNull();
      expect(await s.coordinator.state("thread-0")).toMatchObject({
        phase: "unavailable",
        result: { kind: "unavailable", reason: "not_tracked" },
      });
      expect(s.coordinator.inspect("thread-0")).toBeNull();
      expect((await s.coordinator.state("thread-1")).phase).toBe("none");
      expect(s.coordinator.diagnostics()).toMatchObject({
        tracked: 8,
        admitted: 18,
      });
      s.advance(1);
      expect(await s.coordinator.track("thread-0", "returning")).toMatchObject({
        phase: "none",
        jobId: firstJobId,
      });
      expect(s.coordinator.inspect("thread-0")).toBeNull();
      expect((await s.coordinator.state("thread-1")).phase).toBe("unavailable");
      expect(s.generate).toHaveBeenCalledTimes(9);
    } finally {
      s.coordinator.dispose();
    }
  });

  it("runs one generation and gives a foreground waiter priority over an older background job", async () => {
    const s = setup();
    const started: string[] = [];
    const release = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    s.generate.mockImplementation(async (threadId) => {
      started.push(threadId);
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => release.set(threadId, resolve));
        return { kind: "none" };
      } finally {
        active--;
      }
    });
    try {
      await s.coordinator.track("running", "a");
      await vi.waitFor(() => expect(started).toEqual(["running"]));
      s.advance(1);
      await s.coordinator.track("background", "b");
      s.coordinator.detach("background", "b");
      s.advance(1);
      await s.coordinator.track("foreground", "c");
      expect((await s.coordinator.state("background")).phase).toBe("queued");
      expect((await s.coordinator.state("foreground")).phase).toBe("queued");
      expect(started).toEqual(["running"]);
      release.get("running")!();
      await vi.waitFor(() =>
        expect(started).toEqual(["running", "foreground"]),
      );
      expect((await s.coordinator.state("background")).phase).toBe("queued");
      release.get("foreground")!();
      await vi.waitFor(() =>
        expect(started).toEqual(["running", "foreground", "background"]),
      );
      release.get("background")!();
      await vi.waitFor(async () =>
        expect((await s.coordinator.state("background")).phase).toBe("none"),
      );
      expect(peak).toBe(1);
      expect(active).toBe(0);
    } finally {
      s.coordinator.dispose();
      for (const finish of release.values()) finish();
    }
  });

  it("repeats preparation when an idle wake arrives during an older active-thread read", async () => {
    const s = setup();
    s.eligible(false);
    const stale = s.prepared();
    let release!: () => void;
    const pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.prepare.mockImplementationOnce(async () => {
      await pendingRead;
      return stale;
    });
    try {
      const tracked = s.coordinator.track("thread", "a");
      await vi.waitFor(() => expect(s.prepare).toHaveBeenCalledTimes(1));
      s.eligible(true);
      const wake = s.coordinator.wake("thread");
      expect(s.generate).not.toHaveBeenCalled();
      release();
      await Promise.all([tracked, wake]);
      await vi.waitFor(async () =>
        expect((await s.coordinator.state("thread")).phase).toBe("none"),
      );
      expect(s.generate).toHaveBeenCalledTimes(1);
      expect(s.generate.mock.calls[0]![1].context.eligible).toBe(true);
    } finally {
      release();
      s.coordinator.dispose();
    }
  });

  it.each(["dispose", "expire"] as const)(
    "aborts owned generation on %s and never retains its output",
    async (action) => {
      vi.useFakeTimers();
      const s = setup();
      let started!: (signal: AbortSignal) => void;
      const generationStarted = new Promise<AbortSignal>((resolve) => {
        started = resolve;
      });
      s.generate.mockImplementationOnce(
        async (_threadId, _prepared, signal) => {
          started(signal);
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          return { kind: "none" };
        },
      );
      try {
        await s.coordinator.track("thread", "foreground");
        const signal = await generationStarted;
        const result = s.coordinator.suggest("thread", "waiter");
        await s.coordinator.wake("thread");
        s.coordinator.detach("thread", "foreground");
        s.coordinator.detach("thread", "waiter");
        expect(signal.aborted).toBe(false);
        if (action === "dispose") s.coordinator.dispose();
        else {
          s.advance(600000);
          await vi.advanceTimersByTimeAsync(600000);
        }
        expect(signal.aborted).toBe(true);
        expect((await result).kind).toBe("unavailable");
        expect(s.coordinator.inspect("thread")).toBeNull();
        expect((await s.coordinator.state("thread")).phase).toBe("unavailable");
        expect(s.generate).toHaveBeenCalledTimes(1);
      } finally {
        s.coordinator.dispose();
        vi.useRealTimers();
      }
    },
  );
});
