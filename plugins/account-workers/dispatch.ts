import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { Binding } from "./bindings.js";
import { profileById } from "./profiles/index.js";

export const READY_DEADLINE_MS = 60_000;
export const WAIT_RECHECK_MS = 2_000;

export const RELEASED_MESSAGE = "account-workers: this thread's workspace binding was released; spawn a new thread.";

export interface DispatchVerdict {
  decision: MessageDispatchHookDecision;
  abandoned?: Binding;
}

export function decideDispatch(
  pluginId: string,
  context: Pick<MessageDispatchHookContext, "thread" | "requestedExecution">,
  record: Binding | null,
  now: number,
): DispatchVerdict {
  const { thread } = context;
  const ours = thread.originPluginId === pluginId;
  const wait = (reason: string): DispatchVerdict => ({
    decision: { action: "wait", reason: `account-workers: ${reason}`, recheckAt: now + WAIT_RECHECK_MS },
  });
  const reject = (message: string): DispatchVerdict => ({ decision: { action: "reject", message } });
  if (record === null) {
    if (!ours) return { decision: { action: "proceed" } };
    if (now - thread.createdAt > READY_DEADLINE_MS) return reject("account-workers: this thread never got its workspace binding; spawn a new thread.");
    return wait("waiting for the workspace binding");
  }
  if (record.releasedAt !== null) return reject(RELEASED_MESSAGE);
  const providerId = context.requestedExecution.providerId;
  if (!profileById(record.profile)?.providerIds.includes(providerId)) {
    return reject(`account-workers: this thread is bound for profile ${record.profile}; provider ${providerId} would run without its guards. Spawn a new thread for another provider.`);
  }
  if (!record.ready) {
    if (now - record.createdAt > READY_DEADLINE_MS) {
      return { ...reject("account-workers: the binding was never readied (spawn did not finish); spawn a new thread."), abandoned: record };
    }
    return wait("preparing the workspace binding");
  }
  return { decision: { action: "proceed" } };
}

export function safeDecide(
  pluginId: string,
  context: Pick<MessageDispatchHookContext, "thread" | "requestedExecution">,
  lookup: (threadId: string) => Binding | null,
  now: number,
  onError: (error: unknown) => void,
): DispatchVerdict {
  try {
    return decideDispatch(pluginId, context, lookup(context.thread.id), now);
  } catch (error) {
    onError(error);
    if (context.thread?.originPluginId === pluginId) {
      return { decision: { action: "wait", reason: "account-workers: binding check failed; retrying", recheckAt: now + WAIT_RECHECK_MS } };
    }
    return { decision: { action: "proceed" } };
  }
}
