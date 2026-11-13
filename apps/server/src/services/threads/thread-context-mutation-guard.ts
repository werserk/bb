import { ApiError } from "../../errors.js";

const inFlightByThreadId = new Map<string, number>();
const availableByThreadId = new Map<string, Set<() => void>>();

export class ThreadContextMutationBusyError extends ApiError {
  constructor(message = "Thread is processing another request") {
    super(409, "invalid_request", message);
  }
}

export class ThreadContextClearInProgressError extends ThreadContextMutationBusyError {
  constructor() {
    super("Thread context is being cleared");
  }
}

function acquireThreadContextMutationGuard(threadId: string, mode: "clear" | "send"): () => void {
  const inFlight = inFlightByThreadId.get(threadId) ?? 0;
  if (inFlight !== 0 && (mode === "clear" || inFlight < 0)) {
    if (mode === "send") throw new ThreadContextClearInProgressError();
    throw new ThreadContextMutationBusyError();
  }
  inFlightByThreadId.set(threadId, mode === "clear" ? -1 : inFlight + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = mode === "clear" ? 0 : (inFlightByThreadId.get(threadId) ?? 1) - 1;
    if (remaining !== 0) { inFlightByThreadId.set(threadId, remaining); return; }
    inFlightByThreadId.delete(threadId);
    const available = availableByThreadId.get(threadId);
    availableByThreadId.delete(threadId);
    for (const wake of available ?? []) wake();
  };
}

export function acquireThreadSendGuard(threadId: string): () => void {
  return acquireThreadContextMutationGuard(threadId, "send");
}

export function onThreadContextMutationAvailable(threadId: string, wake: () => void): () => void {
  let active = true;
  const notify = () => { if (active) { active = false; wake(); } };
  const available = availableByThreadId.get(threadId) ?? new Set();
  available.add(notify);
  availableByThreadId.set(threadId, available);
  if (!inFlightByThreadId.has(threadId)) queueMicrotask(notify);
  return () => {
    active = false;
    available.delete(notify);
    if (available.size === 0 && availableByThreadId.get(threadId) === available) availableByThreadId.delete(threadId);
  };
}

async function withThreadContextMutationGuard<T>(threadId: string, mode: "clear" | "send", work: () => Promise<T>): Promise<T> {
  const release = acquireThreadContextMutationGuard(threadId, mode);
  try { return await work(); } finally { release(); }
}

export async function withThreadSendGuard<T>(threadId: string, work: () => Promise<T>): Promise<T> {
  return withThreadContextMutationGuard(threadId, "send", work);
}

export async function withThreadContextClearGuard<T>(threadId: string, work: () => Promise<T>): Promise<T> {
  return withThreadContextMutationGuard(threadId, "clear", work);
}
