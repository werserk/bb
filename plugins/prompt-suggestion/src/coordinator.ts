import { experimental_AiGenerationError } from "@get-bb/plugin-sdk";
import { IncompleteGenerationError } from "./generate.js";
import { randomUUID } from "node:crypto";
import { createAdmissionLedger } from "./admission.js";
import type { CompanionContext } from "./context.js";
import type { GenerationResult, GenerationMeasurement } from "./generate.js";
import {
  taskStateSchema,
  type TaskState,
  rememberTask,
  validateStateSources,
  type TaskMemory,
} from "./task-state.js";

export type Outcome =
  | GenerationResult
  | { kind: "unavailable"; reason: string };
export type JobView = {
  phase:
    | "prepared"
    | "queued"
    | "pending"
    | "ready"
    | "none"
    | "error"
    | "unavailable";
  jobId: string | null;
  turnId: string | null;
  result: Outcome | null;
  queueMs: number;
  preparationMs: number;
  modelMs: number;
  validationMs: number;
  serverMs: number | null;
  usage: GenerationMeasurement["usage"];
  actualModel: string | null;
  actualServiceTier: string | null;
  finishReason: "stop" | "length" | null;
  outputTokenLimit: number | null;
};
export type Prepared = {
  context: CompanionContext;
  instructionRevision: string;
  instructions: string;
  memoryInstructions: string;
  memoryInstructionRevision: string;
  configKey: string;
};
export type CoordinatorDeps = {
  prepare(
    threadId: string,
    memory: TaskMemory | null,
    signal: AbortSignal,
  ): Promise<Prepared | null>;
  generate(
    threadId: string,
    prepared: Prepared,
    signal: AbortSignal,
    measured: (measurement: GenerationMeasurement) => void,
  ): Promise<GenerationResult>;
  generateMemory(
    threadId: string,
    prepared: Prepared,
    signal: AbortSignal,
  ): Promise<TaskState>;
  configuration(): {
    enabled: boolean;
    backgroundPreparation: boolean;
    maxRequestsPerHour: number;
    timeoutMs: number;
    outputTokenLimit: number;
  };
  changed(threadId: string): void;
  now?: () => number;
};
type Job = {
  key: string;
  id: string;
  threadId: string;
  prepared: Prepared;
  controller: AbortController;
  enqueued: number;
  view: JobView;
  done: Promise<Outcome>;
  finish: (outcome: Outcome) => void;
  settled: boolean;
};
type MemoryJob = {
  entry: Entry;
  prepared: Prepared;
  key: string;
  controller: AbortController;
};
type Admission =
  | { role: "suggestion"; job: Job }
  | { role: "memory" }
  | { role: "helper" };
type Entry = {
  threadId: string;
  clients: Set<string>;
  backgroundInterest: boolean;
  expires: number;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
  memory: TaskMemory | null;
  prepared: Prepared | null;
  job: Job | null;
  preparationMs: number;
  reading: Promise<void> | null;
  dirty: boolean;
};
const unavailable = (reason: string): Outcome => ({
  kind: "unavailable",
  reason,
});
const emptyView = (reason: string): JobView => ({
  phase: "unavailable",
  jobId: null,
  turnId: null,
  result: unavailable(reason),
  queueMs: 0,
  preparationMs: 0,
  modelMs: 0,
  validationMs: 0,
  serverMs: null,
  usage: null,
  actualModel: null,
  actualServiceTier: null,
  finishReason: null,
  outputTokenLimit: null,
});

export function createCoordinator(deps: CoordinatorDeps) {
  const now = deps.now ?? (() => performance.now());
  const entries = new Map<string, Entry>();
  const ledger = createAdmissionLedger<Admission>(now);
  const queue = new Map<string, Job>();
  const memoryQueue = new Map<string, MemoryJob>();
  let helperActive = false;
  const helperStats = {
    requests: 0,
    completed: 0,
    none: 0,
    errors: 0,
    cancelled: 0,
    lastLatencyMs: 0,
  };
  let memoryRunning: MemoryJob | null = null;
  const memoryStats = { completed: 0, errors: 0, cancelled: 0 };
  let running: Job | null = null;
  let pumping = false;
  let disposed = false;
  const stats = {
    requests: 0,
    suggestions: 0,
    none: 0,
    errors: 0,
    cancelled: 0,
    lastLatencyMs: 0,
  };
  const keyFor = (prepared: Prepared) =>
    JSON.stringify([
      prepared.context.turnId,
      prepared.context.revision,
      prepared.configKey,
      prepared.instructionRevision,
      prepared.memoryInstructionRevision,
    ]);
  const interested = (entry: Entry) =>
    !disposed &&
    !entry.controller.signal.aborted &&
    entries.get(entry.threadId) === entry &&
    (entry.clients.size > 0 ||
      (deps.configuration().backgroundPreparation &&
        entry.backgroundInterest &&
        entry.expires > now()));
  const settle = (job: Job, result: Outcome) => {
    if (job.settled) return;
    job.settled = true;
    job.view.result = result;
    job.view.serverMs = now() - job.enqueued + job.view.preparationMs;
    job.view.phase =
      result.kind === "suggestion"
        ? "ready"
        : result.kind === "none"
          ? "none"
          : "error";
    job.finish(result);
    deps.changed(job.threadId);
  };
  const cancelJob = (job: Job, reason: string) => {
    job.controller.abort();
    queue.delete(job.threadId);
    settle(job, unavailable(reason));
  };
  function remove(threadId: string) {
    const entry = entries.get(threadId);
    if (!entry) return;
    cancelMemory(threadId);
    entries.delete(threadId);
    clearTimeout(entry.timer);
    entry.controller.abort();
    if (entry.job && !entry.job.settled) cancelJob(entry.job, "cancelled");
    deps.changed(threadId);
  }
  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (queue.size && !disposed) {
        const jobs = [...queue.values()].sort(
          (a, b) =>
            Number((entries.get(b.threadId)?.clients.size ?? 0) > 0) -
              Number((entries.get(a.threadId)?.clients.size ?? 0) > 0) ||
            a.enqueued - b.enqueued,
        );
        const job = jobs[0]!;
        queue.delete(job.threadId);
        const entry = entries.get(job.threadId);
        if (!entry || !interested(entry) || entry.job !== job || job.settled) {
          cancelJob(job, "stale");
          continue;
        }
        running = job;
        const deadline = AbortSignal.timeout(deps.configuration().timeoutMs);
        const signal = AbortSignal.any([
          deadline,
          entry.controller.signal,
          job.controller.signal,
        ]);
        try {
          const fresh = await deps.prepare(job.threadId, entry.memory, signal);
          if (
            !interested(entry) ||
            !fresh?.context.eligible ||
            keyFor(fresh) !== keyFor(job.prepared) ||
            signal.aborted
          ) {
            settle(job, unavailable("stale"));
            continue;
          }
          const previous = ledger.get(job.key);
          if (previous?.role === "suggestion") {
            settle(job, await previous.job.done);
            continue;
          }
          if (
            !ledger.admit(
              job.key,
              { role: "suggestion", job },
              deps.configuration().maxRequestsPerHour,
            )
          ) {
            settle(job, unavailable("rate_limited"));
            continue;
          }
          stats.requests++;
          job.view.phase = "pending";
          job.view.queueMs = now() - job.enqueued;
          deps.changed(job.threadId);
          const began = now();
          const result = await deps
            .generate(job.threadId, fresh, signal, (measurement) => {
              job.view.usage = measurement.usage;
              job.view.actualModel = measurement.actualModel;
              job.view.actualServiceTier =
                measurement.actualServiceTier ?? null;
              job.view.finishReason = measurement.finishReason;
            })
            .finally(() => {
              job.view.modelMs = now() - began;
              stats.lastLatencyMs = job.view.modelMs;
            });
          const validationBegan = now();
          const current = await deps.prepare(
            job.threadId,
            entry.memory,
            signal,
          );
          if (
            signal.aborted ||
            !interested(entry) ||
            entry.job !== job ||
            !current?.context.eligible ||
            keyFor(current) !== keyFor(fresh)
          ) {
            settle(job, unavailable("stale"));
            continue;
          }
          job.view.validationMs = now() - validationBegan;
          if (result.kind === "suggestion") stats.suggestions++;
          else stats.none++;
          settle(job, result);
          memoryQueue.set(entry.threadId, {
            entry,
            prepared: fresh,
            key: JSON.stringify(["memory", entry.threadId, keyFor(fresh)]),
            controller: new AbortController(),
          });
        } catch (error) {
          if (error instanceof IncompleteGenerationError)
            job.view.outputTokenLimit = error.outputTokenLimit;
          const reason = deadline.aborted
            ? "timeout"
            : signal.aborted
              ? "cancelled"
              : error instanceof IncompleteGenerationError
                ? error.code
                : error instanceof experimental_AiGenerationError &&
                    error.code === "busy"
                  ? "busy"
                  : "generation_failed";
          if (reason === "cancelled") stats.cancelled++;
          else stats.errors++;
          settle(job, unavailable(reason));
        } finally {
          running = null;
        }
      }
    } finally {
      pumping = false;
      void pumpMemory();
    }
  }
  function cancelMemory(threadId: string) {
    memoryQueue.get(threadId)?.controller.abort();
    memoryQueue.delete(threadId);
    if (memoryRunning?.entry.threadId === threadId)
      memoryRunning.controller.abort();
  }
  async function pumpMemory() {
    if (helperActive || memoryRunning || pumping || queue.size || disposed)
      return;
    const job = memoryQueue.values().next().value;
    if (!job) return;
    memoryQueue.delete(job.entry.threadId);
    memoryRunning = job;
    const signal = AbortSignal.any([
      job.controller.signal,
      job.entry.controller.signal,
      AbortSignal.timeout(deps.configuration().timeoutMs),
    ]);
    const valid = (fresh: Prepared | null) =>
      !signal.aborted &&
      interested(job.entry) &&
      deps.configuration().enabled &&
      fresh?.context.eligible &&
      keyFor(fresh) === keyFor(job.prepared);
    try {
      const fresh = await deps.prepare(
        job.entry.threadId,
        job.entry.memory,
        signal,
      );
      if (
        !valid(fresh) ||
        !fresh ||
        helperActive ||
        pumping ||
        queue.size ||
        ledger.get(job.key)
      )
        return;
      const limit = deps.configuration().maxRequestsPerHour;
      if (
        ledger.size() >= limit - 1 ||
        !ledger.admit(job.key, { role: "memory" }, limit)
      )
        return;
      stats.requests++;
      const state = taskStateSchema.parse(
        await deps.generateMemory(job.entry.threadId, fresh, signal),
      );
      validateStateSources(state, fresh.context.messages);
      if (!fresh.context.contextComplete && state.contextComplete)
        throw new Error("Unfounded complete context");
      const current = await deps.prepare(
        job.entry.threadId,
        job.entry.memory,
        signal,
      );
      if (!valid(current)) return;
      job.entry.memory = rememberTask(
        state,
        fresh.context.messages,
        fresh.context.boundary,
      );
      memoryStats.completed++;
      deps.changed(job.entry.threadId);
    } catch {
      if (signal.aborted) memoryStats.cancelled++;
      else memoryStats.errors++;
    } finally {
      memoryRunning = null;
      void pumpMemory();
    }
  }
  async function refresh(entry: Entry) {
    const began = now();
    const prepared = await deps.prepare(
      entry.threadId,
      entry.memory,
      entry.controller.signal,
    );
    if (!interested(entry)) return;
    entry.preparationMs = now() - began;
    if (!prepared || !deps.configuration().enabled) {
      entry.prepared = null;
      cancelMemory(entry.threadId);
      if (entry.job && !entry.job.settled) cancelJob(entry.job, "ineligible");
      entry.job = null;
      deps.changed(entry.threadId);
      return;
    }
    entry.prepared = prepared;
    const memoryJob =
      memoryQueue.get(entry.threadId) ??
      (memoryRunning?.entry === entry ? memoryRunning : null);
    if (
      memoryJob &&
      (!prepared.context.eligible ||
        keyFor(memoryJob.prepared) !== keyFor(prepared))
    )
      cancelMemory(entry.threadId);
    if (entry.memory && entry.memory.boundary !== prepared.context.boundary)
      entry.memory = null;
    if (!prepared.context.eligible) {
      if (entry.job && !entry.job.settled) cancelJob(entry.job, "stale");
      entry.job = null;
      deps.changed(entry.threadId);
      return;
    }
    const key = JSON.stringify([entry.threadId, keyFor(prepared)]);
    if (entry.job?.key === key) {
      if (!entry.job.settled || ledger.get(key)) return;
      entry.job = null;
    }
    if (entry.job && !entry.job.settled) cancelJob(entry.job, "stale");
    const existing = ledger.get(key);
    if (existing?.role === "suggestion") {
      entry.job = existing.job;
      deps.changed(entry.threadId);
      return;
    }
    let finish!: (result: Outcome) => void;
    const done = new Promise<Outcome>((resolve) => {
      finish = resolve;
    });
    const id = randomUUID();
    const job: Job = {
      key,
      id,
      threadId: entry.threadId,
      prepared,
      controller: new AbortController(),
      enqueued: now(),
      done,
      finish,
      settled: false,
      view: {
        phase: "queued",
        jobId: id,
        turnId: prepared.context.turnId,
        result: null,
        queueMs: 0,
        preparationMs: entry.preparationMs,
        modelMs: 0,
        validationMs: 0,
        serverMs: null,
        usage: null,
        actualModel: null,
        actualServiceTier: null,
        finishReason: null,
        outputTokenLimit: deps.configuration().outputTokenLimit || null,
      },
    };
    if (memoryRunning) memoryRunning.controller.abort();
    cancelMemory(entry.threadId);
    entry.job = job;
    queue.set(entry.threadId, job);
    deps.changed(entry.threadId);
    void pump();
  }
  async function wake(threadId: string) {
    const entry = entries.get(threadId);
    if (!entry || !interested(entry)) return;
    entry.dirty = true;
    if (entry.reading) return entry.reading;
    entry.reading = (async () => {
      while (entry.dirty && interested(entry)) {
        entry.dirty = false;
        try {
          await refresh(entry);
        } catch {
          entry.prepared = null;
          cancelMemory(threadId);
          if (entry.job && !entry.job.settled)
            cancelJob(entry.job, "unavailable");
          entry.job = null;
          deps.changed(threadId);
        }
      }
    })();
    try {
      await entry.reading;
    } finally {
      entry.reading = null;
    }
  }
  async function track(
    threadId: string,
    clientId: string,
    backgroundInterest = true,
  ) {
    if (disposed || !deps.configuration().enabled)
      return emptyView("not_configured");
    let entry = entries.get(threadId);
    if (!entry) {
      if (entries.size >= 8) {
        const oldest = [...entries.values()]
          .filter((item) => item.clients.size === 0)
          .sort((a, b) => a.expires - b.expires)[0];
        if (!oldest) return emptyView("busy");
        remove(oldest.threadId);
      }
      entry = {
        threadId,
        clients: new Set(),
        backgroundInterest,
        expires: now() + 600000,
        timer: setTimeout(() => remove(threadId), 600000),
        controller: new AbortController(),
        memory: null,
        prepared: null,
        job: null,
        preparationMs: 0,
        reading: null,
        dirty: false,
      };
      entry.timer.unref?.();
      entries.set(threadId, entry);
    } else {
      clearTimeout(entry.timer);
      entry.expires = now() + 600000;
      entry.timer = setTimeout(() => remove(threadId), 600000);
      entry.timer.unref?.();
    }
    entry.backgroundInterest ||= backgroundInterest;
    entry.clients.add(clientId);
    await wake(threadId);
    return state(threadId);
  }
  async function state(threadId: string): Promise<JobView> {
    const entry = entries.get(threadId);
    if (!entry || !interested(entry)) return emptyView("not_tracked");
    if (!entry.prepared) return emptyView("ineligible");
    const fresh = await deps
      .prepare(threadId, entry.memory, entry.controller.signal)
      .catch(() => null);
    if (!fresh || !interested(entry)) return emptyView("ineligible");
    const job = entry.job;
    if (job) {
      if (!fresh.context.eligible || keyFor(fresh) !== keyFor(job.prepared))
        return emptyView("stale");
      return { ...job.view };
    }
    return {
      ...emptyView("preparing_context"),
      phase: "prepared",
      result: null,
      turnId: fresh.context.turnId,
      preparationMs: entry.preparationMs,
    };
  }
  return {
    beginHelper(requestId: string) {
      if (disposed || helperActive) return null;
      helperActive = true;
      memoryRunning?.controller.abort();
      let admitted = false;
      const began = now();
      return {
        admit() {
          admitted = ledger.admit(
            JSON.stringify(["helper", requestId]),
            { role: "helper" },
            deps.configuration().maxRequestsPerHour,
          );
          if (admitted) {
            stats.requests++;
            helperStats.requests++;
          }
          return admitted;
        },
        finish(kind: "helper" | "none" | "unavailable", cancelled: boolean) {
          if (admitted) {
            helperStats.lastLatencyMs = now() - began;
            if (kind === "helper") helperStats.completed++;
            else if (kind === "none") helperStats.none++;
            else if (cancelled) helperStats.cancelled++;
            else helperStats.errors++;
          }
          helperActive = false;
          void pumpMemory();
        },
      };
    },
    track,
    state,
    wake,
    async suggest(
      threadId: string,
      clientId: string,
      expectedTurnId: string | null = null,
    ): Promise<Outcome> {
      const view = await track(threadId, clientId, false);
      const entry = entries.get(threadId);
      if (expectedTurnId !== null && view.turnId !== expectedTurnId)
        return unavailable("ineligible");
      if (!entry?.job) return view.result ?? unavailable("ineligible");
      const job = entry.job;
      const result = await job.done;
      const current = await state(threadId);
      return current.jobId === job.id ? result : unavailable("stale");
    },
    detach(threadId: string, clientId: string) {
      const entry = entries.get(threadId);
      if (!entry || !entry.clients.delete(clientId)) return false;
      if (!interested(entry)) cancelMemory(threadId);
      if (!interested(entry) && entry.job && !entry.job.settled)
        cancelJob(entry.job, "cancelled");
      return true;
    },
    cancel(threadId: string, clientId: string) {
      const entry = entries.get(threadId);
      if (
        !entry ||
        (entry.backgroundInterest &&
          deps.configuration().backgroundPreparation &&
          entry.expires > now()) ||
        entry.clients.size !== 1 ||
        !entry.clients.has(clientId) ||
        !entry.job ||
        entry.job.settled
      )
        return false;
      cancelMemory(threadId);
      cancelJob(entry.job, "cancelled");
      return true;
    },
    clearCache: remove,
    inspect(threadId: string) {
      return entries.get(threadId)?.memory ?? null;
    },
    reset() {
      for (const id of entries.keys()) remove(id);
    },
    dispose() {
      disposed = true;
      for (const id of entries.keys()) remove(id);
    },
    diagnostics() {
      return {
        ...stats,
        tracked: entries.size,
        queued: queue.size,
        active: running === null ? 0 : 1,
        admitted: ledger.size(),
        helper: { ...helperStats, active: helperActive ? 1 : 0 },
        memory: {
          ...memoryStats,
          active: memoryRunning ? 1 : 0,
          queued: memoryQueue.size,
        },
        scope: "current plugin process; rolling one-hour admission window",
      };
    },
  };
}
