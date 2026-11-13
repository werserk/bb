import { isServerMoveFrozen } from "../server-move/freeze-state.js";
import { assertSubmissionNotAdmitted } from "./submission-admission.js";
import { createHash, randomUUID } from "node:crypto";
import {
  afterCommit,
  finaliseThreadSendIntake,
  getProjectAttachment,
  getThread,
  getThreadSendIntake,
  hasThreadSendIntakeNativeIdentity,
  readThreadSendIntakeEnvelope,
  reconcileThreadSendIntake,
  mutateThreadSendIntake,
  rejectThreadSendIntake,
  reserveThreadSendIntake,
  ThreadSendIntakeConflict,
  type ThreadSendIntakeRow,
} from "@bb/db";
import {
  canonicalProjectAttachmentPath,
  clientSubmissionQueueId,
  pathLooksRuntimeReadable,
  projectAttachmentPaths,
  type PromptInput,
  type Thread,
  isStandaloneBuiltinClearCommand,
} from "@bb/domain";
import {
  sendAdmissionResponseSchema,
  sendMessageRequestSchema,
  threadSendIntakeViewSchema,
  type MutateThreadSendIntakeRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadSendIntakeView,
} from "@bb/server-contract";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { resolvePromptAttachmentReferences } from "../projects/attachments.js";
import { threadTargetHostId } from "./dispatch-attempt.js";
import { createSendIntakeWorker } from "./send-intake-worker.js";
import type { SendIntakeAuthority } from "./send-intake-authority.js";
import { acquireThreadSendGuard } from "./thread-context-mutation-guard.js";
import { findSendIntakeHandoffProof } from "./send-intake-recovery.js";
import { deterministicIntakeError, encodeIntakeErrorOutcome, readIntakeErrorOutcome } from "./send-intake-errors.js";

function canonicalJson(value: import("@bb/domain").JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function readIntakeEnvelope(row: ThreadSendIntakeRow): SendMessageRequest {
  const stored = readThreadSendIntakeEnvelope(row);
  if (stored === null) throw new Error("Intake payload already transferred or retired");
  return sendMessageRequestSchema.parse(stored.payload);
}

export function toSendIntakeView(row: ThreadSendIntakeRow): ThreadSendIntakeView {
  return threadSendIntakeViewSchema.parse({
    id: row.id, clientSubmissionId: row.clientSubmissionId, intakeOrder: row.intakeOrder,
    revision: row.revision, state: row.state,
    input: row.currentEnvelope === null ? null : readIntakeEnvelope(row).input,
    sealed: row.sealedAt !== null, recoveryRequired: row.state === "failed" && row.sealedAt !== null,
    effectStage: readThreadSendIntakeEnvelope(row)?.effectStage ?? null,
    error: row.lastError, handoff: row.nativeHandoff === null ? null : JSON.parse(row.nativeHandoff),
  });
}

export function createThreadSendIntakeService(
  deps: LoggedPendingInteractionWorkSessionDeps,
  execute: (payload: SendMessageRequest, thread: Thread, authority: SendIntakeAuthority) => Promise<SendMessageResponse>,
  isReady: () => boolean = () => true,
) {
  const preparing = new Map<string, Promise<void>>();
  let stopped = false;
  const notify = (threadId: string) => deps.hub.notifyThread(threadId, ["queue-changed"]);

  function assertAvailable(): void {
    if (stopped || isServerMoveFrozen(deps.db))
      throw new ApiError(503, "intake_unavailable", "Pending send intake stopped");
  }

  function readyInput(payload: SendMessageRequest, thread: Thread): PromptInput[] | null {
    const resolved: PromptInput[] = [];
    for (const item of payload.input) {
      if (item.type !== "localFile" && item.type !== "localImage") { resolved.push(item); continue; }
      const { sourceProjectId, hostId, ...attachment } = item;
      if (pathLooksRuntimeReadable(item.path)) {
        if (sourceProjectId !== undefined) throw new ApiError(400, "invalid_request", "A source project can only be specified for an uploaded attachment");
        const targetHost = threadTargetHostId(deps, thread);
        if (hostId !== undefined && targetHost !== null && hostId !== targetHost)
          throw new ApiError(400, "invalid_request", "Attachment is on another machine; upload it to use it here");
        resolved.push(attachment); continue;
      }
      if (hostId !== undefined) throw new ApiError(400, "invalid_request", "A machine can only be specified for an absolute file path");
      const path = canonicalProjectAttachmentPath(item.path);
      if (sourceProjectId !== undefined && sourceProjectId !== thread.projectId) return null;
      const asset = getProjectAttachment(deps.db, thread.projectId, path);
      if (!asset || asset.readyAt === null || asset.deletionClaimedAt !== null) return null;
      resolved.push({ ...attachment, path });
    }
    return resolved;
  }

  function finalise(row: ThreadSendIntakeRow, payload: SendMessageRequest): void {
    assertAvailable();
    deps.db.transaction(tx => {
      const fresh = getThreadSendIntake(tx, row.id);
      if (!fresh || fresh.state !== "staging") return;
      const receipt = row.clientSubmissionId === null ? null : JSON.stringify(sendAdmissionResponseSchema.parse({
        ok: true, delivery: "accepted", admissionVersion: 1,
        admission: { id: row.id, clientSubmissionId: row.clientSubmissionId, revision: fresh.revision + 1, state: "pending" },
      }));
      finaliseThreadSendIntake(tx, { id: row.id, envelope: JSON.stringify(payload),
        attachmentPaths: projectAttachmentPaths(payload.input), admissionReceipt: receipt, now: Date.now() });
    }, { behavior: "immediate" });
  }

  async function prepare(row: ThreadSendIntakeRow): Promise<void> {
    const active = preparing.get(row.id);
    if (active) return active;
    const promise = (async () => {
      try {
        const payload = readIntakeEnvelope(row);
        const thread = getThread(deps.db, row.threadId);
        if (!thread) throw new Error("Thread deleted before asset custody");
        const input = await resolvePromptAttachmentReferences({ db: deps.db, dataDir: deps.config.dataDir,
          input: payload.input, projectId: thread.projectId, hostId: threadTargetHostId(deps, thread),
          copyTargetPath: (sourceId, path) => `intake-${row.id}/${sourceId}/${canonicalProjectAttachmentPath(path)}`,
          beforeWrite: tx => {
            if (stopped || isServerMoveFrozen(deps.db)) throw new Error("Intake service stopped");
            if (getThreadSendIntake(tx, row.id)?.state !== "staging") throw new Error("Staging custody changed");
          },
        });
        finalise(row, { ...payload, input });
      } catch (error) {
        const rejection = deterministicIntakeError(error);
        if (!stopped) rejectThreadSendIntake(deps.db, row.id, error instanceof Error ? error.message : "Asset custody failed", Date.now(),
          rejection === null ? null : encodeIntakeErrorOutcome(rejection));
        if (!stopped) worker.changed(row.threadId, row.id, error instanceof Error ? error : new Error("Asset custody failed"));
        throw error;
      } finally {
        preparing.delete(row.id);
      }
    })();
    preparing.set(row.id, promise);
    return promise;
  }

  const worker = createSendIntakeWorker({
    db: deps.db, isReady, prepare, notify,
    execute: async (row, authority) => {
      const thread = getThread(deps.db, row.threadId);
      if (!thread) throw new Error("Thread deleted before dispatch");
      const payload = readIntakeEnvelope(row);
      let release: (() => void) | undefined;
      const cleanup = () => { release?.(); release = undefined; };
      authority.onRelease?.(cleanup);
      try {
        return await execute(payload, thread, { ...authority,
          isStopped: () => authority.isStopped() || isServerMoveFrozen(deps.db),
          beforeEffects: () => {
            authority.beforeEffects?.();
            if (!release && !isStandaloneBuiltinClearCommand(payload.input)) release = acquireThreadSendGuard(thread.id);
          },
        });
      } finally { cleanup(); }
    },
    report: (error, id) => deps.logger.warn({ err: error, intakeId: id }, "Pending send preparation stopped; custody retained"),
  });

  const unsubscribeDeleted = deps.hub.onChangedMessage(message => {
    if (message.entity === "thread" && message.changes.includes("thread-deleted"))
      afterCommit(deps.db, () => worker.changed(message.id));
  });

  return {
    recover: worker.recover,
    async admit(payload: SendMessageRequest, thread: Thread): Promise<ThreadSendIntakeRow> {
      assertAvailable();
      const canonicalPayload = sendMessageRequestSchema.parse({ ...payload,
        ...(payload.clientSubmissionId ? { clientSubmissionId: payload.clientSubmissionId.toLowerCase() } : {}) });
      const envelope = canonicalJson(canonicalPayload);
      const fingerprint = createHash("sha256").update(envelope).digest("hex");
      const id = canonicalPayload.clientSubmissionId === undefined ? `intake_${randomUUID()}` : clientSubmissionQueueId(canonicalPayload.clientSubmissionId);
      let row: ThreadSendIntakeRow;
      try {
        row = deps.db.transaction(tx => {
          if (canonicalPayload.clientSubmissionId && !getThreadSendIntake(tx, id)) {
            assertSubmissionNotAdmitted(tx, thread.id, canonicalPayload.clientSubmissionId);
            if (hasThreadSendIntakeNativeIdentity(tx, thread.id, canonicalPayload.clientSubmissionId))
              throw new ApiError(409, "submission_already_admitted", "Submission already admitted");
          }
          const reserved = reserveThreadSendIntake(tx, { id, threadId: thread.id,
            clientSubmissionId: canonicalPayload.clientSubmissionId ?? null, envelope, fingerprint, now: Date.now() });
          if (reserved.state === "staging") {
            const input = readyInput(canonicalPayload, thread);
            if (input !== null) finalise(reserved, { ...canonicalPayload, input });
          }
          return getThreadSendIntake(tx, reserved.id)!;
        }, { behavior: "immediate" });
      } catch (error) {
        if (error instanceof ThreadSendIntakeConflict) throw new ApiError(409, "submission_conflict", error.message);
        throw error;
      }
      if (row.state === "staging") {
        await prepare(row);
        row = getThreadSendIntake(deps.db, row.id)!;
      }
      if (row.state === "rejected" && row.admissionReceipt === null) {
        const rejection = row.nativeReceipt === null ? null : readIntakeErrorOutcome(JSON.parse(row.nativeReceipt));
        throw rejection ?? new ApiError(400, "intake_rejected", row.lastError ?? "Asset custody failed");
      }
      notify(thread.id);
      worker.wake(thread.id);
      return row;
    },
    wait: worker.wait,
    async mutate(threadId: string, payload: MutateThreadSendIntakeRequest): Promise<ThreadSendIntakeView> {
      assertAvailable();
      const row = getThreadSendIntake(deps.db, payload.id);
      if (!row || row.threadId !== threadId) throw new ApiError(404, "intake_not_found", "Pending send not found");
      if (payload.action.kind === "reconcile") {
        try {
          const result = deps.db.transaction(tx => {
            assertAvailable();
            const current = getThreadSendIntake(tx, row.id);
            if (!current || current.revision !== payload.revision || current.state !== "failed" || current.sealedAt === null)
              throw new ThreadSendIntakeConflict("Intake recovery revision conflict");
            const reconciled = reconcileThreadSendIntake(tx, current, findSendIntakeHandoffProof(tx, current), Date.now());
            afterCommit(tx, () => { worker.changed(threadId, row.id); worker.wake(threadId); });
            return reconciled;
          }, { behavior: "immediate" });
          return toSendIntakeView(result);
        } catch (error) {
          if (error instanceof ThreadSendIntakeConflict) throw new ApiError(409, "intake_conflict", error.message);
          throw error;
        }
      }
      if (row.revision !== payload.revision || row.sealedAt !== null ||
        (row.state !== "pending" && row.state !== "preparing" && row.state !== "failed"))
        throw new ApiError(409, "intake_conflict", "Intake revision changed or effect sealed; custody retained");
      if (payload.action.kind === "send-now" || payload.action.kind === "reorder")
        throw new ApiError(409, "intake_not_ready", "Use native queue actions after committed queue handoff");
      try {
        let action: Parameters<typeof mutateThreadSendIntake>[1]["action"];
        if (payload.action.kind === "edit") {
          const thread = getThread(deps.db, threadId);
          if (!thread) throw new ApiError(404, "thread_not_found", "Thread not found");
          const envelope = readIntakeEnvelope(row);
          const input = await resolvePromptAttachmentReferences({ db: deps.db, dataDir: deps.config.dataDir,
            input: payload.action.input, projectId: thread.projectId, hostId: threadTargetHostId(deps, thread),
            beforeWrite: tx => {
              assertAvailable();
              const current = getThreadSendIntake(tx, row.id);
              if (!current || current.revision !== payload.revision || current.sealedAt !== null)
                throw new ThreadSendIntakeConflict("Intake revision changed or effect sealed; custody retained");
            },
          });
          action = { kind: "edit", envelope: JSON.stringify({ ...envelope, input }), attachmentPaths: projectAttachmentPaths(input) };
        } else action = payload.action;
        assertAvailable();
        const result = mutateThreadSendIntake(deps.db, { id: row.id, revision: payload.revision, action, now: Date.now() });
        worker.changed(threadId, row.id);
        worker.wake(threadId);
        return toSendIntakeView(result);
      } catch (error) {
        if (error instanceof ThreadSendIntakeConflict) throw new ApiError(409, "intake_conflict", error.message);
        throw error;
      }
    },
    stop() { stopped = true; unsubscribeDeleted(); worker.stop(); },
  };
}
