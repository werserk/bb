import {
  getActiveStoredTurnId,
  getEnvironment,
  getLastStoredProviderThreadId,
  getStoredTurnRequestEventByRequestId,
  hasStoredTerminalClientTurnRequestEvent,
  readPlacementDispatchReceipt,
  readPlacementAdmittedExecution,
  refusePlacementBeforeHandoff,
  getThread,
  placementWorkspaceMatches,
  placementWorkspaces,
  readPlacementOperationRecord,
  readPlacementOwner,
  readPlacementThreadBinding,
  readPlacementWorker,
  type DbConnection,
  type DbQueryConnection,
} from "@bb/db";
import {
  canonicalJsonBytes,
  workspaceBindingRef,
  workspaceBindingSchema,
  type ClientTurnRequestId,
  type WorkspacePurpose,
  threadScope,
} from "@bb/domain";
import type { HostDaemonRpcCommand } from "@bb/host-daemon-contract";
import { and, eq } from "drizzle-orm";
import { ApiError } from "../../errors.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import type { WorkSessionDeps } from "../../types.js";

export const MANAGED_EXECUTION_UNSUPPORTED = "managed_execution_unsupported";

function placementConflict(): never {
  throw new ApiError(
    409,
    "managed_placement_changed",
    "Managed execution placement is unavailable or has changed",
    false,
  );
}

export class ManagedExecutionUnsupported extends ApiError {
  constructor() {
    super(
      409,
      MANAGED_EXECUTION_UNSUPPORTED,
      "Managed execution requires a verified command handoff and daemon custody",
      false,
    );
  }
}

// Placement describes the two destinations. It grants no permission to launch or invoke a tool.
export function readManagedExecutionPlacement(
  db: DbQueryConnection,
  threadId: string,
) {
  const binding = readPlacementThreadBinding(db, threadId);
  if (!binding) return null;
  const thread = getThread(db, threadId);
  const owner = readPlacementOwner(db, binding.providerId);
  const worker = readPlacementWorker(
    db,
    binding.ownerPluginId,
    binding.workerId,
  );
  if (
    !thread ||
    thread.providerId !== binding.providerId ||
    !owner?.available ||
    owner.mode !== "managed" ||
    owner.ownerPluginId !== binding.ownerPluginId ||
    !worker?.available ||
    !worker.ownerOperationId ||
    worker.threadId !== threadId ||
    worker.agentHostId !== binding.agentHostId ||
    worker.generation !== binding.generation ||
    worker.accountId !== binding.accountId ||
    worker.providerId !== binding.providerId
  )
    placementConflict();
  const operation = readPlacementOperationRecord(db, worker.ownerOperationId);
  if (
    !operation?.binding ||
    operation.threadId !== threadId ||
    operation.fence !== worker.fence ||
    canonicalJsonBytes(operation.binding) !== canonicalJsonBytes(binding)
  )
    placementConflict();

  const ref = binding.workspace;
  const snapshot = db
    .select()
    .from(placementWorkspaces)
    .where(
      and(
        eq(placementWorkspaces.workspaceBindingId, ref.workspaceBindingId),
        eq(placementWorkspaces.revision, ref.revision),
        eq(placementWorkspaces.workspaceDigest, ref.workspaceDigest),
      ),
    )
    .get();
  if (!snapshot || !placementWorkspaceMatches(db, snapshot))
    placementConflict();
  const workspace = workspaceBindingSchema.parse(
    JSON.parse(snapshot.canonicalDescriptor),
  );
  const environment = getEnvironment(db, workspace.environmentId);
  if (
    workspaceBindingRef(workspace).workspaceDigest !== ref.workspaceDigest ||
    thread.environmentId !== workspace.environmentId ||
    environment?.status !== "ready" ||
    thread.projectId !== environment.projectId ||
    environment.hostId !== workspace.hostId
  )
    placementConflict();
  return {
    binding,
    workspace,
    executionOwnerOperationId: operation.id,
    fence: worker.fence,
  };
}

// The native path carries neither a managed launch profile nor the identity of the command being stopped.
export function assertNativeThreadExecution(
  db: DbQueryConnection,
  threadId: string,
): void {
  if (readPlacementThreadBinding(db, threadId))
    throw new ManagedExecutionUnsupported();
}

export function assertNativeExecutionCommand(
  db: DbQueryConnection,
  command: HostDaemonRpcCommand,
): void {
  switch (command.type) {
    case "thread.start":
    case "turn.submit":
    case "thread.stop":
      assertNativeThreadExecution(db, command.threadId);
  }
}

export async function dispatchManagedOrdinaryTurn(
  deps: Pick<WorkSessionDeps, "db" | "hub"> & {
    placementWorkspacePurpose?: WorkspacePurpose;
  },
  committed: { threadId: string; requestId: ClientTurnRequestId },
): Promise<void> {
  const { refusal, sequence } = deps.db.transaction(
    (tx) => {
      const requested = getStoredTurnRequestEventByRequestId(tx, committed);
      if (!requested)
        throw new ApiError(
          409,
          "managed_request_missing",
          "Committed native turn request was not found",
          false,
        );
      const receipt = readPlacementDispatchReceipt(tx, committed);
      if (!receipt || receipt.requestSequence !== requested.sequence)
        throw new ApiError(
          409,
          "managed_receipt_missing",
          "Native request has no matching committed dispatch receipt",
          false,
        );
      if (
        receipt.state !== "prepared" ||
        hasStoredTerminalClientTurnRequestEvent(tx, committed)
      ) {
        throw new ApiError(
          409,
          "managed_execution_recorded",
          "Managed dispatch requires reconciliation with its recorded outcome",
          {
            retryable: false,
            details: { state: receipt.state },
          },
        );
      }

      const admitted =
        deps.placementWorkspacePurpose &&
        readPlacementAdmittedExecution(tx, {
          ...committed,
          purpose: deps.placementWorkspacePurpose,
        });
      const refusal = admitted
        ? new ManagedExecutionUnsupported()
        : new ApiError(
            409,
            "managed_admission_unavailable",
            "Current managed execution admission is unavailable",
            false,
          );

      // No live RPC on protocol 270. Commit a definite refusal and the matching native event together.
      // An immediate writer lock orders this transaction with the final send claim.
      const sequence = appendThreadEventInTransaction(tx, {
        threadId: committed.threadId,
        environmentId: getThread(tx, committed.threadId)?.environmentId ?? null,
        type: "client/turn/rejected",
        scope: threadScope(),
        data: {
          requestId: committed.requestId,
          reason: refusal.body.code,
          message: refusal.body.message,
        },
      });
      const changed = refusePlacementBeforeHandoff(tx, {
        ...committed,
        executionOwnerOperationId: receipt.executionOwnerOperationId,
        fence: receipt.fence,
      });
      if (!changed)
        throw new ApiError(
          409,
          "managed_execution_recorded",
          "Managed dispatch changed before refusal",
          false,
        );
      return { refusal, sequence };
    },
    { behavior: "immediate" },
  );
  deps.hub.notifyThread(committed.threadId, ["events-appended"], {
    eventTypes: ["client/turn/rejected"],
    timelineSequence: sequence,
  });
  throw refusal;
}

export function assertThreadToolSession(
  db: DbConnection,
  args: {
    threadId: string;
    environmentHostId: string;
    sessionHostId: string;
    providerThreadId: string;
    turnId?: string;
  },
): void {
  db.transaction((tx) => {
    const binding = readPlacementThreadBinding(tx, args.threadId);
    if (!binding) {
      if (args.environmentHostId !== args.sessionHostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }
      return;
    }
    if (binding.agentHostId !== args.sessionHostId) {
      throw new ApiError(
        403,
        "managed_agent_mismatch",
        "Tool call did not originate on the bound Agent",
        false,
      );
    }
    readManagedExecutionPlacement(tx, args.threadId);
    if (
      !args.turnId ||
      getActiveStoredTurnId(tx, args.threadId) !== args.turnId ||
      getLastStoredProviderThreadId(tx, args.threadId) !== args.providerThreadId
    ) {
      throw new ApiError(
        403,
        "managed_turn_mismatch",
        "Tool call has no matching active provider turn",
        false,
      );
    }
    // Even an active provider turn lacks authenticated origin-command and permission evidence on protocol 270.
    throw new ManagedExecutionUnsupported();
  });
}
