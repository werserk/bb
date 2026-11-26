import { canonicalJsonBytes, sha256Digest } from "./placement-canonical.js";
import { z } from "zod";

export const workspaceCapabilities = [
  "text.read",
  "text.write",
  "text.edit",
  "path.list",
  "text.search",
  "shell.foreground",
  "git.via-shell",
  "context.text",
  "cancel.process-group",
  "path.provenance",
] as const;
const capability = z.enum(workspaceCapabilities);
const id = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0") && !/[\uD800-\uDFFF]/u.test(value));
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const root = id.refine(
  (value) =>
    value.startsWith("/") &&
    (value === "/" ||
      (!value.endsWith("/") &&
        !value.includes("//") &&
        !value.split("/").some((part) => part === "." || part === ".."))),
);
export const workspaceBindingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  workspaceBindingId: id,
  revision,
  hostId: id,
  environmentId: id,
  projectId: id.nullable(),
  sourceId: id.nullable(),
  pathFlavor: z.literal("posix"),
  canonicalRoot: root,
  adapter: z.strictObject({
    id: z.literal("bb-mcp-workspace"),
    version: z.literal("1"),
  }),
  requiredCapabilities: z
    .array(capability)
    .min(1)
    .refine((items) => new Set(items).size === items.length),
});
export const workspaceBindingRefSchema = z.strictObject({
  workspaceBindingId: id,
  revision,
  workspaceDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export const workspaceEvidenceSchema = z
  .strictObject({
    revision,
    workspace: workspaceBindingRefSchema,
    agent: z.strictObject({ hostId: id, generation: id, providerVersion: id }),
    tier: z.enum(["source", "local-fixture", "live"]),
    evidenceId: id,
    fixtureRunId: id.nullable(),
    connected: z.boolean(),
    rootVerified: z.boolean(),
    capabilities: z.partialRecord(
      capability,
      z.enum(["checked", "failed", "untested"]),
    ),
  })
  .superRefine((value, context) => {
    if ((value.tier === "local-fixture") !== (value.fixtureRunId !== null))
      context.addIssue({
        code: "custom",
        message: "Evidence tier/run mismatch",
      });
  });
export const workspacePurposeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("local-fixture"), fixtureRunId: id }),
  z.strictObject({ kind: z.literal("live") }),
]);
export type WorkspaceBinding = z.output<typeof workspaceBindingSchema>;
export type WorkspaceBindingRef = z.output<typeof workspaceBindingRefSchema>;
export type WorkspaceRouteEvidence = z.output<typeof workspaceEvidenceSchema>;
export type WorkspacePurpose = z.output<typeof workspacePurposeSchema>;
export type WorkspaceCapability = (typeof workspaceCapabilities)[number];
export function normalizeWorkspaceBinding(input: unknown): WorkspaceBinding {
  const binding = workspaceBindingSchema.parse(input);
  binding.requiredCapabilities.sort();
  return binding;
}
export function canonicalWorkspaceBytes(input: unknown): string {
  return canonicalJsonBytes(normalizeWorkspaceBinding(input));
}
export function workspaceBindingRef(input: unknown): WorkspaceBindingRef {
  const binding = normalizeWorkspaceBinding(input);
  return {
    workspaceBindingId: binding.workspaceBindingId,
    revision: binding.revision,
    workspaceDigest: sha256Digest(canonicalWorkspaceBytes(binding)),
  };
}
export class WorkspaceRefusal extends Error {
  constructor(
    readonly code:
      | "binding_changed"
      | "workspace_unavailable"
      | "unsupported_tool_route",
    message: string,
  ) {
    super(message);
  }
}
export function assertWorkspaceRoute(input: {
  binding: unknown;
  pinned: unknown;
  evidence: unknown;
  purpose: unknown;
}): WorkspaceBinding {
  const binding = normalizeWorkspaceBinding(input.binding);
  const pinned = workspaceBindingRefSchema.parse(input.pinned);
  const evidence = workspaceEvidenceSchema.parse(input.evidence);
  const purpose = workspacePurposeSchema.parse(input.purpose);
  const actual = workspaceBindingRef(binding);
  const equals = (ref: WorkspaceBindingRef) =>
    Object.keys(actual).every(
      (key) =>
        actual[key as keyof WorkspaceBindingRef] ===
        ref[key as keyof WorkspaceBindingRef],
    );
  if (!equals(pinned) || !equals(evidence.workspace))
    throw new WorkspaceRefusal(
      "binding_changed",
      "Workspace ref does not match its canonical descriptor",
    );
  if (
    evidence.tier === "source" ||
    evidence.tier !== purpose.kind ||
    (purpose.kind === "local-fixture" &&
      evidence.fixtureRunId !== purpose.fixtureRunId)
  )
    throw new WorkspaceRefusal(
      "unsupported_tool_route",
      "Evidence tier cannot qualify this execution purpose",
    );
  if (!evidence.connected || !evidence.rootVerified)
    throw new WorkspaceRefusal(
      "workspace_unavailable",
      "Workspace transport/root unavailable",
    );
  if (
    binding.requiredCapabilities.some(
      (name) => evidence.capabilities[name] !== "checked",
    )
  )
    throw new WorkspaceRefusal(
      "unsupported_tool_route",
      "Required workspace capability not checked",
    );
  return binding;
}
