import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import type { ThreadAccountSetInput, ThreadAccountSetResult } from "./thread-account.js";
import type { PolicyCaller, ThreadPolicy } from "./thread-policy.js";
import { dispatchAccountSchema, type DispatchAccount } from "./contracts.js";

// The account a new thread's composer chose, applied on that thread's first
// dispatch (docs/THREAD_ACCOUNT_V1.md, "New thread account"). It is a
// decision that stores a policy, never a hold.

export { dispatchAccountSchema, type DispatchAccount } from "./contracts.js";

export interface DispatchAccountDeps {
  pluginId: string;
  policy: (threadId: string) => ThreadPolicy;
  permitted: (hostId: string) => boolean;
  set: (input: ThreadAccountSetInput, caller: PolicyCaller) => Promise<ThreadAccountSetResult>;
}

const PROCEED: MessageDispatchHookDecision = { action: "proceed" };

export function isPendingStart(context: MessageDispatchHookContext): boolean {
  return (
    context.thread.status === "pending" &&
    context.attempt === "start-turn" &&
    context.queuedMessages.length === 0
  );
}

function stored(current: ThreadPolicy, wanted: DispatchAccount["policy"]): boolean {
  return wanted.mode === "auto"
    ? current.mode === "auto"
    : current.mode === "named" &&
        current.accountId === wanted.accountId &&
        current.onLimit === (wanted.onLimit ?? "fallback-auto");
}

export function createDispatchAccountHook(deps: DispatchAccountDeps) {
  return async (context: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> => {
    const submission = context.experimental_submission;
    if (submission === null || submission.pluginId !== deps.pluginId) return PROCEED;
    const parsed = dispatchAccountSchema.safeParse(submission.data);
    if (!parsed.success)
      return {
        action: "reject",
        message:
          "Account Pooler received an invalid account choice for this thread; choose the account again.",
      };
    if (!isPendingStart(context)) return PROCEED;
    const threadId = context.thread.id;
    const { policy } = parsed.data;
    if (stored(deps.policy(threadId), policy)) return PROCEED;
    if (context.host === null || !deps.permitted(context.host.id))
      return {
        action: "reject",
        message:
          "This thread's machine has no Account Pooler role, so a chosen account would not apply. Start it with Auto, or give the machine a role with `bb pool machine role <host-id> <role>` (for example `trusted`).",
      };
    const result = await deps.set(
      { threadId, policy },
      { kind: "plugin", pluginId: deps.pluginId },
    );
    return result.ok ? PROCEED : { action: "reject", message: result.message };
  };
}
