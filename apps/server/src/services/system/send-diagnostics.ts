import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { roundDurationMs } from "@bb/process-utils";
import type { ServerLogger } from "../../types.js";

type SendStage =
  | "request"
  | "guards"
  | "dispatch"
  | "queue.dispatch"
  | "execution"
  | "context"
  | "send.prepare"
  | "runtime.config"
  | "config.workspace"
  | "config.plugins"
  | "config.env"
  | "environment.ready"
  | "host.ready"
  | "enqueue.done"
  | "daemon.send"
  | "daemon.ack";

interface SendScope {
  correlationId: string;
  threadId: string;
  service: 0 | 1;
  startedAt: number;
  logger: Pick<ServerLogger, "info">;
}

const currentSend = new AsyncLocalStorage<SendScope>();

function emit(
  scope: SendScope,
  stage: SendStage,
  status: 0 | 1 | 2,
  startedAt: number,
  messageId: string | null = null,
): void {
  const now = performance.now();
  scope.logger.info(
    {
      sendDiagnostic: {
        correlationId: scope.correlationId,
        threadId: scope.threadId,
        service: scope.service,
        stage,
        status,
        elapsedMs: roundDurationMs(now - scope.startedAt),
        durationMs: roundDurationMs(now - startedAt),
        messageId,
      },
    },
    "Send diagnostic",
  );
}

export function runWithSendDiagnostics<T>(
  deps: { logger: Pick<ServerLogger, "info"> },
  args: { threadId: string; service: 0 | 1; queuedMessageId?: string },
  work: () => Promise<T>,
): Promise<T> {
  if (currentSend.getStore()?.threadId === args.threadId) return work();
  return currentSend.run(
    {
      correlationId: randomUUID(),
      threadId: args.threadId,
      service: args.service,
      startedAt: performance.now(),
      logger: deps.logger,
    },
    () =>
      traceSendStage(
        args.queuedMessageId === undefined ? "request" : "queue.dispatch",
        work,
        args.queuedMessageId,
      ),
  );
}

export async function traceSendStage<T>(
  stage: SendStage,
  work: () => Promise<T>,
  messageId?: string,
): Promise<T> {
  const scope = currentSend.getStore();
  if (scope === undefined) return work();
  const startedAt = performance.now();
  emit(scope, stage, 0, startedAt, messageId);
  try {
    const result = await work();
    emit(scope, stage, 1, startedAt, messageId);
    return result;
  } catch (error) {
    emit(scope, stage, 2, startedAt, messageId);
    throw error;
  }
}

export function markSendDiagnostic(stage: SendStage, messageId?: string): void {
  const scope = currentSend.getStore();
  if (scope !== undefined) emit(scope, stage, 1, performance.now(), messageId);
}
