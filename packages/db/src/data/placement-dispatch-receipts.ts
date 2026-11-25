import { placementPreparedGroups } from "./placement-prepared-input.js";
import {
  PlacementDispatchConflictError,
  PlacementGroupFairnessError,
} from "./placement-dispatch-errors.js";
import {
  reconcileSupersededPlacementRetries,
  spendPlacementRetry,
} from "./placement-retry.js";
import { classifyLocalQuestionAnswer } from "./conversation-questions.js";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  flattenPromptInputGroups,
  canonicalJsonBytes,
  placementBindingSchema,
  placementAuthoritySchema,
  turnRequestEventDataSchema,
  promptInputSchema,
  isStandaloneBuiltinCompactCommand,
  type PlacementAuthority,
  type PlacementBinding,
  type WorkspacePurpose,
  type TurnRequestEventData,
} from "@bb/domain";
import type {
  DbConnection,
  DbQueryConnection,
  DbTransaction,
} from "../connection.js";
import {
  events,
  placementEffects as effects,
  placementActionIdentities as identities,
  placementOperations as operations,
  placementAttempts as attempts,
  placementWorkers as workers,
  queuedThreadMessages as queue,
} from "../schema.js";
import { readPlacementOperationRecord } from "./placement-operations.js";
import {
  readPlacementWorker,
  readPlacementOwner,
} from "./placement-workers.js";
import { readPlacementThreadBinding } from "./placement-bindings.js";
import {
  olderCompatible,
  placementMemberIneligible,
} from "./placement-admission.js";
import {
  readPlacementActionReceipt,
  readPlacementQueueAttempts,
  queueMemberDigest,
} from "./placement-action-receipts.js";
import { getLatestTurnRequestEventRow } from "./events.js";
import { hasTimeWait } from "./queued-thread-messages.js";

export {
  PlacementDispatchConflictError,
  PlacementGroupFairnessError,
} from "./placement-dispatch-errors.js";
function requireReceipt(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new PlacementDispatchConflictError(reason);
}
const equal = (a: unknown, b: unknown) =>
  canonicalJsonBytes(a) === canonicalJsonBytes(b);
export type PlacementDispatchKey = { threadId: string; requestId: string };
export type PlacementExecutionGuard = {
  executionOwnerOperationId: string;
  fence: number;
  purpose: WorkspacePurpose;
};
export type PlacementOrdinaryDispatchInput = PlacementDispatchKey &
  PlacementExecutionGuard & {
    requestSequence: number;
    claimed: readonly { id: string; claimToken: string }[];
  };
type Attempt = typeof attempts.$inferSelect;

function snapshot<T>(db: DbQueryConnection, read: (tx: DbTransaction) => T): T {
  return "$client" in db
    ? db.transaction(read, { behavior: "deferred" })
    : read(db);
}
export function readPlacementDispatchReceipt(
  db: DbQueryConnection,
  key: PlacementDispatchKey,
) {
  return snapshot(db, (tx) => dispatchReceipt(tx, key));
}
function dispatchReceipt(db: DbQueryConnection, key: PlacementDispatchKey) {
  const row = db
    .select()
    .from(effects)
    .where(
      and(eq(effects.request, key.requestId), eq(effects.thread, key.threadId)),
    )
    .get();
  if (!row) return null;
  const members = db
    .select({ attempt: attempts, submissionUuid: identities.submissionUuid })
    .from(attempts)
    .innerJoin(identities, eq(identities.op, attempts.op))
    .where(eq(attempts.request, key.requestId))
    .orderBy(asc(attempts.ordinal))
    .all()
    .map(({ attempt, submissionUuid }) => ({ ...attempt, submissionUuid }));
  const { binding, execution, ...effect } = row;
  return {
    ...effect,
    binding: placementBindingSchema.parse(JSON.parse(binding)),
    execution: turnRequestEventDataSchema.shape.execution.parse(
      JSON.parse(execution),
    ),
    members,
  };
}
export function readPlacementResidentGuard(
  db: DbQueryConnection,
  threadId: string,
  purpose: WorkspacePurpose,
) {
  const b = readPlacementThreadBinding(db, threadId);
  const w = b && readPlacementWorker(db, b.ownerPluginId, b.workerId);
  if (!w?.ownerOperationId) return null;
  const guard = {
    executionOwnerOperationId: w.ownerOperationId,
    fence: w.fence,
    purpose,
  };
  return currentOwner(db, threadId, guard) ? guard : null;
}
function currentOwner(
  db: DbQueryConnection,
  threadId: string,
  guard: PlacementExecutionGuard,
) {
  const binding = readPlacementThreadBinding(db, threadId);
  if (!binding) return null;
  const w = readPlacementWorker(db, binding.ownerPluginId, binding.workerId);
  const op = readPlacementOperationRecord(db, guard.executionOwnerOperationId);
  const owner = readPlacementOwner(db, binding.providerId);
  if (
    !op?.binding ||
    !owner?.available ||
    owner.mode !== "managed" ||
    owner.ownerPluginId !== binding.ownerPluginId ||
    !w ||
    op.cancelRequested ||
    w.threadId !== threadId ||
    op.threadId !== threadId ||
    !equal(binding, op.binding) ||
    !["reserved", "resident", "active"].includes(w.slotState) ||
    w.fence !== guard.fence ||
    op.fence !== w.fence ||
    w.ownerOperationId !== op.id ||
    placementMemberIneligible(db, op, w, guard.purpose)
  )
    return null;
  const c = w.nativeCustody;
  if (
    !c?.lock ||
    c.status === "unknown" ||
    !equal(c.lock, w.fenceLock) ||
    c.generation !== binding.generation ||
    c.agentHostId !== binding.agentHostId ||
    (c.status === "held" &&
      (c.holder?.threadId !== threadId || c.holder.fence !== w.fence))
  )
    return null;
  return { binding, w };
}
export function readPlacementAdmittedExecution(
  db: DbQueryConnection,
  args: PlacementDispatchKey & { purpose: WorkspacePurpose },
) {
  return snapshot(db, (tx) => currentExecution(tx, args));
}
function currentExecution(
  db: DbQueryConnection,
  args: PlacementDispatchKey & { purpose: WorkspacePurpose },
) {
  const receipt = readPlacementDispatchReceipt(db, args);
  if (
    !receipt ||
    !receipt.liveEventId ||
    receipt.state !== "prepared" ||
    getLatestTurnRequestEventRow(db, args.threadId)?.id !== receipt.eventId
  )
    return null;
  const owner = currentOwner(db, args.threadId, {
    ...receipt,
    purpose: args.purpose,
  });
  if (
    !owner ||
    !equal(owner.binding, receipt.binding) ||
    !receipt.members.length
  )
    return null;
  for (const member of receipt.members) {
    const op = readPlacementOperationRecord(db, member.op);
    if (
      !op?.binding ||
      !equal(op.binding, receipt.binding) ||
      op.cancelRequested ||
      op.clientTurnRequestId !== args.requestId ||
      placementMemberIneligible(db, op, owner.w, args.purpose)
    )
      return null;
  }
  return receipt;
}
function validateAuth(
  authority: PlacementAuthority,
  body: TurnRequestEventData,
  row?: typeof queue.$inferSelect,
) {
  const p = body.dispatchProvenance;
  if (body.originPluginId !== undefined)
    requireReceipt(
      authority.plugin === body.originPluginId,
      "plugin attribution changed",
    );
  requireReceipt(
    authority.initiator === body.initiator &&
      authority.sender === body.senderThreadId &&
      authority.permission === body.execution.permissionMode &&
      authority.origin === (p?.origin ?? null) &&
      authority.plugin === (p?.originPluginId ?? body.originPluginId ?? null) &&
      equal(authority.requestedBy, p?.requestedBy ?? null) &&
      equal(authority.serviceTurn, body.serviceTurn ?? null),
    "event attribution changed",
  );
  if (row)
    requireReceipt(
      authority.sender === row.senderThreadId &&
        authority.origin === row.origin &&
        authority.plugin === row.originPluginId &&
        authority.permission === row.permissionMode &&
        row.requestedByInitiator ===
          (authority.requestedBy?.initiator ?? null) &&
        row.requestedByThreadId ===
          (authority.requestedBy?.senderThreadId ?? null) &&
        equal(row.serviceTurn, authority.serviceTurn),
      "queue attribution changed",
    );
}
function requestedEvent(
  tx: DbTransaction,
  args: PlacementDispatchKey & { requestSequence: number },
) {
  const event = getLatestTurnRequestEventRow(tx, args.threadId);
  requireReceipt(
    event && event.sequence === args.requestSequence,
    "requested event is not current",
  );
  const body = turnRequestEventDataSchema.parse(JSON.parse(event.data));
  requireReceipt(body.requestId === args.requestId, "wrong native request");
  return { event, body };
}
function assignEffect(
  tx: DbTransaction,
  args: PlacementDispatchKey &
    PlacementExecutionGuard & { requestSequence: number },
  eventId: string,
  body: TurnRequestEventData,
  binding: PlacementBinding,
  members: Attempt[],
  root: string,
) {
  requireReceipt(members.length, "empty request");
  requireReceipt(!dispatchReceipt(tx, args), "request already admitted");
  reconcileSupersededPlacementRetries(tx, args.threadId);
  tx.insert(effects)
    .values({
      request: args.requestId,
      eventId,
      liveEventId: eventId,
      requestSequence: args.requestSequence,
      thread: args.threadId,
      root,
      executionOwnerOperationId: args.executionOwnerOperationId,
      binding: canonicalJsonBytes(binding),
      fence: args.fence,
      execution: canonicalJsonBytes(body.execution),
      state: "prepared",
    })
    .run();
  members.forEach((m, ordinal) => {
    tx.update(attempts)
      .set({ request: args.requestId, ordinal })
      .where(
        and(
          eq(attempts.op, m.op),
          eq(attempts.step, m.step),
          eq(attempts.attempt, m.attempt),
        ),
      )
      .run();
    tx.update(operations)
      .set({
        clientTurnRequestId: args.requestId,
        phase: "admitted",
        revision: sql`${operations.revision}+1`,
        updatedAt: Date.now(),
      })
      .where(eq(operations.id, m.op))
      .run();
  });
  tx.update(workers)
    .set({ slotState: "active" })
    .where(
      and(
        eq(workers.ownerPluginId, binding.ownerPluginId),
        eq(workers.workerId, binding.workerId),
      ),
    )
    .run();
  return readPlacementDispatchReceipt(tx, args)!;
}
export function commitPlacementOrdinaryDispatch(
  tx: DbTransaction,
  args: PlacementOrdinaryDispatchInput,
) {
  const { event, body } = requestedEvent(tx, args);
  const owner = currentOwner(tx, args.threadId, args);
  requireReceipt(
    owner && args.claimed.length,
    "no current execution owner or claims",
  );
  const ids = args.claimed.map((c) => c.id);
  requireReceipt(
    equal(ids, body.sourceQueuedMessageIds ?? []),
    "native source order differs",
  );
  const token = args.claimed[0]!.claimToken;
  const rows = tx
    .select()
    .from(queue)
    .where(and(eq(queue.threadId, args.threadId), eq(queue.claimToken, token)))
    .orderBy(asc(queue.sortKey), asc(queue.id))
    .all();
  requireReceipt(
    token &&
      args.claimed.every((c) => c.claimToken === token) &&
      equal(
        ids,
        rows.map((r) => r.id),
      ),
    "partial or wrong claim",
  );
  const members: Attempt[] = [];
  const timeline: NonNullable<TurnRequestEventData["clientSubmissions"]> = [];
  const groups: NonNullable<TurnRequestEventData["inputGroups"]> = [];
  let groupAuthority: string | undefined;
  let root = args.requestId;
  let retryInput: TurnRequestEventData["input"] | undefined;
  for (const row of rows) {
    requireReceipt(
      row.placementOperationId &&
        row.state === "claimed" &&
        row.claimedAt !== null &&
        (!row.waitingOn || (hasTimeWait(row) && row.sendAt !== null)) &&
        (row.sendAt === null || row.sendAt <= Date.now()) &&
        (row.editHeldUntil === null || row.editHeldUntil <= Date.now()),
      "row is held or not due",
    );
    requireReceipt(
      row.model === body.execution.model &&
        row.reasoningLevel === body.execution.reasoningLevel &&
        row.serviceTier === body.execution.serviceTier,
      "execution differs",
    );
    const links = readPlacementQueueAttempts(tx, row.id);
    requireReceipt(
      links.length && links[0]!.op === row.placementOperationId,
      "missing queue associations",
    );
    const input = promptInputSchema.array().parse(JSON.parse(row.content));
    const offset = groups.length;
    if (row.payloadKind === "questionResponse") groups.push(input);
    for (const m of links) {
      const op = readPlacementOperationRecord(tx, m.op);
      const receipt = readPlacementActionReceipt(tx, m.op);
      requireReceipt(
        op?.binding &&
          receipt &&
          (receipt.submissionUuid || receipt.protocol) &&
          !op.cancelRequested &&
          op.threadId === args.threadId &&
          equal(owner.binding, op.binding) &&
          !placementMemberIneligible(tx, op, owner.w, args.purpose) &&
          m.request === null &&
          m.queueDigest === queueMemberDigest(row),
        "stale member",
      );
      requireReceipt(receipt.currentStep === m.step, "prior step incomplete");
      requireReceipt(
        receipt.steps[m.step]?.kind !== "clear" &&
          receipt.steps[m.step]?.kind !== "compact",
        "native control step required",
      );
      requireReceipt(
        op.preparedExecution === canonicalJsonBytes(body.execution),
        "member execution changed",
      );
      const auth = canonicalJsonBytes(receipt.authority);
      requireReceipt(
        groupAuthority === undefined || groupAuthority === auth,
        "incompatible group",
      );
      groupAuthority = auth;
      if (row.payloadKind === "inline") {
        requireReceipt(
          links.length === 1 && op.kind !== "retry" && !receipt.protocol,
          "ordinary membership changed",
        );
        const prepared = placementPreparedGroups(op.preparedRequest, op.kind);
        requireReceipt(
          equal(flattenPromptInputGroups(prepared), input),
          "ordinary input differs from preparation",
        );
        groups.push(...prepared);
      }
      const authority =
        row.payloadKind === "retry"
          ? placementAuthoritySchema.safeParse(
              op.retryDerivation?.executionAuthority,
            ).data
          : receipt.authority;
      requireReceipt(authority, "missing retry execution authority");
      validateAuth(authority, body, row);
      if (row.payloadKind === "retry") {
        requireReceipt(
          rows.length === 1 && links.length === 1 && op.consentId,
          "mixed retry",
        );
        requireReceipt(
          op.fence === null ||
            (op.id === args.executionOwnerOperationId &&
              op.fence === args.fence),
          "retry reservation changed",
        );
      }
      if (
        (row.payloadKind === "inline" || row.payloadKind === "retry") &&
        op.id !== args.executionOwnerOperationId
      ) {
        const earlier = olderCompatible(
          tx,
          op,
          owner.w,
          args.purpose,
          row.payloadKind === "inline" ? args.threadId : undefined,
        );
        if (earlier) {
          const head = rows[0]!;
          const maySeparate =
            row.payloadKind === "inline" &&
            rows.length > 1 &&
            head.placementOperationId === args.executionOwnerOperationId &&
            head.payloadKind === "inline" &&
            readPlacementQueueAttempts(tx, head.id).length === 1;
          throw new PlacementGroupFairnessError(
            maySeparate ? { id: head.id, claimToken: token } : null,
            op.id,
            earlier.id,
          );
        }
      }
      if (row.payloadKind === "retry") {
        const retry = spendPlacementRetry(
          tx,
          op,
          row,
          body,
          args.fence,
          event.sequence,
        );
        retryInput = retry.input;
        groups.push(...retry.groups);
        timeline.push(...retry.membership);
        root = retry.root;
      } else if (row.payloadKind === "deferredSteer") {
        requireReceipt(
          row.placementFence === args.fence,
          "replacement fence changed",
        );
        requireReceipt(
          rows.length === 1 &&
            row.retryOfTurnRequestId === body.deferredFromRequestId,
          "wrong deferred source",
        );
        if (m === links[0]) {
          const prior = readPlacementDispatchReceipt(tx, {
            threadId: args.threadId,
            requestId: row.retryOfTurnRequestId!,
          });
          requireReceipt(
            prior?.liveEventId &&
              ["refused", "refused_unsent"].includes(prior.state),
            "unproven deferred source",
          );
          const saved = tx
            .select()
            .from(events)
            .where(eq(events.id, prior.eventId))
            .get()!;
          const old = turnRequestEventDataSchema.parse(JSON.parse(saved.data));
          groups.push(...(old.inputGroups ?? [old.input]));
          timeline.push(...(old.clientSubmissions ?? []));
        }
      } else {
        if (row.payloadKind === "questionResponse")
          requireReceipt(
            receipt.authority.actor === "local-unverified" &&
              classifyLocalQuestionAnswer(tx, [row]) &&
              rows.length === 1 &&
              links.length === 1 &&
              body.questionResponse?.queuedMessageId === row.id &&
              body.questionResponse.questionId === row.questionId &&
              body.questionResponse.revision === row.questionRevision,
            "question receipt mismatch",
          );
        requireReceipt(
          (row.payloadKind === "inline" ||
            row.payloadKind === "questionResponse") &&
            row.placementFence === args.fence &&
            !body.retryOfRequestId &&
            body.retryAttempt === undefined &&
            !body.deferredFromRequestId,
          "unsupported row",
        );
        if (receipt.submissionUuid)
          timeline.push({
            id: receipt.submissionUuid,
            inputGroupIndex: offset,
          });
      }
      members.push(m);
    }
  }
  requireReceipt(
    equal(groups, body.inputGroups ?? [body.input]) &&
      equal(retryInput ?? flattenPromptInputGroups(groups), body.input) &&
      equal(timeline, body.clientSubmissions ?? []),
    "native input or presentation differs",
  );
  return assignEffect(tx, args, event.id, body, owner.binding, members, root);
}
export function commitPlacementCompactDispatch(
  tx: DbTransaction,
  args: PlacementDispatchKey &
    PlacementExecutionGuard & { requestSequence: number; operationId: string },
) {
  const { event, body } = requestedEvent(tx, args);
  const owner = currentOwner(tx, args.threadId, args);
  const action = readPlacementActionReceipt(tx, args.operationId);
  const step = action?.steps[0];
  requireReceipt(
    owner &&
      action &&
      args.operationId === args.executionOwnerOperationId &&
      step?.kind === "compact" &&
      !step.latest &&
      !body.sourceQueuedMessageIds?.length &&
      isStandaloneBuiltinCompactCommand(body.input),
    "invalid compact step",
  );
  requireReceipt(
    readPlacementOperationRecord(tx, args.operationId)?.preparedExecution ===
      canonicalJsonBytes(body.execution),
    "compact execution changed",
  );
  validateAuth(action.authority, body);
  const member = tx
    .insert(attempts)
    .values({ op: args.operationId, step: 0, attempt: 0 })
    .returning()
    .get();
  return assignEffect(
    tx,
    args,
    event.id,
    body,
    owner.binding,
    [member],
    args.requestId,
  );
}
export type PlacementCommandIdentity = {
  nativeExecutionId: string;
  commandId: string;
  agentSessionId: string;
  agentHostId: string;
};
type CommandArgs = PlacementDispatchKey &
  PlacementExecutionGuard &
  PlacementCommandIdentity;
function validateCommand(db: DbQueryConnection, args: CommandArgs) {
  const receipt = readPlacementAdmittedExecution(db, args);
  if (
    !receipt ||
    receipt.executionOwnerOperationId !== args.executionOwnerOperationId ||
    receipt.fence !== args.fence ||
    receipt.binding.agentHostId !== args.agentHostId ||
    ![args.commandId, args.nativeExecutionId, args.agentSessionId].every(
      Boolean,
    )
  )
    return null;
  return receipt;
}
export function preparePlacementExecutionCommand(
  db: DbConnection,
  args: CommandArgs,
) {
  return db.transaction(
    (tx) => {
      const r = validateCommand(tx, args);
      if (!r) return { kind: "refused" } as const;
      if (r.commandId !== null)
        return {
          kind:
            r.commandId === args.commandId &&
            r.nativeExecutionId === args.nativeExecutionId &&
            r.agentSessionId === args.agentSessionId
              ? "prepared"
              : "refused",
        } as const;
      tx.update(effects)
        .set({
          commandId: args.commandId,
          nativeExecutionId: args.nativeExecutionId,
          agentSessionId: args.agentSessionId,
        })
        .where(eq(effects.request, r.request))
        .run();
      return { kind: "prepared" } as const;
    },
    { behavior: "immediate" },
  );
}
export function claimPlacementExecutionCommand(
  db: DbConnection,
  args: CommandArgs & { currentAgentSessionId: string },
) {
  if (db.$client?.inTransaction !== false) return { kind: "refused" } as const;
  return db.transaction(
    (tx) => {
      const r = readPlacementDispatchReceipt(tx, args);
      if (
        !r ||
        r.commandId !== args.commandId ||
        r.nativeExecutionId !== args.nativeExecutionId ||
        r.agentSessionId !== args.agentSessionId ||
        args.currentAgentSessionId !== r.agentSessionId
      )
        return { kind: "refused" } as const;
      if (r.state === "possibly_sent") return { kind: "held" } as const;
      if (!validateCommand(tx, args)) return { kind: "refused" } as const;
      const changed = tx
        .update(effects)
        .set({ state: "possibly_sent" })
        .where(
          and(eq(effects.request, r.request), eq(effects.state, "prepared")),
        )
        .run();
      return { kind: changed.changes === 1 ? "won" : "held" } as const;
    },
    { behavior: "immediate" },
  );
}
export function settlePlacementExecutionCommand(
  tx: DbTransaction,
  args: PlacementDispatchKey &
    PlacementCommandIdentity & {
      executionOwnerOperationId: string;
      fence: number;
      outcome: "succeeded" | "failed_accepted" | "refused";
    },
) {
  const r = readPlacementDispatchReceipt(tx, args);
  if (
    !r ||
    r.commandId !== args.commandId ||
    r.nativeExecutionId !== args.nativeExecutionId ||
    r.agentSessionId !== args.agentSessionId ||
    r.binding.agentHostId !== args.agentHostId ||
    r.fence !== args.fence ||
    r.executionOwnerOperationId !== args.executionOwnerOperationId
  )
    return false;
  if (r.state === args.outcome) return true;
  if (r.state !== "possibly_sent") return false;
  tx.update(effects)
    .set({ state: args.outcome })
    .where(eq(effects.request, r.request))
    .run();
  for (const m of r.members)
    tx.update(operations)
      .set({
        phase: args.outcome === "succeeded" ? "active" : "failed",
        revision: sql`${operations.revision}+1`,
      })
      .where(
        and(
          eq(operations.id, m.op),
          eq(operations.clientTurnRequestId, r.request),
        ),
      )
      .run();
  return true;
}
export function refusePlacementBeforeHandoff(
  tx: DbTransaction,
  args: PlacementDispatchKey & {
    executionOwnerOperationId: string;
    fence: number;
  },
) {
  const r = readPlacementDispatchReceipt(tx, args);
  if (
    !r ||
    r.executionOwnerOperationId !== args.executionOwnerOperationId ||
    r.fence !== args.fence ||
    r.state !== "prepared"
  )
    return false;
  const native = tx
    .select({ seq: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, r.thread),
        eq(events.type, "client/turn/rejected"),
        sql`json_extract(${events.data},'$.requestId') = ${r.request}`,
      ),
    )
    .get();
  if (!native || native.seq <= r.requestSequence) return false;
  return (
    tx
      .update(effects)
      .set({ state: "refused_unsent" })
      .where(and(eq(effects.request, r.request), eq(effects.state, "prepared")))
      .run().changes === 1
  );
}
