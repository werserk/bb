import {
  commitPlacementOrdinaryDispatch,
  PlacementDispatchConflictError,
  placementPreparedGroups,
  noopNotifier,
  queuedThreadMessages,
  placementActionIdentities,
  placementAttempts,
  placementBindings,
  placementEffects,
  getStoredProviderSession,
  getLatestTurnRequestEventRow,
  placementOperations,
  readPlacementOperationRecord,
  releaseQueuedMessageClaim,
  type PlacementGroupFairnessError,
  type ClaimedQueuedThreadMessageRow,
  readPlacementQueueAttempts,
  readPlacementActionReceipt,
  readPlacementDispatchReceipt,
  events,
  type DbConnection,
  readPlacementResidentGuard,
  readPlacementOwner,
  readPlacementThreadBinding,
  type DbQueryConnection,
  type DbTransaction,
  type QueuedThreadMessageRow,
  getThread,
  type PlacementOrdinaryDispatchInput,
  type PlacementExecutionGuard,
} from "@bb/db";
import {
  canonicalJsonBytes,
  flattenPromptInputGroups,
  type PromptInput,
  clientSubmissionQueueId,
  resolvedThreadExecutionOptionsSchema,
  type ResolvedThreadExecutionOptions,
  type ThreadQueuedMessage,
  type TurnRequestEventData,
  isStandaloneBuiltinClearCommand,
  isStandaloneBuiltinCompactCommand,
  clientTurnRequestIdSchema,
  turnRequestEventDataSchema,
  type Thread,
  type WorkspacePurpose,
  type PermissionEscalation,
} from "@bb/domain";
import { createThreadRequestSchema } from "@bb/server-contract";
import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { MANAGED_EXECUTION_UNSUPPORTED } from "./managed-execution.js";
import type { AppDeps, PlacementSendScope } from "../../types.js";
import { ApiError } from "../../errors.js";
import type { DispatchAttemptArgs } from "./dispatch-attempt.js";

export type ReadPlacementScope = () => PlacementSendScope | null;

export interface ManagedQueuePlacement {
  firstStart?: {
    selectedQueueId: string;
    execution: ResolvedThreadExecutionOptions;
  };
  guard: PlacementExecutionGuard;
  groupsByQueueId: ReadonlyMap<string, PromptInput[][]>;
  readScope: ReadPlacementScope;
}

function missingQueueEntry(): never {
  throw new ApiError(404, "invalid_request", "Queued message not found");
}

// Request and queue keys identify the entire group, including siblings reached
// only through a consumed qsub. Only ownership metadata leaves this query.
function readQueueMemberOwners(
  db: DbQueryConnection,
  queueId: string,
  marker?: string,
) {
  const requests = db
    .select({ request: placementAttempts.request })
    .from(placementAttempts)
    .where(eq(placementAttempts.queueId, queueId));
  const members = db
    .select({ op: placementAttempts.op })
    .from(placementAttempts)
    .where(
      or(
        eq(placementAttempts.queueId, queueId),
        inArray(placementAttempts.request, requests),
      ),
    );
  return db
    .select({
      op: placementActionIdentities.op,
      threadId: placementOperations.threadId,
      principal: sql<string>`json_extract(${placementActionIdentities.authority}, '$.principal')`,
      actor: sql<string>`json_extract(${placementActionIdentities.authority}, '$.actor')`,
    })
    .from(placementActionIdentities)
    .innerJoin(
      placementOperations,
      eq(placementOperations.id, placementActionIdentities.op),
    )
    .where(
      or(
        inArray(placementActionIdentities.op, members),
        marker === undefined
          ? undefined
          : eq(placementActionIdentities.op, marker),
      ),
    )
    .all();
}

function assertQueueOwners(
  owners: ReturnType<typeof readQueueMemberOwners>,
  scope: PlacementSendScope | null,
  threadId: string,
  marker?: string,
) {
  if (
    !scope?.principal ||
    scope.identity !== "local-unverified" ||
    scope.authority !== "local-input-parity" ||
    !owners.length ||
    (marker !== undefined && !owners.some((owner) => owner.op === marker))
  )
    missingQueueEntry();
  for (const owner of owners) {
    // An accepted action can be marked before a thread binding exists. The
    // resident admission check below handles that live queue entry.
    const unboundMarker = owner.threadId === null && owner.op === marker;
    if (
      (owner.threadId !== threadId && !unboundMarker) ||
      owner.principal !== scope.principal ||
      owner.actor !== scope.identity
    )
      missingQueueEntry();
  }
}

export function authorizeManagedQueueMembers(
  db: DbQueryConnection,
  rows: readonly Pick<
    QueuedThreadMessageRow,
    "id" | "threadId" | "placementOperationId"
  >[],
  readScope?: ReadPlacementScope,
): boolean {
  const first = rows[0];
  if (!first) return false;
  if (!rows.some((row) => row.placementOperationId !== null)) {
    const thread = getThread(db, first.threadId);
    if (!thread || !threadRequiresPlacement(db, thread)) return false;
  }
  const scope = readScope?.() ?? null;
  for (const row of rows) {
    if (!row.placementOperationId) missingQueueEntry();
    const owners = readQueueMemberOwners(db, row.id, row.placementOperationId);
    assertQueueOwners(owners, scope, first.threadId, row.placementOperationId);
  }
  return true;
}

// A pending row is also the post-.270 refusal state. Only the original unspent
// independent action may admit a first request, even after native history edits.
export function requireManagedPendingStart(
  db: DbQueryConnection,
  head: Pick<
    QueuedThreadMessageRow,
    "id" | "threadId" | "placementOperationId" | "sendAt"
  >,
  selectedId: string,
): ResolvedThreadExecutionOptions {
  const thread = getThread(db, head.threadId);
  if (
    selectedId !== head.id ||
    !head.placementOperationId ||
    thread?.status !== "pending" ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    !thread.environmentId ||
    !thread.startupContext
  )
    placementDispatchUnavailable();
  const binding = db
    .select({ origin: placementBindings.boundFromOperationId })
    .from(placementBindings)
    .where(eq(placementBindings.threadId, thread.id))
    .get();
  const op = readPlacementOperationRecord(db, head.placementOperationId);
  const action = readPlacementActionReceipt(db, head.placementOperationId);
  if (
    binding?.origin !== head.placementOperationId ||
    op?.kind !== "independent" ||
    op.cancelRequested ||
    op.phase !== "queued" ||
    op.threadId !== thread.id ||
    op.queuedMessageId !== head.id ||
    !op.preparedRequest ||
    !op.preparedExecution ||
    !action?.submissionUuid ||
    clientSubmissionQueueId(action.submissionUuid) !== head.id
  )
    placementDispatchUnavailable();
  const request = createThreadRequestSchema.parse(
    JSON.parse(op.preparedRequest),
  );
  const execution = resolvedThreadExecutionOptionsSchema.parse(
    JSON.parse(op.preparedExecution),
  );
  if (
    head.sendAt !== (request.sendAt ?? null) ||
    request.environment.type !== "reuse" ||
    request.environment.environmentId !== thread.environmentId ||
    request.projectId !== thread.projectId ||
    request.providerId !== thread.providerId ||
    execution.source !== "client/thread/start"
  )
    placementDispatchUnavailable();
  const expectedContext = {
    kind: "pending",
    environmentIntent: request.environment,
    fork: null,
    startedOnBehalfOf: request.startedOnBehalfOf ?? null,
    titleProvided: Boolean(request.title),
    execution,
  };
  let actualContext: unknown;
  try {
    actualContext = JSON.parse(thread.startupContext);
  } catch {
    placementDispatchUnavailable();
  }
  if (
    canonicalJsonBytes(actualContext) !== canonicalJsonBytes(expectedContext) ||
    getStoredProviderSession(db, thread.id).kind !== "none" ||
    getLatestTurnRequestEventRow(db, thread.id) ||
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, thread.id),
          or(
            isNotNull(events.providerThreadId),
            isNotNull(events.turnId),
            eq(events.type, "client/thread/start"),
          ),
        ),
      )
      .limit(1)
      .get() ||
    db
      .select({ id: placementEffects.request })
      .from(placementEffects)
      .where(eq(placementEffects.thread, thread.id))
      .limit(1)
      .get()
  )
    placementDispatchUnavailable();
  return execution;
}

export function prepareManagedQueueGroup(
  db: DbQueryConnection,
  rows: readonly QueuedThreadMessageRow[],
  purpose?: WorkspacePurpose,
  readScope?: ReadPlacementScope,
  selectedId = rows[0]?.id,
): ManagedQueuePlacement {
  const threadId = rows[0]?.threadId;
  if (!threadId || !purpose || !readScope) placementDispatchUnavailable();
  const guard = readPlacementResidentGuard(db, threadId, purpose);
  if (!guard || rows.some((row) => row.placementFence !== guard.fence))
    placementDispatchUnavailable();
  const firstStart =
    getThread(db, threadId)?.status === "pending"
      ? {
          selectedQueueId: selectedId!,
          execution: requireManagedPendingStart(db, rows[0]!, selectedId!),
        }
      : undefined;
  const groupsByQueueId = new Map<string, PromptInput[][]>();
  for (const row of rows) {
    if (row.payloadKind !== "inline" || !row.placementOperationId)
      placementDispatchUnavailable();
    const op = readPlacementOperationRecord(db, row.placementOperationId);
    if (!op || op.cancelRequested) placementDispatchUnavailable();
    try {
      const groups = placementPreparedGroups(op.preparedRequest, op.kind);
      if (
        canonicalJsonBytes(flattenPromptInputGroups(groups)) !==
        canonicalJsonBytes(JSON.parse(row.content))
      )
        placementDispatchUnavailable();
      groupsByQueueId.set(row.id, groups);
    } catch (error) {
      if (error instanceof PlacementDispatchConflictError)
        placementDispatchUnavailable();
      throw error;
    }
  }
  return { guard, readScope, groupsByQueueId, firstStart };
}

export function managedOrdinaryPresentation(
  placement: ManagedQueuePlacement,
  rows: readonly ThreadQueuedMessage[],
) {
  const inputGroups: PromptInput[][] = [];
  const clientSubmissions: NonNullable<
    TurnRequestEventData["clientSubmissions"]
  > = [];
  for (const row of rows) {
    const prepared = placement.groupsByQueueId.get(row.id);
    if (!prepared) placementDispatchUnavailable();
    for (const id of row.clientSubmissionIds ?? [])
      clientSubmissions.push({ id, inputGroupIndex: inputGroups.length });
    inputGroups.push(...prepared);
  }
  return { inputGroups, clientSubmissions };
}

export function retainGrantedHead(
  deps: Pick<AppDeps, "db" | "hub" | "placementWorkspacePurpose">,
  original: readonly ClaimedQueuedThreadMessageRow[],
  placement: ManagedQueuePlacement,
  decision: PlacementGroupFairnessError,
) {
  const head = original[0];
  if (
    !head ||
    original.length < 2 ||
    decision.retainedHead?.id !== head.id ||
    decision.retainedHead.claimToken !== head.claimToken
  )
    placementDispatchUnavailable();
  deps.db.transaction(
    (tx) => {
      const sameClaim = and(
        eq(queuedThreadMessages.threadId, head.threadId),
        eq(queuedThreadMessages.claimToken, head.claimToken),
      );
      const order = [
        asc(queuedThreadMessages.sortKey),
        asc(queuedThreadMessages.id),
      ];
      const rows = tx
        .select({
          id: queuedThreadMessages.id,
          threadId: queuedThreadMessages.threadId,
          claimToken: queuedThreadMessages.claimToken,
          state: queuedThreadMessages.state,
          placementOperationId: queuedThreadMessages.placementOperationId,
          placementFence: queuedThreadMessages.placementFence,
          groupWithNext: queuedThreadMessages.groupWithNext,
        })
        .from(queuedThreadMessages)
        .where(sameClaim)
        .orderBy(...order)
        .all();
      if (
        rows.length !== original.length ||
        rows.some(
          (row, i) =>
            row.state !== "claimed" ||
            row.id !== original[i]!.id ||
            row.placementOperationId !== original[i]!.placementOperationId ||
            row.placementFence !== original[i]!.placementFence ||
            row.groupWithNext !== original[i]!.groupWithNext ||
            row.claimToken !== original[i]!.claimToken,
        )
      )
        placementDispatchUnavailable();
      if (!authorizeManagedQueueMembers(tx, rows, placement.readScope))
        placementDispatchUnavailable();
      const verifiedRows = tx
        .select()
        .from(queuedThreadMessages)
        .where(sameClaim)
        .orderBy(...order)
        .all();
      const current = prepareManagedQueueGroup(
        tx,
        verifiedRows,
        deps.placementWorkspacePurpose,
        placement.readScope,
      );
      if (
        current.guard.executionOwnerOperationId !==
          placement.guard.executionOwnerOperationId ||
        canonicalJsonBytes(current.guard.purpose) !==
          canonicalJsonBytes(placement.guard.purpose) ||
        current.guard.fence !== placement.guard.fence
      )
        placementDispatchUnavailable();
      for (const row of rows) {
        const links = readPlacementQueueAttempts(tx, row.id);
        if (
          !links.length ||
          links.some(
            (m) =>
              m.request !== null ||
              readPlacementOperationRecord(tx, m.op)?.cancelRequested !== false,
          )
        )
          placementDispatchUnavailable();
      }
      // Each native token CAS is a nested SQLite savepoint. A refusal rolls back every release.
      for (const row of original.slice(1))
        if (!releaseQueuedMessageClaim(deps.db, noopNotifier, row))
          placementDispatchUnavailable();
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(head.threadId, ["queue-changed"]);
  return { ...head, deferredSplitGroupIds: original.map((row) => row.id) };
}

export function threadRequiresPlacement(db: DbQueryConnection, thread: Thread) {
  return (
    readPlacementThreadBinding(db, thread.id) !== null ||
    readPlacementOwner(db, thread.providerId)?.mode === "managed"
  );
}

export function placementDispatchUnavailable(): never {
  throw new ApiError(
    409,
    "placement_dispatch_unavailable",
    "This input requires an admitted ordinary placement queue entry.",
  );
}

export function managedOrdinaryClaim(
  deps: Pick<AppDeps, "db">,
  args: DispatchAttemptArgs,
) {
  const { db } = deps;
  const placement =
    args.source.kind === "drain" ? args.source.placement : undefined;
  const claimed = args.source.kind === "drain" ? args.source.claimed : null;
  const binding = readPlacementThreadBinding(db, args.thread.id);
  if (
    !binding &&
    !claimed?.some((row) => row.placementOperationId !== null) &&
    readPlacementOwner(db, args.thread.providerId)?.mode !== "managed"
  )
    return null;
  if (
    !binding ||
    !placement ||
    !claimed?.length ||
    !claimed.every(
      (row) =>
        row.placementOperationId !== null &&
        row.payloadKind === "inline" &&
        !row.serviceTurn &&
        row.systemNotice === null,
    ) ||
    args.queuePayload.kind !== "inline" ||
    args.payload.compactFirst ||
    args.payload.serviceTurn ||
    args.retryOf ||
    args.systemNotice ||
    !args.thread.environmentId ||
    (placement.firstStart
      ? args.thread.status !== "pending" ||
        args.source.kind !== "drain" ||
        !args.source.sendNow
      : !["idle", "error"].includes(args.thread.status)) ||
    isStandaloneBuiltinCompactCommand(args.payload.input) ||
    isStandaloneBuiltinClearCommand(args.payload.input)
  )
    placementDispatchUnavailable();
  return { rows: claimed, ...placement };
}

export function managedOrdinaryRequest(
  tx: DbTransaction,
  args: PlacementOrdinaryDispatchInput,
  escalation: PermissionEscalation,
  readScope?: ReadPlacementScope,
  selectedFirstQueueId?: string,
) {
  const scope = readScope?.() ?? null;
  for (const claim of args.claimed)
    assertQueueOwners(
      readQueueMemberOwners(tx, claim.id),
      scope,
      args.threadId,
    );
  for (const claim of args.claimed) {
    const members = readPlacementQueueAttempts(tx, claim.id);
    for (const member of members) {
      const action = readPlacementActionReceipt(tx, member.op);
      if (
        !action ||
        action.authority.escalation !== escalation ||
        action.steps.length !== 1 ||
        action.steps[0]?.kind !== "input"
      )
        placementDispatchUnavailable();
    }
  }
  if (
    selectedFirstQueueId &&
    (!scope || args.claimed[0]?.id !== selectedFirstQueueId)
  )
    placementDispatchUnavailable();
  return commitPlacementOrdinaryDispatch(tx, {
    ...args,
    ...(selectedFirstQueueId && scope
      ? {
          explicitFirstSend: {
            queueId: selectedFirstQueueId,
            principal: scope.principal,
            actor: scope.identity,
          },
        }
      : {}),
  });
}

export function retainedManagedSend(
  db: DbConnection,
  args: {
    threadId: string;
    queuedMessageId: string;
    readPlacementScope?: ReadPlacementScope;
  },
) {
  return db.transaction(
    (tx) => {
      const owners = readQueueMemberOwners(tx, args.queuedMessageId);
      if (!owners.length) return null;
      assertQueueOwners(
        owners,
        args.readPlacementScope?.() ?? null,
        args.threadId,
      );
      const attempts = readPlacementQueueAttempts(tx, args.queuedMessageId);
      const requestIds = new Set(attempts.map((member) => member.request));
      const id = attempts[0]?.request;
      if (!id || requestIds.size !== 1) placementDispatchUnavailable();
      const key = {
        threadId: args.threadId,
        requestId: clientTurnRequestIdSchema.parse(id),
      };
      const receipt = readPlacementDispatchReceipt(tx, key);
      if (!receipt) missingQueueEntry();
      if (receipt.liveEventId !== receipt.eventId)
        placementDispatchUnavailable();
      const stored = tx
        .select({ data: events.data })
        .from(events)
        .where(
          and(
            eq(events.id, receipt.eventId),
            eq(events.threadId, key.threadId),
            eq(events.type, "client/turn/requested"),
            eq(events.sequence, receipt.requestSequence),
          ),
        )
        .get();
      if (!stored) placementDispatchUnavailable();
      const body = turnRequestEventDataSchema.parse(JSON.parse(stored.data));
      if (body.requestId !== key.requestId) placementDispatchUnavailable();
      const sources = body.sourceQueuedMessageIds;
      const submissionIds = (body.clientSubmissions ?? []).map(
        (member) => member.id,
      );
      const orderedQueues = [
        ...new Set(receipt.members.map((member) => member.queueId)),
      ];
      if (
        !sources?.includes(args.queuedMessageId) ||
        sources.length !== orderedQueues.length ||
        submissionIds.length !== receipt.members.length ||
        !submissionIds.every(
          (id, i) => receipt.members[i]?.submissionUuid === id,
        ) ||
        !sources.every((qid, i) => qid === orderedQueues[i]) ||
        !attempts.every((a) =>
          receipt.members.some(
            (m) =>
              m.op === a.op &&
              m.step === a.step &&
              m.attempt === a.attempt &&
              m.queueId === args.queuedMessageId,
          ),
        )
      )
        placementDispatchUnavailable();
      const details = {
        requested: {
          requestId: key.requestId,
          sequence: receipt.requestSequence,
        },
        sourceQueuedMessageIds: sources,
        submissionIds,
        state: receipt.state,
      };
      if (receipt.state === "succeeded")
        return {
          delivery: "sent" as const,
          requested: details.requested,
          sourceQueuedMessageIds: sources,
          submissionIds: details.submissionIds,
        };
      // Older receipts have no durable rejection identity. Rewritten timeline rows cannot establish it.
      if (
        receipt.state === "refused_unsent" &&
        "rejectionEventId" in receipt &&
        typeof receipt.rejectionEventId === "string" &&
        receipt.rejectionEventId.length > 0 &&
        "rejectionReason" in receipt &&
        (receipt.rejectionReason === MANAGED_EXECUTION_UNSUPPORTED ||
          receipt.rejectionReason === "managed_admission_unavailable")
      ) {
        throw new ApiError(
          409,
          receipt.rejectionReason,
          "Managed execution was refused before provider handoff.",
          { details, retryable: false },
        );
      }
      throw new ApiError(
        409,
        "placement_dispatch_recorded",
        "The queue entry has a committed dispatch receipt.",
        { details, retryable: false },
      );
    },
    { behavior: "deferred" },
  );
}
