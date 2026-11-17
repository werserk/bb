import { expect, it, vi } from "vitest";
import { createCoordinator, type Prepared } from "./coordinator.js";
import { sourceMessage } from "./context-input.js";
import { emptyTaskState } from "./task-state.js";

function harness(limit = 60) {
  let version = "one";
  let eligible = true;
  let instruction = "bible";
  let release!: (state: ReturnType<typeof emptyTaskState>) => void;
  let memorySignal: AbortSignal | null = null;
  const prepare = async (): Promise<Prepared> => ({
    context: {
      projectId: "p",
      turnId: version,
      revision: version,
      eligible,
      boundary: null,
      text: "{}",
      messages: [sourceMessage("u", "user", version, 1)],
      contextComplete: false,
    },
    instructions: instruction,
    instructionRevision: instruction,
    memoryInstructions: instruction,
    memoryInstructionRevision: instruction,
    configKey: "config",
  });
  const generate = vi.fn(async () => ({ kind: "none" as const }));
  const generateMemory = vi.fn(
    async (_id: string, _prepared: Prepared, signal: AbortSignal) => {
      memorySignal = signal;
      return new Promise<ReturnType<typeof emptyTaskState>>((resolve) => {
        release = resolve;
      });
    },
  );
  const coordinator = createCoordinator({
    prepare,
    generate,
    generateMemory,
    changed: vi.fn(),
    configuration: () => ({
      enabled: true,
      backgroundPreparation: true,
      maxRequestsPerHour: limit,
      timeoutMs: 30000,
      outputTokenLimit: 256,
    }),
  });
  return {
    coordinator,
    generate,
    generateMemory,
    signal: () => memorySignal,
    release: (state = { ...emptyTaskState(), contextComplete: false }) =>
      release(state),
    invalidate: (kind: string) => {
      if (kind === "instructions") instruction = "changed";
      else if (kind === "eligibility") eligible = false;
      else version = kind;
    },
  };
}

it("settles none before memory and preserves its job through memory commit and wakes", async () => {
  const h = harness();
  try {
    await h.coordinator.track("t", "a");
    expect(await h.coordinator.suggest("t", "a")).toEqual({ kind: "none" });
    await vi.waitFor(() => expect(h.generateMemory).toHaveBeenCalledTimes(1));
    const before = await h.coordinator.state("t");
    expect(h.coordinator.inspect("t")).toBeNull();
    h.release();
    await vi.waitFor(() => expect(h.coordinator.inspect("t")).not.toBeNull());
    await h.coordinator.wake("t");
    expect(await h.coordinator.state("t")).toEqual(before);
    expect(h.generate).toHaveBeenCalledTimes(1);
    expect(h.generateMemory).toHaveBeenCalledTimes(1);
    expect(h.coordinator.diagnostics()).toMatchObject({
      requests: 2,
      admitted: 2,
      memory: { completed: 1 },
    });
  } finally {
    h.coordinator.dispose();
  }
});

it.each([
  "new-turn",
  "source-edit",
  "instructions",
  "eligibility",
  "clear",
  "reset",
  "dispose",
])("rejects late memory after %s", async (kind) => {
  const h = harness();
  try {
    await h.coordinator.track("t", "a");
    await vi.waitFor(() => expect(h.generateMemory).toHaveBeenCalledTimes(1));
    if (kind === "clear") h.coordinator.clearCache("t");
    else if (kind === "reset") h.coordinator.reset();
    else if (kind === "dispose") h.coordinator.dispose();
    else {
      h.invalidate(kind);
      await h.coordinator.wake("t");
    }
    expect(h.signal()?.aborted).toBe(true);
    h.release();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.coordinator.diagnostics().memory.completed).toBe(0);
    expect(h.coordinator.inspect("t")).toBeNull();
  } finally {
    h.coordinator.dispose();
  }
});

it.each(["forged", "incomplete", "oversized"])(
  "memory %s failure leaves foreground intact and does not retry on clear",
  async (failure) => {
    const h = harness();
    try {
      await h.coordinator.track("t", "a");
      await vi.waitFor(() => expect(h.generateMemory).toHaveBeenCalledTimes(1));
      const state = emptyTaskState();
      state.contextComplete = failure === "incomplete";
      if (failure !== "incomplete")
        state.goal = {
          text: failure === "oversized" ? "x".repeat(401) : "forged",
          sources: [{ messageId: "missing", revision: "a".repeat(64) }],
        };
      h.release(state);
      await vi.waitFor(() =>
        expect(h.coordinator.diagnostics().memory.errors).toBe(1),
      );
      expect((await h.coordinator.state("t")).phase).toBe("none");
      expect(h.coordinator.inspect("t")).toBeNull();
      h.coordinator.clearCache("t");
      await h.coordinator.track("t", "b");
      expect(h.generateMemory).toHaveBeenCalledTimes(1);
      expect(h.generate).toHaveBeenCalledTimes(1);
    } finally {
      h.coordinator.dispose();
    }
  },
);

it("reserves quota one exclusively for foreground", async () => {
  const h = harness(1);
  try {
    expect(await h.coordinator.suggest("t", "a")).toEqual({ kind: "none" });
    expect(h.generateMemory).not.toHaveBeenCalled();
    expect(h.coordinator.diagnostics()).toMatchObject({
      admitted: 1,
      requests: 1,
    });
  } finally {
    h.coordinator.dispose();
  }
});

it("retains earlier memory and the new foreground result after a failed refresh", async () => {
  const h = harness();
  try {
    await h.coordinator.track("t", "a");
    await vi.waitFor(() => expect(h.generateMemory).toHaveBeenCalledTimes(1));
    h.release();
    await vi.waitFor(() => expect(h.coordinator.inspect("t")).not.toBeNull());
    const previous = h.coordinator.inspect("t");
    h.invalidate("next");
    await h.coordinator.wake("t");
    await vi.waitFor(() => expect(h.generateMemory).toHaveBeenCalledTimes(2));
    const before = await h.coordinator.state("t");
    h.release({ ...emptyTaskState(), contextComplete: true });
    await vi.waitFor(() =>
      expect(h.coordinator.diagnostics().memory.errors).toBe(1),
    );
    expect(h.coordinator.inspect("t")).toEqual(previous);
    expect(await h.coordinator.state("t")).toEqual(before);
  } finally {
    h.coordinator.dispose();
  }
});

it("manual helper preempts memory and holds its priority until release", async () => {
  const h = harness();
  try {
    await h.coordinator.track("t", "a");
    await vi.waitFor(() => expect(h.generateMemory).toHaveBeenCalledTimes(1));
    const lease = h.coordinator.beginHelper("helper");
    expect(lease).not.toBeNull();
    expect(h.signal()?.aborted).toBe(true);
    expect(h.coordinator.beginHelper("other")).toBeNull();
    expect(lease!.admit()).toBe(true);
    h.release();
    await vi.waitFor(() =>
      expect(h.coordinator.diagnostics().memory.active).toBe(0),
    );
    expect(h.coordinator.diagnostics()).toMatchObject({
      admitted: 3,
      helper: { active: 1, requests: 1 },
    });
    lease!.finish("helper", false);
    expect(h.coordinator.diagnostics().helper.active).toBe(0);
  } finally {
    h.coordinator.dispose();
  }
});
