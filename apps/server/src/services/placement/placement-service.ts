import { and, asc, eq, inArray } from "drizzle-orm";
import {
  acceptPlacementOperation,
  cancelPlacementOperation,
  getThread,
  markPlacementOwnerUnavailable,
  preparePlacementOperation,
  observePlacementWorkers,
  placementOperationProjection,
  placementOperations,
  placementWorkers,
  readPlacementOperationRecord,
  readPlacementOwner,
  readPlacementThreadBinding,
  readPlacementActionReceipt,
  recordPlacementWait,
  registerPlacementOwner,
  reservePlacementWorker,
  resetPlacementOwnerAvailability,
} from "@bb/db";
import {
  placementReasonSchema,
  type PermissionMode,
  type PlacementOperation,
  type PlacementReason,
  type WorkerObservation,
  type WorkspacePurpose,
  workspaceCapabilities,
} from "@bb/domain";
import {
  placementDraftRecoverySchema,
  placementRequestV1Schema,
  type PlacementAcceptance,
  type PlacementDraftRecovery,
  type PlacementRequestV1,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import { createAsyncRerunner } from "../lib/async-deduper.js";
import { getLastExecutionOptions } from "../threads/thread-events.js";
import { loadThreadExecutionDefaults } from "../threads/project-execution-defaults.js";
import { toThreadResponseFromThread } from "../threads/thread-runtime-display.js";
import { materializePlacementWorkspace } from "./placement-workspace.js";
import {
  derivePlacementAuthority,
  placementPrincipal,
  type PlacementInvocation,
} from "./placement-authority.js";

export type { PlacementInvocation } from "./placement-authority.js";

export type PlacementPolicyWorker = {
  workerId: string;
  observation: WorkerObservation;
  slotState: string;
  lastAssignedSeq: number | null;
};
export type PlacementPolicyContext = {
  operation: PlacementOperation;
  ownerRevision: number;
  workers: PlacementPolicyWorker[];
};
export type PlacementPolicyDecision =
  | {
      kind: "candidates";
      ownerRevision: number;
      candidates: {
        workerId: string;
        workerRevision: number;
        routeEvidenceRevision: number;
      }[];
    }
  | { kind: "wait" | "refuse"; reason: PlacementReason };
export type PlacementOwnerPolicy = {
  evaluate(context: PlacementPolicyContext): Promise<PlacementPolicyDecision>;
};

type PlacementDeps = AppDeps;

const WAKE_PHASES = ["accepted", "pending", "queued"] as const;
const PLACED_PHASES = new Set<PlacementOperation["phase"]>([
  "queued",
  "admitted",
  "starting",
  "active",
  "completed",
  "failed",
  "unknown",
]);

function notFound(): never {
  throw new ApiError(404, "placement_not_found", "Placement operation not found");
}

function refusedBeforeAcceptance(reason: string, message: string): never {
  throw new ApiError(409, "placement_refused", message, {
    details: { reason, created: false },
  });
}

export function createPlacementService(
  deps: PlacementDeps,
  options: { purpose: WorkspacePurpose },
) {
  const policies = new Map<
    string,
    { ownerPluginId: string; ownerRevision: number; policy: PlacementOwnerPolicy }
  >();
  const wakes = createAsyncRerunner<string>();
  resetPlacementOwnerAvailability(deps.db);

  function resolveOwnerScope(request: PlacementRequestV1) {
    const intent = request.intent;
    switch (intent.kind) {
      case "independent": {
        const providerId = intent.request.providerId;
        if (providerId === undefined)
          throw new ApiError(
            400,
            "invalid_request",
            "Placement requires an explicit providerId",
          );
        return { providerId, sourceThreadId: null };
      }
      case "continuation":
      case "fork": {
        const threadId =
          intent.kind === "continuation"
            ? intent.threadId
            : intent.request.sourceThreadId;
        const binding = readPlacementThreadBinding(deps.db, threadId);
        if (!binding)
          refusedBeforeAcceptance(
            "binding_changed",
            "The thread has no placement binding",
          );
        return { providerId: binding.providerId, sourceThreadId: threadId };
      }
      case "retry": {
        const failed = readPlacementOperationRecord(
          deps.db,
          intent.failedOperationId,
        );
        if (!failed) notFound();
        return { providerId: failed.providerId, sourceThreadId: failed.threadId };
      }
    }
  }

  function effectivePermission(
    request: PlacementRequestV1,
    providerId: string,
    sourceThreadId: string | null,
  ): PermissionMode {
    const intent = request.intent;
    if (intent.kind === "retry") {
      const failed = readPlacementActionReceipt(
        deps.db,
        intent.failedOperationId,
      );
      if (!failed) notFound();
      return failed.authority.permission;
    }
    if (intent.request.permissionMode !== undefined)
      return intent.request.permissionMode;
    const source = sourceThreadId === null ? null : getThread(deps.db, sourceThreadId);
    if (source) {
      const last = getLastExecutionOptions(deps, source.id);
      return last?.permissionMode === "accept-edits" ||
        last?.permissionMode === "auto" ||
        last?.permissionMode === "full"
        ? last.permissionMode
        : loadThreadExecutionDefaults(deps, source).permissionMode;
    }
    if (intent.kind !== "independent") notFound();
    return loadThreadExecutionDefaults(deps, {
      parentThreadId: intent.request.parentThreadId ?? null,
      projectId: intent.request.projectId,
      providerId,
    }).permissionMode;
  }

  function toAcceptance(operation: PlacementOperation): PlacementAcceptance {
    if (operation.phase === "refused")
      return { kind: "refused", operation, outcome: "not-created" };
    const thread =
      operation.threadId !== null && PLACED_PHASES.has(operation.phase)
        ? getThread(deps.db, operation.threadId)
        : null;
    return thread
      ? {
          kind: "placed",
          operation,
          thread: toThreadResponseFromThread(deps, { thread }),
        }
      : { kind: "pending", operation };
  }

  function readOwned(invocation: PlacementInvocation, operationId: string) {
    const record = readPlacementOperationRecord(deps.db, operationId);
    if (!record || record.principalScope !== placementPrincipal(invocation))
      notFound();
    return record;
  }

  async function wakeProvider(providerId: string): Promise<void> {
    await wakes.run(providerId, async () => {
      const registered = policies.get(providerId);
      if (!registered) return;
      const operations = deps.db
        .select()
        .from(placementOperations)
        .where(
          and(
            eq(placementOperations.providerId, providerId),
            eq(placementOperations.ownerPluginId, registered.ownerPluginId),
            eq(placementOperations.cancelRequested, false),
            inArray(placementOperations.phase, [...WAKE_PHASES]),
          ),
        )
        .orderBy(asc(placementOperations.acceptedSeq))
        .all();
      for (const record of operations) {
        if (record.kind === "retry") continue;
        if (record.resolvedWorkspaceDigest === null) {
          if (record.kind === "continuation") continue;
          if (!materialize(record)) continue;
        }
        await advanceOperation(registered, record.id);
      }
    });
  }

  async function advanceOperation(
    registered: { ownerPluginId: string; ownerRevision: number; policy: PlacementOwnerPolicy },
    operationId: string,
  ): Promise<void> {
    const record = readPlacementOperationRecord(deps.db, operationId);
    if (!record) return;
    const operation = placementOperationProjection(record);
    const workers = deps.db
      .select()
      .from(placementWorkers)
      .where(
        and(
          eq(placementWorkers.ownerPluginId, registered.ownerPluginId),
          eq(placementWorkers.providerId, record.providerId),
        ),
      )
      .all()
      .map((row) => ({
        workerId: row.workerId,
        observation: row.observation,
        slotState: row.slotState,
        lastAssignedSeq: row.lastAssignedSeq,
      }));
    let decision: PlacementPolicyDecision;
    try {
      decision = await registered.policy.evaluate({
        operation,
        ownerRevision: registered.ownerRevision,
        workers,
      });
    } catch (error) {
      deps.logger.warn(
        `placement policy evaluation failed for ${operationId}: ${String(error)}`,
      );
      decision = { kind: "wait", reason: "owner_unavailable" };
    }
    if (decision.kind !== "candidates") {
      persistWait(record.id, record.revision, decision.reason, decision.kind);
      return;
    }
    let lastReason: PlacementReason = "all_busy";
    for (const candidate of decision.candidates) {
      const current = readPlacementOperationRecord(deps.db, operationId);
      if (!current) return;
      const result = reservePlacementWorker(deps.db, {
        operationId,
        expectedRevision: current.revision,
        ownerRevision: decision.ownerRevision,
        workerId: candidate.workerId,
        workerRevision: candidate.workerRevision,
        routeEvidenceRevision: candidate.routeEvidenceRevision,
        purpose: options.purpose,
      });
      if (result.kind === "reserved") return;
      const parsed = placementReasonSchema.safeParse(
        "reason" in result ? result.reason : null,
      );
      if (parsed.success) lastReason = parsed.data;
    }
    const latest = readPlacementOperationRecord(deps.db, operationId);
    if (latest) persistWait(latest.id, latest.revision, lastReason);
  }

  function persistWait(
    operationId: string,
    expectedRevision: number,
    reason: PlacementReason,
    outcome: "wait" | "refuse" = "wait",
  ) {
    recordPlacementWait(deps.db, {
      operationId,
      expectedRevision,
      outcome,
      reason,
    });
  }

  function materialize(
    record: NonNullable<ReturnType<typeof readPlacementOperationRecord>>,
  ): boolean {
    const result = materializePlacementWorkspace(
      deps,
      record,
      workspaceCapabilities,
    );
    if (result.kind !== "prepared") {
      persistWait(record.id, record.revision, result.reason, result.kind);
      return false;
    }
    const prepared = preparePlacementOperation(deps.db, {
      operationId: record.id,
      expectedRevision: record.revision,
      workspace: result.workspace,
      preparedRequest: result.preparedRequest,
      preparedExecution: result.preparedExecution,
      attachmentReceipts: result.attachmentReceipts,
    });
    if (prepared.kind === "prepared") return true;
    if (prepared.kind === "conflict")
      persistWait(record.id, record.revision, "workspace_unavailable", "refuse");
    return false;
  }

  return {
    async accept(
      invocation: PlacementInvocation,
      input: PlacementRequestV1,
    ): Promise<PlacementAcceptance> {
      const request = placementRequestV1Schema.parse(input);
      const scope = resolveOwnerScope(request);
      const owner = readPlacementOwner(deps.db, scope.providerId);
      if (!owner)
        refusedBeforeAcceptance(
          "owner_unavailable",
          "The provider is not managed by a placement owner",
        );
      if (request.intent.kind === "independent" && owner.mode !== "managed")
        refusedBeforeAcceptance(
          "owner_unavailable",
          "The placement owner is not accepting new independent work",
        );
      const authority = derivePlacementAuthority({
        invocation,
        request,
        permission: effectivePermission(
          request,
          scope.providerId,
          scope.sourceThreadId,
        ),
      });
      const result = acceptPlacementOperation(deps.db, {
        principalScope: authority.principal,
        submissionKey: request.submissionKey,
        ownerPluginId: owner.ownerPluginId,
        providerId: scope.providerId,
        authority,
        request: { schemaVersion: request.schemaVersion, intent: request.intent },
      });
      if (result.kind === "conflict")
        throw new ApiError(
          409,
          "placement_submission_conflict",
          "This submission key was already accepted with different content",
        );
      if (result.kind === "refused")
        refusedBeforeAcceptance(result.reason, "Placement was refused");
      void wakeProvider(scope.providerId).catch((error: unknown) =>
        deps.logger.warn(`placement wake failed: ${String(error)}`),
      );
      return toAcceptance(result.operation);
    },

    get(invocation: PlacementInvocation, operationId: string): PlacementOperation {
      const record = readPlacementOperationRecord(deps.db, operationId);
      if (
        !record ||
        (record.principalScope !== placementPrincipal(invocation) &&
          !(
            invocation.kind === "plugin" &&
            invocation.pluginId === record.ownerPluginId
          ))
      )
        notFound();
      return placementOperationProjection(record);
    },

    recoverDraft(
      invocation: PlacementInvocation,
      operationId: string,
    ): PlacementDraftRecovery {
      const record = readOwned(invocation, operationId);
      const payload: unknown = JSON.parse(record.canonicalRequest);
      return placementDraftRecoverySchema.parse({
        operation: placementOperationProjection(record),
        originalRequest: {
          ...(payload as object),
          submissionKey: record.submissionKey,
        },
        preparedExecution:
          record.preparedExecution === null
            ? null
            : JSON.parse(record.preparedExecution),
        attachmentReceipts:
          record.attachmentReceipts === null
            ? []
            : JSON.parse(record.attachmentReceipts),
      });
    },

    cancel(invocation: PlacementInvocation, operationId: string): PlacementOperation {
      readOwned(invocation, operationId);
      const operation = cancelPlacementOperation(deps.db, operationId);
      if (!operation) notFound();
      return operation;
    },

    registerOwner(args: {
      providerId: string;
      ownerPluginId: string;
      policy: PlacementOwnerPolicy;
    }): { ownerRevision: number; dispose(): void } {
      const result = registerPlacementOwner(deps.db, {
        providerId: args.providerId,
        ownerPluginId: args.ownerPluginId,
      });
      if (result.kind !== "registered")
        throw new Error(
          `Placement owner for ${args.providerId} is already registered`,
        );
      const entry = {
        ownerPluginId: args.ownerPluginId,
        ownerRevision: result.owner.revision,
        policy: args.policy,
      };
      policies.set(args.providerId, entry);
      let disposed = false;
      return {
        ownerRevision: result.owner.revision,
        dispose() {
          if (disposed) return;
          disposed = true;
          if (policies.get(args.providerId) === entry)
            policies.delete(args.providerId);
          const current = readPlacementOwner(deps.db, args.providerId);
          if (current)
            markPlacementOwnerUnavailable(deps.db, {
              providerId: args.providerId,
              ownerPluginId: args.ownerPluginId,
              expectedRevision: current.revision,
            });
        },
      };
    },

    async observeWorkers(args: {
      providerId: string;
      ownerPluginId: string;
      workers: WorkerObservation[];
    }): Promise<"observed" | "stale" | "conflict"> {
      const registered = policies.get(args.providerId);
      if (!registered || registered.ownerPluginId !== args.ownerPluginId)
        throw new Error(`No live placement owner for ${args.providerId}`);
      const observed = observePlacementWorkers(deps.db, {
        providerId: args.providerId,
        ownerPluginId: args.ownerPluginId,
        expectedOwnerRevision: registered.ownerRevision,
        workers: args.workers,
      });
      if (observed.kind === "observed") await wakeProvider(args.providerId);
      return observed.kind;
    },

    wake(providerId: string): Promise<void> {
      return wakeProvider(providerId);
    },
  };
}

export type PlacementService = ReturnType<typeof createPlacementService>;
