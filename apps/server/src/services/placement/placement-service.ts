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
  readPlacementSubmissionContext,
  recordPlacementWait,
  refuseReservedPlacement,
  registerPlacementOwner,
  reservePlacementWorker,
  resetPlacementOwnerAvailability,
  type UnusedPlacementReservationGuard,
} from "@bb/db";
import {
  placementReasonSchema,
  type PermissionMode,
  type PlacementOperation,
  type PlacementReason,
  type WorkerObservation,
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
import { dispatchReservedPlacement } from "./placement-dispatch.js";
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
  throw new ApiError(
    404,
    "placement_not_found",
    "Placement operation not found",
  );
}

function refusedBeforeAcceptance(reason: string, message: string): never {
  throw new ApiError(409, "placement_refused", message, {
    details: { reason, created: false },
  });
}

export function createPlacementService(deps: PlacementDeps) {
  const policies = new Map<
    string,
    { ownerPluginId: string; policy: PlacementOwnerPolicy }
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
        return {
          providerId: failed.providerId,
          sourceThreadId: failed.threadId,
        };
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
    const source =
      sourceThreadId === null ? null : getThread(deps.db, sourceThreadId);
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
    const thread =
      operation.threadId === null
        ? null
        : (getThread(deps.db, operation.threadId) ?? null);
    const placed = thread
      ? ({
          kind: "placed",
          operation,
          thread: toThreadResponseFromThread(deps, { thread }),
        } as const)
      : null;
    if (operation.phase === "refused")
      return placed ?? { kind: "refused", operation, outcome: "not-created" };
    if (operation.phase === "cancelled")
      return { kind: "cancelled", operation };
    return placed && PLACED_PHASES.has(operation.phase)
      ? placed
      : { kind: "pending", operation };
  }

  function readOwned(invocation: PlacementInvocation, operationId: string) {
    const record = readPlacementOperationRecord(deps.db, operationId);
    if (!record || record.principalScope !== placementPrincipal(invocation))
      notFound();
    return record;
  }

  type Registered = {
    ownerPluginId: string;
    policy: PlacementOwnerPolicy;
  };
  type OperationRow = NonNullable<
    ReturnType<typeof readPlacementOperationRecord>
  >;
  type WaitSource = Parameters<typeof recordPlacementWait>[1]["source"];

  function waitingOperations(
    providerId: string,
    ownerPluginId: string,
    phases: readonly PlacementOperation["phase"][] = WAKE_PHASES,
  ) {
    return deps.db
      .select()
      .from(placementOperations)
      .where(
        and(
          eq(placementOperations.providerId, providerId),
          eq(placementOperations.ownerPluginId, ownerPluginId),
          eq(placementOperations.cancelRequested, false),
          inArray(placementOperations.phase, [...phases]),
        ),
      )
      .orderBy(asc(placementOperations.acceptedSeq))
      .all();
  }

  function currentEpoch(providerId: string, registered: Registered) {
    const owner = readPlacementOwner(deps.db, providerId);
    return policies.get(providerId) === registered &&
      owner?.ownerPluginId === registered.ownerPluginId &&
      owner.available &&
      owner.mode === "managed"
      ? owner.revision
      : null;
  }

  function recordOwnerUnavailable(providerId: string) {
    const owner = readPlacementOwner(deps.db, providerId);
    if (!owner || (owner.available && owner.mode === "managed")) return;
    const source: WaitSource = {
      kind: "owner_unavailable",
      providerId,
      ownerPluginId: owner.ownerPluginId,
      ownerRevision: owner.revision,
    };
    for (const record of waitingOperations(providerId, owner.ownerPluginId)) {
      if (record.phase === "queued") continue;
      persistWait(record, source, "owner_unavailable");
    }
  }

  async function wakeProvider(providerId: string): Promise<void> {
    await wakes.run(providerId, async () => {
      const registered = policies.get(providerId);
      const epoch = registered ? currentEpoch(providerId, registered) : null;
      if (!registered || epoch === null) {
        recordOwnerUnavailable(providerId);
        return;
      }
      for (const record of waitingOperations(
        providerId,
        registered.ownerPluginId,
        ["reserved"],
      )) {
        try {
          dispatch(record.id, epoch);
        } catch (error) {
          deps.logger.warn(
            `placement dispatch failed for ${record.id}: ${String(error)}`,
          );
        }
      }
      for (const record of waitingOperations(
        providerId,
        registered.ownerPluginId,
      )) {
        if (record.kind === "retry") continue;
        try {
          if (record.resolvedWorkspaceDigest === null) {
            if (record.kind === "continuation") continue;
            if (!materialize(providerId, registered, record)) continue;
          }
          await advanceOperation(providerId, registered, record.id);
        } catch (error) {
          deps.logger.warn(
            `placement wake failed for ${record.id}: ${String(error)}`,
          );
        }
      }
    });
  }

  async function advanceOperation(
    providerId: string,
    registered: Registered,
    operationId: string,
  ): Promise<void> {
    const epoch = currentEpoch(providerId, registered);
    const record = readPlacementOperationRecord(deps.db, operationId);
    if (epoch === null || !record) return;
    const source: WaitSource = {
      kind: "policy",
      providerId,
      ownerPluginId: registered.ownerPluginId,
      ownerRevision: epoch,
    };
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
    const rootKeyOf = (workerId: string) => {
      const observation = workers.find(
        (w) => w.workerId === workerId,
      )?.observation;
      return observation && deps.placementRuntimeRootKey
        ? deps.placementRuntimeRootKey({
            ownerPluginId: registered.ownerPluginId,
            providerId: record.providerId,
            accountId: observation.accountId,
            agentHostId: observation.agentHostId,
            workerId,
            generation: observation.generation,
          })
        : null;
    };
    let decision: PlacementPolicyDecision;
    try {
      decision = await registered.policy.evaluate({
        operation: placementOperationProjection(record),
        ownerRevision: epoch,
        workers,
      });
    } catch (error) {
      deps.logger.warn(
        `placement policy evaluation failed for ${operationId}: ${String(error)}`,
      );
      decision = { kind: "wait", reason: "owner_unavailable" };
    }
    if (currentEpoch(providerId, registered) !== epoch) return;
    if (decision.kind !== "candidates") {
      persistWait(record, source, decision.reason, decision.kind);
      return;
    }
    const purpose = deps.placementWorkspacePurpose;
    if (decision.ownerRevision !== epoch || purpose === undefined) {
      persistWait(
        record,
        source,
        purpose === undefined ? "unsupported_tool_route" : "owner_unavailable",
      );
      return;
    }
    let lastReason: PlacementReason = "all_busy";
    for (const candidate of decision.candidates) {
      if (
        record.kind === "independent" &&
        rootKeyOf(candidate.workerId) === null
      ) {
        lastReason = "unsupported_tool_route";
        continue;
      }
      const current = readPlacementOperationRecord(deps.db, operationId);
      if (!current) return;
      const result = reservePlacementWorker(deps.db, {
        operationId,
        expectedRevision: current.revision,
        ownerRevision: epoch,
        workerId: candidate.workerId,
        workerRevision: candidate.workerRevision,
        routeEvidenceRevision: candidate.routeEvidenceRevision,
        purpose,
      });
      if (result.kind === "reserved") {
        dispatch(operationId, epoch);
        return;
      }
      const parsed = placementReasonSchema.safeParse(
        "reason" in result ? result.reason : null,
      );
      if (parsed.success) lastReason = parsed.data;
    }
    const latest = readPlacementOperationRecord(deps.db, operationId);
    if (latest) persistWait(latest, source, lastReason);
  }

  function dispatch(operationId: string, ownerRevision: number) {
    const result = dispatchReservedPlacement(deps, operationId);
    if (result.kind === "retry")
      deps.logger.warn(
        `placement dispatch retry for ${operationId}: ${result.reason}`,
      );
    if (result.kind !== "terminal") return;
    const record = readPlacementOperationRecord(deps.db, operationId);
    const refused =
      record && record.fence !== null
        ? refuseReservedPlacement(deps.db, {
            operationId,
            expectedRevision: record.revision,
            fence: record.fence,
            ownerRevision,
            reason: result.reason,
          }).kind
        : "stale";
    deps.logger.warn(
      `placement dispatch ${refused} for ${operationId}: ${result.reason}: ${result.error}`,
    );
  }

  function unusedReservationGuards(
    ownerPluginId: string,
    reported: readonly WorkerObservation[],
  ): UnusedPlacementReservationGuard[] {
    const workerIds = reported.map((worker) => worker.workerId);
    if (workerIds.length === 0) return [];
    return deps.db
      .select()
      .from(placementWorkers)
      .where(
        and(
          eq(placementWorkers.ownerPluginId, ownerPluginId),
          inArray(placementWorkers.workerId, workerIds),
          inArray(placementWorkers.slotState, ["reserved", "active"]),
        ),
      )
      .all()
      .flatMap((worker) => {
        const record = worker.ownerOperationId
          ? readPlacementOperationRecord(deps.db, worker.ownerOperationId)
          : null;
        return record &&
          worker.fence !== null &&
          record.fence === worker.fence &&
          (record.cancelRequested ||
            record.phase === "refused" ||
            worker.slotState === "active")
          ? [
              {
                workerId: worker.workerId,
                operationId: record.id,
                expectedRevision: record.revision,
                fence: worker.fence,
              },
            ]
          : [];
      });
  }

  function persistWait(
    record: OperationRow,
    source: WaitSource,
    reason: PlacementReason,
    outcome: "wait" | "refuse" = "wait",
  ) {
    recordPlacementWait(deps.db, {
      operationId: record.id,
      expectedRevision: record.revision,
      outcome,
      reason,
      source,
    });
  }

  function materialize(
    providerId: string,
    registered: Registered,
    record: OperationRow,
  ): boolean {
    const epoch = currentEpoch(providerId, registered);
    const receipt = readPlacementActionReceipt(deps.db, record.id);
    if (epoch === null || !receipt) return false;
    const source: WaitSource = {
      kind: "policy",
      providerId,
      ownerPluginId: registered.ownerPluginId,
      ownerRevision: epoch,
    };
    const result = materializePlacementWorkspace(deps, {
      record,
      acceptedPermission: receipt.authority.permission,
      requiredCapabilities: workspaceCapabilities,
    });
    if (result.kind !== "prepared") {
      persistWait(record, source, result.reason, result.kind);
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
      persistWait(record, source, "workspace_unavailable", "refuse");
    return false;
  }

  function retainedAuthority(principalScope: string, submissionKey: string) {
    const row = deps.db
      .select({ id: placementOperations.id })
      .from(placementOperations)
      .where(
        and(
          eq(placementOperations.principalScope, principalScope),
          eq(placementOperations.submissionKey, submissionKey),
        ),
      )
      .get();
    const receipt = row ? readPlacementActionReceipt(deps.db, row.id) : null;
    if (!receipt)
      throw new Error("Placement submission is missing its action receipt");
    return receipt.authority;
  }

  function newWorkScope(request: PlacementRequestV1) {
    const scope = resolveOwnerScope(request);
    const owner = readPlacementOwner(deps.db, scope.providerId);
    if (!owner)
      refusedBeforeAcceptance(
        "owner_unavailable",
        "The provider is not managed by a placement owner",
      );
    return { ...scope, ownerPluginId: owner.ownerPluginId };
  }

  return {
    async accept(
      invocation: PlacementInvocation,
      input: PlacementRequestV1,
    ): Promise<PlacementAcceptance> {
      const request = placementRequestV1Schema.parse(input);
      const retained = readPlacementSubmissionContext(deps.db, {
        principalScope: placementPrincipal(invocation),
        submissionKey: request.submissionKey,
      });
      const fresh = retained ? null : newWorkScope(request);
      const scope = retained ?? fresh!;
      const authority = fresh
        ? derivePlacementAuthority(deps, {
            invocation,
            request,
            permission: effectivePermission(
              request,
              fresh.providerId,
              fresh.sourceThreadId,
            ),
          })
        : retainedAuthority(
            placementPrincipal(invocation),
            request.submissionKey,
          );
      const result = acceptPlacementOperation(deps.db, {
        principalScope: authority.principal,
        submissionKey: request.submissionKey,
        ownerPluginId: scope.ownerPluginId,
        providerId: scope.providerId,
        authority,
        request: {
          schemaVersion: request.schemaVersion,
          intent: request.intent,
        },
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

    get(
      invocation: PlacementInvocation,
      operationId: string,
    ): PlacementOperation {
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

    cancel(
      invocation: PlacementInvocation,
      operationId: string,
    ): PlacementOperation {
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
      const owner = readPlacementOwner(deps.db, args.providerId);
      if (
        !registered ||
        registered.ownerPluginId !== args.ownerPluginId ||
        owner?.ownerPluginId !== args.ownerPluginId
      )
        throw new Error(`No live placement owner for ${args.providerId}`);
      const observed = observePlacementWorkers(deps.db, {
        providerId: args.providerId,
        ownerPluginId: args.ownerPluginId,
        expectedOwnerRevision: owner.revision,
        workers: args.workers,
        unusedReservations: unusedReservationGuards(
          args.ownerPluginId,
          args.workers,
        ),
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
