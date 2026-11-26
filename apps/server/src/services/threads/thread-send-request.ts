import { runWithSendDiagnostics } from "../system/send-diagnostics.js";
import {
  findRequestedSubmission,
  guardSubmission,
} from "./submission-admission.js";
import { isServerMoveFrozen } from "../server-move/freeze-state.js";
import { sendAdmissionResponseSchema } from "@bb/server-contract";
import { createThreadSendIntakeService } from "./thread-send-intake.js";
import type { SendIntakeAuthority } from "./send-intake-authority.js";
import { getExperiments, listThreadSendIntakes } from "@bb/db";
import {
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  type Thread,
} from "@bb/domain";
import type {
  SendMessageRequest,
  SendMessageResponse,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { attemptDispatch } from "./dispatch-attempt.js";
import { requireThreadCommandEnvironment } from "./thread-command-environment.js";
import { assertThreadHostAcceptsWork } from "./thread-host-admission.js";
import { runWithTurnTrace } from "../system/turn-trace.js";
import { assertProviderAcceptsPromptActions } from "../providers/provider-plan-command.js";

interface AcceptThreadSendRequestArgs {
  payload: SendMessageRequest;
  intake?: SendIntakeAuthority;
  thread: Thread;
}

async function acceptThreadSendRequestOnce(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  return runWithSendDiagnostics(
    deps,
    { threadId: args.thread.id, service: args.payload.serviceTurn ? 1 : 0 },
    () => acceptThreadSendRequestImpl(deps, args),
  );
}

async function acceptThreadSendRequestImpl(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  assertThreadHostAcceptsWork(deps.db, args.thread);
  assertProviderAcceptsPromptActions(deps.providerRegistry, {
    input: args.payload.input,
    providerId: args.thread.providerId,
  });
  const { compactFirst, ...request } = args.payload;
  if (isStandaloneBuiltinClearCommand(request.input)) {
    if (compactFirst) throwInvalidCompactFirst("cannot clear the context");
    const environment = await requireThreadCommandEnvironment(deps, {
      thread: args.thread,
    });
    await attemptDispatch(deps, {
      intake: args.intake,
      thread: args.thread,
      payload: request,
      source: { kind: "operation", environment },
      queuePayload: { kind: "inline" },
      pluginSubmission: null,
      systemNotice: null,
      origin: null,
      originPluginId: null,
      startedOnBehalfOf: null,
      trigger: "user",
    });
    return { ok: true, delivery: "sent" };
  }

  if (compactFirst) {
    if (isStandaloneBuiltinCompactCommand(request.input)) {
      throwInvalidCompactFirst("needs a message to send after compacting");
    }
    if (request.sendAt !== undefined) {
      throwInvalidCompactFirst("cannot be scheduled with sendAt");
    }
    if (request.mode === "steer") {
      throwInvalidCompactFirst("cannot steer a turn");
    }
  }
  const payload: SendMessageRequest = compactFirst
    ? { ...request, mode: "queue-if-active", compactFirst }
    : request;

  const outcome = await runWithTurnTrace(
    deps,
    { threadId: args.thread.id },
    () =>
      attemptDispatch(deps, {
        thread: args.thread,
        intake: args.intake,
        payload,
        source: { kind: "inline" },
        queuePayload: { kind: "inline" },
        pluginSubmission: payload.pluginSubmission ?? null,
        systemNotice: null,
        origin: payload.originPluginId === undefined ? null : "plugin",
        originPluginId: payload.originPluginId ?? null,
        startedOnBehalfOf: null,
        trigger: "user",
      }),
  );
  if (outcome.kind === "dispatched") {
    return { ok: true, delivery: "sent" };
  }
  return {
    ok: true,
    delivery: "queued",
    queuedMessage: outcome.entry,
  };
}

function throwInvalidCompactFirst(reason: string): never {
  throw new ApiError(400, "invalid_request", `compactFirst ${reason}`);
}

async function sendWithReceipt(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
  floor?: number,
): Promise<SendMessageResponse> {
  const id = args.payload.clientSubmissionId;
  const result = await acceptThreadSendRequestOnce(deps, args);
  if (!id) return result;
  if (result.delivery === "queued") return { ...result, submissionIds: [id] };
  if (isStandaloneBuiltinClearCommand(args.payload.input))
    return { ...result, submissionIds: [id], command: true as const };
  const { requested } = findRequestedSubmission(
    deps.db,
    args.thread.id,
    id,
    floor,
  );
  return requested ? { ...result, submissionIds: [id], requested } : result;
}

function executeThreadSendIntake(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  return sendWithReceipt(deps, args);
}

const readyIntakeDatabases = new WeakSet<object>();
const stoppedIntakeDatabases = new WeakSet<object>();
const closedIntakeDatabases = new WeakSet<object>();
const intakeServices = new WeakMap<object, ReturnType<typeof createThreadSendIntakeService>>();

export function getThreadSendIntakeService(deps: LoggedPendingInteractionWorkSessionDeps) {
  if (closedIntakeDatabases.has(deps.db) || stoppedIntakeDatabases.has(deps.db) || isServerMoveFrozen(deps.db))
    throw new ApiError(503, "intake_unavailable", "Pending send intake is stopped");
  let service = intakeServices.get(deps.db);
  if (!service) {
    service = createThreadSendIntakeService(deps, (payload, thread, intake) =>
      executeThreadSendIntake(deps, { payload, thread, intake }), () => readyIntakeDatabases.has(deps.db));
    intakeServices.set(deps.db, service);
  }
  return service;
}

function validateIntakeRequest(deps: LoggedPendingInteractionWorkSessionDeps, args: AcceptThreadSendRequestArgs): void {
  assertThreadHostAcceptsWork(deps.db, args.thread);
  assertProviderAcceptsPromptActions(deps.providerRegistry, { input: args.payload.input, providerId: args.thread.providerId });
  if (!args.payload.compactFirst) return;
  if (isStandaloneBuiltinClearCommand(args.payload.input)) throwInvalidCompactFirst("cannot clear the context");
  if (isStandaloneBuiltinCompactCommand(args.payload.input)) throwInvalidCompactFirst("needs a message to send after compacting");
  if (args.payload.sendAt !== undefined) throwInvalidCompactFirst("cannot be scheduled with sendAt");
  if (args.payload.mode === "steer") throwInvalidCompactFirst("cannot steer a turn");
}

export function acceptThreadSendRequestWithoutIntake(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  const id = args.payload.clientSubmissionId;
  return id
    ? guardSubmission(deps.db, args.thread.id, id, args.payload, (floor) =>
        sendWithReceipt(deps, args, floor),
      )
    : sendWithReceipt(deps, args);
}

export function isSendIntakeEnabled(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): boolean {
  return getExperiments(deps.db).sendIntake;
}

export function usesSendIntakeLane(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  threadId: string,
): boolean {
  return (
    isSendIntakeEnabled(deps) ||
    listThreadSendIntakes(deps.db, threadId, 1).length > 0
  );
}

export function assertSendIntakeEnabled(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
): void {
  if (!isSendIntakeEnabled(deps))
    throw new ApiError(404, "intake_disabled", "Pending send intake is not enabled");
}

export async function acceptThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AcceptThreadSendRequestArgs,
): Promise<SendMessageResponse> {
  if (!usesSendIntakeLane(deps, args.thread.id))
    return acceptThreadSendRequestWithoutIntake(deps, args);
  validateIntakeRequest(deps, args);
  const service = getThreadSendIntakeService(deps);
  const row = await service.admit(args.payload, args.thread);
  return service.wait(row.id);
}

export async function admitThreadSendRequest(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: { payload: import("@bb/server-contract").SendAdmissionRequest; thread: Thread },
): Promise<import("@bb/server-contract").SendAdmissionResponse> {
  assertSendIntakeEnabled(deps);
  validateIntakeRequest(deps, args);
  const { admissionVersion, ...payload } = args.payload;
  const row = await getThreadSendIntakeService(deps).admit(payload, args.thread);
  if (row.admissionReceipt === null) throw new ApiError(503, "intake_unavailable", "No committed admission receipt");
  return sendAdmissionResponseSchema.parse(JSON.parse(row.admissionReceipt));
}

export function startThreadSendIntakes(deps: LoggedPendingInteractionWorkSessionDeps): void {
  if (closedIntakeDatabases.has(deps.db) || isServerMoveFrozen(deps.db)) return;
  stoppedIntakeDatabases.delete(deps.db);
  readyIntakeDatabases.add(deps.db);
  getThreadSendIntakeService(deps).recover();
}

export function stopThreadSendIntakes(deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">, permanent = false): void {
  readyIntakeDatabases.delete(deps.db);
  if (permanent) closedIntakeDatabases.add(deps.db);
  stoppedIntakeDatabases.add(deps.db);
  intakeServices.get(deps.db)?.stop();
  intakeServices.delete(deps.db);
}
