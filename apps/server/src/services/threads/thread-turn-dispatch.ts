import type { SendIntakeAuthority } from "./send-intake-authority.js";
import type {
  PromptInput,
  TurnRequestEventData,
  ClientTurnRequestId,
  ServiceTurnDescriptor,
  ResolvedThreadExecutionOptions,
  SystemMessageKind,
  SystemMessageSubject,
  Thread,
  ThreadTurnInitiator,
} from "@bb/domain";
import { getThread, type DbTransaction, type EnvironmentRow } from "@bb/db";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  goneThreadEnvironmentDetails,
  throwEnvironmentNotReady,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import {
  requestThreadTargetReprovision,
  scheduleThreadProvisioningAdvance,
} from "./thread-provisioning.js";
import { applyLoggedThreadLifecycleEventInTransaction } from "./lifecycle-outcome.js";
import type { TurnRequestRetryMarker } from "./thread-events.js";
import { buildThreadStatusChangeMetadata } from "./thread-runtime-display.js";

export interface ReadyThreadEnvironment extends EnvironmentRow {
  path: string;
  status: "ready";
}

interface DispatchTurnDuringReprovisionArgs {
  intake?: SendIntakeAuthority;
  dispatchProvenance?: TurnRequestEventData["dispatchProvenance"];
  deferredFromRequestId?: ClientTurnRequestId;
  serviceTurn?: ServiceTurnDescriptor;
  beforeRequestAppendInTransaction?: (args: { tx: DbTransaction }) => void;
  deps: LoggedPendingInteractionWorkSessionDeps;
  environment: EnvironmentRow;
  execution: ResolvedThreadExecutionOptions;
  initiator: ThreadTurnInitiator;
  input: PromptInput[];
  clientSubmissions?: TurnRequestEventData["clientSubmissions"];
  sourceQueuedMessageIds?: string[];
  inputGroups?: PromptInput[][];
  originPluginId: string | null;
  retryOf?: TurnRequestRetryMarker;
  senderThreadId: string | null;
  systemMessageKind?: SystemMessageKind;
  systemMessageSubject?: SystemMessageSubject | null;
  thread: Thread;
}

export function requireReadyThreadEnvironment(
  environment: EnvironmentRow,
): ReadyThreadEnvironment {
  if (environment.status !== "ready" || !environment.path) {
    throwEnvironmentNotReady(environment);
  }

  return {
    ...environment,
    path: environment.path,
    status: "ready",
  };
}

export async function dispatchTurnDuringReprovision(
  args: DispatchTurnDuringReprovisionArgs,
): Promise<boolean> {
  if (args.environment.status === "ready" && args.environment.path) {
    return false;
  }

  const environmentProviderId = args.environment.environmentProviderId;
  const environmentProviderSelection =
    args.environment.environmentProviderSelection;
  if (
    environmentProviderId !== null &&
    environmentProviderSelection !== null &&
    args.environment.status !== "provisioning" &&
    args.environment.status !== "destroyed"
  ) {
    requestThreadTargetReprovision(args.deps, {
      intake: args.intake,
      dispatchProvenance: args.dispatchProvenance,
      deferredFromRequestId: args.deferredFromRequestId,
      serviceTurn: args.serviceTurn,
      beforeRequestAppendInTransaction: ({ tx }) => {
        args.beforeRequestAppendInTransaction?.({ tx });
        const prepared = applyLoggedThreadLifecycleEventInTransaction(
          { db: tx, logger: args.deps.logger },
          { event: { type: "run.preparing" }, threadId: args.thread.id },
        );
        if (!prepared.applied) {
          throwEnvironmentNotReady(args.environment);
        }
      },
      environment: args.environment,
      execution: args.execution,
      initiator: args.initiator,
      input: args.input,
      inputGroups: args.inputGroups,
      originPluginId: args.originPluginId,
      ...(args.retryOf !== undefined ? { retryOf: args.retryOf } : {}),
      clientSubmissions: args.clientSubmissions,
      sourceQueuedMessageIds: args.sourceQueuedMessageIds,
      senderThreadId: args.senderThreadId,
      systemMessageKind: args.systemMessageKind,
      systemMessageSubject: args.systemMessageSubject,
      provider: {
        environmentProviderId,
        selection: environmentProviderSelection,
      },
      thread: args.thread,
    });
    const startingThread = getThread(args.deps.db, args.thread.id);
    if (startingThread !== null) {
      args.deps.hub.notifyThread(
        args.thread.id,
        ["status-changed"],
        buildThreadStatusChangeMetadata(args.deps, startingThread),
      );
    }
    scheduleThreadProvisioningAdvance(args.deps, args.thread.id);
    return true;
  }

  const goneDetails = goneThreadEnvironmentDetails(args.environment);
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }

  throwEnvironmentNotReady(args.environment);
}
