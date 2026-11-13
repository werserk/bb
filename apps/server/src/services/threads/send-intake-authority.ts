import { createClientTurnRequestId } from "./thread-events.js";
import {
  afterCommit,
  assertThreadSendIntakeClaim,
  checkpointThreadSendIntake,
  createEventId,
  getThreadSendIntake,
  handoffThreadSendIntake,
  sealThreadSendIntake,
  type DbConnection,
  type DbTransaction,
  type ThreadSendIntakeClaim,
  type ThreadSendIntakeHandoff,
  type ThreadSendIntakeEffectStage,
} from "@bb/db";
import type { SendMessageResponse } from "@bb/server-contract";

export interface SendIntakeAuthority {
  claim: ThreadSendIntakeClaim;
  stage: "message" | "compact";
  committed: () => void;
  isStopped: () => boolean;
  onRelease?: (cleanup: () => void) => void;
  beforeEffects?: () => void;
}

export function assertSendIntake(tx: DbTransaction, intake: SendIntakeAuthority | undefined): void {
  if (intake?.isStopped()) throw new Error("Intake worker stopped");
  if (intake) assertThreadSendIntakeClaim(tx, intake.claim, Date.now());
}

export function sealSendIntake(db: DbConnection, intake: SendIntakeAuthority | undefined,
  stage: ThreadSendIntakeEffectStage = "request"): void {
  if (intake?.isStopped()) throw new Error("Intake worker stopped");
  intake?.beforeEffects?.();
  if (intake) db.transaction(tx => sealThreadSendIntake(tx, intake.claim, Date.now(), stage), { behavior: "immediate" });
}

export function commitSendIntake(tx: DbTransaction, intake: SendIntakeAuthority | undefined,
  handoff: ThreadSendIntakeHandoff, receipt?: SendMessageResponse): void {
  if (!intake) return;
  assertSendIntake(tx, intake);
  const now = Date.now();
  if (intake.stage === "compact") {
    sealThreadSendIntake(tx, intake.claim, now, "compact");
    checkpointThreadSendIntake(tx, intake.claim, { compactCheckpoint: JSON.stringify(handoff) }, now);
    return;
  }
  const id = intake.claim.clientSubmissionId;
  const nativeReceipt: SendMessageResponse = receipt ?? {
    ok: true, delivery: "sent",
    ...(id === null ? {} : { submissionIds: [id] }),
    ...(handoff.kind === "request" && id !== null ? { requested: { requestId: handoff.id, sequence: handoff.sequence } } : {}),
    ...(handoff.kind === "clear" && id !== null ? { command: true } : {}),
  };
  handoffThreadSendIntake(tx, intake.claim, handoff, JSON.stringify(nativeReceipt), now);
  afterCommit(tx, intake.committed);
}

export function stableSendIntakeOperation(db: DbConnection, intake: SendIntakeAuthority | undefined,
  kind: "clear" | "compact"): string | undefined {
  if (!intake) return undefined;
  return db.transaction(tx => {
    assertSendIntake(tx, intake);
    const row = kind === "clear" ? sealThreadSendIntake(tx, intake.claim, Date.now(), "clear") :
      assertThreadSendIntakeClaim(tx, intake.claim, Date.now());
    const previous = kind === "clear" ? row.clearOperationId : row.compactRequestId;
    if (previous !== null) return previous;
    const id = kind === "compact" ? createClientTurnRequestId() : createEventId();
    checkpointThreadSendIntake(tx, intake.claim,
      kind === "clear" ? { clearOperationId: id } : { compactRequestId: id }, Date.now());
    return id;
  }, { behavior: "immediate" });
}

export function compactSendIntakeComplete(db: DbConnection, intake: SendIntakeAuthority | undefined): boolean {
  if (!intake) return false;
  const row = getThreadSendIntake(db, intake.claim.id);
  return row !== null && row.compactCheckpoint !== null;
}
