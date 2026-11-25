import {
  retainedManagedSend,
  managedOrdinaryPresentation,
  retainGrantedHead,
  checkManagedQueueGroup,
  placementDispatchUnavailable,
  threadRequiresPlacement,
  type ReadPlacementScope,
  type ManagedQueuePlacement,
} from "./managed-queue-dispatch.js";
import {
  getLatestThreadSequence,
  PlacementGroupFairnessError,
  listQueuedThreadMessages,
  listStoredEventRowsContaining,
} from "@bb/db";
import { turnRequestEventDataSchema } from "@bb/domain";
import {
  queuedSubmissionMembership,
  queuedInputGroups,
} from "./submission-membership.js";
import { classifyLocalQuestionAnswer } from "@bb/db";
import { resolveDeferredSteerQueuedMessage } from "./deferred-steer.js";
import {
  hasOrdinaryQueuedThreadMessages,
  getQueuedQuestionResponseDeferral,
  isAppUpdateSendHoldSet,
  QuestionResponseNotDeliverableError,
  setQueuedThreadMessageFailureReason,
  claimNextQueuedThreadMessageGroup,
  claimQueuedThreadMessageGroup,
  createQueuedThreadMessageInTransaction,
  getEnvironment,
  getHost,
  getQueuedThreadMessage,
  getStoredProviderSession,
  getThread,
  holdQueuedThreadMessageForEdit,
  isOrdinaryTurnEndQueuedMessage,
  isThreadQueueAutoSendPaused,
  releaseQueuedMessageClaim,
  releaseQueuedThreadMessageEditHold,
  releaseStaleQueuedMessageClaims,
  type DbQueryConnection,
  type QueuedThreadMessageExecution,
  type QueuedThreadMessageGroupClaimPolicy,
  type QueuedThreadMessageGroupEligibility,
} from "@bb/db";
import {
  flattenPromptInputGroups,
  isQueuedMessageFailedState,
} from "@bb/domain";
import type {
  QueuedMessageDeliveryMode,
  QueuedMessageWaitingOn,
  Thread,
  ThreadQueuedMessage,
} from "@bb/domain";
import type {
  CreateQueuedMessageRequest,
  QueuedMessageEditHoldResponse,
  SendMessageRequest,
  SendQueuedMessageMode,
  UpdateQueuedMessageRequest,
} from "@bb/server-contract";
import type {
  AppDeps,
  LoggedPendingInteractionWorkSessionDeps,
} from "../../types.js";
import { ApiError } from "../../errors.js";
import { isCommandTimeoutError } from "../lib/error-log-fields.js";
import {
  parseStoredQueuedThreadMessageSystemNotice,
  parseStoredQueuedThreadMessageWaitingOn,
  storedQueuedThreadMessageRequestedBy,
  toThreadQueuedMessage,
} from "./thread-queued-messages.js";
import { buildExecutionOptions } from "./thread-commands.js";
import {
  getActiveTurnId,
  isActiveTurnMainRunIdle,
  isManualCompactionActive,
} from "./thread-events.js";
import { attemptDispatch, threadTargetHostId } from "./dispatch-attempt.js";
import {
  QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE,
  QUEUED_MESSAGE_CLAIM_LOST_CODE,
} from "./queue-waits.js";
import { recordQueuedMessageDrainFailure } from "./queue-drain-failure.js";
import {
  captureUserMessageSentTelemetry,
  ensureThreadQueueIsWritable,
  resolveMessageSenderThreadId,
} from "./thread-send.js";
import {
  goneThreadEnvironmentDetails,
  threadEnvironmentUnavailableDetails,
  throwThreadEnvironmentUnavailable,
} from "../lib/lifecycle-api-errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { ThreadContextClearInProgressError } from "./thread-context-mutation-guard.js";

interface SendQueuedMessageArgs {
  readPlacementScope?: ReadPlacementScope;
  claimPolicy: QueuedThreadMessageGroupClaimPolicy;
  mode: SendQueuedMessageMode;
  queuedMessageId: string;
  threadId: string;
}

type ClaimedQueuedMessage = Exclude<
  ReturnType<typeof claimQueuedThreadMessageGroup>,
  null
>[number];

interface SendClaimedQueuedMessageArgs {
  placement?: ManagedQueuePlacement;
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  /** True for an explicit "send now"; false for an ordinary drain. */
  sendNow: boolean;
  threadId: string;
}

interface SendClaimedQueuedMessageForThreadArgs {
  placement?: ManagedQueuePlacement;
  mode: SendQueuedMessageMode;
  queuedMessages: ClaimedQueuedMessage[];
  sendNow: boolean;
  thread: Thread;
}

export function createAutomaticQueuedMessageGroupEligibility(
  deps: Pick<AppDeps, "db" | "hub">,
  args: {
    now: number;
    retryingFailure: boolean;
    thread: Thread;
    idleDrain?: boolean;
  },
): QueuedThreadMessageGroupEligibility {
  const activeTurnId = getActiveTurnId(deps, args.thread.id);
  return (group) =>
    !threadRequiresPlacement(deps.db, args.thread) &&
    group.every((member) => {
      if (member.placementOperationId !== null) return false;
      if (
        args.idleDrain &&
        member.serviceTurn !== null &&
        // werserk fork: a retry keeps its position (see dispatch-attempt.ts).
        member.payloadKind !== "retry" &&
        hasOrdinaryQueuedThreadMessages(deps.db, args.thread.id)
      )
        return false;
      if (isQueuedMessageFailedState(member.state) && !args.retryingFailure)
        return false;
      const waitingOn = parseStoredQueuedThreadMessageWaitingOn(member);
      switch (waitingOn?.kind) {
        case undefined:
        case "plugin":
          return true;
        case "time":
          return member.sendAt !== null && member.sendAt <= args.now;
        case "thread-busy":
          if (
            member.payloadKind === "questionResponse" &&
            getQueuedQuestionResponseDeferral(deps.db, {
              threadId: args.thread.id,
              queuedMessageId: member.id,
            }) !== null
          )
            return (
              args.thread.status === "idle" || args.thread.status === "pending"
            );
          return (
            args.thread.status === "idle" ||
            args.thread.status === "pending" ||
            (classifyLocalQuestionAnswer(deps.db, group) !== undefined &&
              args.thread.status === "active") ||
            isActiveTurnMainRunIdle(deps, args.thread)
          );
        case "stopping":
          return (
            args.thread.status === "idle" || args.thread.status === "pending"
          );
        case "turn-starting":
          return (
            args.thread.status === "idle" ||
            (args.thread.status === "active" && activeTurnId !== null)
          );
        case "host-offline": {
          const environment =
            args.thread.environmentId === null
              ? null
              : getEnvironment(deps.db, args.thread.environmentId);
          const host =
            environment === null ? null : getHost(deps.db, environment.hostId);
          return (
            host !== null &&
            host.destroyedAt === null &&
            host.phase === "active" &&
            deps.hub.hasDaemonForHost(host.id)
          );
        }
        case "app-update":
          return !isAppUpdateSendHoldSet(deps.db);
        case "provisioning":
        case "interaction":
        case "superseded":
          return false;
      }
    });
}

export interface CreateQueuedMessageForThreadArgs {
  payload: CreateQueuedMessageRequest;
  thread: Thread;
}

function admitQueuedMessage(
  db: DbQueryConnection,
  thread: Thread,
): { hasProviderSession: boolean } {
  ensureThreadQueueIsWritable(thread);
  const hasProviderSession =
    getStoredProviderSession(db, thread.id).kind !== "none";
  if (thread.environmentId === null) {
    if (hasProviderSession) {
      throwThreadEnvironmentUnavailable(
        threadEnvironmentUnavailableDetails("never_attached", null),
      );
    }
    return { hasProviderSession };
  }
  const environment = getEnvironment(db, thread.environmentId);
  assertThreadHostAcceptsWork(db, thread);
  const goneDetails = environment
    ? goneThreadEnvironmentDetails(environment)
    : null;
  if (goneDetails) {
    throwThreadEnvironmentUnavailable(goneDetails);
  }
  return { hasProviderSession };
}

export async function createQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: CreateQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const { payload, thread } = args;
  ensureThreadQueueIsWritable(thread);
  const input = await resolvePromptAttachmentReferences({
    db: deps.db,
    dataDir: deps.config.dataDir,
    input: payload.input,
    projectId: thread.projectId,
    hostId: threadTargetHostId(deps, thread),
  });
  const execution = await buildExecutionOptions(deps, payload, {
    threadId: thread.id,
  });
  const senderThreadId = resolveMessageSenderThreadId(deps, {
    senderThreadId: payload.senderThreadId,
    targetThread: thread,
  });
  const { currentThread, hasProviderSession, queuedMessage } =
    deps.db.transaction(
      (tx) => {
        const currentThread = getThread(tx, thread.id);
        if (!currentThread) {
          throw new ApiError(404, "thread_not_found", "Thread not found");
        }
        const { hasProviderSession } = admitQueuedMessage(tx, currentThread);
        const queuedMessage = createQueuedThreadMessageInTransaction(tx, {
          threadId: thread.id,
          content: input,
          senderThreadId,
          model: execution.model,
          reasoningLevel: execution.reasoningLevel,
          permissionMode: execution.permissionMode,
          serviceTier: execution.serviceTier,
          // An explicit "queue this" is a message waiting for the running turn
          // to end, which is exactly `thread-busy`. Naming it rather than
          // leaving the wait null keeps every row on one vocabulary, and the
          // idle drain treats the two identically anyway.
          //
          // Queued while the thread is stopping, or after a manual stop whose
          // pause is still in force, it is instead a message the user composed
          // AFTER asking for the stop, so it carries `stopping` and runs once
          // the thread is idle rather than joining the rows the manual-stop
          // pause holds back.
          waitingOn:
            currentThread.status === "stopping" ||
            isThreadQueueAutoSendPaused(tx, thread.id)
              ? { kind: "stopping" }
              : { kind: "thread-busy" },
          sendAt: null,
          payload: { kind: "inline" },
          systemNotice: null,
          deliveryMode: "queue",
        });
        return { currentThread, hasProviderSession, queuedMessage };
      },
      { behavior: "immediate" },
    );
  deps.hub.notifyThread(thread.id, ["queue-changed"]);
  if (senderThreadId === null && payload.input.length > 0) {
    captureUserMessageSentTelemetry(deps, {
      isChildThread: thread.parentThreadId !== null,
      messageSource: "queued_message",
      providerId: thread.providerId,
      initiator: "user",
    });
  }
  if (
    (currentThread.status === "idle" && hasProviderSession) ||
    isActiveTurnMainRunIdle(deps, currentThread)
  ) {
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: thread.id,
    });
  }
  return toThreadQueuedMessage(queuedMessage);
}

export interface ResolveQueuedMessageExecutionChangeArgs {
  expectedUpdatedAt: number;
  queuedMessageId: string;
  request: Pick<
    UpdateQueuedMessageRequest,
    "model" | "permissionMode" | "reasoningLevel" | "serviceTier"
  >;
  thread: Thread;
}

export async function resolveQueuedMessageExecutionChange(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: ResolveQueuedMessageExecutionChangeArgs,
): Promise<QueuedThreadMessageExecution | null> {
  const { request } = args;
  if (
    request.model === undefined &&
    request.permissionMode === undefined &&
    request.reasoningLevel === undefined &&
    request.serviceTier === undefined
  ) {
    return null;
  }
  const row = getQueuedThreadMessage(deps.db, args.queuedMessageId);
  if (
    row === null ||
    row.threadId !== args.thread.id ||
    row.state === "claimed" ||
    row.updatedAt !== args.expectedUpdatedAt
  ) {
    return null;
  }
  const current = toThreadQueuedMessage(row);
  const resolved = await buildExecutionOptions(
    deps,
    {
      model: request.model ?? current.model,
      permissionMode: request.permissionMode ?? current.permissionMode,
      reasoningLevel: request.reasoningLevel ?? current.reasoningLevel,
      serviceTier: request.serviceTier ?? current.serviceTier,
    },
    { threadId: args.thread.id },
  );
  return {
    model: resolved.model,
    permissionMode: resolved.permissionMode,
    reasoningLevel: resolved.reasoningLevel,
    serviceTier: resolved.serviceTier,
  };
}

function isQueuedMessageAutoSendCandidate(
  thread: Thread | null,
): thread is Thread {
  return (
    thread !== null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.status !== "stopping"
  );
}

const STALE_QUEUED_MESSAGE_CLAIM_MS = 5 * 60 * 1000;
const QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS = 2 * 60 * 1000;
const activeQueuedMessageClaimTokens = new Set<string>();

function respectsManualStopPause(
  args: SendClaimedQueuedMessageForThreadArgs,
): boolean {
  return (
    args.mode === "auto" &&
    !args.sendNow &&
    args.queuedMessages.some(isOrdinaryTurnEndQueuedMessage)
  );
}

function sendModeForDeliveryMode(
  group: readonly { deliveryMode: QueuedMessageDeliveryMode }[],
): SendMessageRequest["mode"] {
  return group.some((row) => row.deliveryMode === "queue")
    ? "queue-if-active"
    : "auto";
}

function sendQueuedMessagePayload(
  queuedMessage: ThreadQueuedMessage,
  mode: SendMessageRequest["mode"],
  senderThreadId: string | null,
): SendMessageRequest {
  return {
    input: queuedMessage.content,
    serviceTurn: queuedMessage.serviceTurn ?? undefined,
    mode,
    model: queuedMessage.model,
    permissionMode: queuedMessage.permissionMode,
    reasoningLevel: queuedMessage.reasoningLevel,
    serviceTier: queuedMessage.serviceTier,
    ...(senderThreadId !== null ? { senderThreadId } : {}),
  };
}

function releaseQueuedMessageClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  queuedMessages: readonly ClaimedQueuedMessage[],
): void {
  for (const queuedMessage of queuedMessages) {
    releaseQueuedMessageClaim(deps.db, deps.hub, {
      id: queuedMessage.id,
      claimToken: queuedMessage.claimToken,
    });
  }
}

async function withActiveQueuedMessageClaims<T>(
  queuedMessages: readonly ClaimedQueuedMessage[],
  task: () => Promise<T>,
): Promise<T> {
  for (const queuedMessage of queuedMessages) {
    activeQueuedMessageClaimTokens.add(queuedMessage.claimToken);
  }
  try {
    return await task();
  } finally {
    for (const queuedMessage of queuedMessages) {
      activeQueuedMessageClaimTokens.delete(queuedMessage.claimToken);
    }
  }
}

function claimQueuedThreadMessageForSend(
  deps: Pick<AppDeps, "db" | "hub" | "placementWorkspacePurpose">,
  args: SendQueuedMessageArgs,
): { rows: ClaimedQueuedMessage[]; placement?: ManagedQueuePlacement } {
  let placement: ManagedQueuePlacement | undefined;
  const existingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (
    !existingQueuedMessage ||
    existingQueuedMessage.threadId !== args.threadId
  ) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }

  const policy = args.claimPolicy;
  const claimedQueuedMessages = claimQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.queuedMessageId,
    policy.kind === "explicit-send"
      ? {
          kind: "explicit-send",
          assertGroupAllowed: (tx, group) => {
            policy.assertGroupAllowed?.(tx, group);
            placement = checkManagedQueueGroup(
              tx,
              group,
              deps.placementWorkspacePurpose,
              args.readPlacementScope,
            );
          },
        }
      : policy,
  );
  if (claimedQueuedMessages) {
    return { rows: claimedQueuedMessages, placement };
  }
  if (args.claimPolicy.kind === "automatic") return { rows: [] };

  const latestQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (!latestQueuedMessage || latestQueuedMessage.threadId !== args.threadId) {
    throw new ApiError(404, "invalid_request", "Queued message not found");
  }
  throw new ApiError(
    409,
    "invalid_request",
    "Queued message is already being sent",
  );
}

function isQueuedMessageClaimLostError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_CLAIM_LOST_CODE
  );
}

function isQueuedMessageAutoSendPausedError(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.body.code === QUEUED_MESSAGE_AUTO_SEND_PAUSED_CODE
  );
}

async function sendClaimedQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const thread = getThread(deps.db, args.threadId);
  if (!thread) {
    throw new ApiError(404, "thread_not_found", "Thread not found");
  }
  return sendClaimedQueuedMessageForThread(deps, {
    mode: args.mode,
    queuedMessages: args.queuedMessages,
    sendNow: args.sendNow,
    placement: args.placement,
    thread,
  });
}

/**
 * Re-attempts a claimed group through the dispatch checkpoint.
 *
 * The drain is nothing but a re-attempt: the same checkpoint runs, so a row
 * whose wait cleared but whose thread went busy in the meantime simply queues
 * again on the new reason rather than dispatching into a running turn. The
 * claim the caller already won is handed to the attempt, which either consumes
 * it inside the dispatch transaction (exactly once) or gives it back.
 */
async function sendClaimedQueuedMessageForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  try {
    return await sendClaimedQueuedMessageForThreadImpl(deps, args);
  } catch (error) {
    if (!(error instanceof QuestionResponseNotDeliverableError)) throw error;
    releaseQueuedMessageClaims(deps, args.queuedMessages);
    const row = setQueuedThreadMessageFailureReason(deps.db, deps.hub, {
      id: error.queuedMessageId,
      threadId: args.thread.id,
      failureReason: error.message,
      now: Date.now(),
      retryDelaysMs: [],
    });
    if (!row) throw error;
    return toThreadQueuedMessage(row);
  }
}

async function sendClaimedQueuedMessageForThreadImpl(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendClaimedQueuedMessageForThreadArgs,
): Promise<ThreadQueuedMessage> {
  const queuedMessages = args.queuedMessages.map(toThreadQueuedMessage);
  const deferred = resolveDeferredSteerQueuedMessage(
    deps.db,
    queuedMessages[0]!,
  );
  const queuedMessage = deferred?.message ?? queuedMessages[0]!;
  const presentation = args.placement
    ? managedOrdinaryPresentation(args.placement, queuedMessages)
    : undefined;
  const inputGroups =
    presentation?.inputGroups ?? queuedInputGroups(deps.db, queuedMessages);
  const input = flattenPromptInputGroups(inputGroups);
  const lead = args.queuedMessages[0]!;
  const mode =
    args.mode === "auto" && !args.sendNow
      ? sendModeForDeliveryMode(args.queuedMessages)
      : args.mode;
  const systemNotice = parseStoredQueuedThreadMessageSystemNotice(lead);
  const outcome = await attemptDispatch(deps, {
    thread: args.thread,
    payload: {
      ...(systemNotice === null
        ? sendQueuedMessagePayload(
            { ...queuedMessage, content: input },
            mode,
            lead.senderThreadId,
          )
        : { input, mode }),
      ...(systemNotice === null
        ? {
            clientSubmissions:
              presentation?.clientSubmissions ??
              queuedSubmissionMembership(deps.db, queuedMessages),
            sourceQueuedMessageIds: queuedMessages.map((row) => row.id),
          }
        : {}),
      ...(inputGroups.length > 1 ? { inputGroups } : {}),
    },
    source: {
      kind: "drain",
      placement: args.placement,
      claimed: args.queuedMessages,
      respectManualStopPause: respectsManualStopPause(args),
      sendNow: args.sendNow,
    },
    queuePayload: queuedMessage.payload,
    pluginSubmission: null,
    systemNotice,
    ...(queuedMessage.payload.kind === "retry"
      ? {
          retryOf: {
            requestId: queuedMessage.payload.retryOfTurnRequestId,
            attempt: queuedMessage.payload.attempt,
          },
        }
      : {}),
    origin: lead.origin,
    originPluginId: lead.originPluginId,
    startedOnBehalfOf: storedQueuedThreadMessageRequestedBy(lead),
    trigger: "auto-dispatch",
  });
  if (
    args.sendNow &&
    args.mode !== "steer" &&
    outcome.kind === "queued" &&
    outcome.entry.waitingOn?.kind !== "stopping"
  ) {
    // "Send now" overrides every plugin wait and the row's own schedule, but
    // not a core wait — those guard invariants rather than express a policy.
    // The row is back on the queue with its new reason; say so rather than
    // returning a success the caller would read as "it went".
    //
    // `stopping` is the one core wait Send-now does clear, because pressing it
    // is what clears it: the row leaves the manual-stop pause behind and
    // dispatches when the stop lands. Refusing would leave the user no way to
    // express that intent until the stop finished.
    throw new ApiError(
      409,
      "queued_message_still_waiting",
      `This message cannot be sent yet: ${describeCoreWait(outcome.entry.waitingOn)}.`,
    );
  }
  return queuedMessage;
}

/** The user-facing half of a core wait, for a refused "Send now". */
function describeCoreWait(waitingOn: QueuedMessageWaitingOn | null): string {
  switch (waitingOn?.kind) {
    case "provisioning":
      return "the thread's workspace is still being prepared";
    case "host-offline":
      return `the "${waitingOn.hostName}" host is not ready`;
    case "interaction":
      return "the thread is waiting for you to answer a pending interaction";
    case "turn-starting":
      return "the current turn is still starting";
    case "stopping":
      return "the thread is still stopping";
    case "app-update":
      return "bb is restarting to update";
    case "plugin":
      return `it is waiting on the "${waitingOn.pluginId}" plugin`;
    case "superseded":
      return "a newer message was sent after it";
    case "time":
    case "thread-busy":
    case undefined:
      return "the thread is already running a turn";
  }
}

export async function sendQueuedMessage(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: SendQueuedMessageArgs,
): Promise<ThreadQueuedMessage> {
  const sendNow = args.claimPolicy.kind === "explicit-send";
  const { rows: queuedMessages, placement } = claimQueuedThreadMessageForSend(
    deps,
    args,
  );
  if (queuedMessages.length === 0) {
    const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);
    if (!existing)
      throw new ApiError(404, "invalid_request", "Queued message not found");
    return toThreadQueuedMessage(existing);
  }
  const thread = getThread(deps.db, args.threadId);
  if (
    thread &&
    (isManualCompactionActive(deps, thread) ||
      (args.mode === "auto" &&
        !sendNow &&
        queuedMessages.some(isOrdinaryTurnEndQueuedMessage) &&
        isThreadQueueAutoSendPaused(deps.db, thread.id)))
  ) {
    releaseQueuedMessageClaims(deps, queuedMessages);
    return toThreadQueuedMessage(queuedMessages[0]!);
  }
  const dispatch = (rows: ClaimedQueuedMessage[]) =>
    sendClaimedQueuedMessage(deps, {
      mode: args.mode,
      queuedMessages: rows,
      placement,
      sendNow,
      threadId: args.threadId,
    });
  try {
    return await withActiveQueuedMessageClaims(queuedMessages, async () => {
      try {
        return await dispatch(queuedMessages);
      } catch (error) {
        if (!(error instanceof PlacementGroupFairnessError) || !placement)
          throw error;
        const head = retainGrantedHead(deps, queuedMessages, placement, error);
        return dispatch([head]);
      }
    });
  } catch (error) {
    releaseQueuedMessageClaims(deps, queuedMessages);
    if (
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return toThreadQueuedMessage(queuedMessages[0]!);
    }
    throw error;
  }
}

export async function sendQueuedMessageNow(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    readPlacementScope?: ReadPlacementScope;
    mode: SendQueuedMessageMode;
    queuedMessageId: string;
    threadId: string;
  },
): Promise<
  | {
      delivery: "sent";
      sourceQueuedMessageIds?: string[];
      submissionIds?: string[];
      requested?: {
        requestId: import("@bb/domain").ClientTurnRequestId;
        sequence: number;
      };
    }
  | {
      delivery: "queued";
      queuedMessage: ThreadQueuedMessage;
      sourceQueuedMessageIds?: string[];
      submissionIds?: string[];
    }
> {
  const existing = getQueuedThreadMessage(deps.db, args.queuedMessageId);
  if (!existing) {
    const retained = retainedManagedSend(deps.db, args);
    if (retained) return retained;
  }
  const requestThread = getThread(deps.db, args.threadId);
  const managed =
    existing?.placementOperationId != null ||
    (requestThread && threadRequiresPlacement(deps.db, requestThread));
  const before = managed
    ? []
    : listQueuedThreadMessages(deps.db, args.threadId).map(
        toThreadQueuedMessage,
      );
  const index = before.findIndex((row) => row.id === args.queuedMessageId);
  const selection: ThreadQueuedMessage[] = [];
  if (index === 0) {
    for (const row of before) {
      selection.push(row);
      if (!row.groupWithNext) break;
    }
  } else if (index > 0) selection.push(before[index]!);
  const sourceQueuedMessageIds = selection.map((row) => row.id);
  const submissionIds = queuedSubmissionMembership(deps.db, selection).map(
    (entry) => entry.id,
  );
  const floor = getLatestThreadSequence(deps.db, { threadId: args.threadId });
  try {
    await sendQueuedMessage(deps, {
      claimPolicy: { kind: "explicit-send" },
      readPlacementScope: args.readPlacementScope,
      mode: args.mode,
      queuedMessageId: args.queuedMessageId,
      threadId: args.threadId,
    });
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 409 || error.status === 404) &&
      !getQueuedThreadMessage(deps.db, args.queuedMessageId)
    ) {
      const retained = retainedManagedSend(deps.db, args);
      if (retained) return retained;
    }
    throw error;
  }
  const remainingQueuedMessage = getQueuedThreadMessage(
    deps.db,
    args.queuedMessageId,
  );
  if (!remainingQueuedMessage) {
    const retained = retainedManagedSend(deps.db, args);
    if (retained) return retained;
  }
  if (managed) placementDispatchUnavailable();
  if (!remainingQueuedMessage && sourceQueuedMessageIds.length) {
    for (const row of listStoredEventRowsContaining(deps.db, {
      threadId: args.threadId,
      type: "client/turn/requested",
      window: 1000,
      afterSequence: floor,
      needles: [sourceQueuedMessageIds[0]!],
    })) {
      const request = turnRequestEventDataSchema.safeParse(
        JSON.parse(row.data),
      );
      if (
        request.success &&
        sourceQueuedMessageIds.every((id) =>
          request.data.sourceQueuedMessageIds?.includes(id),
        )
      )
        return {
          delivery: "sent",
          sourceQueuedMessageIds,
          submissionIds,
          requested: {
            requestId: request.data.requestId,
            sequence: row.sequence,
          },
        };
    }
  }
  return remainingQueuedMessage
    ? {
        sourceQueuedMessageIds,
        submissionIds,
        delivery: "queued",
        queuedMessage: toThreadQueuedMessage(remainingQueuedMessage),
      }
    : { delivery: "sent", sourceQueuedMessageIds, submissionIds };
}

export async function sendNextQueuedMessageIfPresent(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { threadId: string },
): Promise<boolean> {
  const initialThread = getThread(deps.db, args.threadId);
  if (!isQueuedMessageAutoSendCandidate(initialThread)) {
    return false;
  }

  const nextQueuedMessages = claimNextQueuedThreadMessageGroup(
    deps.db,
    deps.hub,
    args.threadId,
    createAutomaticQueuedMessageGroupEligibility(deps, {
      now: Date.now(),
      retryingFailure: false,
      thread: initialThread,
      idleDrain: true,
    }),
  );
  if (!nextQueuedMessages) {
    return false;
  }

  const thread = getThread(deps.db, args.threadId);
  if (
    !isQueuedMessageAutoSendCandidate(thread) ||
    isManualCompactionActive(deps, thread)
  ) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);
    return false;
  }

  try {
    await withActiveQueuedMessageClaims(nextQueuedMessages, () =>
      sendClaimedQueuedMessageForThread(deps, {
        mode: "auto",
        queuedMessages: nextQueuedMessages,
        sendNow: false,
        thread,
      }),
    );
  } catch (error) {
    releaseQueuedMessageClaims(deps, nextQueuedMessages);
    if (
      isQueuedMessageClaimLostError(error) ||
      isQueuedMessageAutoSendPausedError(error) ||
      error instanceof ThreadContextClearInProgressError
    ) {
      return false;
    }
    // Nobody is listening to this attempt, so the row itself has to carry what
    // happened — either as a `host-offline` wait it can recover from, or as a
    // failure reason the queued row renders. A host timeout is excluded: the
    // command is still in flight, so the attempt has not failed yet.
    if (!isCommandTimeoutError(error)) {
      recordQueuedMessageDrainFailure(deps, {
        error,
        now: Date.now(),
        row: nextQueuedMessages[0]!,
        thread,
      });
    }
    throw error;
  }
  return true;
}

export function releaseStaleQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): void {
  releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now - STALE_QUEUED_MESSAGE_CLAIM_MS,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

export function releaseOrphanedQueuedMessageDispatchClaims(
  deps: Pick<AppDeps, "db" | "hub">,
  now: number,
): number {
  return releaseStaleQueuedMessageClaims(deps.db, deps.hub, {
    claimedBefore: now + 1,
    protectedClaimTokens: [...activeQueuedMessageClaimTokens],
  });
}

interface QueuedMessageEditHoldArgs {
  queuedMessageId: string;
  threadId: string;
}

export function holdQueuedMessageForEdit(
  deps: Pick<AppDeps, "db">,
  args: QueuedMessageEditHoldArgs,
): QueuedMessageEditHoldResponse {
  const result = holdQueuedThreadMessageForEdit(deps.db, {
    heldUntil: Date.now() + QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS,
    id: args.queuedMessageId,
    threadId: args.threadId,
  });
  switch (result.kind) {
    case "not_found":
      throw new ApiError(404, "invalid_request", "Queued message not found");
    case "claimed":
      throw new ApiError(
        409,
        "invalid_request",
        "Queued message is already being sent",
      );
    case "held":
      return { leaseMs: QUEUED_MESSAGE_EDIT_HOLD_LEASE_MS };
  }
}

export function requestEditReleasedQueuedMessageDispatch(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  requestQueuedMessageDispatch(deps, {
    kind: "edit-released",
    queuedMessageId: args.queuedMessageId,
    threadId: args.threadId,
  });
}

export function releaseQueuedMessageEditHold(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QueuedMessageEditHoldArgs,
): void {
  if (
    releaseQueuedThreadMessageEditHold(deps.db, {
      id: args.queuedMessageId,
      threadId: args.threadId,
    })
  ) {
    requestEditReleasedQueuedMessageDispatch(deps, args);
  }
}
