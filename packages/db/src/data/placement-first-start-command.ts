import { and, eq, isNotNull, ne, or } from "drizzle-orm";
import {
  canonicalJsonBytes,
  clientSubmissionQueueId,
  flattenPromptInputGroups,
  sha256Digest,
  turnRequestEventDataSchema,
  jsonValueSchema,
  type JsonValue,
  type PlacementBinding,
  type PromptInput,
} from "@bb/domain";
import type { DbTransaction } from "../connection.js";
import { events, placementBindings, placementEffects } from "../schema.js";
import { getStoredProviderSession } from "./events.js";
import { getThread } from "./threads.js";
import { readPlacementOperationRecord } from "./placement-operations.js";
import { readPlacementWorker } from "./placement-workers.js";
import { placementPreparedGroups } from "./placement-prepared-input.js";
import type { readPlacementDispatchReceipt } from "./placement-dispatch-receipts.js";

export type PlacementFirstStartClaim = {
  eventId: string;
  requestDigest: string;
  readCurrentManifest: (binding: PlacementBinding) => {
    runtimeRootKey: string;
    launchProfileId: string;
    agentSessionId: string;
  } | null;
};
type Receipt = NonNullable<ReturnType<typeof readPlacementDispatchReceipt>>;
function parseJson(text: string | null) {
  if (text === null) return null;
  try {
    return jsonValueSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}
function object(value: JsonValue | undefined) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}
function same(a: unknown, b: unknown) {
  return canonicalJsonBytes(a) === canonicalJsonBytes(b);
}
function hasOtherStart(tx: DbTransaction, r: Receipt) {
  return !!(
    tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, r.thread),
          or(
            isNotNull(events.providerThreadId),
            isNotNull(events.turnId),
            eq(events.type, "client/thread/start"),
            eq(events.type, "thread/started"),
            eq(events.type, "turn/started"),
            and(
              ne(events.id, r.eventId),
              eq(events.type, "client/turn/requested"),
            ),
          ),
        ),
      )
      .limit(1)
      .get() ||
    tx
      .select({ id: placementEffects.request })
      .from(placementEffects)
      .where(
        and(
          eq(placementEffects.thread, r.thread),
          ne(placementEffects.request, r.request),
        ),
      )
      .limit(1)
      .get() ||
    getStoredProviderSession(tx, r.thread).kind !== "none"
  );
}
export function permitsPlacementCommand(
  tx: DbTransaction,
  r: Receipt,
  proof?: PlacementFirstStartClaim,
) {
  const event = tx
    .select({
      id: events.id,
      type: events.type,
      thread: events.threadId,
      scope: events.scopeKind,
      sequence: events.sequence,
      data: events.data,
    })
    .from(events)
    .where(eq(events.id, r.eventId))
    .get();
  if (
    !event ||
    r.liveEventId !== event.id ||
    event.thread !== r.thread ||
    event.sequence !== r.requestSequence ||
    event.scope !== "thread" ||
    event.type !== "client/turn/requested"
  )
    return false;
  const parsed = turnRequestEventDataSchema.safeParse(parseJson(event.data));
  if (!parsed.success || parsed.data.requestId !== r.request) return false;
  const body = parsed.data;
  const thread = getThread(tx, r.thread);
  const binding = tx
    .select()
    .from(placementBindings)
    .where(eq(placementBindings.threadId, r.thread))
    .get();
  if (!thread || !binding) return false;
  const head = r.members[0];
  const origin =
    head?.op === binding.boundFromOperationId
      ? readPlacementOperationRecord(tx, head.op)
      : null;
  const prepared = object(parseJson(origin?.preparedRequest ?? null));
  const env = object(prepared?.environment);
  const originalStart =
    origin?.kind === "independent" &&
    head?.attempt === 0 &&
    head.step === 0 &&
    env?.type === "reuse";
  const marker =
    body.source === "spawn" ||
    body.target.kind === "thread-start" ||
    body.request.method === "thread/start";
  if (!marker && !originalStart && !proof && thread.status !== "pending")
    return true;
  if (
    !proof ||
    typeof proof.readCurrentManifest !== "function" ||
    proof.eventId !== event.id ||
    sha256Digest(canonicalJsonBytes(body)) !== proof.requestDigest ||
    body.source !== "spawn" ||
    body.target.kind !== "thread-start" ||
    body.request.method !== "thread/start" ||
    !originalStart ||
    thread.status !== "pending" ||
    thread.deletedAt !== null ||
    thread.archivedAt !== null ||
    !prepared ||
    !env ||
    thread.environmentId !== env.environmentId ||
    thread.projectId !== prepared.projectId ||
    thread.providerId !== prepared.providerId ||
    !origin ||
    origin.reservedThreadId !== thread.id ||
    origin.clientTurnRequestId !== r.request ||
    r.execution.source !== "client/thread/start" ||
    origin.preparedExecution !== canonicalJsonBytes(r.execution) ||
    !same(body.execution, r.execution) ||
    Object.keys(body.request.params).length ||
    body.serviceTurn ||
    body.systemMessageKind ||
    body.deferredFromRequestId ||
    body.retryOfRequestId ||
    body.retryAttempt ||
    body.questionResponse ||
    hasOtherStart(tx, r)
  )
    return false;
  const context = {
    kind: "pending",
    environmentIntent: prepared.environment,
    fork: null,
    startedOnBehalfOf: prepared.startedOnBehalfOf ?? null,
    titleProvided: Boolean(prepared.title),
    execution: r.execution,
  };
  if (!same(parseJson(thread.startupContext), context)) return false;
  const groups: PromptInput[][] = [];
  const timeline = [],
    queueIds = [];
  for (const m of r.members) {
    const op = readPlacementOperationRecord(tx, m.op);
    if (
      !op?.preparedRequest ||
      !m.submissionUuid ||
      m.queueId !== clientSubmissionQueueId(m.submissionUuid) ||
      m.queueId !== op.queuedMessageId ||
      m.ordinal !== queueIds.length ||
      m.step !== 0 ||
      m.attempt !== 0 ||
      !["independent", "continuation"].includes(op.kind) ||
      op.phase !== "admitted" ||
      op.preparedExecution !== origin.preparedExecution
    )
      return false;
    timeline.push({ id: m.submissionUuid, inputGroupIndex: groups.length });
    queueIds.push(m.queueId);
    groups.push(...placementPreparedGroups(op.preparedRequest, op.kind));
  }
  if (
    !same(body.input, flattenPromptInputGroups(groups)) ||
    !same(body.inputGroups ?? [body.input], groups) ||
    !same(body.clientSubmissions ?? [], timeline) ||
    !same(body.sourceQueuedMessageIds ?? [], queueIds)
  )
    return false;
  const w = readPlacementWorker(
    tx,
    r.binding.ownerPluginId,
    r.binding.workerId,
  );
  if (
    w?.slotState !== "active" ||
    w.nativeCustody?.status !== "free" ||
    !w.observation.launchProfileId ||
    !binding.runtimeRootKey
  )
    return false;
  try {
    const manifest = proof.readCurrentManifest(r.binding);
    return (
      !!manifest &&
      !("then" in manifest) &&
      manifest.runtimeRootKey === binding.runtimeRootKey &&
      manifest.launchProfileId === w.observation.launchProfileId &&
      manifest.agentSessionId === r.agentSessionId
    );
  } catch {
    return false;
  }
}
