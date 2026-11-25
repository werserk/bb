import { getEnvironment, type placementOperations } from "@bb/db";
import {
  clampPermissionModeToCeiling,
  normalizeWorkspaceBinding,
  type PermissionMode,
  placementPayloadSchema,
  resolvedThreadExecutionOptionsSchema,
  type JsonValue,
  type PlacementReason,
  type ResolvedThreadExecutionOptions,
  type WorkspaceBinding,
  type WorkspaceCapability,
} from "@bb/domain";
import { createThreadRequestSchema } from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { loadThreadExecutionDefaults } from "../threads/project-execution-defaults.js";

type OperationRecord = typeof placementOperations.$inferSelect;

export type PlacementMaterialization =
  | {
      kind: "prepared";
      workspace: WorkspaceBinding;
      preparedRequest: JsonValue;
      preparedExecution: ResolvedThreadExecutionOptions;
      attachmentReceipts: JsonValue;
    }
  | { kind: "wait" | "refuse"; reason: PlacementReason };

/**
 * Pre-thread preparation that performs no host side effect: an independent
 * launch may reuse an already-ready environment. Fresh environment
 * preparation, pre-thread forks and roots outside the POSIX descriptor have no
 * operation-owned provider path yet and are refused visibly. The prepared
 * permission never exceeds the one accepted with the receipt.
 */
export function materializePlacementWorkspace(
  deps: Pick<AppDeps, "db" | "providerRegistry">,
  args: {
    record: OperationRecord;
    acceptedPermission: PermissionMode;
    requiredCapabilities: readonly WorkspaceCapability[];
  },
): PlacementMaterialization {
  const { record, requiredCapabilities } = args;
  const { intent } = placementPayloadSchema.parse(
    JSON.parse(record.canonicalRequest),
  );
  if (intent.kind !== "independent")
    return { kind: "refuse", reason: "unsupported_preparation" };
  const request = createThreadRequestSchema.parse(intent.request);
  if (request.environment.type !== "reuse")
    return { kind: "refuse", reason: "unsupported_preparation" };
  if (request.input.some((item) => item.type !== "text" || item.mentions.length > 0))
    return { kind: "refuse", reason: "unsupported_preparation" };
  const environment = getEnvironment(deps.db, request.environment.environmentId);
  if (!environment || environment.projectId !== request.projectId)
    return { kind: "refuse", reason: "workspace_unavailable" };
  if (environment.status !== "ready" || !environment.path)
    return { kind: "wait", reason: "workspace_unavailable" };
  const defaults = loadThreadExecutionDefaults(deps, {
    parentThreadId: request.parentThreadId ?? null,
    projectId: request.projectId,
    providerId: record.providerId,
  });
  const model = request.model ?? defaults.model;
  if (model === null) return { kind: "refuse", reason: "capability_mismatch" };
  let workspace: WorkspaceBinding;
  try {
    workspace = normalizeWorkspaceBinding({
      schemaVersion: 1,
      workspaceBindingId: `env:${environment.id}`,
      revision: 1,
      hostId: environment.hostId,
      environmentId: environment.id,
      projectId: environment.projectId,
      sourceId: null,
      pathFlavor: "posix",
      canonicalRoot: environment.path,
      adapter: { id: "bb-mcp-workspace", version: "1" },
      requiredCapabilities: [...requiredCapabilities],
    });
  } catch {
    return { kind: "refuse", reason: "unsupported_preparation" };
  }
  const permissionMode = clampPermissionModeToCeiling({
    ceiling: args.acceptedPermission,
    permissionMode: request.permissionMode ?? defaults.permissionMode,
  });
  if (permissionMode === null)
    return { kind: "refuse", reason: "capability_mismatch" };
  return {
    kind: "prepared",
    workspace,
    preparedRequest: intent.request,
    preparedExecution: resolvedThreadExecutionOptionsSchema.parse({
      model,
      serviceTier: request.serviceTier ?? defaults.serviceTier,
      reasoningLevel: request.reasoningLevel ?? defaults.reasoningLevel,
      permissionMode,
      source: "client/thread/start",
    }),
    attachmentReceipts: [],
  };
}
