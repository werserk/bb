import { z } from "zod";
import { jsonValueSchema } from "./json-value.js";
import {
  workspaceBindingRefSchema,
  workspaceEvidenceSchema,
} from "./workspace-binding.js";

export const placementIdSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
export const placementRevisionSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const placementDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const id = placementIdSchema;
const revision = placementRevisionSchema;
const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const agentSelectionSchema = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("auto") }),
  z.strictObject({ mode: z.literal("worker"), workerId: id }),
]);
export const placementPhaseSchema = z.enum([
  "accepted",
  "materializing",
  "pending",
  "reserved",
  "creating",
  "queued",
  "admitted",
  "starting",
  "active",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "unknown",
  "refused",
]);
export const placementReasonSchema = z.enum([
  "native_queue_wait",
  "all_busy",
  "selected_busy",
  "owner_unavailable",
  "worker_disabled",
  "worker_draining",
  "worker_offline",
  "auth_required",
  "quota_blocked",
  "custody_unknown",
  "workspace_unavailable",
  "source_required",
  "unsupported_tool_route",
  "unsupported_preparation",
  "capability_mismatch",
  "binding_changed",
  "reconciliation_required",
  "retry_consent_required",
  "retry_scheduler_required",
  "worker_identity_mismatch",
]);
export const placementBindingSchema = z.strictObject({
  ownerPluginId: id,
  providerId: id,
  accountId: id,
  workerId: id,
  agentHostId: id,
  generation: id,
  workspace: workspaceBindingRefSchema,
});
export const workerLeaseSchema = z.strictObject({
  workerId: id,
  agentHostId: id,
  generation: id,
  fence: revision,
  purpose: z.enum(["runtime", "usage-read"]),
});
export const workerCustodySchema = z
  .strictObject({
    revision,
    status: z.enum(["free", "held", "unknown"]),
    workerId: id,
    agentHostId: id,
    generation: id,
    holder: z
      .strictObject({
        fence: revision,
        threadId: id.nullable(),
        processStart: id,
        bootId: id,
      })
      .nullable(),
    lock: z.strictObject({ device: id, inode: id }).nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      (v.status === "free" && (v.holder !== null || v.lock === null)) ||
      (v.status === "held" && (v.holder === null || v.lock === null))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Custody requires an observed fixed lock and consistent holder",
      });
  });
const qualification = z
  .strictObject({
    tier: z.enum(["source", "local-fixture", "live"]),
    evidenceId: id,
    fixtureRunId: id.nullable(),
  })
  .superRefine((v, ctx) => {
    if ((v.tier === "local-fixture") !== (v.fixtureRunId !== null))
      ctx.addIssue({ code: "custom", message: "Evidence tier/run mismatch" });
  });
export const workerObservationSchema = z
  .strictObject({
    workerId: id,
    accountId: id,
    agentHostId: id,
    generation: id,
    providerId: id,
    providerVersion: id,
    revision,
    admission: z.enum(["enabled", "draining", "disabled"]),
    connected: z.boolean(),
    auth: z.enum(["authenticated", "required", "unknown"]),
    qualification,
    custody: workerCustodySchema,
    exclusion: z.strictObject({
      authorityPluginId: id,
      revision,
      status: z.enum(["excluded", "included", "unknown"]),
    }),
    quota: z.strictObject({
      revision,
      freshness: z.enum(["fresh", "stale", "unknown"]),
      block: z
        .strictObject({
          kind: z.enum(["quota", "auth"]),
          generation: id,
          model: id.nullable(),
          recheckAt: z.number().int().nullable(),
          evidenceId: id,
        })
        .nullable(),
    }),
    routes: z.array(workspaceEvidenceSchema),
    launchProfileId: id.nullable(),
  })
  .superRefine((v, ctx) => {
    if (
      v.custody.workerId !== v.workerId ||
      v.custody.agentHostId !== v.agentHostId ||
      v.custody.generation !== v.generation
    )
      ctx.addIssue({ code: "custom", message: "Custody identity mismatch" });
  });
export const placementOperationSchema = z.strictObject({
  id,
  schemaVersion: z.literal(1),
  revision,
  acceptedSeq: revision,
  kind: z.enum(["independent", "continuation", "fork", "retry"]),
  phase: placementPhaseSchema,
  reason: placementReasonSchema.nullable(),
  requestedSelection: agentSelectionSchema.nullable(),
  binding: placementBindingSchema.nullable(),
  threadId: id.nullable(),
  payloadDigest: placementDigestSchema,
  queueReceipt: z
    .strictObject({ queuedMessageId: id, requestId: id.nullable() })
    .nullable(),
  failedOperationId: id.nullable(),
  retrySchedule: z
    .strictObject({
      state: z.enum(["awaiting_scheduler", "queued"]),
      sendAt: z.number().int().nullable(),
      schedulerRevision: sequence,
    })
    .nullable(),
  cancelRequested: z.boolean(),
});
export const retryConsentSchema = z.strictObject({
  consentId: id,
  failedOperationId: id,
  bindingDigest: placementDigestSchema,
  failedPayloadDigest: placementDigestSchema,
  budget: z.literal(1),
  consumedByOperationId: id.nullable(),
  revoked: z.boolean(),
});
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export type PlacementPhase = z.infer<typeof placementPhaseSchema>;
export type PlacementReason = z.infer<typeof placementReasonSchema>;
export type PlacementBinding = z.infer<typeof placementBindingSchema>;
export type PlacementOperation = z.infer<typeof placementOperationSchema>;
export type WorkerObservation = z.infer<typeof workerObservationSchema>;
export type WorkerCustody = z.infer<typeof workerCustodySchema>;
export type WorkerLease = z.infer<typeof workerLeaseSchema>;
export type RetryConsent = z.infer<typeof retryConsentSchema>;
export const placementPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  intent: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("independent"),
      selection: agentSelectionSchema,
      request: jsonValueSchema,
    }),
    z.strictObject({
      kind: z.literal("continuation"),
      threadId: id,
      request: jsonValueSchema,
    }),
    z.strictObject({ kind: z.literal("fork"), request: jsonValueSchema }),
    z.strictObject({
      kind: z.literal("retry"),
      failedOperationId: id,
      consentId: id,
    }),
  ]),
});
export type PlacementPayload = z.infer<typeof placementPayloadSchema>;

export const placementPermissionProvenanceSchema = z.strictObject({
  identity: z.literal("local-unverified"),
  authority: z.literal("local-input-parity"),
  actionId: placementIdSchema,
});
export type PlacementPermissionProvenance = z.infer<
  typeof placementPermissionProvenanceSchema
>;
