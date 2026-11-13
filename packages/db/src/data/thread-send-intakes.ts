import { and, asc, desc, eq, gt, inArray, max, or, sql } from "drizzle-orm";
import { jsonObjectSchema } from "@bb/domain";
import type { DbConnection, DbQueryConnection, DbTransaction } from "../connection.js";
import { events, queuedThreadMessages, threadSendIntakes } from "../schema.js";
import { acquireProjectAttachmentOwnership } from "./project-attachments.js";

export type ThreadSendIntakeRow = typeof threadSendIntakes.$inferSelect;
export type ThreadSendIntakeClaim = ThreadSendIntakeRow & {
  claimToken: string;
  leaseExpiresAt: number;
};
export type ThreadSendIntakeEffectStage = "hook" | "mention" | "model" | "clear" | "compact" | "startup-cleanup" | "request";

export function readThreadSendIntakeEnvelope(row: ThreadSendIntakeRow) {
  if (row.currentEnvelope === null) return null;
  const { _intakeEffectStage: stage, ...payload } = jsonObjectSchema.parse(JSON.parse(row.currentEnvelope));
  if (stage !== undefined && stage !== "hook" && stage !== "mention" && stage !== "model" && stage !== "clear" &&
    stage !== "compact" && stage !== "startup-cleanup" && stage !== "request")
    throw new Error("Invalid intake effect stage");
  return { payload, effectStage: stage ?? null };
}
export type ThreadSendIntakeHandoff =
  | { kind: "queue"; id: string }
  | { kind: "request"; id: string; sequence: number }
  | { kind: "startup"; id: string }
  | { kind: "clear"; id: string };

export class ThreadSendIntakeConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThreadSendIntakeConflict";
  }
}

const openStates = ["staging", "pending", "preparing", "failed"] as const;

export function hasThreadSendIntakeNativeIdentity(db: DbQueryConnection, threadId: string, id: string): boolean {
  const queued = db.select({ id: queuedThreadMessages.id }).from(queuedThreadMessages)
    .where(sql`${queuedThreadMessages.id} = ${`qsub_${id}`} COLLATE NOCASE`).limit(1).get();
  if (queued) return true;
  return db.select({ id: events.id }).from(events).where(and(
    eq(events.threadId, threadId), eq(events.type, "client/turn/requested"),
    sql`EXISTS (SELECT 1 FROM json_each(${events.data}, '$.clientSubmissions') AS submission
      WHERE json_extract(submission.value, '$.id') = ${id} COLLATE NOCASE)`,
  )).limit(1).get() !== undefined;
}

export function getThreadSendIntake(db: DbQueryConnection, id: string): ThreadSendIntakeRow | null {
  return db.select().from(threadSendIntakes).where(eq(threadSendIntakes.id, id)).get() ?? null;
}

export function listThreadSendIntakes(db: DbQueryConnection, threadId: string, limit = 100): ThreadSendIntakeRow[] {
  return db.select().from(threadSendIntakes)
    .where(and(eq(threadSendIntakes.threadId, threadId), inArray(threadSendIntakes.state, [...openStates])))
    .orderBy(asc(threadSendIntakes.intakeOrder)).limit(limit).all();
}

export function listRecoverableThreadSendIntakeThreads(db: DbQueryConnection, afterThreadId: string | null = null, limit = 32): string[] {
  return db.selectDistinct({ threadId: threadSendIntakes.threadId }).from(threadSendIntakes)
    .where(and(inArray(threadSendIntakes.state, ["staging", "pending", "preparing"]),
      afterThreadId === null ? undefined : gt(threadSendIntakes.threadId, afterThreadId),
      sql`NOT EXISTS (SELECT 1 FROM thread_send_intakes AS head WHERE head.thread_id = ${threadSendIntakes.threadId} AND head.intake_order < ${threadSendIntakes.intakeOrder} AND head.state IN ('staging','pending','preparing','failed'))`))
    .orderBy(asc(threadSendIntakes.threadId)).limit(limit).all().map(row => row.threadId);
}

export function reserveThreadSendIntake(db: DbQueryConnection, args: {
  id: string; threadId: string; clientSubmissionId: string | null;
  envelope: string; fingerprint: string; now: number;
}): ThreadSendIntakeRow {
  return db.transaction(tx => {
    const previous = args.clientSubmissionId === null ? getThreadSendIntake(tx, args.id) :
      tx.select().from(threadSendIntakes).where(and(
        eq(threadSendIntakes.threadId, args.threadId), eq(threadSendIntakes.clientSubmissionId, args.clientSubmissionId),
      )).get();
    if (previous) {
      if (previous.threadId !== args.threadId || previous.originalFingerprint !== args.fingerprint)
        throw new ThreadSendIntakeConflict("Submission identity conflict");
      return previous;
    }
    if (getThreadSendIntake(tx, args.id)) throw new ThreadSendIntakeConflict("Submission identity belongs to another thread");
    const tail = tx.select({ order: max(threadSendIntakes.intakeOrder) }).from(threadSendIntakes)
      .where(eq(threadSendIntakes.threadId, args.threadId)).get()?.order ?? 0;
    return tx.insert(threadSendIntakes).values({
      id: args.id, threadId: args.threadId, clientSubmissionId: args.clientSubmissionId,
      intakeOrder: tail + 1, originalEnvelope: args.envelope, currentEnvelope: args.envelope,
      originalFingerprint: args.fingerprint, state: "staging", createdAt: args.now, updatedAt: args.now,
    }).returning().get();
  }, { behavior: "immediate" });
}

export function finaliseThreadSendIntake(tx: DbTransaction, args: {
  id: string; envelope: string; attachmentPaths: readonly string[]; admissionReceipt: string | null; now: number;
}): ThreadSendIntakeRow {
  const row = getThreadSendIntake(tx, args.id);
  if (!row || row.state !== "staging") throw new ThreadSendIntakeConflict("Intake no longer staging");
  acquireProjectAttachmentOwnership(tx, row.threadId, args.attachmentPaths);
  return tx.update(threadSendIntakes).set({
    currentEnvelope: args.envelope, state: "pending", admissionReceipt: args.admissionReceipt,
    updatedAt: args.now, revision: row.revision + 1,
  }).where(and(eq(threadSendIntakes.id, row.id), eq(threadSendIntakes.state, "staging"))).returning().get();
}

export function rejectThreadSendIntake(db: DbConnection, id: string, error: string, now: number, receipt: string | null = null): void {
  db.update(threadSendIntakes).set({ state: "rejected", originalEnvelope: null, currentEnvelope: null,
    lastError: error, nativeReceipt: receipt, revision: sql`${threadSendIntakes.revision} + 1`, updatedAt: now,
  }).where(and(eq(threadSendIntakes.id, id), eq(threadSendIntakes.state, "staging"))).run();
}

export function claimThreadSendIntake(db: DbConnection, args: {
  threadId: string; token: string; now: number; leaseMs: number;
}): ThreadSendIntakeClaim | null {
  return db.transaction(tx => {
    const row = listThreadSendIntakes(tx, args.threadId, 1)[0];
    if (!row || row.state === "staging" || row.state === "failed") return null;
    if (row.state === "preparing") {
      if (row.leaseExpiresAt !== null && row.leaseExpiresAt > args.now) return null;
      if (row.sealedAt !== null) {
        tx.update(threadSendIntakes).set({ state: "failed", claimToken: null, leaseExpiresAt: null,
          lastError: "Recovery required: effect-sealed claim expired", revision: row.revision + 1, updatedAt: args.now,
        }).where(eq(threadSendIntakes.id, row.id)).run();
        return null;
      }
    }
    const claimed = tx.update(threadSendIntakes).set({ state: "preparing", claimToken: args.token,
      claimEpoch: row.claimEpoch + 1, leaseExpiresAt: args.now + args.leaseMs,
      revision: row.revision + 1, lastError: null, updatedAt: args.now,
    }).where(and(eq(threadSendIntakes.id, row.id), eq(threadSendIntakes.revision, row.revision))).returning().get();
    return claimed?.claimToken !== null && claimed?.leaseExpiresAt !== null && claimed !== undefined
      ? { ...claimed, claimToken: claimed.claimToken, leaseExpiresAt: claimed.leaseExpiresAt } : null;
  }, { behavior: "immediate" });
}

function claimWhere(claim: ThreadSendIntakeClaim, now: number) {
  return and(eq(threadSendIntakes.id, claim.id), eq(threadSendIntakes.state, "preparing"),
    eq(threadSendIntakes.claimToken, claim.claimToken), eq(threadSendIntakes.claimEpoch, claim.claimEpoch),
    gt(threadSendIntakes.leaseExpiresAt, now));
}

export function assertThreadSendIntakeClaim(tx: DbQueryConnection, claim: ThreadSendIntakeClaim, now: number): ThreadSendIntakeRow {
  const row = tx.select().from(threadSendIntakes).where(claimWhere(claim, now)).get();
  if (!row) throw new ThreadSendIntakeConflict("Intake claim lost or expired");
  return row;
}

export function renewThreadSendIntakeClaim(db: DbConnection, claim: ThreadSendIntakeClaim, now: number, leaseMs: number): boolean {
  return db.update(threadSendIntakes).set({ leaseExpiresAt: now + leaseMs, updatedAt: now })
    .where(claimWhere(claim, now)).run().changes === 1;
}

export function sealThreadSendIntake(tx: DbTransaction, claim: ThreadSendIntakeClaim, now: number,
  stage: ThreadSendIntakeEffectStage = "request"): ThreadSendIntakeRow {
  const row = assertThreadSendIntakeClaim(tx, claim, now);
  const envelope = readThreadSendIntakeEnvelope(row);
  if (!envelope) throw new Error("Missing intake effect envelope");
  if (row.sealedAt !== null && envelope.effectStage === stage) return row;
  return tx.update(threadSendIntakes).set({ sealedAt: row.sealedAt ?? now,
    currentEnvelope: JSON.stringify({ ...envelope.payload, _intakeEffectStage: stage }), revision: row.revision + 1, updatedAt: now })
    .where(claimWhere(claim, now)).returning().get();
}

export function rejectClaimedThreadSendIntake(db: DbConnection, claim: ThreadSendIntakeClaim,
  receipt: string, error: string, now: number): boolean {
  return db.update(threadSendIntakes).set({ state: "rejected", originalEnvelope: null, currentEnvelope: null,
    nativeReceipt: receipt, lastError: error, claimToken: null, leaseExpiresAt: null,
    revision: sql`${threadSendIntakes.revision} + 1`, updatedAt: now,
  }).where(and(claimWhere(claim, now), sql`${threadSendIntakes.sealedAt} IS NULL`)).run().changes === 1;
}

export function deferThreadSendIntakeClaim(db: DbConnection, claim: ThreadSendIntakeClaim, now: number): boolean {
  return db.update(threadSendIntakes).set({ state: "pending", claimToken: null, leaseExpiresAt: null,
    revision: sql`${threadSendIntakes.revision} + 1`, updatedAt: now,
  }).where(and(claimWhere(claim, now), sql`${threadSendIntakes.sealedAt} IS NULL`)).run().changes === 1;
}

export function findThreadSendIntakeNativeRequest(db: DbQueryConnection, row: ThreadSendIntakeRow, requestId: string | null) {
  if (row.clientSubmissionId === null && requestId === null) return null;
  return db.select({ data: events.data, sequence: events.sequence }).from(events).where(and(
    eq(events.threadId, row.threadId), eq(events.type, "client/turn/requested"),
    or(requestId === null ? undefined : sql`json_extract(${events.data}, '$.requestId') = ${requestId}`,
      row.clientSubmissionId === null ? undefined : sql`EXISTS (
        SELECT 1 FROM json_each(${events.data}, '$.clientSubmissions') AS submission
        WHERE json_extract(submission.value, '$.id') = ${row.clientSubmissionId} COLLATE NOCASE)`),
  )).orderBy(desc(events.sequence)).limit(1).get() ?? null;
}

export function findThreadSendIntakeClearCompletion(db: DbQueryConnection, row: ThreadSendIntakeRow) {
  if (row.clearOperationId === null) return null;
  return db.select({ data: events.data }).from(events).where(and(eq(events.threadId, row.threadId),
    eq(events.type, "system/operation"), sql`json_extract(${events.data}, '$.operationId') = ${row.clearOperationId}`,
    sql`json_extract(${events.data}, '$.operation') = 'context_clear'`,
    sql`json_extract(${events.data}, '$.status') = 'completed'`,
  )).limit(1).get() ?? null;
}

export function hasThreadSendIntakeProviderAcceptance(db: DbQueryConnection, threadId: string, requestId: string, afterSequence: number): boolean {
  return db.select({ id: events.id }).from(events).where(and(eq(events.threadId, threadId),
    eq(events.type, "turn/input/accepted"), gt(events.sequence, afterSequence),
    sql`json_extract(${events.data}, '$.clientRequestId') = ${requestId}`,
  )).limit(1).get() !== undefined;
}

export function reconcileThreadSendIntake(tx: DbTransaction, row: ThreadSendIntakeRow,
  evidence: { handoff: ThreadSendIntakeHandoff; receipt: string } | null, now: number): ThreadSendIntakeRow {
  const current = getThreadSendIntake(tx, row.id);
  if (!current || current.revision !== row.revision || current.state !== "failed" || current.sealedAt === null)
    throw new ThreadSendIntakeConflict("Intake recovery revision conflict");
  return tx.update(threadSendIntakes).set(evidence === null ? {
    lastError: "Unresolved: no committed native handoff proof; custody retained", revision: current.revision + 1, updatedAt: now,
  } : { state: "transferred", nativeHandoff: JSON.stringify(evidence.handoff), nativeReceipt: evidence.receipt,
    originalEnvelope: null, currentEnvelope: null, lastError: null, revision: current.revision + 1, updatedAt: now,
  }).where(and(eq(threadSendIntakes.id, row.id), eq(threadSendIntakes.revision, current.revision))).returning().get();
}

export function checkpointThreadSendIntake(tx: DbTransaction, claim: ThreadSendIntakeClaim, args: {
  clearOperationId?: string; compactRequestId?: string; compactCheckpoint?: string;
}, now: number): void {
  assertThreadSendIntakeClaim(tx, claim, now);
  tx.update(threadSendIntakes).set({ ...args, updatedAt: now }).where(claimWhere(claim, now)).run();
}

export function handoffThreadSendIntake(tx: DbTransaction, claim: ThreadSendIntakeClaim,
  handoff: ThreadSendIntakeHandoff, receipt: string | null, now: number): void {
  assertThreadSendIntakeClaim(tx, claim, now);
  tx.update(threadSendIntakes).set({ state: "transferred", nativeHandoff: JSON.stringify(handoff), nativeReceipt: receipt,
    currentEnvelope: null, originalEnvelope: null, claimToken: null, leaseExpiresAt: null,
    revision: sql`${threadSendIntakes.revision} + 1`, updatedAt: now,
  }).where(claimWhere(claim, now)).run();
}

export function setThreadSendIntakeNativeReceipt(db: DbConnection, id: string, receipt: string): void {
  db.update(threadSendIntakes).set({ nativeReceipt: receipt })
    .where(and(eq(threadSendIntakes.id, id), eq(threadSendIntakes.state, "transferred"))).run();
}

export function failThreadSendIntake(db: DbConnection, claim: ThreadSendIntakeClaim, error: string, now: number, errorOutcome: string | null = null): void {
  db.update(threadSendIntakes).set({ state: "failed", lastError: error, nativeReceipt: errorOutcome, claimToken: null, leaseExpiresAt: null,
    revision: sql`${threadSendIntakes.revision} + 1`, updatedAt: now,
  }).where(and(eq(threadSendIntakes.id, claim.id), eq(threadSendIntakes.state, "preparing"),
    eq(threadSendIntakes.claimToken, claim.claimToken), eq(threadSendIntakes.claimEpoch, claim.claimEpoch))).run();
}

export function mutateThreadSendIntake(db: DbConnection, args: {
  id: string; revision: number; now: number;
  action: { kind: "cancel" } | { kind: "retry" } | { kind: "edit"; envelope: string; attachmentPaths: readonly string[] };
}): ThreadSendIntakeRow {
  return db.transaction(tx => {
    const row = getThreadSendIntake(tx, args.id);
    if (!row || row.revision !== args.revision) throw new ThreadSendIntakeConflict("Intake revision conflict");
    if (row.sealedAt !== null) throw new ThreadSendIntakeConflict("Intake effect sealed; custody retained");
    if (row.state !== "pending" && row.state !== "failed" && row.state !== "preparing")
      throw new ThreadSendIntakeConflict("Intake action not ready");
    if (args.action.kind === "retry" && row.state !== "failed") throw new ThreadSendIntakeConflict("Only failed intake can retry");
    if (args.action.kind === "edit") acquireProjectAttachmentOwnership(tx, row.threadId, args.action.attachmentPaths);
    const cancelled = args.action.kind === "cancel";
    return tx.update(threadSendIntakes).set({
      state: cancelled ? "cancelled" : "pending", currentEnvelope: cancelled ? null : args.action.kind === "edit" ? args.action.envelope : row.currentEnvelope,
      originalEnvelope: cancelled ? null : row.originalEnvelope, claimToken: null, leaseExpiresAt: null,
      revision: row.revision + 1, lastError: null, updatedAt: args.now,
    }).where(and(eq(threadSendIntakes.id, row.id), eq(threadSendIntakes.revision, args.revision))).returning().get();
  }, { behavior: "immediate" });
}

export function readThreadSendIntakePage(db: DbQueryConnection, threadId: string, afterOrder: number, limit = 101): ThreadSendIntakeRow[] {
  return db.select().from(threadSendIntakes)
    .where(and(eq(threadSendIntakes.threadId, threadId), gt(threadSendIntakes.intakeOrder, afterOrder)))
    .orderBy(asc(threadSendIntakes.intakeOrder)).limit(limit).all();
}

export function releaseThreadSendIntakeForStop(db: DbConnection, claim: ThreadSendIntakeClaim, now: number): void {
  db.transaction(tx => {
    const row = getThreadSendIntake(tx, claim.id);
    if (!row || row.state !== "preparing" || row.claimToken !== claim.claimToken || row.claimEpoch !== claim.claimEpoch) return;
    tx.update(threadSendIntakes).set({ state: row.sealedAt === null ? "pending" : "failed",
      claimToken: null, leaseExpiresAt: null, revision: row.revision + 1, updatedAt: now,
      lastError: row.sealedAt === null ? null : "Server stopped after effect seal; recovery required",
    }).where(eq(threadSendIntakes.id, row.id)).run();
  }, { behavior: "immediate" });
}
