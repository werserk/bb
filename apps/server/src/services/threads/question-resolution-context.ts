import { AsyncLocalStorage } from "node:async_hooks";
import type { QuestionResolutionInvocation } from "./question-resolution-scope.js";

const current = new AsyncLocalStorage<{
  invocation: QuestionResolutionInvocation | null;
  signal: AbortSignal;
  active: boolean;
}>();

export async function withQuestionResolutionInvocation<T>(
  invocation: QuestionResolutionInvocation | null,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const context = { invocation, signal, active: true };
  return current.run(context, async () => {
    try {
      return await run();
    } finally {
      context.active = false;
    }
  });
}

export function currentQuestionResolutionInvocation(): QuestionResolutionInvocation | null {
  const context = current.getStore();
  if (!context) return null;
  if (!context.active || context.signal.aborted || !context.invocation)
    throw new Error(
      "Verified question resolution invocation is unavailable or ended",
    );
  return { ...context.invocation, signal: context.signal };
}
