// ../domain/src/service-turn.ts
import { z } from "zod";
var serviceTurnDescriptorSchema = z.object({
  version: z.literal(1),
  visibility: z.literal("hidden"),
  deliveryId: z.string().min(1).optional(),
  automaticRedelivery: z.boolean().optional(),
  reason: z.string().regex(/^[a-z0-9-]{1,64}$/),
  origin: z.object({
    pluginId: z.string().min(1),
    senderThreadId: z.string().min(1).nullable()
  })
}).strict();

// ../domain/src/context-snapshot.ts
import { z as z2 } from "zod";
var tokenCountSchema = z2.number().int().nonnegative();
var contextEntrySchema = z2.object({
  id: z2.string().min(1),
  label: z2.string().min(1),
  tokens: tokenCountSchema
});
var contextCategorySchema = z2.object({
  id: z2.string().min(1),
  label: z2.string().min(1),
  kind: z2.enum(["used", "free", "reserved", "deferred"]),
  tokens: tokenCountSchema,
  entries: z2.array(contextEntrySchema)
});
var contextSnapshotSchema = z2.object({
  capturedAt: z2.iso.datetime(),
  providerSessionId: z2.string().min(1),
  providerTurnId: z2.string().min(1).nullable(),
  model: z2.string().min(1),
  usedTokens: tokenCountSchema,
  contextWindowTokens: z2.number().int().positive(),
  autoCompactAtTokens: z2.number().int().positive().nullable(),
  estimated: z2.boolean(),
  categories: z2.array(contextCategorySchema)
});

// ../domain/src/shared-types.ts
import { z as z4 } from "zod";

// ../domain/src/json-value.ts
import { z as z3 } from "zod";
var jsonValueSchema = z3.lazy(
  () => z3.union([
    z3.string(),
    z3.number(),
    z3.boolean(),
    z3.null(),
    z3.array(jsonValueSchema),
    z3.record(z3.string(), jsonValueSchema)
  ])
);
var jsonObjectSchema = z3.record(
  z3.string(),
  jsonValueSchema
);

// ../domain/src/shared-types.ts
var reasoningLevelSchema = z4.string().min(1);
var serviceTierSchema = z4.string().min(1);
var instructionModeValues = ["append", "replace"];
var instructionModeSchema = z4.enum(instructionModeValues);
var permissionModeValues = ["accept-edits", "auto", "full"];
var permissionModeSchema = z4.enum(permissionModeValues);
var permissionModeInputSchema = z4.union([permissionModeSchema, z4.literal("workspace-write")]).transform(
  (permissionMode) => permissionMode === "workspace-write" ? "accept-edits" : permissionMode
);
var legacyRecordedPermissionModeValues = [
  "workspace-write",
  "readonly"
];
var recordedPermissionModeSchema = z4.enum([
  ...permissionModeValues,
  ...legacyRecordedPermissionModeValues
]);
var permissionEscalationValues = ["ask", "deny"];
var permissionEscalationSchema = z4.enum(permissionEscalationValues);
var promptInputVisibilityValues = ["agent-only"];
var promptInputVisibilitySchema = z4.enum(promptInputVisibilityValues);
var promptInputVisibilityFields = {
  visibility: promptInputVisibilitySchema.optional()
};
var promptMentionPathSourceValues = ["workspace", "thread-storage"];
var promptMentionPathSourceSchema = z4.enum(promptMentionPathSourceValues);
var promptMentionPathEntryKindValues = ["file", "directory"];
var promptMentionPathEntryKindSchema = z4.enum(
  promptMentionPathEntryKindValues
);
var promptMentionCommandTriggerValues = ["/", "$"];
var promptMentionCommandTriggerSchema = z4.enum(
  promptMentionCommandTriggerValues
);
var promptMentionCommandSourceValues = ["skill", "command"];
var promptMentionCommandSourceSchema = z4.enum(
  promptMentionCommandSourceValues
);
var promptMentionCommandOriginValues = [
  "builtin",
  "project",
  "user"
];
var promptMentionCommandOriginSchema = z4.enum(
  promptMentionCommandOriginValues
);
var canonicalPromptMentionResourceSchema = z4.discriminatedUnion("kind", [
  z4.object({
    kind: z4.literal("thread"),
    threadId: z4.string(),
    projectId: z4.string().optional(),
    label: z4.string()
  }),
  z4.object({
    kind: z4.literal("project"),
    projectId: z4.string(),
    label: z4.string()
  }),
  z4.object({
    kind: z4.literal("section"),
    sectionId: z4.string(),
    label: z4.string()
  }),
  z4.object({
    kind: z4.literal("path"),
    source: promptMentionPathSourceSchema,
    entryKind: promptMentionPathEntryKindSchema,
    path: z4.string(),
    label: z4.string()
  }),
  z4.object({
    kind: z4.literal("command"),
    trigger: promptMentionCommandTriggerSchema,
    name: z4.string(),
    source: promptMentionCommandSourceSchema,
    origin: promptMentionCommandOriginSchema,
    label: z4.string(),
    argumentHint: z4.string().nullable()
  }),
  z4.object({
    kind: z4.literal("plugin"),
    pluginId: z4.string(),
    icon: z4.string().nullable().optional(),
    itemId: z4.string(),
    label: z4.string()
  }),
  z4.object({
    kind: z4.literal("attachment"),
    path: z4.string(),
    label: z4.string()
  })
]);
function normalizeLegacyPromptMentionResource(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value;
  if (record.kind !== "folder" || typeof record.folderId !== "string") {
    return value;
  }
  const { folderId, ...rest } = record;
  return { ...rest, kind: "section", sectionId: folderId };
}
var promptMentionResourceSchema = z4.preprocess(
  normalizeLegacyPromptMentionResource,
  canonicalPromptMentionResourceSchema
);
var promptTextMentionSchema = z4.object({
  start: z4.number().int().nonnegative(),
  end: z4.number().int().nonnegative(),
  resource: promptMentionResourceSchema
});
var promptInputSchema = z4.discriminatedUnion("type", [
  z4.object({
    type: z4.literal("text"),
    text: z4.string(),
    mentions: z4.array(promptTextMentionSchema).default([]),
    ...promptInputVisibilityFields
  }),
  z4.object({
    type: z4.literal("image"),
    url: z4.string().url(),
    ...promptInputVisibilityFields
  }),
  z4.object({
    type: z4.literal("localImage"),
    path: z4.string(),
    sourceProjectId: z4.string().min(1).optional(),
    hostId: z4.string().min(1).optional(),
    ...promptInputVisibilityFields
  }),
  z4.object({
    type: z4.literal("localFile"),
    path: z4.string(),
    sourceProjectId: z4.string().min(1).optional(),
    hostId: z4.string().min(1).optional(),
    name: z4.string().optional(),
    sizeBytes: z4.number().int().nonnegative().optional(),
    mimeType: z4.string().optional(),
    ...promptInputVisibilityFields
  })
]);
var threadExecutionSourceSchema = z4.enum([
  "client/thread/start",
  "client/turn/requested",
  "client/turn/start"
]);
var callerExecutionInputSourceValues = [
  "explicit",
  "client-preference"
];
var callerExecutionInputSourceSchema = z4.enum(
  callerExecutionInputSourceValues
);
var threadExecutionOptionsSchema = z4.object({
  model: z4.string().optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  permissionMode: permissionModeSchema.optional(),
  source: threadExecutionSourceSchema.optional(),
  seq: z4.number().int().optional()
});
var resolvedThreadExecutionOptionsSchema = threadExecutionOptionsSchema.extend({
  model: z4.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema,
  source: threadExecutionSourceSchema
});
var recordedThreadExecutionOptionsSchema = resolvedThreadExecutionOptionsSchema.extend({
  permissionMode: recordedPermissionModeSchema
});
var runtimePermissionScopeValues = ["workspace", "full"];
var runtimePermissionScopeSchema = z4.enum(runtimePermissionScopeValues);
var runtimePermissionPolicySchema = z4.discriminatedUnion(
  "permissionMode",
  [
    z4.object({
      permissionMode: z4.literal("accept-edits"),
      permissionScope: z4.literal("workspace"),
      approvalReviewer: z4.literal("user"),
      permissionEscalation: permissionEscalationSchema
    }),
    z4.object({
      permissionMode: z4.literal("auto"),
      permissionScope: z4.literal("workspace"),
      approvalReviewer: z4.literal("automatic"),
      permissionEscalation: permissionEscalationSchema
    }),
    z4.object({
      permissionMode: z4.literal("full"),
      permissionScope: z4.literal("full"),
      approvalReviewer: z4.null(),
      permissionEscalation: z4.null()
    })
  ]
);
var promptModeSchema = z4.literal("plan");
var sessionOptionValueSchema = z4.union([z4.string(), z4.boolean()]);
var sessionOptionSelectionsSchema = z4.record(
  z4.string().min(1),
  sessionOptionValueSchema
);
var runtimeThreadExecutionBaseOptionsSchema = z4.object({
  model: z4.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema.optional(),
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  providerOptions: jsonObjectSchema
});
var runtimeThreadExecutionOptionsSchema = runtimeThreadExecutionBaseOptionsSchema.and(runtimePermissionPolicySchema);
var projectExecutionDefaultsSchema = z4.object({
  providerId: z4.string().min(1),
  model: z4.string().min(1),
  serviceTier: serviceTierSchema,
  reasoningLevel: reasoningLevelSchema,
  permissionMode: permissionModeSchema
});

// ../domain/src/completed-turn-display.ts
import { z as z5 } from "zod";
var COMPLETED_TURN_DISPLAY_VALUES = ["collapse", "flat"];
var completedTurnDisplaySchema = z5.enum(COMPLETED_TURN_DISPLAY_VALUES);

// ../domain/src/plugin-id.ts
import { z as z6 } from "zod";
var pluginIdSchema = z6.string().regex(/^[a-z0-9][a-z0-9-]*$/u);

// ../domain/src/background-task.ts
import { z as z7 } from "zod";
var backgroundTaskStatusValues = [
  "pending",
  "running",
  "paused",
  "completed",
  "failed",
  "killed",
  "stopped"
];
var backgroundTaskStatusSchema = z7.enum(backgroundTaskStatusValues);
var workflowAgentStateValues = [
  "queued",
  "running",
  "done",
  "failed",
  "skipped"
];
var workflowAgentStateSchema = z7.enum(workflowAgentStateValues);
var workflowAgentSnapshotSchema = z7.object({
  index: z7.number().int().positive(),
  label: z7.string(),
  state: workflowAgentStateSchema,
  model: z7.string(),
  attempt: z7.number().int().positive(),
  cached: z7.boolean(),
  lastProgressAt: z7.number(),
  phaseIndex: z7.number().int().positive().optional(),
  phaseTitle: z7.string().optional(),
  agentType: z7.string().optional(),
  isolation: z7.string().optional(),
  queuedAt: z7.number().optional(),
  startedAt: z7.number().optional(),
  lastToolName: z7.string().optional(),
  lastToolSummary: z7.string().optional(),
  promptPreview: z7.string().optional(),
  resultPreview: z7.string().optional(),
  error: z7.string().optional(),
  tokens: z7.number().optional(),
  toolCalls: z7.number().optional(),
  durationMs: z7.number().optional()
});
var workflowPhaseSnapshotSchema = z7.object({
  index: z7.number().int().positive(),
  title: z7.string(),
  kind: z7.string().optional()
});
var workflowProgressSnapshotSchema = z7.object({
  phases: z7.array(workflowPhaseSnapshotSchema),
  agents: z7.array(workflowAgentSnapshotSchema)
});
var backgroundTaskUsageSchema = z7.object({
  totalTokens: z7.number(),
  toolUses: z7.number(),
  durationMs: z7.number()
});

// ../domain/src/thread-create-origin.ts
import { z as z8 } from "zod";
var threadCreateOriginValues = ["app", "cli", "sdk", "plugin"];
var threadCreateOriginSchema = z8.enum(threadCreateOriginValues);

// ../domain/src/protocol-ids.ts
import { z as z9 } from "zod";
var conversationQuestionIdSchema = z9.string().regex(/^qst_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);
var clientTurnRequestIdSchema = z9.string().regex(/^creq_[23456789abcdefghijkmnpqrstuvwxyz]{10}$/u);

// ../domain/src/system-message.ts
import { z as z10 } from "zod";
var systemMessageKindValues = [
  "ownership-assigned",
  "ownership-removed",
  "ownership-batch",
  "child-needs-attention",
  "child-completed",
  "child-failed",
  "child-interrupted",
  "child-outcome-batch",
  "tool-result-delivered",
  "environment-directory-updated",
  "unlabeled"
];
var systemMessageKindSchema = z10.enum(systemMessageKindValues);
var systemThreadInterruptedReasonSchema = z10.enum([
  "manual-stop",
  "host-daemon-restarted",
  "host-removed",
  "provider-turn-idle"
]);
var childThreadOutcomeSchema = z10.object({
  threadId: z10.string(),
  /** The child root turn this outcome reports; absent on older notices. */
  turnId: z10.string().optional(),
  status: z10.enum(["completed", "failed", "interrupted"]),
  interruption: z10.object({
    reason: systemThreadInterruptedReasonSchema,
    cause: z10.literal("host-connection-lost").optional()
  }).optional()
});
var systemMessageSubjectSchema = z10.discriminatedUnion("kind", [
  z10.object({
    kind: z10.literal("thread"),
    threadId: z10.string(),
    threadName: z10.string(),
    outcomes: z10.array(childThreadOutcomeSchema).optional()
  }),
  z10.object({
    kind: z10.literal("thread-batch"),
    count: z10.number(),
    outcomes: z10.array(childThreadOutcomeSchema).optional()
  }),
  z10.object({
    kind: z10.literal("tool-call"),
    toolName: z10.string(),
    suppress: z10.boolean()
  }),
  z10.object({
    kind: z10.literal("directory"),
    path: z10.string()
  })
]);

// ../domain/src/item-presentation.ts
import { z as z11 } from "zod";
var THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH = 280;
var threadEventItemPresentationLabelSchema = z11.object({
  pending: z11.string().min(1),
  completed: z11.string().min(1)
});
var threadEventItemPresentationIconSchema = z11.object({
  glyph: z11.string().min(1)
});
var threadEventItemPresentationTintSchema = z11.object({
  light: z11.string().min(1),
  dark: z11.string().min(1)
});
var THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH = 80;
var threadEventItemPresentationBadgeSchema = z11.object({
  glyph: z11.string().min(1),
  label: z11.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  hint: z11.string().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_BADGE_LABEL_MAX_LENGTH),
  tone: z11.enum(["neutral", "destructive"])
});
var threadEventItemPresentationSchema = z11.object({
  label: threadEventItemPresentationLabelSchema,
  icon: threadEventItemPresentationIconSchema,
  title: z11.string().optional(),
  detail: z11.string().max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  suppress: z11.boolean().optional(),
  ownerPost: z11.boolean().optional(),
  tint: threadEventItemPresentationTintSchema.optional(),
  badge: threadEventItemPresentationBadgeSchema.optional()
});

// ../domain/src/pending-interactions.ts
import { z as z13 } from "zod";

// ../domain/src/plugin-interaction-limits.ts
var PLUGIN_INTERACTION_MAX_TITLE_LENGTH = 160;
var PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES = 64 * 1024;
var PLUGIN_INTERACTION_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1e3;
function jsonByteLength(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

// ../domain/src/provider-extension-kind.ts
import { z as z12 } from "zod";
var EXTENSION_KIND_PATTERN = /^[a-z0-9-]+\/[a-z0-9-]+$/u;
function isExtensionKind(value) {
  return EXTENSION_KIND_PATTERN.test(value);
}
var extensionKindSchema = z12.string().refine(isExtensionKind, {
  message: 'extension kinds are "<pluginId>/<name>" (lowercase letters, digits, and "-")'
});

// ../domain/src/pending-interactions.ts
var pendingInteractionStatusSchema = z13.enum([
  "pending",
  "resolving",
  "resolved",
  "interrupted"
]);
var pendingInteractionCommandActionSchema = z13.discriminatedUnion(
  "type",
  [
    z13.object({
      type: z13.literal("read"),
      command: z13.string(),
      name: z13.string(),
      path: z13.string()
    }),
    z13.object({
      type: z13.literal("listFiles"),
      command: z13.string(),
      path: z13.string().nullable()
    }),
    z13.object({
      type: z13.literal("search"),
      command: z13.string(),
      query: z13.string().nullable(),
      path: z13.string().nullable()
    }),
    z13.object({
      type: z13.literal("unknown"),
      command: z13.string()
    })
  ]
);
var pendingInteractionNetworkPermissionsSchema = z13.object({
  enabled: z13.boolean().nullable()
});
var pendingInteractionFileSystemPermissionsSchema = z13.object({
  read: z13.array(z13.string()),
  write: z13.array(z13.string())
});
var pendingInteractionMacOsPreferencesPermissionSchema = z13.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsContactsPermissionSchema = z13.enum([
  "none",
  "read_only",
  "read_write"
]);
var pendingInteractionMacOsAutomationPermissionSchema = z13.union([
  z13.literal("none"),
  z13.literal("all"),
  z13.object({
    kind: z13.literal("bundle_ids"),
    bundleIds: z13.array(z13.string())
  })
]);
var pendingInteractionMacOsPermissionsSchema = z13.object({
  preferences: pendingInteractionMacOsPreferencesPermissionSchema,
  automations: pendingInteractionMacOsAutomationPermissionSchema,
  launchServices: z13.boolean(),
  accessibility: z13.boolean(),
  calendar: z13.boolean(),
  reminders: z13.boolean(),
  contacts: pendingInteractionMacOsContactsPermissionSchema
});
var pendingInteractionRequestedPermissionProfileSchema = z13.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable(),
  macos: pendingInteractionMacOsPermissionsSchema.nullable()
});
var pendingInteractionGrantablePermissionProfileSchema = z13.object({
  network: pendingInteractionNetworkPermissionsSchema.nullable(),
  fileSystem: pendingInteractionFileSystemPermissionsSchema.nullable()
}).strict();
var pendingInteractionGrantedPermissionProfileSchema = pendingInteractionGrantablePermissionProfileSchema;
var pendingInteractionApprovalDecisionSchema = z13.enum([
  "allow_once",
  "allow_for_session",
  "deny"
]);
var pendingInteractionFileChangeWriteScopeSchema = z13.string().min(1);
var pendingInteractionCommandApprovalSubjectSchema = z13.object({
  kind: z13.literal("command"),
  itemId: z13.string().min(1),
  command: z13.string().min(1),
  cwd: z13.string().nullable(),
  actions: z13.array(pendingInteractionCommandActionSchema),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionFileChangeApprovalSubjectSchema = z13.object({
  kind: z13.literal("file_change"),
  itemId: z13.string().min(1),
  writeScope: pendingInteractionFileChangeWriteScopeSchema.nullable(),
  sessionGrant: pendingInteractionGrantablePermissionProfileSchema.nullable()
});
var pendingInteractionPermissionGrantApprovalSubjectSchema = z13.object({
  kind: z13.literal("permission_grant"),
  itemId: z13.string().min(1),
  toolName: z13.string().nullable(),
  permissions: pendingInteractionGrantablePermissionProfileSchema
});
var pendingInteractionPlanApprovalSubjectSchema = z13.object({
  kind: z13.literal("plan"),
  itemId: z13.string().min(1),
  plan: z13.string().min(1),
  planFilePath: z13.string().min(1).nullable()
});
var pendingInteractionToolUseApprovalSubjectSchema = z13.object({
  kind: z13.literal("tool_use"),
  itemId: z13.string().min(1),
  tool: z13.string().min(1),
  presentation: threadEventItemPresentationSchema
});
var pendingInteractionApprovalSubjectSchema = z13.discriminatedUnion("kind", [
  pendingInteractionCommandApprovalSubjectSchema,
  pendingInteractionFileChangeApprovalSubjectSchema,
  pendingInteractionPermissionGrantApprovalSubjectSchema,
  pendingInteractionPlanApprovalSubjectSchema,
  pendingInteractionToolUseApprovalSubjectSchema
]);
var approvalPendingInteractionPayloadSchema = z13.object({
  kind: z13.literal("approval"),
  subject: pendingInteractionApprovalSubjectSchema,
  reason: z13.string().nullable(),
  availableDecisions: z13.array(pendingInteractionApprovalDecisionSchema).min(1)
});
var USER_QUESTION_MAX_QUESTIONS = 10;
var USER_QUESTION_MAX_OPTIONS = 4;
var USER_QUESTION_MAX_SELECTED = 4;
var USER_QUESTION_MAX_FREE_TEXT_LENGTH = 4096;
var pendingInteractionUserQuestionIdSchema = z13.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question ids cannot be blank"
});
var pendingInteractionUserQuestionPromptSchema = z13.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question prompts cannot be blank"
});
var pendingInteractionUserQuestionShortLabelSchema = z13.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question short labels cannot be blank"
});
var pendingInteractionUserQuestionOptionValueSchema = z13.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option values cannot be blank"
});
var pendingInteractionUserQuestionOptionLabelSchema = z13.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option labels cannot be blank"
});
var pendingInteractionUserQuestionOptionDescriptionSchema = z13.string().min(1).refine((value) => value.trim().length > 0, {
  message: "User question option descriptions cannot be blank"
});
var pendingInteractionUserQuestionFreeTextSchema = z13.string().min(1).max(
  USER_QUESTION_MAX_FREE_TEXT_LENGTH,
  `User question free text cannot exceed ${USER_QUESTION_MAX_FREE_TEXT_LENGTH} characters`
).refine((value) => value.trim().length > 0, {
  message: "User question free text cannot be blank"
});
var pendingInteractionUserQuestionOptionSchema = z13.object({
  value: pendingInteractionUserQuestionOptionValueSchema,
  label: pendingInteractionUserQuestionOptionLabelSchema,
  description: pendingInteractionUserQuestionOptionDescriptionSchema.optional()
});
var pendingInteractionUserQuestionQuestionSchema = z13.object({
  id: pendingInteractionUserQuestionIdSchema,
  prompt: pendingInteractionUserQuestionPromptSchema,
  shortLabel: pendingInteractionUserQuestionShortLabelSchema.optional(),
  multiSelect: z13.boolean(),
  options: z13.array(pendingInteractionUserQuestionOptionSchema).max(
    USER_QUESTION_MAX_OPTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_OPTIONS} options`
  ).optional(),
  allowFreeText: z13.boolean(),
  required: z13.boolean().default(true)
}).superRefine((question, context) => {
  const optionValues = /* @__PURE__ */ new Set();
  question.options?.forEach((option, index) => {
    if (optionValues.has(option.value)) {
      context.addIssue({
        code: z13.ZodIssueCode.custom,
        message: "User question option values must be unique",
        path: ["options", index, "value"]
      });
      return;
    }
    optionValues.add(option.value);
  });
}).refine(
  (question) => question.allowFreeText || (question.options?.length ?? 0) > 0,
  {
    message: "User questions must allow free text or provide at least one option",
    path: ["options"]
  }
);
var userQuestionPendingInteractionPayloadSchema = z13.object({
  kind: z13.literal("user_question"),
  questions: z13.array(pendingInteractionUserQuestionQuestionSchema).min(1).max(
    USER_QUESTION_MAX_QUESTIONS,
    `User questions cannot include more than ${USER_QUESTION_MAX_QUESTIONS} questions`
  )
}).superRefine((payload, context) => {
  const questionIds = /* @__PURE__ */ new Set();
  payload.questions.forEach((question, index) => {
    if (questionIds.has(question.id)) {
      context.addIssue({
        code: z13.ZodIssueCode.custom,
        message: "User question ids must be unique",
        path: ["questions", index, "id"]
      });
      return;
    }
    questionIds.add(question.id);
  });
});
var pluginPendingInteractionPayloadSchema = z13.object({
  kind: z13.literal("plugin"),
  title: z13.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema,
  presentation: threadEventItemPresentationSchema.optional()
});
var pluginExtensionInteractionRequestPayloadSchema = z13.object({
  kind: extensionKindSchema,
  title: z13.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH),
  data: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin request data exceeds 64 KiB" }
  )
});
var interactionRequestPayloadSchema = z13.union([
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
var pendingInteractionPayloadSchema = z13.union([
  approvalPendingInteractionPayloadSchema,
  userQuestionPendingInteractionPayloadSchema,
  pluginExtensionInteractionRequestPayloadSchema
]);
var approvalDecisionDiscriminatorError = "Invalid discriminator value. Expected 'allow_once' | 'allow_for_session' | 'deny'";
var approvalPendingInteractionResolutionSchema = z13.discriminatedUnion(
  "decision",
  [
    z13.object({
      decision: z13.literal("allow_once"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z13.object({
      decision: z13.literal("allow_for_session"),
      grantedPermissions: pendingInteractionGrantedPermissionProfileSchema.nullable()
    }),
    z13.object({
      decision: z13.literal("deny")
    })
  ],
  approvalDecisionDiscriminatorError
);
var pendingInteractionUserAnswerSchema = z13.object({
  selected: z13.array(z13.string().min(1)).max(
    USER_QUESTION_MAX_SELECTED,
    `User question selected choices cannot exceed ${USER_QUESTION_MAX_SELECTED}`
  ),
  freeText: pendingInteractionUserQuestionFreeTextSchema.optional()
});
var userQuestionPendingInteractionResolutionSchema = z13.object({
  kind: z13.literal("user_answer"),
  answers: z13.record(z13.string().min(1), pendingInteractionUserAnswerSchema)
});
var pluginInteractionDescriptionSchema = z13.object({
  title: z13.string().trim().min(1).max(PLUGIN_INTERACTION_MAX_TITLE_LENGTH).optional(),
  detail: z13.string().trim().min(1).max(THREAD_EVENT_ITEM_PRESENTATION_DETAIL_MAX_LENGTH).optional(),
  payload: jsonValueSchema.refine(
    (value) => jsonByteLength(value) <= PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES,
    { message: "Plugin interaction description payload exceeds 64 KiB" }
  ).optional()
});
var pluginPendingInteractionResolutionSchema = z13.object({
  kind: z13.literal("plugin_submitted"),
  description: pluginInteractionDescriptionSchema.optional()
});
var pluginExtensionInteractionResolutionSchema = z13.object({
  kind: z13.literal("request_answer"),
  value: jsonValueSchema
});
var resolutionDiscriminatorKeys = /* @__PURE__ */ new Set(["decision", "kind"]);
function pendingInteractionResolutionError(issue) {
  if (issue.code !== "invalid_union") {
    return approvalDecisionDiscriminatorError;
  }
  for (const branch of issue.errors) {
    const first = branch[0];
    if (first !== void 0 && !resolutionDiscriminatorKeys.has(first.path[0] ?? "")) {
      return first.message;
    }
  }
  return approvalDecisionDiscriminatorError;
}
var pendingInteractionResolutionSchema = z13.union(
  [
    approvalPendingInteractionResolutionSchema,
    userQuestionPendingInteractionResolutionSchema,
    pluginPendingInteractionResolutionSchema,
    pluginExtensionInteractionResolutionSchema
  ],
  { error: pendingInteractionResolutionError }
);
var approvalInteractionOutcomeSchema = z13.object({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema
});
var userQuestionInteractionOutcomeSchema = z13.object({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema
});
var pluginExtensionInteractionOutcomeSchema = z13.object({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema
});
var providerInteractionOutcomeSchema = z13.union([
  approvalInteractionOutcomeSchema,
  userQuestionInteractionOutcomeSchema,
  pluginExtensionInteractionOutcomeSchema
]);
var pendingInteractionProviderOriginSchema = z13.object({
  kind: z13.literal("provider"),
  providerId: z13.string().min(1),
  providerThreadId: z13.string().min(1),
  providerRequestId: z13.string().min(1)
});
var pendingInteractionPluginOriginSchema = z13.object({
  kind: z13.literal("plugin"),
  pluginId: z13.string().min(1),
  rendererId: z13.string().min(1)
});
var pendingInteractionCreateSchema = z13.object({
  threadId: z13.string().min(1),
  turnId: z13.string().min(1),
  providerId: z13.string().min(1),
  providerThreadId: z13.string().min(1),
  providerRequestId: z13.string().min(1),
  payload: pendingInteractionPayloadSchema
});
var pendingInteractionBaseSchema = z13.object({
  id: z13.string().min(1),
  threadId: z13.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z13.string().nullable(),
  createdAt: z13.number().int().nonnegative(),
  expiresAt: z13.number().int().nonnegative().nullable().optional(),
  resolvedAt: z13.number().int().nonnegative().nullable()
});
var providerPendingInteractionBaseSchema = pendingInteractionBaseSchema.extend({
  turnId: z13.string().min(1),
  providerId: z13.string().min(1),
  providerThreadId: z13.string().min(1),
  providerRequestId: z13.string().min(1),
  origin: pendingInteractionProviderOriginSchema.optional()
});
var approvalPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: approvalPendingInteractionPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable()
});
var userQuestionPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable()
});
var pluginExtensionPendingInteractionSchema = providerPendingInteractionBaseSchema.extend({
  payload: pluginExtensionInteractionRequestPayloadSchema,
  resolution: pluginExtensionInteractionResolutionSchema.nullable()
});
var providerPendingInteractionSchema = z13.union([
  approvalPendingInteractionSchema,
  userQuestionPendingInteractionSchema,
  pluginExtensionPendingInteractionSchema
]);
var pluginPendingInteractionSchema = pendingInteractionBaseSchema.extend({
  turnId: z13.string().min(1).nullable(),
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema,
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pendingInteractionSchema = z13.union([
  providerPendingInteractionSchema,
  pluginPendingInteractionSchema
]);
var interactionLifecycleRecordBaseSchema = z13.object({
  id: z13.string().min(1),
  status: pendingInteractionStatusSchema,
  statusReason: z13.string().nullable()
});
var interactionLifecycleProviderOriginSchema = z13.object({
  kind: z13.literal("provider"),
  providerId: z13.string().min(1),
  providerRequestId: z13.string().min(1)
});
var approvalInteractionLifecycleRecordPayloadSchema = approvalPendingInteractionPayloadSchema.omit({ availableDecisions: true });
var approvalInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: approvalInteractionLifecycleRecordPayloadSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable()
});
var userQuestionInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: userQuestionPendingInteractionPayloadSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable()
});
var pluginInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: pendingInteractionPluginOriginSchema,
  payload: pluginPendingInteractionPayloadSchema.omit({ data: true }),
  resolution: pluginPendingInteractionResolutionSchema.nullable()
});
var pluginExtensionInteractionLifecycleSchema = interactionLifecycleRecordBaseSchema.extend({
  origin: interactionLifecycleProviderOriginSchema,
  payload: pluginExtensionInteractionRequestPayloadSchema.omit({
    data: true
  }),
  resolution: pluginExtensionInteractionResolutionSchema.omit({ value: true }).nullable()
});
var interactionLifecycleSchema = z13.union([
  approvalInteractionLifecycleSchema,
  userQuestionInteractionLifecycleSchema,
  pluginInteractionLifecycleSchema,
  pluginExtensionInteractionLifecycleSchema
]);

// ../domain/src/plugin-icon.ts
var PLUGIN_ICON_MAX_BYTES = 32 * 1024;
var NAMESPACED_GLYPH_PATTERN = /^[a-z0-9-]+\/[a-z0-9][a-z0-9-]*$/u;
function isNamespacedGlyph(glyph) {
  return NAMESPACED_GLYPH_PATTERN.test(glyph);
}
function parseNamespacedGlyph(glyph) {
  if (!isNamespacedGlyph(glyph)) {
    return null;
  }
  const separator = glyph.indexOf("/");
  return {
    pluginId: glyph.slice(0, separator),
    name: glyph.slice(separator + 1)
  };
}

// ../domain/src/provider-event.ts
import { z as z19 } from "zod";

// ../domain/src/thread-events.ts
import { z as z15 } from "zod";

// ../domain/src/started-on-behalf-of.ts
import { z as z14 } from "zod";
var startedOnBehalfOfInitiatorValues = ["agent", "system"];
var startedOnBehalfOfInitiatorSchema = z14.enum(
  startedOnBehalfOfInitiatorValues
);
var startedOnBehalfOfSchema = z14.object({
  initiator: startedOnBehalfOfInitiatorSchema,
  senderThreadId: z14.string().min(1)
});

// ../domain/src/thread-events.ts
var threadTurnInitiatorValues = ["user", "agent", "system"];
var threadTurnInitiatorSchema = z15.enum(threadTurnInitiatorValues);
var turnRequestOptionsSchema = recordedThreadExecutionOptionsSchema;
var turnRequestTargetSchema = z15.discriminatedUnion("kind", [
  z15.object({ kind: z15.literal("thread-start") }),
  z15.object({ kind: z15.literal("new-turn") }),
  z15.object({
    kind: z15.literal("auto"),
    expectedTurnId: z15.string().nullable()
  }),
  z15.object({
    kind: z15.literal("steer"),
    expectedTurnId: z15.string().nullable()
  })
]);
var clientTurnLifecycleEventDataSchema = z15.object({
  direction: z15.literal("outbound"),
  source: z15.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  request: z15.object({
    method: z15.enum(["thread/start", "turn/start"]),
    params: z15.record(z15.string(), z15.unknown())
  })
});
var turnRequestEventDataSchema = z15.object({
  serviceTurn: serviceTurnDescriptorSchema.optional(),
  direction: z15.literal("outbound"),
  requestId: clientTurnRequestIdSchema,
  dispatchProvenance: z15.object({
    origin: threadCreateOriginSchema.nullable(),
    originPluginId: z15.string().nullable(),
    requestedBy: startedOnBehalfOfSchema.nullable()
  }).optional(),
  questionResponse: z15.object({
    questionId: z15.string().min(1),
    revision: z15.number().int().positive(),
    queuedMessageId: z15.string().min(1)
  }).optional(),
  deferredFromRequestId: clientTurnRequestIdSchema.optional(),
  // Retry provenance, written only when a `turn.failed` gate's retry row
  // dispatches. Both fields are present together or not at all: absence means
  // "this is an original dispatch", which is the overwhelmingly common case.
  // (Supersedes the pre-plugin `continuationOfRequestId` key, which the removed
  // core rate-limit recovery wrote and nothing ever read.)
  /** The original request this attempt re-submits, unchanged across attempts. */
  retryOfRequestId: clientTurnRequestIdSchema.optional(),
  /** Which attempt this is: 2 is the first retry of the original request. */
  retryAttempt: z15.number().int().min(2).optional(),
  source: z15.enum(["spawn", "tell"]),
  initiator: threadTurnInitiatorSchema,
  senderThreadId: z15.string().nullable(),
  originPluginId: pluginIdSchema.optional(),
  systemMessageKind: systemMessageKindSchema.optional(),
  systemMessageSubject: systemMessageSubjectSchema.nullable().optional(),
  input: z15.array(promptInputSchema),
  inputGroups: z15.array(z15.array(promptInputSchema).min(1)).min(1).optional(),
  target: turnRequestTargetSchema,
  request: z15.object({
    method: z15.enum(["thread/start", "turn/start"]),
    params: z15.record(z15.string(), z15.unknown())
  }),
  execution: turnRequestOptionsSchema
});
var turnRequestRejectedEventDataSchema = z15.object({
  requestId: clientTurnRequestIdSchema,
  deferredToQueuedMessageId: z15.string().min(1).optional(),
  reason: z15.string().min(1),
  message: z15.string().min(1)
});
var systemErrorEventDataSchema = z15.object({
  code: z15.string().optional(),
  message: z15.string(),
  detail: z15.string().optional()
});
var ownershipChangeOperationActionValues = [
  "assign",
  "release",
  "transfer"
];
var ownershipChangeOperationActionSchema = z15.enum(
  ownershipChangeOperationActionValues
);
var ownershipChangeOperationMetadataSchema = z15.object({
  action: ownershipChangeOperationActionSchema,
  nextParentThreadId: z15.string().nullable(),
  nextParentThreadTitle: z15.string().nullable(),
  previousParentThreadId: z15.string().nullable(),
  previousParentThreadTitle: z15.string().nullable()
});
var systemOperationEventDataSchema = z15.object({
  operation: z15.string(),
  status: z15.string(),
  message: z15.string(),
  operationId: z15.string(),
  metadata: z15.record(z15.string(), jsonValueSchema).optional()
});
var systemInteractionLifecycleEventDataSchema = z15.object({
  interaction: interactionLifecycleSchema
});
var systemPermissionGrantLifecycleEventDataSchema = z15.object({
  interactionId: z15.string(),
  providerId: z15.string(),
  providerRequestId: z15.string(),
  status: pendingInteractionStatusSchema,
  resolution: approvalPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z15.string().nullable().default(null),
  subject: pendingInteractionPermissionGrantApprovalSubjectSchema
});
var systemUserQuestionLifecycleEventDataSchema = z15.object({
  interactionId: z15.string(),
  providerId: z15.string(),
  providerRequestId: z15.string(),
  status: pendingInteractionStatusSchema,
  resolution: userQuestionPendingInteractionResolutionSchema.nullable().default(null),
  statusReason: z15.string().nullable().default(null),
  payload: userQuestionPendingInteractionPayloadSchema
});
var systemThreadInterruptedEventDataSchema = z15.object({
  serviceTurn: serviceTurnDescriptorSchema.optional(),
  reason: systemThreadInterruptedReasonSchema,
  cause: z15.literal("host-connection-lost").optional()
});
var provisioningTranscriptEntrySchema = z15.object({
  type: z15.enum(["step", "output"]),
  key: z15.string(),
  text: z15.string(),
  startedAt: z15.number().optional(),
  status: z15.enum(["started", "completed", "failed"]).optional(),
  metadata: z15.record(z15.string(), z15.unknown()).optional()
});
var systemThreadProvisioningStatusValues = [
  "active",
  "completed",
  "failed",
  "cancelled"
];
var systemThreadProvisioningStatusSchema = z15.enum(
  systemThreadProvisioningStatusValues
);
var systemThreadProvisioningEventDataSchema = z15.object({
  provisioningId: z15.string(),
  status: systemThreadProvisioningStatusSchema,
  environmentId: z15.string().nullable(),
  entries: z15.array(provisioningTranscriptEntrySchema)
});
var systemLegacyUserMessageEventDataSchema = z15.object({
  text: z15.string(),
  toolCallId: z15.string().optional(),
  turnId: z15.string().optional()
});
var systemProviderTurnWatchdogEventDataSchema = z15.object({
  reason: z15.literal("provider-turn-idle"),
  thresholdMs: z15.number().int().positive(),
  elapsedMs: z15.number().int().nonnegative(),
  activeTurnId: z15.string().min(1),
  activeTurnStartedAt: z15.number().int().nonnegative(),
  lastActivityEventSequence: z15.number().int().positive(),
  lastActivityEventType: z15.string().min(1),
  lastActivityEventAt: z15.number().int().nonnegative(),
  providerId: z15.string().min(1),
  providerThreadId: z15.string().min(1).nullable(),
  firedAt: z15.number().int().nonnegative()
});

// ../domain/src/thread-event-scope.ts
import { z as z16 } from "zod";
var threadEventScopeKindValues = ["thread", "turn"];
var threadEventScopeKindSchema = z16.enum(threadEventScopeKindValues);
var threadEventScopeSchema = z16.discriminatedUnion("kind", [
  z16.object({ kind: z16.literal("thread") }),
  z16.object({ kind: z16.literal("turn"), turnId: z16.string().min(1) })
]);
var threadEventScopePolicyValues = [
  "thread",
  "turn",
  "thread-or-turn"
];
var threadEventScopePolicySchema = z16.enum(threadEventScopePolicyValues);
var threadEventScopeDefinitionByType = {
  "thread/started": {
    policy: "thread",
    rationale: "Thread lifecycle event; it creates the thread timeline itself."
  },
  "thread/identity": {
    policy: "thread",
    rationale: "Thread metadata event; it identifies the provider thread outside turn chronology."
  },
  "turn/started": { policy: "turn" },
  "turn/completed": { policy: "turn" },
  "turn/input/accepted": { policy: "turn" },
  "thread/name/updated": {
    policy: "thread",
    rationale: "Thread metadata event; names are not part of a specific turn transcript."
  },
  "thread/compacted": { policy: "turn" },
  "thread/context/cleared": { policy: "turn" },
  "thread/goal/updated": {
    policy: "thread",
    rationale: "Thread goal state is current thread metadata, not part of a specific turn transcript."
  },
  "thread/goal/cleared": {
    policy: "thread",
    rationale: "Thread goal state is current thread metadata, not part of a specific turn transcript."
  },
  "item/started": { policy: "turn" },
  "item/completed": { policy: "turn" },
  "item/agentMessage/delta": { policy: "turn" },
  "item/commandExecution/outputDelta": { policy: "turn" },
  "item/fileChange/outputDelta": { policy: "turn" },
  "item/reasoning/summaryTextDelta": { policy: "turn" },
  "item/reasoning/textDelta": { policy: "turn" },
  "item/plan/delta": { policy: "turn" },
  "item/mcpToolCall/progress": { policy: "turn" },
  "item/toolCall/progress": { policy: "turn" },
  "item/backgroundTask/progress": {
    policy: "thread",
    rationale: "Background tasks outlive their spawning turn; thread scope keeps turn windows sequence-contiguous (late progress must not interleave into later turns' ranges)."
  },
  "item/backgroundTask/completed": {
    policy: "thread",
    rationale: "Terminal task state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range."
  },
  "item/delegation/progress": {
    policy: "thread",
    rationale: "Background delegations outlive their spawning turn exactly like background tasks; thread scope keeps turn windows sequence-contiguous."
  },
  "item/delegation/completed": {
    policy: "thread",
    rationale: "A background delegation's terminal state can arrive turns after the spawning turn completed; thread scope avoids appending into a closed turn's sequence range."
  },
  "thread/tokenUsage/updated": { policy: "turn" },
  "thread/contextWindowUsage/updated": {
    policy: "thread-or-turn",
    rationale: "Context usage is session state; providers can report it before, during, or after a turn."
  },
  "turn/plan/updated": { policy: "turn" },
  "turn/diff/updated": { policy: "turn" },
  "turn/mainRun/updated": { policy: "turn" },
  "provider/error": {
    policy: "thread-or-turn",
    rationale: "Provider diagnostics use thread scope for provider setup/session failures; in-turn failures use turn scope."
  },
  "provider/rateLimits/updated": {
    policy: "thread",
    rationale: "Subscription usage is account-scoped state that can affect multiple turns and threads."
  },
  "provider.env-resolved": {
    policy: "thread",
    rationale: "Resolved provider environment is session state and can change between turns."
  },
  "thread/extensionState/updated": {
    policy: "thread",
    rationale: "Plugin-declared thread state is current thread metadata (like goals), not part of a specific turn transcript; latest snapshot per kind wins."
  },
  "provider/warning": {
    policy: "thread-or-turn",
    rationale: "Provider warnings use thread scope for config, deprecation, or global notices; turn-specific warnings use turn scope."
  },
  "provider/modelFallback": {
    policy: "thread-or-turn",
    rationale: "Provider model fallback signals can occur while a turn is active or at session scope before a turn is established."
  },
  "provider/unhandled": {
    policy: "thread-or-turn",
    rationale: "Unhandled provider events use thread scope only when no active turn context exists; in-turn unknown events use turn scope."
  },
  "client/thread/start": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it requests thread creation before any turn exists."
  },
  "client/turn/requested": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it records the request before provider turn acceptance."
  },
  "client/turn/rejected": {
    policy: "thread",
    rationale: "Client request rejection occurs before provider turn acceptance and identifies the request at thread scope."
  },
  "client/turn/start": {
    policy: "thread",
    rationale: "Outbound client lifecycle event; it records the start request before provider turn acceptance."
  },
  "system/error": {
    policy: "thread-or-turn",
    rationale: "System errors use thread scope for app, daemon, or session failures outside a turn; turn failures use turn scope."
  },
  "system/manager/user_message": {
    policy: "thread-or-turn",
    rationale: "Legacy persisted user-visible system messages may be thread-scoped for general updates or turn-scoped for in-turn updates."
  },
  "system/thread/interrupted": {
    policy: "thread",
    rationale: "Thread stop lifecycle event; it represents user interruption of the whole running thread."
  },
  "system/operation": {
    policy: "thread-or-turn",
    rationale: "Thread-management operations use thread scope outside provider turns; tool-owned operations use turn scope so the operation stays with the tool call that caused it."
  },
  "system/interaction/lifecycle": {
    policy: "thread-or-turn",
    rationale: "A provider interaction belongs to the turn that raised it; a plugin may raise one outside any turn."
  },
  "system/permissionGrant/lifecycle": { policy: "turn" },
  "system/userQuestion/lifecycle": { policy: "turn" },
  "system/thread-provisioning": {
    policy: "thread",
    rationale: "Workspace provisioning lifecycle event; environment setup belongs to the thread, not a turn."
  },
  "system/provider-turn-watchdog": {
    policy: "thread",
    rationale: "Legacy persisted watchdog diagnostics are decoded for old timelines only; there is no current producer."
  }
};
function getThreadEventScopePolicyDefinitionEntries() {
  return Object.entries(threadEventScopeDefinitionByType).map(
    ([type, definition]) => ({
      type,
      definition
    })
  );
}
function buildThreadEventScopePolicyByType() {
  const policies = {};
  for (const entry of getThreadEventScopePolicyDefinitionEntries()) {
    policies[entry.type] = entry.definition.policy;
  }
  return policies;
}
var threadEventScopePolicyByType = buildThreadEventScopePolicyByType();
function threadScope() {
  return { kind: "thread" };
}
function turnScope(turnId) {
  return { kind: "turn", turnId };
}
function getThreadEventScopeTurnId(scope) {
  return scope.kind === "turn" ? scope.turnId : void 0;
}
function validateThreadEventScope(args) {
  const policy = threadEventScopePolicyByType[args.type];
  if (policy === "thread-or-turn") {
    return { valid: true };
  }
  if (policy !== args.scope.kind) {
    return {
      valid: false,
      message: `${args.type} requires ${policy} scope but received ${args.scope.kind} scope`
    };
  }
  return { valid: true };
}

// ../domain/src/thread-timeline-goal.ts
import { z as z17 } from "zod";
var threadTimelineGoalStatusSchema = z17.enum([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);

// ../domain/src/thread-usage-cost.ts
import { z as z18 } from "zod";
var threadUsageCostSchema = z18.object({
  amount: z18.number().nonnegative(),
  currency: z18.string().min(1)
});

// ../domain/src/provider-event.ts
var threadEventItemStatusSchema = z19.enum([
  "pending",
  "completed",
  "failed",
  "interrupted"
]);
var threadEventItemApprovalStatusSchema = z19.enum(["waiting_for_approval", "denied"]).nullable();
var threadEventTurnStatusSchema = z19.enum([
  "completed",
  "failed",
  "interrupted"
]);
var providerErrorCategoryValues = [
  "active-turn-not-steerable",
  "bad-request",
  "connection-failed",
  "context-window-exceeded",
  "billing",
  "budget-exceeded",
  "internal",
  "max-output-tokens",
  "max-turns",
  "overloaded",
  "policy",
  "rate-limit",
  "sandbox",
  "stream-disconnected",
  "structured-output-retries",
  "thread-rollback-failed",
  "too-many-failed-attempts",
  "unauthorized",
  "unknown"
];
var providerErrorCategorySchema = z19.enum(providerErrorCategoryValues);
var providerErrorInfoSchema = z19.object({
  category: providerErrorCategorySchema,
  providerCode: z19.string().nullable(),
  httpStatusCode: z19.number().nullable()
});
var providerRateLimitStatusSchema = z19.enum([
  "allowed",
  "warning",
  "blocked",
  "unknown"
]);
var providerRateLimitWindowSchema = z19.object({
  providerKey: z19.string().min(1).nullable(),
  label: z19.string().min(1).nullable(),
  status: providerRateLimitStatusSchema,
  resetsAtMs: z19.number().int().nonnegative().nullable()
});
var providerRateLimitStateSchema = z19.object({
  providerId: z19.string().min(1),
  status: providerRateLimitStatusSchema,
  kind: z19.enum(["subscription-window", "credits", "spend-control", "unknown"]),
  windows: z19.array(providerRateLimitWindowSchema),
  reachedReason: z19.string().min(1).nullable(),
  overageStatus: z19.enum(["allowed", "warning", "rejected", "unavailable"]).nullable(),
  overageReason: z19.string().min(1).nullable()
});
var threadEventFileChangeKindSchema = z19.enum(["add", "delete", "update"]);
var threadEventFileChangeSchema = z19.object({
  path: z19.string(),
  kind: threadEventFileChangeKindSchema,
  movePath: z19.string().optional(),
  diff: z19.string().optional()
});
var threadEventPlanStepStatusSchema = z19.enum([
  "pending",
  "active",
  "completed",
  "failed"
]);
var planIdentifierSchema = z19.string().trim().min(1).max(128).regex(/^[^\r\n\u2028\u2029]*$/u);
var threadEventPlanStepSchema = z19.object({
  id: planIdentifierSchema.optional(),
  step: z19.string(),
  status: threadEventPlanStepStatusSchema.optional(),
  note: z19.string().trim().min(1).max(1e3).regex(/^[^\r\n\u2028\u2029]*$/u).optional(),
  actor: z19.string().trim().min(1).max(100).regex(/^[^\r\n\u2028\u2029]*$/u).optional()
});
var itemPresentationField = {
  presentation: threadEventItemPresentationSchema.optional()
};
var threadEventWebSearchItemSchema = z19.object({
  type: z19.literal("webSearch"),
  id: z19.string(),
  queries: z19.array(z19.string()).min(1),
  resultText: z19.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventWebFetchItemSchema = z19.object({
  type: z19.literal("webFetch"),
  id: z19.string(),
  url: z19.string(),
  prompt: z19.string().nullable(),
  pattern: z19.string().nullable(),
  resultText: z19.string().nullable(),
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventImageViewItemSchema = z19.object({
  type: z19.literal("imageView"),
  id: z19.string(),
  path: z19.string(),
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventFileReadItemSchema = z19.object({
  type: z19.literal("fileRead"),
  id: z19.string(),
  path: z19.string(),
  cmd: z19.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventSearchModeSchema = z19.enum(["content", "path", "list"]);
var threadEventSearchItemSchema = z19.object({
  type: z19.literal("search"),
  id: z19.string(),
  mode: threadEventSearchModeSchema,
  query: z19.string(),
  path: z19.string().optional(),
  cmd: z19.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventDelegationItemSchema = z19.object({
  type: z19.literal("delegation"),
  id: z19.string(),
  childRef: z19.string().min(1),
  label: z19.string(),
  status: threadEventItemStatusSchema,
  background: z19.boolean(),
  summary: z19.string().optional(),
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventPlanStepsItemSchema = z19.object({
  type: z19.literal("planSteps"),
  id: z19.string(),
  planId: planIdentifierSchema.optional(),
  steps: z19.array(threadEventPlanStepSchema).refine(
    (steps) => new Set(steps.flatMap((step) => step.id ? [step.id] : [])).size === steps.filter((step) => step.id).length,
    "Duplicate step IDs"
  ),
  explanation: z19.string().optional(),
  status: threadEventItemStatusSchema,
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventExtensionItemSchema = z19.object({
  type: z19.literal("extension"),
  id: z19.string(),
  kind: extensionKindSchema,
  payload: jsonValueSchema,
  status: threadEventItemStatusSchema,
  presentation: threadEventItemPresentationSchema,
  parentToolCallId: z19.string().optional()
});
var threadEventTextTruncationSchema = z19.object({
  originalLength: z19.number(),
  retainedHeadLength: z19.number(),
  retainedTailLength: z19.number(),
  truncatedAt: z19.number()
});
var threadEventItemTruncationSchema = z19.object({
  aggregatedOutput: threadEventTextTruncationSchema.optional(),
  result: threadEventTextTruncationSchema.optional(),
  resultText: threadEventTextTruncationSchema.optional()
});
var threadEventImageGenerationItemSchema = z19.object({
  type: z19.literal("imageGeneration"),
  id: z19.string(),
  status: threadEventItemStatusSchema,
  prompt: z19.string().nullable(),
  path: z19.string().nullable(),
  result: z19.string().optional(),
  error: z19.string().nullable(),
  transparentBackground: z19.boolean(),
  truncation: threadEventItemTruncationSchema.optional(),
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventUserContentSchema = z19.discriminatedUnion("type", [
  z19.object({ type: z19.literal("text"), text: z19.string() }),
  z19.object({ type: z19.literal("image"), url: z19.string() }),
  z19.object({ type: z19.literal("localImage"), path: z19.string() }),
  z19.object({ type: z19.literal("localFile"), path: z19.string() })
]);
var threadEventTokenUsageBreakdownSchema = z19.object({
  totalTokens: z19.number(),
  inputTokens: z19.number(),
  cachedInputTokens: z19.number(),
  cacheReadInputTokens: z19.number().nonnegative().optional(),
  cacheWriteInputTokens: z19.number().nonnegative().optional(),
  outputTokens: z19.number(),
  reasoningOutputTokens: z19.number()
});
var threadEventContextWindowUsageSchema = z19.object({
  snapshot: contextSnapshotSchema.optional(),
  usedTokens: z19.number().nullable(),
  modelContextWindow: z19.number().nullable(),
  estimated: z19.boolean(),
  cost: threadUsageCostSchema.optional()
});
var promptCacheTtlMsSchema = z19.number().int().positive();
var threadEventTokenUsageSchema = z19.object({
  total: threadEventTokenUsageBreakdownSchema,
  last: threadEventTokenUsageBreakdownSchema,
  modelContextWindow: z19.number().nullable(),
  promptCacheTtlMs: promptCacheTtlMsSchema.optional()
});
var threadEventWarningCategorySchema = z19.enum([
  "deprecation",
  "config",
  "general",
  "compaction-skipped"
]);
var providerRawEventSchema = z19.object({
  jsonrpc: z19.literal("2.0"),
  id: z19.union([z19.string(), z19.number()]).optional(),
  method: z19.string(),
  params: jsonValueSchema.optional()
});
var providerUnhandledEventSchema = z19.object({
  type: z19.literal("provider/unhandled"),
  threadId: z19.string(),
  providerThreadId: z19.string(),
  providerId: z19.string(),
  rawType: z19.string(),
  rawEvent: providerRawEventSchema,
  parentToolCallId: z19.string().optional()
});
var toolCallProgressEventSchema = z19.object({
  type: z19.literal("item/toolCall/progress"),
  threadId: z19.string(),
  providerThreadId: z19.string(),
  itemId: z19.string(),
  message: z19.string().optional(),
  parentToolCallId: z19.string().optional()
});
var threadEventBackgroundTaskItemSchema = z19.object({
  type: z19.literal("backgroundTask"),
  id: z19.string(),
  familyId: z19.string().optional(),
  taskType: z19.string(),
  description: z19.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z19.boolean(),
  foreground: z19.boolean(),
  workflowName: z19.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z19.string().optional(),
  error: z19.string().optional(),
  outputFile: z19.string().optional(),
  ownerStopped: z19.literal(true).optional(),
  ...itemPresentationField,
  parentToolCallId: z19.string().optional()
});
var threadEventItemSchema = z19.discriminatedUnion("type", [
  z19.object({
    type: z19.literal("userMessage"),
    id: z19.string(),
    content: z19.array(threadEventUserContentSchema),
    clientRequestId: clientTurnRequestIdSchema.optional(),
    parentToolCallId: z19.string().optional()
  }).strict(),
  z19.object({
    type: z19.literal("agentMessage"),
    id: z19.string(),
    text: z19.string(),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("commandExecution"),
    id: z19.string(),
    command: z19.string(),
    cwd: z19.string(),
    description: z19.string().optional(),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    aggregatedOutput: z19.string().optional(),
    exitCode: z19.number().optional(),
    durationMs: z19.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("fileChange"),
    id: z19.string(),
    changes: z19.array(threadEventFileChangeSchema),
    status: threadEventItemStatusSchema,
    approvalStatus: threadEventItemApprovalStatusSchema,
    error: z19.string().optional(),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  threadEventWebSearchItemSchema,
  threadEventWebFetchItemSchema,
  threadEventImageViewItemSchema,
  threadEventImageGenerationItemSchema,
  threadEventFileReadItemSchema,
  threadEventSearchItemSchema,
  z19.object({
    type: z19.literal("toolCall"),
    id: z19.string(),
    server: z19.string().optional(),
    tool: z19.string(),
    arguments: z19.record(z19.string(), z19.unknown()).optional(),
    status: threadEventItemStatusSchema,
    result: z19.unknown().optional(),
    error: z19.string().optional(),
    durationMs: z19.number().optional(),
    truncation: threadEventItemTruncationSchema.optional(),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("reasoning"),
    id: z19.string(),
    summary: z19.array(z19.string()),
    content: z19.array(z19.string()),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("plan"),
    id: z19.string(),
    text: z19.string(),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  threadEventPlanStepsItemSchema,
  z19.object({
    type: z19.literal("contextCompaction"),
    id: z19.string(),
    ...itemPresentationField,
    parentToolCallId: z19.string().optional()
  }),
  threadEventBackgroundTaskItemSchema,
  threadEventDelegationItemSchema,
  threadEventExtensionItemSchema
]);
function itemTextDeltaEventSchema(type) {
  return z19.object({
    type: z19.literal(type),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    itemId: z19.string(),
    delta: z19.string(),
    parentToolCallId: z19.string().optional()
  });
}
var unscopedProviderEventSchema = z19.discriminatedUnion("type", [
  z19.object({
    type: z19.literal("thread/started"),
    threadId: z19.string()
  }),
  z19.object({
    type: z19.literal("thread/identity"),
    threadId: z19.string(),
    providerThreadId: z19.string()
  }),
  z19.object({
    type: z19.literal("turn/started"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    parentToolCallId: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("turn/completed"),
    threadId: z19.string(),
    providerThreadId: z19.string().nullable(),
    status: threadEventTurnStatusSchema,
    error: z19.object({ message: z19.string() }).optional(),
    providerCheckpointId: z19.string().min(1).optional()
  }),
  z19.object({
    type: z19.literal("turn/input/accepted"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    clientRequestId: clientTurnRequestIdSchema,
    scope: threadEventScopeSchema
  }).strict(),
  z19.object({
    type: z19.literal("thread/name/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    threadName: z19.string(),
    source: z19.literal("agent").optional()
  }),
  z19.object({
    type: z19.literal("thread/compacted"),
    threadId: z19.string(),
    providerThreadId: z19.string()
  }),
  z19.object({
    type: z19.literal("thread/context/cleared"),
    threadId: z19.string(),
    providerThreadId: z19.string()
  }),
  z19.object({
    type: z19.literal("thread/goal/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    objective: z19.string(),
    status: threadTimelineGoalStatusSchema,
    tokenBudget: z19.number().nullable(),
    tokensUsed: z19.number(),
    timeUsedSeconds: z19.number()
  }),
  z19.object({
    type: z19.literal("thread/goal/cleared"),
    threadId: z19.string(),
    providerThreadId: z19.string()
  }),
  z19.object({
    type: z19.literal("item/started"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    item: threadEventItemSchema
  }),
  z19.object({
    type: z19.literal("item/completed"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    item: threadEventItemSchema
  }),
  itemTextDeltaEventSchema("item/agentMessage/delta"),
  z19.object({
    type: z19.literal("item/commandExecution/outputDelta"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    itemId: z19.string(),
    delta: z19.string(),
    reset: z19.boolean().optional(),
    parentToolCallId: z19.string().optional()
  }),
  itemTextDeltaEventSchema("item/fileChange/outputDelta"),
  itemTextDeltaEventSchema("item/reasoning/summaryTextDelta"),
  itemTextDeltaEventSchema("item/reasoning/textDelta"),
  itemTextDeltaEventSchema("item/plan/delta"),
  z19.object({
    type: z19.literal("item/mcpToolCall/progress"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    itemId: z19.string(),
    message: z19.string().optional(),
    parentToolCallId: z19.string().optional()
  }),
  toolCallProgressEventSchema,
  z19.object({
    type: z19.literal("item/backgroundTask/progress"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z19.object({
    type: z19.literal("item/backgroundTask/completed"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    item: threadEventBackgroundTaskItemSchema
  }),
  z19.object({
    type: z19.literal("item/delegation/progress"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    item: threadEventDelegationItemSchema
  }),
  z19.object({
    type: z19.literal("item/delegation/completed"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    item: threadEventDelegationItemSchema
  }),
  z19.object({
    type: z19.literal("thread/tokenUsage/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    tokenUsage: threadEventTokenUsageSchema
  }),
  z19.object({
    type: z19.literal("thread/contextWindowUsage/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    contextWindowUsage: threadEventContextWindowUsageSchema
  }),
  z19.object({
    type: z19.literal("turn/plan/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    plan: z19.array(threadEventPlanStepSchema),
    explanation: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("turn/mainRun/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    state: z19.enum(["idle", "running"])
  }),
  z19.object({
    type: z19.literal("turn/diff/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    diff: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("provider/error"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    message: z19.string(),
    detail: z19.string().optional(),
    willRetry: z19.boolean().optional(),
    errorInfo: providerErrorInfoSchema.optional()
  }),
  z19.object({
    type: z19.literal("provider/rateLimits/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    rateLimits: providerRateLimitStateSchema
  }),
  z19.object({
    type: z19.literal("provider.env-resolved"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    entries: z19.array(
      z19.object({
        name: z19.string(),
        source: z19.union([
          z19.literal("shell"),
          z19.object({ plugin: z19.string() }).strict(),
          z19.object({
            core: z19.enum([
              "machine-git",
              "machine-environment",
              "project-environment"
            ])
          }).strict()
        ]),
        value: z19.union([
          z19.string(),
          z19.object({ masked: z19.literal(true) }).strict()
        ]),
        reason: z19.string().optional()
      }).strict()
    )
  }),
  z19.object({
    type: z19.literal("thread/extensionState/updated"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    kind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z19.object({
    type: z19.literal("provider/warning"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    category: threadEventWarningCategorySchema,
    summary: z19.string().optional(),
    details: z19.string().optional()
  }),
  z19.object({
    type: z19.literal("provider/modelFallback"),
    threadId: z19.string(),
    providerThreadId: z19.string(),
    originalModel: z19.string().min(1),
    fallbackModel: z19.string().min(1),
    reason: z19.enum(["refusal", "provider"]),
    message: z19.string()
  }),
  providerUnhandledEventSchema
]);
var scopedEventDataSchema = z19.object({
  scope: threadEventScopeSchema
});
var providerEventSchema = unscopedProviderEventSchema.and(
  scopedEventDataSchema
);
var unscopedSystemEventSchema = z19.discriminatedUnion("type", [
  z19.object({
    type: z19.literal("client/thread/start"),
    threadId: z19.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z19.object({
    type: z19.literal("client/turn/requested"),
    threadId: z19.string()
  }).merge(turnRequestEventDataSchema),
  z19.object({
    type: z19.literal("client/turn/rejected"),
    threadId: z19.string()
  }).merge(turnRequestRejectedEventDataSchema),
  z19.object({
    type: z19.literal("client/turn/start"),
    threadId: z19.string()
  }).merge(clientTurnLifecycleEventDataSchema),
  z19.object({
    type: z19.literal("system/error"),
    threadId: z19.string()
  }).merge(systemErrorEventDataSchema),
  z19.object({
    type: z19.literal("system/manager/user_message"),
    threadId: z19.string()
  }).merge(systemLegacyUserMessageEventDataSchema),
  z19.object({
    type: z19.literal("system/thread/interrupted"),
    threadId: z19.string()
  }).merge(systemThreadInterruptedEventDataSchema),
  z19.object({
    type: z19.literal("system/operation"),
    threadId: z19.string()
  }).merge(systemOperationEventDataSchema),
  z19.object({
    type: z19.literal("system/interaction/lifecycle"),
    threadId: z19.string()
  }).merge(systemInteractionLifecycleEventDataSchema),
  z19.object({
    type: z19.literal("system/permissionGrant/lifecycle"),
    threadId: z19.string()
  }).merge(systemPermissionGrantLifecycleEventDataSchema),
  z19.object({
    type: z19.literal("system/userQuestion/lifecycle"),
    threadId: z19.string()
  }).merge(systemUserQuestionLifecycleEventDataSchema),
  z19.object({
    type: z19.literal("system/thread-provisioning"),
    threadId: z19.string()
  }).merge(systemThreadProvisioningEventDataSchema),
  z19.object({
    type: z19.literal("system/provider-turn-watchdog"),
    threadId: z19.string()
  }).merge(systemProviderTurnWatchdogEventDataSchema)
]);
var systemEventSchema = unscopedSystemEventSchema.and(scopedEventDataSchema);
var threadEventSchema = z19.union([providerEventSchema, systemEventSchema]).superRefine((event, ctx) => {
  const result2 = validateThreadEventScope({
    type: event.type,
    scope: event.scope
  });
  if (!result2.valid) {
    ctx.addIssue({
      code: z19.ZodIssueCode.custom,
      message: result2.message ?? "Invalid thread event scope",
      path: ["scope"]
    });
    return;
  }
});
function isThreadEventWithItem(event) {
  switch (event.type) {
    case "item/started":
    case "item/completed":
    case "item/delegation/progress":
    case "item/delegation/completed":
    case "item/backgroundTask/progress":
    case "item/backgroundTask/completed":
      return true;
    default:
      return false;
  }
}

// ../domain/src/provider-types.ts
import { z as z21 } from "zod";

// ../domain/src/thread-session-option.ts
import { z as z20 } from "zod";
var threadSessionOptionValueSchema = z20.object({
  id: z20.string().min(1),
  label: z20.string().min(1),
  description: z20.string().min(1).optional(),
  group: z20.string().min(1).optional()
});
var threadSessionOptionBaseShape = {
  id: z20.string().min(1),
  label: z20.string().min(1),
  description: z20.string().min(1).optional(),
  category: z20.string().min(1).optional()
};
var threadSessionOptionSchema = z20.discriminatedUnion("type", [
  z20.object({
    ...threadSessionOptionBaseShape,
    type: z20.literal("select"),
    value: z20.string(),
    values: z20.array(threadSessionOptionValueSchema).max(1e3)
  }),
  z20.object({
    ...threadSessionOptionBaseShape,
    type: z20.literal("boolean"),
    value: z20.boolean(),
    fixed: z20.boolean().optional()
  })
]);

// ../domain/src/provider-types.ts
var modelReasoningEffortSchema = z21.object({
  reasoningEffort: reasoningLevelSchema,
  label: z21.string().min(1).optional(),
  description: z21.string()
});
var modelServiceTierSchema = z21.object({
  id: serviceTierSchema,
  label: z21.string().min(1).optional(),
  description: z21.string().min(1).optional()
});
var availableModelSchema = z21.object({
  id: z21.string(),
  model: z21.string(),
  displayName: z21.string(),
  routeProviderId: z21.string().min(1).optional(),
  description: z21.string(),
  reasoningDiscovery: z21.enum(["unknown", "known"]).default("known"),
  supportedReasoningEfforts: z21.array(modelReasoningEffortSchema),
  defaultReasoningEffort: reasoningLevelSchema,
  supportedServiceTiers: z21.array(modelServiceTierSchema).optional(),
  sessionOptions: z21.array(threadSessionOptionSchema).max(64).optional(),
  isDefault: z21.boolean()
});
var providerModelCatalogScopeSchema = z21.enum(["host", "workspace"]);
var providerCapabilitiesSchema = z21.object({
  supportsThreadArchive: z21.boolean(),
  supportsThreadRename: z21.boolean(),
  supportsServiceTier: z21.boolean(),
  supportsNativeUserQuestion: z21.boolean(),
  supportsFork: z21.boolean(),
  supportsSessionRewind: z21.boolean(),
  permissionModes: z21.array(permissionModeSchema).min(1),
  modelCatalogScope: providerModelCatalogScopeSchema
});
var providerComposerCommandSchema = z21.object({
  trigger: promptMentionCommandTriggerSchema,
  name: z21.string().min(1).regex(/^[^\s/$]+$/u),
  trailingText: z21.string().regex(/^\s*$/u)
});
var providerComposerActionSchema = z21.discriminatedUnion("kind", [
  z21.object({
    kind: z21.literal("skills"),
    trigger: promptMentionCommandTriggerSchema
  }),
  z21.object({
    kind: z21.literal("plan"),
    command: providerComposerCommandSchema
  }),
  z21.object({
    kind: z21.literal("goal"),
    command: providerComposerCommandSchema
  })
]);
var providerStringsSchema = z21.object({
  signInHint: z21.string().min(1),
  expiredHint: z21.string().min(1),
  installUrl: z21.string().min(1),
  brandPrefix: z21.string().min(1).optional(),
  planModeCopy: z21.string().min(1).optional(),
  iconTint: z21.object({ light: z21.string().min(1), dark: z21.string().min(1) }).optional()
});
var providerOptionDescriptorSchema = z21.object({
  id: z21.string().min(1),
  label: z21.string().min(1),
  description: z21.string().min(1).optional(),
  icon: z21.string().min(1).optional()
});
var providerExtensionKindInfoSchema = z21.object({
  item: z21.boolean(),
  state: z21.boolean()
});
var providerExtensionKindsSchema = z21.record(
  extensionKindSchema,
  providerExtensionKindInfoSchema
);
var providerInfoSchema = z21.object({
  id: z21.string(),
  pluginId: z21.string().min(1),
  displayName: z21.string(),
  family: z21.string().min(1).optional(),
  icon: z21.object({ glyph: z21.string().min(1) }).optional(),
  logoUrl: z21.string().min(1).nullable(),
  maintenance: z21.object({
    health: z21.boolean(),
    usage: z21.boolean(),
    installation: z21.boolean()
  }),
  capabilities: providerCapabilitiesSchema,
  composerActions: z21.array(providerComposerActionSchema),
  completedTurnDisplay: completedTurnDisplaySchema,
  available: z21.boolean(),
  strings: providerStringsSchema.optional(),
  serviceTiers: z21.array(providerOptionDescriptorSchema).optional(),
  reasoningLevels: z21.array(providerOptionDescriptorSchema).optional(),
  extensionKinds: providerExtensionKindsSchema.optional()
});
var providerRecoveryKindValues = [
  "sessionArchived",
  "authRequired",
  "restartRecommended",
  "staleTurn",
  "turnBusy",
  "rateLimited"
];
var providerRecoveryKindSchema = z21.enum(providerRecoveryKindValues);
var toolCallOutputItemSchema = z21.discriminatedUnion("type", [
  z21.object({
    type: z21.literal("inputText"),
    text: z21.string()
  }),
  z21.object({
    type: z21.literal("inputImage"),
    imageUrl: z21.string()
  })
]);
var toolCallRequestSchema = z21.object({
  requestId: z21.union([z21.string().min(1), z21.number()]),
  threadId: z21.string().min(1),
  providerThreadId: z21.string().min(1),
  turnId: z21.string().min(1),
  turnOrigin: z21.enum(["provider", "arrival"]).optional(),
  callId: z21.string().min(1),
  tool: z21.string().min(1),
  arguments: z21.unknown().optional()
});
var toolCallResponseSchema = z21.object({
  contentItems: z21.array(toolCallOutputItemSchema),
  success: z21.boolean()
});
var dynamicToolSchema = z21.object({
  name: z21.string(),
  description: z21.string(),
  inputSchema: z21.unknown(),
  presentation: threadEventItemPresentationSchema.optional()
});

// ../domain/src/provider-fork.ts
import { z as z22 } from "zod";
var PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"];
var providerForkSchema = z22.enum(PROVIDER_FORK_VALUES);

// ../provider-bridge-protocol/src/thread-delta.ts
import { z as z23 } from "zod";
var THREAD_DELTA_NOTIFICATION_METHOD = "thread/delta";
var deltaPresentationSchema = threadEventItemPresentationSchema;
var THREAD_DELTA_KEY_SEPARATOR = "";
var deltaKeyPartSchema = z23.string().min(1).refine((value) => !value.includes(THREAD_DELTA_KEY_SEPARATOR), {
  message: "provider keys must not contain the internal key separator (\\u001f)"
});
var deltaItemKeySchema = z23.object({
  providerItemId: deltaKeyPartSchema.optional(),
  channel: deltaKeyPartSchema.optional(),
  parentRef: deltaKeyPartSchema.optional()
});
var providerTurnIdSchema = deltaKeyPartSchema;
var deltaFileChangeSchema = z23.object({
  path: z23.string(),
  kind: z23.enum(["add", "update", "delete"]),
  movePath: z23.string().optional(),
  diff: z23.string().optional(),
  oldText: z23.string().optional(),
  newText: z23.string().optional()
});
var deltaBackgroundTaskShapeSchema = z23.object({
  type: z23.literal("backgroundTask"),
  familyId: z23.string().min(1),
  taskType: z23.string(),
  description: z23.string(),
  status: threadEventItemStatusSchema,
  taskStatus: backgroundTaskStatusSchema,
  skipTranscript: z23.boolean(),
  foreground: z23.boolean().optional(),
  workflowName: z23.string().optional(),
  workflow: workflowProgressSnapshotSchema.optional(),
  usage: backgroundTaskUsageSchema.optional(),
  summary: z23.string().optional(),
  error: z23.string().optional(),
  outputFile: z23.string().optional()
});
var deltaFileReadShapeSchema = z23.object({
  type: z23.literal("fileRead"),
  path: z23.string(),
  cmd: z23.string().optional()
});
var deltaSearchShapeSchema = z23.object({
  type: z23.literal("search"),
  mode: threadEventSearchModeSchema,
  query: z23.string(),
  path: z23.string().optional(),
  cmd: z23.string().optional()
});
var deltaDelegationShapeSchema = z23.object({
  type: z23.literal("delegation"),
  childRef: deltaKeyPartSchema,
  label: z23.string(),
  background: z23.boolean(),
  summary: z23.string().optional()
});
var deltaPlanStepsShapeSchema = z23.object({
  type: z23.literal("planSteps"),
  steps: z23.array(threadEventPlanStepSchema),
  explanation: z23.string().optional()
});
var deltaExtensionShapeSchema = z23.object({
  type: z23.literal("extension"),
  kind: extensionKindSchema,
  payload: jsonValueSchema
});
var deltaItemShapeSchema = z23.discriminatedUnion("type", [
  z23.object({
    type: z23.literal("command"),
    command: z23.string(),
    cwd: z23.string(),
    description: z23.string().optional(),
    aggregatedOutput: z23.string().optional(),
    exitCode: z23.number().optional(),
    durationMs: z23.number().optional()
  }),
  z23.object({
    type: z23.literal("fileChange"),
    changes: z23.array(deltaFileChangeSchema)
  }),
  z23.object({
    type: z23.literal("tool"),
    tool: z23.string(),
    server: z23.string().optional(),
    args: z23.unknown().optional(),
    result: z23.unknown().optional(),
    error: z23.string().optional(),
    durationMs: z23.number().optional()
  }),
  z23.object({ type: z23.literal("compaction") }),
  z23.object({ type: z23.literal("agentMessage"), text: z23.string() }),
  z23.object({
    type: z23.literal("reasoning"),
    summary: z23.array(z23.string()),
    content: z23.array(z23.string())
  }),
  z23.object({ type: z23.literal("plan"), text: z23.string() }),
  z23.object({
    type: z23.literal("webSearch"),
    queries: z23.array(z23.string()).min(1)
  }),
  z23.object({
    type: z23.literal("webFetch"),
    url: z23.string(),
    prompt: z23.string().nullable().optional(),
    pattern: z23.string().nullable()
  }),
  z23.object({ type: z23.literal("imageView"), path: z23.string() }),
  z23.object({
    type: z23.literal("imageGeneration"),
    prompt: z23.string().nullable(),
    path: z23.string().nullable(),
    result: z23.string().optional(),
    error: z23.string().nullable(),
    transparentBackground: z23.boolean()
  }),
  deltaBackgroundTaskShapeSchema,
  deltaFileReadShapeSchema,
  deltaSearchShapeSchema,
  deltaDelegationShapeSchema,
  deltaPlanStepsShapeSchema,
  deltaExtensionShapeSchema
]);
var deltaProgressSnapshotSchema = z23.discriminatedUnion("type", [
  deltaBackgroundTaskShapeSchema,
  deltaDelegationShapeSchema
]);
var deltaTextChannelSchema = z23.enum([
  "agentMessage",
  "reasoningSummary",
  "reasoningText",
  "plan"
]);
var deltaOutputChannelSchema = z23.enum(["command", "fileChange"]);
var deltaErrorSchema = z23.object({ message: z23.string() });
var deltaAttachSchema = z23.enum(["open", "currentOrLast"]);
var deltaNoTurnFallbackSchema = z23.object({
  raw: providerRawEventSchema,
  rawType: z23.string()
});
function requireExtensionPresentation(delta, ctx) {
  if (delta.item.type === "extension" && delta.presentation === void 0) {
    ctx.addIssue({
      code: "custom",
      message: "extension items require a presentation on item.open/item.close",
      path: ["presentation"]
    });
  }
}
var threadDeltaSchema = z23.discriminatedUnion("kind", [
  z23.object({
    kind: z23.literal("input.accepted"),
    clientRequestId: clientTurnRequestIdSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z23.object({
    kind: z23.literal("input.provider"),
    text: z23.string().min(1),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z23.object({
    kind: z23.literal("turn.open"),
    providerTurnId: providerTurnIdSchema.optional(),
    parentRef: deltaKeyPartSchema.optional()
  }),
  z23.object({
    kind: z23.literal("turn.mainRun"),
    state: z23.enum(["idle", "running"])
  }),
  z23.object({
    kind: z23.literal("turn.boundary"),
    status: threadEventTurnStatusSchema,
    error: deltaErrorSchema.optional(),
    providerCheckpointId: z23.string().min(1).optional(),
    claimIfIdle: z23.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z23.object({
    kind: z23.literal("item.open"),
    key: deltaItemKeySchema,
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    attach: deltaAttachSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z23.object({
    kind: z23.literal("item.close"),
    key: deltaItemKeySchema,
    status: threadEventItemStatusSchema,
    resultText: z23.string().optional(),
    exitCode: z23.number().optional(),
    aggregatedOutput: z23.string().optional(),
    approvalStatus: z23.literal("denied").optional(),
    item: deltaItemShapeSchema,
    presentation: deltaPresentationSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }).superRefine(requireExtensionPresentation),
  z23.object({
    kind: z23.literal("item.progress"),
    key: deltaItemKeySchema,
    message: z23.string().optional(),
    snapshot: deltaProgressSnapshotSchema.optional(),
    flush: z23.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z23.object({
    kind: z23.literal("item.textDelta"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z23.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z23.object({
    kind: z23.literal("item.textClose"),
    key: deltaItemKeySchema,
    channel: deltaTextChannelSchema,
    text: z23.string().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z23.object({
    kind: z23.literal("item.outputDelta"),
    key: deltaItemKeySchema,
    channel: deltaOutputChannelSchema,
    text: z23.string(),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z23.object({
    kind: z23.literal("command.outputSnapshot"),
    key: deltaItemKeySchema,
    text: z23.string(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z23.object({
    kind: z23.literal("usage"),
    total: threadEventTokenUsageBreakdownSchema,
    last: threadEventTokenUsageBreakdownSchema,
    modelContextWindow: z23.number().nullable(),
    promptCacheTtlMs: promptCacheTtlMsSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z23.object({
    kind: z23.literal("contextWindow"),
    snapshot: contextSnapshotSchema.optional(),
    used: z23.number().nullable(),
    size: z23.number().nullable().optional(),
    estimated: z23.boolean(),
    cost: threadUsageCostSchema.optional(),
    attach: deltaAttachSchema,
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z23.object({
    kind: z23.literal("context.compacted"),
    providerTurnId: providerTurnIdSchema.optional(),
    noTurnFallback: deltaNoTurnFallbackSchema.optional()
  }),
  z23.object({ kind: z23.literal("context.cleared") }),
  z23.object({
    kind: z23.literal("turn.diff"),
    diff: z23.string(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z23.object({ kind: z23.literal("thread.started") }),
  z23.object({
    kind: z23.literal("thread.identity"),
    providerThreadId: z23.string().min(1)
  }),
  z23.object({
    kind: z23.literal("thread.name"),
    name: z23.string().min(1),
    source: z23.literal("agent").optional()
  }),
  z23.object({
    kind: z23.literal("extension.state"),
    extensionKind: extensionKindSchema,
    payload: jsonValueSchema
  }),
  z23.object({
    kind: z23.literal("provider.rateLimits"),
    rateLimits: providerRateLimitStateSchema
  }),
  z23.object({
    kind: z23.literal("provider.error"),
    message: z23.string(),
    detail: z23.string().optional(),
    willRetry: z23.boolean().optional(),
    category: providerErrorCategorySchema.optional(),
    errorInfo: providerErrorInfoSchema.optional(),
    settlesTurn: z23.boolean().optional(),
    providerTurnId: providerTurnIdSchema.optional(),
    threadScoped: z23.boolean().optional()
  }),
  z23.object({
    kind: z23.literal("provider.modelFallback"),
    originalModel: z23.string().min(1),
    fallbackModel: z23.string().min(1),
    reason: z23.enum(["refusal", "provider"]),
    message: z23.string()
  }),
  z23.object({
    kind: z23.literal("provider.warning"),
    summary: z23.string().optional(),
    details: z23.string().optional(),
    category: threadEventWarningCategorySchema.optional(),
    vouchedTurn: z23.boolean().optional()
  }),
  z23.object({
    kind: z23.literal("unhandled"),
    raw: providerRawEventSchema,
    rawType: z23.string(),
    vouchedTurn: z23.boolean(),
    onlyIfNoTurn: z23.boolean().optional(),
    parentRef: deltaKeyPartSchema.optional(),
    providerTurnId: providerTurnIdSchema.optional()
  }),
  z23.object({ kind: z23.literal("session.ended") }),
  z23.object({ kind: z23.literal("session.reset") })
]);
var threadDeltaNotificationParamsSchema = z23.object({
  threadId: z23.string().min(1),
  deltas: z23.array(threadDeltaSchema)
}).passthrough();

// ../provider-bridge-protocol/src/assembler/delta-assembler.ts
import { randomUUID } from "node:crypto";

// ../provider-bridge-protocol/src/version.ts
var PROVIDER_BRIDGE_PROTOCOL_VERSION = 2;
var THREAD_DELTA_GRAMMAR_V3 = 3;

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
import { z as z25 } from "zod";

// ../provider-bridge-protocol/src/bridge-kit/tool-arg-schemas.ts
import { z as z24 } from "zod";
var bashArgsSchema = z24.object({
  command: z24.string().optional(),
  cwd: z24.string().optional()
}).passthrough();
var textBlockSchema = z24.object({
  type: z24.literal("text"),
  text: z24.string()
});

// ../provider-bridge-protocol/src/bridge-kit/provider-visibility-helpers.ts
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ../provider-bridge-protocol/src/bridge-kit/adapter-utils.ts
var contentWrapperSchema = z25.object({
  content: z25.array(z25.unknown())
}).passthrough();
var shellEnvironmentVariableKeySchema = z25.string().regex(/^[A-Z_][A-Z0-9_]*$/i);
var MAX_EXACT_LINE_DIFF_CELLS = 1e6;
function splitComparableLines(text) {
  const normalized = text.replace(/\r\n?/gu, "\n");
  if (normalized.length === 0) {
    return [];
  }
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}
function commonPrefixLength(oldLines, newLines) {
  const limit = Math.min(oldLines.length, newLines.length);
  let index = 0;
  while (index < limit && oldLines[index] === newLines[index]) {
    index += 1;
  }
  return index;
}
function commonSuffixLength(args) {
  let oldIndex = args.oldLines.length - 1;
  let newIndex = args.newLines.length - 1;
  let length = 0;
  while (oldIndex >= args.prefixLength && newIndex >= args.prefixLength && args.oldLines[oldIndex] === args.newLines[newIndex]) {
    length += 1;
    oldIndex -= 1;
    newIndex -= 1;
  }
  return length;
}
function buildReplacementLineDiff(oldLines, newLines) {
  return [
    ...oldLines.map((line) => ({ type: "remove", line })),
    ...newLines.map((line) => ({ type: "add", line }))
  ];
}
function buildExactLineDiff(oldLines, newLines) {
  if (oldLines.length === 0) {
    return newLines.map((line) => ({ type: "add", line }));
  }
  if (newLines.length === 0) {
    return oldLines.map((line) => ({ type: "remove", line }));
  }
  const columnCount = newLines.length + 1;
  const cellCount = (oldLines.length + 1) * columnCount;
  if (cellCount > MAX_EXACT_LINE_DIFF_CELLS) {
    return buildReplacementLineDiff(oldLines, newLines);
  }
  const lcs = new Uint32Array(cellCount);
  for (let oldIndex2 = oldLines.length - 1; oldIndex2 >= 0; oldIndex2 -= 1) {
    const rowOffset = oldIndex2 * columnCount;
    const nextRowOffset = (oldIndex2 + 1) * columnCount;
    for (let newIndex2 = newLines.length - 1; newIndex2 >= 0; newIndex2 -= 1) {
      lcs[rowOffset + newIndex2] = oldLines[oldIndex2] === newLines[newIndex2] ? lcs[nextRowOffset + newIndex2 + 1] + 1 : Math.max(
        lcs[nextRowOffset + newIndex2],
        lcs[rowOffset + newIndex2 + 1]
      );
    }
  }
  const operations = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      oldIndex += 1;
      newIndex += 1;
      continue;
    }
    const removeScore = lcs[(oldIndex + 1) * columnCount + newIndex];
    const addScore = lcs[oldIndex * columnCount + newIndex + 1];
    if (removeScore >= addScore) {
      operations.push({ type: "remove", line: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      operations.push({ type: "add", line: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }
  while (oldIndex < oldLines.length) {
    operations.push({ type: "remove", line: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }
  while (newIndex < newLines.length) {
    operations.push({ type: "add", line: newLines[newIndex] ?? "" });
    newIndex += 1;
  }
  return operations;
}
function buildChangedLineDiff(oldLines, newLines) {
  const prefixLength = commonPrefixLength(oldLines, newLines);
  const suffixLength = commonSuffixLength({
    oldLines,
    newLines,
    prefixLength
  });
  const oldEnd = oldLines.length - suffixLength;
  const newEnd = newLines.length - suffixLength;
  return buildExactLineDiff(
    oldLines.slice(prefixLength, oldEnd),
    newLines.slice(prefixLength, newEnd)
  );
}
function formatLineDiff(args) {
  const body = args.operations.map(
    (operation) => operation.type === "add" ? `+${operation.line}` : `-${operation.line}`
  );
  return [...args.headers, ...body].join("\n") + "\n";
}
function buildEditDiff(filePath, oldString, newString) {
  const normalizedPath = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (oldString === void 0 && newString !== void 0) {
    return formatLineDiff({
      headers: ["--- /dev/null", `+++ b/${normalizedPath}`],
      operations: splitComparableLines(newString).map((line) => ({
        type: "add",
        line
      }))
    });
  }
  if (oldString !== void 0 && newString === void 0) {
    return formatLineDiff({
      headers: [`--- a/${normalizedPath}`, "+++ /dev/null"],
      operations: splitComparableLines(oldString).map((line) => ({
        type: "remove",
        line
      }))
    });
  }
  if (oldString !== void 0 && newString !== void 0) {
    const oldLines = splitComparableLines(oldString);
    const newLines = splitComparableLines(newString);
    const operations = buildChangedLineDiff(oldLines, newLines);
    if (operations.length === 0) {
      return void 0;
    }
    return formatLineDiff({
      headers: [`--- a/${normalizedPath}`, `+++ b/${normalizedPath}`],
      operations
    });
  }
  return void 0;
}
function toOptionalRecord(value) {
  return isRecord(value) ? value : void 0;
}
function withParentToolCallId(item, parentToolCallId) {
  if (!parentToolCallId) {
    return item;
  }
  return {
    ...item,
    parentToolCallId
  };
}

// ../provider-bridge-protocol/src/assembler/delta-assembler.ts
var ASSEMBLER_GRAMMAR_VERSIONS = [
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_GRAMMAR_V3
];
var UNSTAMPED_THREAD_ID = "";
function diffCumulativeText(args) {
  const previousText = args.previousText ?? "";
  if (args.nextText.length === 0 || args.nextText === previousText) {
    return null;
  }
  if (previousText.length === 0) {
    return { delta: args.nextText, nextText: args.nextText, reset: false };
  }
  if (args.nextText.startsWith(previousText)) {
    const delta = args.nextText.slice(previousText.length);
    return delta.length > 0 ? { delta, nextText: args.nextText, reset: false } : null;
  }
  return { delta: args.nextText, nextText: args.nextText, reset: true };
}
var MAX_THREAD_STATES = 256;
var MAX_ID_MAP_ENTRIES = 1024;
var MAX_SETTLED_ITEM_KEYS = 512;
function asTextDeltaEvent(event) {
  switch (event.type) {
    case "item/agentMessage/delta":
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryTextDelta":
    case "item/plan/delta":
    case "item/commandExecution/outputDelta":
    case "item/fileChange/outputDelta":
      return event;
    default:
      return void 0;
  }
}
var TEXT_DELTA_FLUSH_MS = 50;
var SEP = THREAD_DELTA_KEY_SEPARATOR;
function itemKeyString(key) {
  return [
    key.providerItemId ?? "",
    key.channel ?? "",
    key.parentRef ?? ""
  ].join(SEP);
}
function withPresentation(item, presentation) {
  if (presentation === void 0 || item.type === "userMessage") {
    return item;
  }
  return { ...item, presentation };
}
function presentationOf(item) {
  return item !== void 0 && "presentation" in item ? item.presentation : void 0;
}
function trimOldestEntries(map, max) {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) {
      return;
    }
    map.delete(oldest.value);
  }
}
function createDeltaAssembler(options) {
  const entropyPrefix = options.entropyPrefix ?? `da${randomUUID().slice(0, 8)}`;
  const progressThrottleMs = options.progressThrottleMs ?? 500;
  const textDeltaFlushMs = options.textDeltaFlushMs ?? TEXT_DELTA_FLUSH_MS;
  const now = options.now ?? Date.now;
  let turnCounter = 0;
  let itemCounter = 0;
  const states = /* @__PURE__ */ new Map();
  function mintTurnId() {
    turnCounter += 1;
    return `${entropyPrefix}-t${turnCounter}`;
  }
  function mintItemId() {
    itemCounter += 1;
    return `${entropyPrefix}-i${itemCounter}`;
  }
  function stateFor(threadId) {
    const existing = states.get(threadId);
    if (existing) {
      states.delete(threadId);
      states.set(threadId, existing);
      return existing;
    }
    const created = {
      currentTurnId: void 0,
      lastTurnId: void 0,
      pendingAccepted: [],
      openItemsByKey: /* @__PURE__ */ new Map(),
      commandSnapshotsByKey: /* @__PURE__ */ new Map(),
      bbItemIdByProviderItemId: /* @__PURE__ */ new Map(),
      providerItemIdByBbItemId: /* @__PURE__ */ new Map(),
      bbTurnIdByProviderTurnId: /* @__PURE__ */ new Map(),
      providerTurnIdByBbTurnId: /* @__PURE__ */ new Map(),
      settledItemKeys: /* @__PURE__ */ new Set(),
      progressLastEmitByKey: /* @__PURE__ */ new Map(),
      pendingProgressByKey: /* @__PURE__ */ new Map(),
      pendingTextByStream: /* @__PURE__ */ new Map(),
      pendingTextTimer: void 0
    };
    states.set(threadId, created);
    pruneIdleStates();
    return created;
  }
  function pruneIdleStates() {
    while (states.size > MAX_THREAD_STATES) {
      let removed = false;
      for (const [threadId, state] of states) {
        if (state.currentTurnId !== void 0 || state.openItemsByKey.size > 0 || state.pendingAccepted.length > 0 || state.pendingTextByStream.size > 0) {
          continue;
        }
        states.delete(threadId);
        removed = true;
        break;
      }
      if (!removed) {
        return;
      }
    }
  }
  function registerItemId(state, providerItemId, bbItemId) {
    state.bbItemIdByProviderItemId.set(providerItemId, bbItemId);
    state.providerItemIdByBbItemId.set(bbItemId, providerItemId);
    trimOldestEntries(state.bbItemIdByProviderItemId, MAX_ID_MAP_ENTRIES);
    trimOldestEntries(state.providerItemIdByBbItemId, MAX_ID_MAP_ENTRIES);
  }
  function resolveVouchedTurnId(state, providerTurnId) {
    const existing = state.bbTurnIdByProviderTurnId.get(providerTurnId);
    if (existing !== void 0) {
      return existing;
    }
    const bbTurnId = mintTurnId();
    state.bbTurnIdByProviderTurnId.set(providerTurnId, bbTurnId);
    state.providerTurnIdByBbTurnId.set(bbTurnId, providerTurnId);
    trimOldestEntries(state.bbTurnIdByProviderTurnId, MAX_ID_MAP_ENTRIES);
    trimOldestEntries(state.providerTurnIdByBbTurnId, MAX_ID_MAP_ENTRIES);
    return bbTurnId;
  }
  function rememberProgressEmit(state, key) {
    state.progressLastEmitByKey.set(key, now());
    trimOldestEntries(state.progressLastEmitByKey, MAX_ID_MAP_ENTRIES);
  }
  function flushElapsedPendingProgress(state, events, skipKeys) {
    if (state.pendingProgressByKey.size === 0) {
      return;
    }
    const nowMs = now();
    for (const [key, pending] of [...state.pendingProgressByKey]) {
      if (skipKeys.has(key)) {
        continue;
      }
      const last = state.progressLastEmitByKey.get(key);
      if (last !== void 0 && nowMs - last < progressThrottleMs) {
        continue;
      }
      state.pendingProgressByKey.delete(key);
      state.progressLastEmitByKey.set(key, nowMs);
      events.push(pending.event);
    }
  }
  function flushPendingText(state, out) {
    if (state.pendingTextTimer !== void 0) {
      clearTimeout(state.pendingTextTimer);
      state.pendingTextTimer = void 0;
    }
    for (const pending of state.pendingTextByStream.values()) {
      out.push({ ...pending.event, delta: pending.text });
    }
    state.pendingTextByStream.clear();
  }
  function flushElapsedPendingText(state, out) {
    const nowMs = now();
    for (const pending of state.pendingTextByStream.values()) {
      if (nowMs - pending.openedAt >= textDeltaFlushMs) {
        flushPendingText(state, out);
        return;
      }
    }
  }
  function schedulePendingTextFlush(threadId, state) {
    const onDeferredEvents = options.onDeferredEvents;
    if (onDeferredEvents === void 0 || state.pendingTextTimer !== void 0) {
      return;
    }
    let openedAt = Number.POSITIVE_INFINITY;
    for (const pending of state.pendingTextByStream.values()) {
      openedAt = Math.min(openedAt, pending.openedAt);
    }
    if (openedAt === Number.POSITIVE_INFINITY) {
      return;
    }
    state.pendingTextTimer = setTimeout(
      () => {
        state.pendingTextTimer = void 0;
        const events = [];
        flushPendingText(state, events);
        if (events.length > 0) {
          onDeferredEvents(threadId, events);
        }
      },
      Math.max(0, openedAt + textDeltaFlushMs - now())
    );
    state.pendingTextTimer.unref?.();
  }
  function bufferTextDelta(state, event, out) {
    if (event.type === "item/commandExecution/outputDelta" && event.reset === true) {
      flushPendingText(state, out);
      out.push(event);
      return;
    }
    const streamKey = `${event.type}${SEP}${event.itemId}`;
    const pending = state.pendingTextByStream.get(streamKey);
    if (pending === void 0) {
      state.pendingTextByStream.set(streamKey, {
        event,
        openedAt: now(),
        text: event.delta
      });
    } else {
      pending.text += event.delta;
    }
    flushElapsedPendingText(state, out);
  }
  function rememberSettledKey(state, key) {
    state.settledItemKeys.add(key);
    while (state.settledItemKeys.size > MAX_SETTLED_ITEM_KEYS) {
      const oldest = state.settledItemKeys.values().next();
      if (oldest.done === true) {
        return;
      }
      state.settledItemKeys.delete(oldest.value);
    }
  }
  function mapParentRef(state, parentRef) {
    if (parentRef === void 0) {
      return void 0;
    }
    const existing = state.bbItemIdByProviderItemId.get(parentRef);
    if (existing !== void 0) {
      return existing;
    }
    const bbItemId = mintItemId();
    registerItemId(state, parentRef, bbItemId);
    return bbItemId;
  }
  function ensureTurnOpen(state, events) {
    if (state.currentTurnId !== void 0) {
      return state.currentTurnId;
    }
    const turnId = mintTurnId();
    state.currentTurnId = turnId;
    events.push({
      type: "turn/started",
      threadId: UNSTAMPED_THREAD_ID,
      providerThreadId: "",
      scope: turnScope(turnId)
    });
    while (state.pendingAccepted.length > 0) {
      const clientRequestId = state.pendingAccepted.shift();
      if (clientRequestId === void 0) {
        break;
      }
      events.push({
        type: "turn/input/accepted",
        threadId: UNSTAMPED_THREAD_ID,
        providerThreadId: "",
        scope: turnScope(turnId),
        clientRequestId
      });
    }
    return turnId;
  }
  function finishTurn(state) {
    state.lastTurnId = state.currentTurnId ?? state.lastTurnId;
    state.currentTurnId = void 0;
    for (const [key, open] of [...state.openItemsByKey]) {
      if (!open.threadAttached) {
        state.openItemsByKey.delete(key);
      }
    }
    for (const [key, pending] of [...state.pendingProgressByKey]) {
      if (pending.turnScoped) {
        state.pendingProgressByKey.delete(key);
      }
    }
    state.commandSnapshotsByKey.clear();
  }
  function currentOrLastTurnId(state) {
    return state.currentTurnId ?? state.lastTurnId;
  }
  function buildFileChanges(shape) {
    return shape.changes.map((change) => {
      const diff = change.diff ?? (change.newText === void 0 ? void 0 : buildEditDiff(change.path, change.oldText, change.newText));
      return {
        path: change.path,
        kind: change.kind,
        ...change.movePath === void 0 ? {} : { movePath: change.movePath },
        ...diff ? { diff } : {}
      };
    });
  }
  function shapeMatchesItem(shape, item) {
    switch (shape.type) {
      case "command":
        return item.type === "commandExecution";
      case "fileChange":
        return item.type === "fileChange";
      case "tool":
        return item.type === "toolCall";
      case "compaction":
        return item.type === "contextCompaction";
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "webSearch":
      case "webFetch":
      case "imageView":
      case "imageGeneration":
      case "backgroundTask":
      case "fileRead":
      case "search":
      case "delegation":
      case "planSteps":
        return item.type === shape.type;
      case "extension":
        return item.type === "extension" && item.kind === shape.kind;
    }
  }
  function buildBackgroundTaskItem(bbItemId, shape, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "backgroundTask",
        id: bbItemId,
        familyId: shape.familyId,
        taskType: shape.taskType,
        description: shape.description,
        status: shape.status,
        taskStatus: shape.taskStatus,
        skipTranscript: shape.skipTranscript,
        foreground: shape.foreground ?? false,
        ...shape.workflowName === void 0 ? {} : { workflowName: shape.workflowName },
        ...shape.workflow === void 0 ? {} : { workflow: shape.workflow },
        ...shape.usage === void 0 ? {} : { usage: shape.usage },
        ...shape.summary === void 0 ? {} : { summary: shape.summary },
        ...shape.error === void 0 ? {} : { error: shape.error },
        ...shape.outputFile === void 0 ? {} : { outputFile: shape.outputFile }
      },
      parentToolCallId
    );
  }
  function buildFileReadItem(bbItemId, shape, status, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "fileRead",
        id: bbItemId,
        path: shape.path,
        ...shape.cmd === void 0 ? {} : { cmd: shape.cmd },
        status
      },
      parentToolCallId
    );
  }
  function buildSearchItem(bbItemId, shape, status, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "search",
        id: bbItemId,
        mode: shape.mode,
        query: shape.query,
        ...shape.path === void 0 ? {} : { path: shape.path },
        ...shape.cmd === void 0 ? {} : { cmd: shape.cmd },
        status
      },
      parentToolCallId
    );
  }
  function buildDelegationItem(bbItemId, shape, status, parentToolCallId, fallbackSummary) {
    const summary = shape.summary ?? fallbackSummary;
    return withParentToolCallId(
      {
        type: "delegation",
        id: bbItemId,
        childRef: shape.childRef,
        label: shape.label,
        status,
        background: shape.background,
        ...summary === void 0 ? {} : { summary }
      },
      parentToolCallId
    );
  }
  function buildExtensionItem(bbItemId, shape, status, parentToolCallId, presentation) {
    if (presentation === void 0) {
      throw new Error(
        `extension item "${shape.kind}" reached the assembler without a presentation`
      );
    }
    return withParentToolCallId(
      {
        type: "extension",
        id: bbItemId,
        kind: shape.kind,
        payload: shape.payload,
        status,
        presentation
      },
      parentToolCallId
    );
  }
  function buildPlanStepsItem(bbItemId, shape, status, parentToolCallId) {
    return withParentToolCallId(
      {
        type: "planSteps",
        id: bbItemId,
        steps: shape.steps,
        ...shape.explanation === void 0 ? {} : { explanation: shape.explanation },
        status
      },
      parentToolCallId
    );
  }
  function isThreadAttachedShape(shape) {
    switch (shape.type) {
      case "backgroundTask":
        return true;
      case "delegation":
        return shape.background;
      case "command":
      case "fileChange":
      case "tool":
      case "compaction":
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "webSearch":
      case "webFetch":
      case "imageView":
      case "imageGeneration":
      case "fileRead":
      case "search":
      case "planSteps":
      case "extension":
        return false;
    }
  }
  function buildOpenedItem(bbItemId, shape, parentToolCallId, presentation) {
    return withPresentation(
      buildOpenedItemShape(bbItemId, shape, parentToolCallId, presentation),
      presentation
    );
  }
  function buildOpenedItemShape(bbItemId, shape, parentToolCallId, presentation) {
    switch (shape.type) {
      case "command":
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: bbItemId,
            command: shape.command,
            cwd: shape.cwd,
            ...shape.description === void 0 ? {} : { description: shape.description },
            ...shape.aggregatedOutput === void 0 ? {} : { aggregatedOutput: shape.aggregatedOutput },
            ...shape.exitCode === void 0 ? {} : { exitCode: shape.exitCode },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs },
            status: "pending",
            approvalStatus: null
          },
          parentToolCallId
        );
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: bbItemId,
            changes: buildFileChanges(shape),
            status: "pending",
            approvalStatus: null
          },
          parentToolCallId
        );
      case "tool": {
        const toolArguments = toOptionalRecord(shape.args);
        return withParentToolCallId(
          {
            type: "toolCall",
            id: bbItemId,
            ...shape.server === void 0 ? {} : { server: shape.server },
            tool: shape.tool,
            ...toolArguments ? { arguments: toolArguments } : {},
            status: "pending",
            ...shape.result === void 0 ? {} : { result: shape.result },
            ...shape.error === void 0 ? {} : { error: shape.error },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs }
          },
          parentToolCallId
        );
      }
      case "compaction":
        return withParentToolCallId(
          { type: "contextCompaction", id: bbItemId },
          parentToolCallId
        );
      case "agentMessage":
        return withParentToolCallId(
          { type: "agentMessage", id: bbItemId, text: shape.text },
          parentToolCallId
        );
      case "reasoning":
        return withParentToolCallId(
          {
            type: "reasoning",
            id: bbItemId,
            summary: shape.summary,
            content: shape.content
          },
          parentToolCallId
        );
      case "plan":
        return withParentToolCallId(
          { type: "plan", id: bbItemId, text: shape.text },
          parentToolCallId
        );
      case "webSearch":
        return withParentToolCallId(
          {
            type: "webSearch",
            id: bbItemId,
            queries: shape.queries,
            resultText: null
          },
          parentToolCallId
        );
      case "webFetch":
        return withParentToolCallId(
          {
            type: "webFetch",
            id: bbItemId,
            url: shape.url,
            prompt: shape.prompt ?? null,
            pattern: shape.pattern,
            resultText: null
          },
          parentToolCallId
        );
      case "imageView":
        return withParentToolCallId(
          { type: "imageView", id: bbItemId, path: shape.path },
          parentToolCallId
        );
      case "imageGeneration":
        return withParentToolCallId(
          {
            type: "imageGeneration",
            id: bbItemId,
            status: "pending",
            prompt: shape.prompt,
            path: shape.path,
            ...shape.result === void 0 ? {} : { result: shape.result },
            error: shape.error,
            transparentBackground: shape.transparentBackground
          },
          parentToolCallId
        );
      case "backgroundTask":
        return buildBackgroundTaskItem(bbItemId, shape, parentToolCallId);
      case "fileRead":
        return buildFileReadItem(bbItemId, shape, "pending", parentToolCallId);
      case "search":
        return buildSearchItem(bbItemId, shape, "pending", parentToolCallId);
      case "delegation":
        return buildDelegationItem(
          bbItemId,
          shape,
          "pending",
          parentToolCallId
        );
      case "planSteps":
        return buildPlanStepsItem(bbItemId, shape, "pending", parentToolCallId);
      case "extension":
        return buildExtensionItem(
          bbItemId,
          shape,
          "pending",
          parentToolCallId,
          presentation
        );
    }
  }
  function fileChangeErrorField(close) {
    return close.status === "failed" && close.resultText?.trim() ? { error: close.resultText } : {};
  }
  function completeStartedItem(started, close, parentToolCallId) {
    const parent = parentToolCallId ?? started.parentToolCallId;
    switch (started.type) {
      case "commandExecution":
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: started.id,
            command: started.command,
            cwd: started.cwd,
            ...close.aggregatedOutput === void 0 ? {} : { aggregatedOutput: close.aggregatedOutput },
            ...close.exitCode === void 0 ? {} : { exitCode: close.exitCode },
            status: close.status,
            approvalStatus: started.approvalStatus
          },
          parent
        );
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: started.id,
            changes: started.changes,
            status: close.status,
            approvalStatus: started.approvalStatus,
            ...fileChangeErrorField(close)
          },
          parent
        );
      case "toolCall":
        return withParentToolCallId(
          {
            type: "toolCall",
            id: started.id,
            tool: started.tool,
            ...started.arguments === void 0 ? {} : { arguments: started.arguments },
            status: close.status,
            ...close.resultText === void 0 ? {} : { result: close.resultText }
          },
          parent
        );
      case "contextCompaction":
        return withParentToolCallId(
          { type: "contextCompaction", id: started.id },
          parent
        );
      case "imageGeneration":
        return withParentToolCallId(
          {
            ...started,
            status: close.status
          },
          parent
        );
      case "fileRead":
        return buildFileReadItem(started.id, started, close.status, parent);
      case "search":
        return buildSearchItem(started.id, started, close.status, parent);
      case "delegation":
        return buildDelegationItem(started.id, started, close.status, parent);
      case "planSteps":
        return buildPlanStepsItem(started.id, started, close.status, parent);
      case "extension":
        return buildExtensionItem(
          started.id,
          started,
          close.status,
          parent,
          started.presentation
        );
      default:
        return started;
    }
  }
  function buildClosedItemFromShape(bbItemId, shape, close, parentToolCallId, presentation) {
    return withPresentation(
      buildClosedItemShape(
        bbItemId,
        shape,
        close,
        parentToolCallId,
        presentation
      ),
      presentation
    );
  }
  function buildClosedItemShape(bbItemId, shape, close, parentToolCallId, presentation) {
    switch (shape.type) {
      case "command": {
        const aggregatedOutput = close.aggregatedOutput ?? shape.aggregatedOutput;
        const exitCode = close.exitCode ?? shape.exitCode;
        return withParentToolCallId(
          {
            type: "commandExecution",
            id: bbItemId,
            command: shape.command,
            cwd: shape.cwd,
            ...shape.description === void 0 ? {} : { description: shape.description },
            ...aggregatedOutput === void 0 ? {} : { aggregatedOutput },
            ...exitCode === void 0 ? {} : { exitCode },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs },
            status: close.status,
            approvalStatus: close.approvalStatus ?? null
          },
          parentToolCallId
        );
      }
      case "fileChange":
        return withParentToolCallId(
          {
            type: "fileChange",
            id: bbItemId,
            changes: buildFileChanges(shape),
            status: close.status,
            approvalStatus: close.approvalStatus ?? null,
            ...fileChangeErrorField(close)
          },
          parentToolCallId
        );
      case "tool": {
        const toolArguments = toOptionalRecord(shape.args);
        const result2 = shape.result ?? close.resultText;
        return withParentToolCallId(
          {
            type: "toolCall",
            id: bbItemId,
            ...shape.server === void 0 ? {} : { server: shape.server },
            tool: shape.tool,
            ...toolArguments ? { arguments: toolArguments } : {},
            status: close.status,
            ...result2 === void 0 ? {} : { result: result2 },
            ...shape.error === void 0 ? {} : { error: shape.error },
            ...shape.durationMs === void 0 ? {} : { durationMs: shape.durationMs }
          },
          parentToolCallId
        );
      }
      case "compaction":
        return withParentToolCallId(
          { type: "contextCompaction", id: bbItemId },
          parentToolCallId
        );
      case "webSearch":
        return withParentToolCallId(
          {
            type: "webSearch",
            id: bbItemId,
            queries: shape.queries,
            resultText: close.resultText ?? null
          },
          parentToolCallId
        );
      case "webFetch":
        return withParentToolCallId(
          {
            type: "webFetch",
            id: bbItemId,
            url: shape.url,
            prompt: shape.prompt ?? null,
            pattern: shape.pattern,
            resultText: close.resultText ?? null
          },
          parentToolCallId
        );
      case "imageGeneration":
        return withParentToolCallId(
          {
            type: "imageGeneration",
            id: bbItemId,
            status: close.status,
            prompt: shape.prompt,
            path: shape.path,
            ...shape.result === void 0 ? {} : { result: shape.result },
            error: shape.error,
            transparentBackground: shape.transparentBackground
          },
          parentToolCallId
        );
      case "backgroundTask":
        return buildBackgroundTaskItem(bbItemId, shape, parentToolCallId);
      case "fileRead":
        return buildFileReadItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId
        );
      case "search":
        return buildSearchItem(bbItemId, shape, close.status, parentToolCallId);
      case "delegation":
        return buildDelegationItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId,
          close.delegationSummary
        );
      case "planSteps":
        return buildPlanStepsItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId
        );
      case "extension":
        return buildExtensionItem(
          bbItemId,
          shape,
          close.status,
          parentToolCallId,
          presentation
        );
      case "agentMessage":
      case "reasoning":
      case "plan":
      case "imageView":
        return buildOpenedItemShape(
          bbItemId,
          shape,
          parentToolCallId,
          presentation
        );
    }
  }
  function pushNoTurnFallback(state, fallback, parentRef, events) {
    if (fallback === void 0) {
      return;
    }
    const parentToolCallId = mapParentRef(state, parentRef);
    events.push({
      type: "provider/unhandled",
      threadId: UNSTAMPED_THREAD_ID,
      providerThreadId: "",
      providerId: options.providerId,
      rawType: fallback.rawType,
      rawEvent: fallback.raw,
      scope: threadScope(),
      ...parentToolCallId === void 0 ? {} : { parentToolCallId }
    });
  }
  function detachAssistantStreams(state, parentRef) {
    for (const [keyStr, open] of [...state.openItemsByKey]) {
      if (open.key.providerItemId === void 0 && open.item.type === "agentMessage" && open.key.parentRef === parentRef) {
        state.openItemsByKey.delete(keyStr);
      }
    }
  }
  function settleTextItem(open, finalText, channel) {
    const text = channel === "reasoningSummary" ? open.text : finalText ?? open.text;
    const summaryText = channel === "reasoningSummary" ? finalText ?? open.summaryText : open.summaryText;
    switch (open.item.type) {
      case "agentMessage":
        return withPresentation(
          withParentToolCallId(
            { type: "agentMessage", id: open.bbItemId, text },
            open.item.parentToolCallId
          ),
          open.item.presentation
        );
      case "plan":
        return withPresentation(
          withParentToolCallId(
            { type: "plan", id: open.bbItemId, text },
            open.item.parentToolCallId
          ),
          open.item.presentation
        );
      case "reasoning":
        return withPresentation(
          withParentToolCallId(
            {
              type: "reasoning",
              id: open.bbItemId,
              summary: summaryText.length === 0 ? [] : [summaryText],
              content: text.length === 0 ? [] : [text]
            },
            open.item.parentToolCallId
          ),
          open.item.presentation
        );
      default:
        return void 0;
    }
  }
  function buildTextItemForChannel(bbItemId, channel, text, parentToolCallId) {
    switch (channel) {
      case "agentMessage":
        return withParentToolCallId(
          { type: "agentMessage", id: bbItemId, text },
          parentToolCallId
        );
      case "plan":
        return withParentToolCallId(
          { type: "plan", id: bbItemId, text },
          parentToolCallId
        );
      case "reasoningText":
        return withParentToolCallId(
          { type: "reasoning", id: bbItemId, summary: [], content: [text] },
          parentToolCallId
        );
      case "reasoningSummary":
        return withParentToolCallId(
          { type: "reasoning", id: bbItemId, summary: [text], content: [] },
          parentToolCallId
        );
    }
  }
  function handleDelta(state, delta, events) {
    switch (delta.kind) {
      case "input.accepted": {
        if (delta.providerTurnId !== void 0) {
          events.push({
            type: "turn/input/accepted",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(resolveVouchedTurnId(state, delta.providerTurnId)),
            clientRequestId: delta.clientRequestId
          });
          return;
        }
        if (state.currentTurnId !== void 0) {
          events.push({
            type: "turn/input/accepted",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(state.currentTurnId),
            clientRequestId: delta.clientRequestId
          });
          return;
        }
        state.pendingAccepted.push(delta.clientRequestId);
        return;
      }
      case "input.provider": {
        if (state.currentTurnId === void 0) {
          return;
        }
        const parentToolCallId = mapParentRef(state, delta.parentRef);
        events.push({
          type: "item/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(state.currentTurnId),
          item: {
            type: "userMessage",
            id: mintItemId(),
            content: [{ type: "text", text: delta.text }],
            ...parentToolCallId === void 0 ? {} : { parentToolCallId }
          }
        });
        return;
      }
      case "turn.open": {
        if (options.providerId === "claude-code" && delta.providerTurnId !== void 0 && delta.parentRef === void 0) {
          if (!state.bbTurnIdByProviderTurnId.has(delta.providerTurnId)) {
            const turnId = ensureTurnOpen(state, events);
            state.bbTurnIdByProviderTurnId.set(delta.providerTurnId, turnId);
            state.providerTurnIdByBbTurnId.set(turnId, delta.providerTurnId);
            trimOldestEntries(
              state.bbTurnIdByProviderTurnId,
              MAX_ID_MAP_ENTRIES
            );
            trimOldestEntries(
              state.providerTurnIdByBbTurnId,
              MAX_ID_MAP_ENTRIES
            );
          }
          return;
        }
        if (delta.providerTurnId !== void 0) {
          const parentToolCallId = mapParentRef(state, delta.parentRef);
          events.push({
            type: "turn/started",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(resolveVouchedTurnId(state, delta.providerTurnId)),
            ...parentToolCallId === void 0 ? {} : { parentToolCallId }
          });
          return;
        }
        ensureTurnOpen(state, events);
        return;
      }
      case "turn.boundary": {
        if (delta.providerTurnId !== void 0) {
          events.push({
            type: "turn/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(resolveVouchedTurnId(state, delta.providerTurnId)),
            status: delta.status,
            ...delta.error === void 0 ? {} : { error: delta.error },
            ...delta.providerCheckpointId === void 0 ? {} : { providerCheckpointId: delta.providerCheckpointId }
          });
          return;
        }
        const turnId = state.currentTurnId ?? (delta.claimIfIdle === true && state.pendingAccepted.length > 0 ? ensureTurnOpen(state, events) : void 0);
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "turn/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          status: delta.status,
          ...delta.error === void 0 ? {} : { error: delta.error },
          ...delta.providerCheckpointId === void 0 ? {} : { providerCheckpointId: delta.providerCheckpointId }
        });
        finishTurn(state);
        return;
      }
      case "item.open": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.attach === "currentOrLast" ? currentOrLastTurnId(state) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        state.settledItemKeys.delete(keyStr);
        if (delta.item.type !== "compaction") {
          detachAssistantStreams(state, delta.key.parentRef);
        }
        const bbItemId = (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? mintItemId();
        if (delta.key.providerItemId !== void 0) {
          registerItemId(state, delta.key.providerItemId, bbItemId);
        }
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        const item = buildOpenedItem(
          bbItemId,
          delta.item,
          parentToolCallId,
          delta.presentation
        );
        state.openItemsByKey.set(keyStr, {
          bbItemId,
          key: delta.key,
          item,
          threadAttached: isThreadAttachedShape(delta.item),
          text: "",
          summaryText: ""
        });
        rememberProgressEmit(state, keyStr);
        events.push({
          type: "item/started",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          item
        });
        return;
      }
      case "item.close": {
        const threadScoped = isThreadAttachedShape(delta.item);
        const turnId = threadScoped ? void 0 : delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (!threadScoped && turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        if (delta.key.providerItemId !== void 0 && state.settledItemKeys.has(keyStr)) {
          return;
        }
        const open = state.openItemsByKey.get(keyStr);
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        const openDelegationSummary = open?.item.type === "delegation" ? open.item.summary : void 0;
        const closeFields = {
          status: delta.status,
          ...delta.resultText === void 0 ? {} : { resultText: delta.resultText },
          ...delta.exitCode === void 0 ? {} : { exitCode: delta.exitCode },
          ...delta.aggregatedOutput === void 0 ? {} : { aggregatedOutput: delta.aggregatedOutput },
          ...delta.approvalStatus === void 0 ? {} : { approvalStatus: delta.approvalStatus },
          ...openDelegationSummary === void 0 ? {} : { delegationSummary: openDelegationSummary }
        };
        if (open !== void 0 && turnId !== void 0 && !shapeMatchesItem(delta.item, open.item)) {
          events.push({
            type: "item/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item: withPresentation(
              completeStartedItem(open.item, closeFields, parentToolCallId),
              presentationOf(open.item)
            )
          });
        }
        const bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? mintItemId();
        if (delta.key.providerItemId !== void 0) {
          registerItemId(state, delta.key.providerItemId, bbItemId);
        }
        const presentation = delta.presentation ?? presentationOf(open?.item);
        const item = buildClosedItemFromShape(
          bbItemId,
          delta.item,
          closeFields,
          parentToolCallId ?? open?.item.parentToolCallId,
          presentation
        );
        state.openItemsByKey.delete(keyStr);
        state.commandSnapshotsByKey.delete(keyStr);
        state.pendingProgressByKey.delete(keyStr);
        state.progressLastEmitByKey.delete(keyStr);
        if (delta.key.providerItemId !== void 0) {
          rememberSettledKey(state, keyStr);
        }
        if (item.type === "backgroundTask") {
          events.push({
            type: "item/backgroundTask/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item
          });
          return;
        }
        if (item.type === "delegation" && item.background) {
          events.push({
            type: "item/delegation/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item
          });
          return;
        }
        if (turnId !== void 0) {
          events.push({
            type: "item/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item
          });
        }
        return;
      }
      case "item.progress": {
        const keyStr = itemKeyString(delta.key);
        const open = state.openItemsByKey.get(keyStr);
        const bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? delta.key.providerItemId ?? mintItemId();
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        let event;
        if (delta.snapshot?.type === "delegation") {
          event = {
            type: "item/delegation/progress",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item: withPresentation(
              buildDelegationItem(
                bbItemId,
                delta.snapshot,
                "pending",
                parentToolCallId ?? open?.item.parentToolCallId,
                open?.item.type === "delegation" ? open.item.summary : void 0
              ),
              presentationOf(open?.item)
            )
          };
        } else if (delta.snapshot !== void 0) {
          event = {
            type: "item/backgroundTask/progress",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: threadScope(),
            item: buildBackgroundTaskItem(
              bbItemId,
              delta.snapshot,
              parentToolCallId
            )
          };
        } else {
          const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
          if (turnId === void 0) {
            pushNoTurnFallback(
              state,
              delta.noTurnFallback,
              delta.key.parentRef,
              events
            );
            return;
          }
          event = {
            type: "item/toolCall/progress",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            itemId: bbItemId,
            ...delta.message === void 0 ? {} : { message: delta.message },
            ...parentToolCallId === void 0 ? {} : { parentToolCallId }
          };
        }
        const lastEmit = state.progressLastEmitByKey.get(keyStr);
        if (delta.flush !== true && lastEmit !== void 0 && now() - lastEmit < progressThrottleMs) {
          state.pendingProgressByKey.set(keyStr, {
            event,
            turnScoped: delta.snapshot === void 0
          });
          return;
        }
        state.pendingProgressByKey.delete(keyStr);
        rememberProgressEmit(state, keyStr);
        events.push(event);
        return;
      }
      case "item.textDelta": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        const open = state.openItemsByKey.get(keyStr);
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        let bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0);
        if (bbItemId === void 0) {
          bbItemId = mintItemId();
          if (delta.key.providerItemId !== void 0) {
            registerItemId(state, delta.key.providerItemId, bbItemId);
          }
          const shape = delta.channel === "agentMessage" ? { type: "agentMessage", text: "" } : delta.channel === "plan" ? { type: "plan", text: "" } : { type: "reasoning", summary: [], content: [] };
          const item = buildOpenedItem(
            bbItemId,
            shape,
            parentToolCallId,
            void 0
          );
          state.openItemsByKey.set(keyStr, {
            bbItemId,
            key: delta.key,
            item,
            threadAttached: false,
            text: "",
            summaryText: ""
          });
          events.push({
            type: "item/started",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item
          });
        }
        const openText = state.openItemsByKey.get(keyStr);
        if (openText !== void 0) {
          if (delta.channel === "reasoningSummary") {
            openText.summaryText += delta.text;
          } else {
            openText.text += delta.text;
          }
        }
        const type = delta.channel === "agentMessage" ? "item/agentMessage/delta" : delta.channel === "reasoningSummary" ? "item/reasoning/summaryTextDelta" : delta.channel === "reasoningText" ? "item/reasoning/textDelta" : "item/plan/delta";
        events.push({
          type,
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          itemId: bbItemId,
          delta: delta.text,
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "item.textClose": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        if (delta.key.providerItemId !== void 0 && state.settledItemKeys.has(keyStr)) {
          return;
        }
        const open = state.openItemsByKey.get(keyStr);
        state.openItemsByKey.delete(keyStr);
        const accumulated = open === void 0 ? void 0 : delta.channel === "reasoningSummary" ? open.summaryText : open.text;
        const finalText = delta.text ?? accumulated;
        if (finalText === void 0 || finalText.length === 0) {
          return;
        }
        if (delta.text === void 0 && finalText.trim().length === 0) {
          return;
        }
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        let item = open === void 0 ? void 0 : settleTextItem(open, delta.text, delta.channel);
        let bbItemId = open?.bbItemId;
        if (item === void 0) {
          bbItemId = bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0) ?? mintItemId();
          item = buildTextItemForChannel(
            bbItemId,
            delta.channel,
            finalText,
            parentToolCallId ?? open?.item.parentToolCallId
          );
        }
        if (delta.key.providerItemId !== void 0 && bbItemId !== void 0) {
          registerItemId(state, delta.key.providerItemId, bbItemId);
          rememberSettledKey(state, keyStr);
        }
        events.push({
          type: "item/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          item
        });
        return;
      }
      case "item.outputDelta": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const open = state.openItemsByKey.get(itemKeyString(delta.key));
        let bbItemId = open?.bbItemId ?? (delta.key.providerItemId !== void 0 ? state.bbItemIdByProviderItemId.get(delta.key.providerItemId) : void 0);
        if (bbItemId === void 0) {
          bbItemId = mintItemId();
          if (delta.key.providerItemId !== void 0) {
            registerItemId(state, delta.key.providerItemId, bbItemId);
          }
        }
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        events.push({
          type: delta.channel === "command" ? "item/commandExecution/outputDelta" : "item/fileChange/outputDelta",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          itemId: bbItemId,
          delta: delta.text,
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "command.outputSnapshot": {
        if (state.currentTurnId === void 0) {
          pushNoTurnFallback(
            state,
            delta.noTurnFallback,
            delta.key.parentRef,
            events
          );
          return;
        }
        const keyStr = itemKeyString(delta.key);
        const open = state.openItemsByKey.get(keyStr);
        if (open === void 0) {
          return;
        }
        const diffed = diffCumulativeText({
          previousText: state.commandSnapshotsByKey.get(keyStr),
          nextText: delta.text
        });
        if (diffed === null) {
          return;
        }
        state.commandSnapshotsByKey.set(keyStr, diffed.nextText);
        const parentToolCallId = mapParentRef(state, delta.key.parentRef);
        events.push({
          type: "item/commandExecution/outputDelta",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(state.currentTurnId),
          itemId: open.bbItemId,
          delta: diffed.delta,
          ...diffed.reset ? { reset: true } : {},
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "usage": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : currentOrLastTurnId(state);
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "thread/tokenUsage/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          tokenUsage: {
            total: { ...delta.total },
            last: { ...delta.last },
            modelContextWindow: delta.modelContextWindow,
            ...delta.promptCacheTtlMs === void 0 ? {} : { promptCacheTtlMs: delta.promptCacheTtlMs }
          }
        });
        return;
      }
      case "contextWindow": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.attach === "open" ? state.currentTurnId : currentOrLastTurnId(state);
        events.push({
          type: "thread/contextWindowUsage/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          contextWindowUsage: {
            usedTokens: delta.snapshot?.usedTokens ?? delta.used,
            modelContextWindow: delta.snapshot?.contextWindowTokens ?? delta.size ?? null,
            estimated: delta.snapshot?.estimated ?? delta.estimated,
            ...delta.snapshot ? { snapshot: delta.snapshot } : {},
            ...delta.cost ? { cost: delta.cost } : {}
          }
        });
        return;
      }
      case "context.compacted": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : currentOrLastTurnId(state);
        if (turnId === void 0) {
          pushNoTurnFallback(state, delta.noTurnFallback, void 0, events);
          return;
        }
        events.push({
          type: "thread/compacted",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId)
        });
        return;
      }
      case "context.cleared": {
        const turnId = currentOrLastTurnId(state);
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "thread/context/cleared",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId)
        });
        return;
      }
      case "provider.error": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.threadScoped === true ? void 0 : state.currentTurnId ?? (state.pendingAccepted.length > 0 ? ensureTurnOpen(state, events) : void 0);
        events.push({
          type: "provider/error",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          message: delta.message,
          ...delta.detail === void 0 ? {} : { detail: delta.detail },
          ...delta.willRetry === void 0 ? {} : { willRetry: delta.willRetry },
          ...delta.errorInfo === void 0 ? {} : { errorInfo: delta.errorInfo }
        });
        if (delta.settlesTurn === true && turnId !== void 0) {
          events.push({
            type: "turn/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            status: "failed"
          });
          finishTurn(state);
        }
        return;
      }
      case "provider.modelFallback": {
        const turnId = currentOrLastTurnId(state);
        events.push({
          type: "provider/modelFallback",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          originalModel: delta.originalModel,
          fallbackModel: delta.fallbackModel,
          reason: delta.reason,
          message: delta.message
        });
        return;
      }
      case "provider.warning": {
        const turnId = delta.vouchedTurn === true ? state.currentTurnId : void 0;
        events.push({
          type: "provider/warning",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          category: delta.category ?? "general",
          ...delta.summary === void 0 ? {} : { summary: delta.summary },
          ...delta.details === void 0 ? {} : { details: delta.details }
        });
        return;
      }
      case "unhandled": {
        if (delta.onlyIfNoTurn === true && state.currentTurnId !== void 0) {
          return;
        }
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : delta.vouchedTurn === true ? state.currentTurnId : void 0;
        const parentToolCallId = mapParentRef(state, delta.parentRef);
        events.push({
          type: "provider/unhandled",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          providerId: options.providerId,
          rawType: delta.rawType,
          rawEvent: delta.raw,
          scope: turnId === void 0 ? threadScope() : turnScope(turnId),
          ...parentToolCallId === void 0 ? {} : { parentToolCallId }
        });
        return;
      }
      case "turn.mainRun": {
        if (state.currentTurnId === void 0) {
          return;
        }
        events.push({
          type: "turn/mainRun/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(state.currentTurnId),
          state: delta.state
        });
        return;
      }
      case "turn.diff": {
        const turnId = delta.providerTurnId !== void 0 ? resolveVouchedTurnId(state, delta.providerTurnId) : state.currentTurnId;
        if (turnId === void 0) {
          return;
        }
        events.push({
          type: "turn/diff/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          diff: delta.diff
        });
        return;
      }
      case "thread.started": {
        events.push({
          type: "thread/started",
          threadId: UNSTAMPED_THREAD_ID,
          scope: threadScope()
        });
        return;
      }
      case "thread.identity": {
        events.push({
          type: "thread/identity",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: delta.providerThreadId,
          scope: threadScope()
        });
        return;
      }
      case "thread.name": {
        events.push({
          type: "thread/name/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          threadName: delta.name,
          ...delta.source === void 0 ? {} : { source: delta.source }
        });
        return;
      }
      case "provider.rateLimits": {
        events.push({
          type: "provider/rateLimits/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          rateLimits: delta.rateLimits
        });
        return;
      }
      case "extension.state": {
        events.push({
          type: "thread/extensionState/updated",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: threadScope(),
          kind: delta.extensionKind,
          payload: delta.payload
        });
        return;
      }
      case "session.reset": {
        return;
      }
      case "session.ended": {
        const turnId = state.currentTurnId ?? (state.pendingAccepted.length > 0 ? ensureTurnOpen(state, events) : void 0);
        if (turnId === void 0) {
          return;
        }
        for (const open of state.openItemsByKey.values()) {
          if (open.threadAttached) {
            continue;
          }
          const streamed = open.text.length > 0 || open.summaryText.length > 0;
          const item = (streamed ? settleTextItem(open, void 0, void 0) : void 0) ?? completeStartedItem(
            open.item,
            { status: "interrupted" },
            void 0
          );
          events.push({
            type: "item/completed",
            threadId: UNSTAMPED_THREAD_ID,
            providerThreadId: "",
            scope: turnScope(turnId),
            item
          });
        }
        events.push({
          type: "turn/completed",
          threadId: UNSTAMPED_THREAD_ID,
          providerThreadId: "",
          scope: turnScope(turnId),
          status: "interrupted"
        });
        finishTurn(state);
        return;
      }
    }
  }
  return {
    assemble(args) {
      const events = [];
      const sink = {
        push: (...newEvents) => {
          for (const event of newEvents) {
            const textDelta = textDeltaFlushMs > 0 ? asTextDeltaEvent(event) : void 0;
            const state2 = states.get(args.threadId);
            if (textDelta !== void 0 && state2 !== void 0) {
              bufferTextDelta(state2, textDelta, events);
              continue;
            }
            if (state2 !== void 0) {
              flushPendingText(state2, events);
            }
            events.push(event);
          }
        }
      };
      const existing = args.deltas[0]?.kind === "session.reset" ? void 0 : states.get(args.threadId);
      if (existing !== void 0) {
        flushElapsedPendingText(existing, events);
        const progressKeysInBatch = /* @__PURE__ */ new Set();
        for (const delta of args.deltas) {
          if (delta.kind === "item.progress") {
            progressKeysInBatch.add(itemKeyString(delta.key));
          }
        }
        flushElapsedPendingProgress(existing, sink, progressKeysInBatch);
      }
      for (const delta of args.deltas) {
        if (delta.kind === "session.reset") {
          const state2 = states.get(args.threadId);
          if (state2 !== void 0) {
            flushPendingText(state2, events);
          }
          states.delete(args.threadId);
          continue;
        }
        handleDelta(stateFor(args.threadId), delta, sink);
      }
      const state = states.get(args.threadId);
      if (state !== void 0) {
        schedulePendingTextFlush(args.threadId, state);
      }
      return events;
    },
    getBbItemId(threadId, providerItemId) {
      return states.get(threadId)?.bbItemIdByProviderItemId.get(providerItemId);
    },
    getProviderItemId(threadId, bbItemId) {
      return states.get(threadId)?.providerItemIdByBbItemId.get(bbItemId);
    },
    getBbTurnId(threadId, providerTurnId) {
      return states.get(threadId)?.bbTurnIdByProviderTurnId.get(providerTurnId);
    },
    getProviderTurnId(threadId, bbTurnId) {
      return states.get(threadId)?.providerTurnIdByBbTurnId.get(bbTurnId);
    },
    getOpenTurnId(threadId) {
      return states.get(threadId)?.currentTurnId;
    }
  };
}

// ../provider-bridge-protocol/src/testing/bridge-delta-assembly.ts
function createBridgeDeltaEventCollector(providerId = "pi") {
  const assembler = createDeltaAssembler({
    providerId,
    textDeltaFlushMs: 0,
    now: () => 0
  });
  return {
    assembler,
    assembleMessage(message) {
      if (message.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        return [];
      }
      const parsed = threadDeltaNotificationParamsSchema.safeParse(
        message.params
      );
      if (!parsed.success) {
        throw new Error(
          `Invalid thread/delta notification: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(
            "; "
          )} (params: ${JSON.stringify(message.params)?.slice(0, 400)})`
        );
      }
      return assembler.assemble({
        threadId: parsed.data.threadId,
        deltas: parsed.data.deltas
      });
    }
  };
}
function assembleCapturedThreadEvents(messages, providerId = "pi") {
  const collector = createBridgeDeltaEventCollector(providerId);
  return messages.flatMap((message) => collector.assembleMessage(message));
}

// ../provider-bridge-protocol/src/conformance/client.ts
import { z as z26 } from "zod";
function isWireMessage(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
var threadDeltaAddressSchema = z26.object({ threadId: z26.string() }).passthrough();
var ConformanceClient = class {
  constructor(transport, timeoutMs, collector) {
    this.transport = transport;
    this.timeoutMs = timeoutMs;
    this.collector = collector;
  }
  transport;
  timeoutMs;
  collector;
  nextId = 1;
  log = [];
  events = [];
  drainIntoLog() {
    for (const raw of this.transport.takeMessages()) {
      if (!isWireMessage(raw)) {
        continue;
      }
      const logIndex = this.log.length;
      this.log.push(raw);
      if (raw.method !== THREAD_DELTA_NOTIFICATION_METHOD) {
        continue;
      }
      const events = this.collector.assembleMessage(raw);
      const address = threadDeltaAddressSchema.parse(raw.params);
      for (const event of events) {
        this.events.push({ threadId: address.threadId, event, logIndex });
      }
    }
  }
  sendRaw(line) {
    this.transport.send(line);
  }
  notify(method, params) {
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...params !== void 0 ? { params } : {}
      })
    );
  }
  request(method, params) {
    const id = this.nextId;
    this.nextId += 1;
    this.transport.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        ...params !== void 0 ? { params } : {}
      })
    );
    return id;
  }
  async waitFor(resolve3) {
    const deadline = Date.now() + this.timeoutMs;
    for (; ; ) {
      this.drainIntoLog();
      const value = resolve3();
      if (value !== void 0) {
        return value;
      }
      if (Date.now() > deadline) {
        return null;
      }
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  async waitForResponse(id) {
    return this.waitFor(
      () => this.log.find(
        (message) => message.id === id && message.method === void 0
      )
    );
  }
  async settle(quietMs) {
    const deadline = Date.now() + quietMs;
    while (Date.now() < deadline) {
      this.drainIntoLog();
      await new Promise((r) => setTimeout(r, 15));
    }
    this.drainIntoLog();
  }
  responsesFor(id) {
    return this.log.filter(
      (message) => message.id === id && message.method === void 0
    );
  }
  notifications(method) {
    return this.log.filter(
      (message) => message.id === void 0 && typeof message.method === "string" && (method === void 0 || message.method === method)
    );
  }
};
var clientRequestCounter = 0;
function nextConformanceClientRequestId() {
  const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
  clientRequestCounter += 1;
  let remaining = clientRequestCounter;
  let suffix = "";
  while (suffix.length < 10) {
    suffix = alphabet[remaining % alphabet.length] + suffix;
    remaining = Math.floor(remaining / alphabet.length);
  }
  return `creq_${suffix}`;
}

// ../provider-bridge-protocol/src/conformance/scenarios.ts
import { z as z34 } from "zod";

// ../provider-bridge-protocol/src/handshake.ts
import { z as z27 } from "zod";
var bridgeGrammarVersionsSchema = z27.tuple([z27.number().int().positive(), z27.number().int().positive()]).refine(([min, max]) => min <= max, {
  message: "grammarVersions must be an ascending [min, max] range"
});
function negotiateGrammarVersion(runtime, bridge) {
  const min = Math.max(runtime[0], bridge[0]);
  const max = Math.min(runtime[1], bridge[1]);
  return min <= max ? max : null;
}
var bridgeSteerModeSchema = z27.enum(["inject", "queue"]);
var bridgeCapabilitiesSchema = z27.object({
  sessionRestore: z27.boolean().default(false),
  threadArchive: z27.boolean().default(false),
  threadRename: z27.boolean().default(false),
  threadGoalClear: z27.boolean().default(false),
  fork: providerForkSchema.default("none"),
  approvalEnforcedBy: z27.enum(["runtime", "provider"]).default("runtime"),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ]),
  steerMode: bridgeSteerModeSchema.default("queue"),
  skills: z27.object({ configure: z27.boolean().default(false) }).default({ configure: false }),
  commands: z27.object({ list: z27.boolean().default(false) }).default({ list: false })
}).passthrough();
var initializeParamsSchema = z27.object({
  protocolVersion: z27.number().int().positive(),
  client: z27.object({ name: z27.string().min(1), version: z27.string().min(1) }),
  grammarVersions: bridgeGrammarVersionsSchema.default([
    PROVIDER_BRIDGE_PROTOCOL_VERSION,
    PROVIDER_BRIDGE_PROTOCOL_VERSION
  ])
}).passthrough();
var initializeResultSchema = z27.object({
  protocolVersion: z27.number().int().positive(),
  capabilities: z27.preprocess(
    (value) => value ?? {},
    bridgeCapabilitiesSchema
  )
}).passthrough();

// ../provider-bridge-protocol/src/execution-options.ts
import { z as z28 } from "zod";
var bridgeExecutionOptionsSchema = z28.object({
  model: z28.string().min(1).optional(),
  serviceTier: serviceTierSchema.optional(),
  reasoningLevel: reasoningLevelSchema.optional(),
  promptMode: promptModeSchema.optional(),
  sessionOptions: sessionOptionSelectionsSchema.optional(),
  instructions: z28.string().optional(),
  envVars: z28.record(z28.string(), z28.string()).optional(),
  providerOptions: z28.record(z28.string(), z28.unknown()).optional()
}).and(runtimePermissionPolicySchema);

// ../provider-bridge-protocol/src/provider-maintenance.ts
import { z as z29 } from "zod";
var providerMaintenanceParamsSchema = z29.object({
  providerId: z29.string().min(1),
  cwd: z29.string().min(1).optional(),
  providerOptions: z29.record(z29.string(), z29.unknown()).optional()
}).passthrough();
var providerInstallationRequirementSchema = z29.enum(["thread_rewind"]);
var providerInstallationStatusParamsSchema = providerMaintenanceParamsSchema.extend({
  requirement: providerInstallationRequirementSchema.optional(),
  checkUpdates: z29.boolean().default(true)
});
var providerHealthSchema = z29.object({
  status: z29.enum([
    "ready",
    "not_installed",
    "unauthenticated",
    "expired",
    "unsupported_version",
    "unknown"
  ]),
  statusMessage: z29.string().min(1).nullable(),
  accountEmail: z29.string().nullable(),
  planLabel: z29.string().min(1).nullable(),
  installedVersion: z29.string().min(1).nullable(),
  minimumSupportedVersion: z29.string().min(1).nullable(),
  canInstall: z29.boolean(),
  canUpdate: z29.boolean(),
  loginCommand: z29.string().min(1).nullable(),
  localLoginCommand: z29.string().min(1).nullable().optional(),
  internal_DO_NOT_USE_setupGuidePlanLabel: z29.string().min(1).nullable().optional()
}).passthrough();
var providerUsageWindowSchema = z29.object({
  label: z29.string().min(1),
  usedPercent: z29.number().min(0).max(100),
  resetsAt: z29.string().min(1).nullable(),
  cost: z29.object({
    usedUsdCents: z29.number().int().nonnegative(),
    limitUsdCents: z29.number().int().positive()
  }).optional()
}).passthrough();
var providerUsageSchema = z29.discriminatedUnion("status", [
  z29.object({
    status: z29.literal("ok"),
    accountEmail: z29.string().email().nullable(),
    planLabel: z29.string().min(1).nullable(),
    windows: z29.array(providerUsageWindowSchema)
  }).passthrough(),
  z29.object({ status: z29.literal("not_installed") }).passthrough(),
  z29.object({ status: z29.literal("unauthenticated") }).passthrough(),
  z29.object({ status: z29.literal("expired") }).passthrough(),
  z29.object({
    status: z29.literal("error"),
    message: z29.string().min(1),
    planLabel: z29.string().min(1).nullable().default(null),
    accountEmail: z29.string().nullable().default(null)
  }).passthrough()
]);
var providerHealthResultSchema = z29.discriminatedUnion("supported", [
  z29.object({ supported: z29.literal(false) }).passthrough(),
  z29.object({
    supported: z29.literal(true),
    health: providerHealthSchema
  }).passthrough()
]);
var providerUsageResultSchema = z29.discriminatedUnion("supported", [
  z29.object({ supported: z29.literal(false) }).passthrough(),
  z29.object({
    supported: z29.literal(true),
    usage: providerUsageSchema
  }).passthrough()
]);
var providerInstallationActionKindSchema = z29.enum([
  "install",
  "update"
]);
var providerInstallationActionSchema = z29.object({
  kind: providerInstallationActionKindSchema,
  label: z29.enum(["Install", "Update"]),
  command: z29.string().min(1)
}).passthrough();
var providerInstallationSourceSchema = z29.enum([
  "notInstalled",
  "npmGlobal",
  "external"
]);
var providerInstallationStatusSchema = z29.object({
  executableName: z29.string().min(1),
  executablePath: z29.string().min(1).nullable(),
  installed: z29.boolean(),
  installSource: providerInstallationSourceSchema,
  currentVersion: z29.string().min(1).nullable(),
  latestVersion: z29.string().min(1).nullable(),
  minimumSupportedVersion: z29.string().min(1).nullable(),
  npmPackageName: z29.string().min(1).nullable(),
  npmGlobalPackageVersion: z29.string().min(1).nullable(),
  installAction: providerInstallationActionSchema.nullable(),
  needsUpdate: z29.boolean(),
  versionUnsupported: z29.boolean()
}).passthrough();
var providerInstallationRunParamsSchema = providerMaintenanceParamsSchema.extend({
  action: providerInstallationActionKindSchema
});
var providerInstallationCommandSchema = z29.object({
  command: z29.string().min(1),
  args: z29.array(z29.string()).max(64),
  displayCommand: z29.string().min(1)
}).passthrough();
var providerInstallationVerificationSchema = z29.discriminatedUnion(
  "kind",
  [
    z29.object({ kind: z29.literal("installed") }).passthrough(),
    z29.object({
      kind: z29.literal("version_changed"),
      previousVersion: z29.string().min(1)
    }).passthrough(),
    z29.object({
      kind: z29.literal("version_at_least"),
      version: z29.string().min(1)
    }).passthrough()
  ]
);
var providerInstallationRunResultSchema = z29.discriminatedUnion(
  "available",
  [
    z29.object({
      available: z29.literal(false),
      message: z29.string().min(1)
    }).passthrough(),
    z29.object({
      available: z29.literal(true),
      command: providerInstallationCommandSchema,
      verification: providerInstallationVerificationSchema
    }).passthrough()
  ]
);

// ../provider-bridge-protocol/src/requests.ts
import { z as z30 } from "zod";
var BRIDGE_REQUEST_METHODS = {
  initialize: "initialize",
  modelList: "model/list",
  commandList: "commands/list",
  providerHealth: "provider/health",
  providerUsage: "provider/usage",
  providerInstallationStatus: "provider/installation/status",
  providerInstallationRun: "provider/installation/run",
  threadStart: "thread/start",
  threadResume: "thread/resume",
  threadFork: "thread/fork",
  threadStop: "thread/stop",
  threadDiscard: "thread/discard",
  threadNameSet: "thread/name/set",
  threadArchive: "thread/archive",
  threadUnarchive: "thread/unarchive",
  threadGoalClear: "thread/goal/clear",
  turnStart: "turn/start",
  turnSteer: "turn/steer",
  skillsConfigure: "skills/configure"
};
var sessionConstructionFields = {
  threadId: z30.string().min(1),
  cwd: z30.string().min(1),
  options: bridgeExecutionOptionsSchema,
  dynamicTools: z30.array(dynamicToolSchema).optional(),
  disallowedTools: z30.array(z30.string().min(1)).optional(),
  instructionMode: instructionModeSchema
};
var modelListParamsSchema = z30.object({
  cwd: z30.string().min(1).optional(),
  envVars: z30.record(z30.string(), z30.string()).optional(),
  selectedModel: z30.string().min(1).optional()
}).passthrough();
var commandListParamsSchema = z30.object({ cwd: z30.string().min(1) }).passthrough();
var threadStartParamsSchema = z30.object({
  ...sessionConstructionFields,
  input: z30.array(promptInputSchema).optional()
}).passthrough();
var threadResumeParamsSchema = z30.object({
  ...sessionConstructionFields,
  providerThreadId: z30.string().min(1)
}).passthrough();
var threadForkParamsSchema = z30.object({
  ...sessionConstructionFields,
  sourceProviderThreadId: z30.string().min(1),
  sourceProviderCheckpointId: z30.string().min(1).optional()
}).passthrough();
var threadStopParamsSchema = z30.object({
  threadId: z30.string().min(1),
  providerThreadId: z30.string().min(1),
  intent: z30.enum(["interrupt", "release"]),
  activeTurnId: z30.string().min(1).nullable()
}).passthrough();
var threadRefParams = z30.object({
  threadId: z30.string().min(1),
  providerThreadId: z30.string().min(1)
}).passthrough();
var threadNameSetParamsSchema = z30.object({
  threadId: z30.string().min(1),
  providerThreadId: z30.string().min(1),
  title: z30.string().min(1)
}).passthrough();
var turnInputFields = {
  threadId: z30.string().min(1),
  providerThreadId: z30.string().min(1),
  input: z30.array(promptInputSchema),
  clientRequestId: clientTurnRequestIdSchema,
  options: bridgeExecutionOptionsSchema
};
var turnStartParamsSchema = z30.object(turnInputFields).passthrough();
var turnSteerParamsSchema = z30.object({
  ...turnInputFields,
  expectedTurnId: z30.string().min(1)
}).passthrough();
var skillsConfigureRootSchema = z30.object({
  id: z30.string().min(1),
  path: z30.string().min(1),
  skills: z30.array(
    z30.object({
      name: z30.string().min(1),
      description: z30.string()
    }).passthrough()
  )
}).passthrough();
var skillsConfigureParamsSchema = z30.object({
  roots: z30.array(skillsConfigureRootSchema)
}).passthrough();
var threadIdentityResultSchema = z30.object({
  providerThreadId: z30.string().min(1),
  sessionRestorable: z30.boolean().optional()
}).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
import { z as z32 } from "zod";

// ../provider-bridge-protocol/src/errors.ts
import { z as z31 } from "zod";
var BRIDGE_JSON_RPC_ERRORS = {
  INVALID_PARAMS: -32602,
  METHOD_NOT_FOUND: -32601,
  BRIDGE_ERROR: -32e3,
  NO_ACTIVE_TURN: -32001,
  SESSION_NOT_RESTORABLE: -32002,
  FORK_CHECKPOINT_UNSUPPORTED: -32003,
  MISSING_EXECUTABLE: -32004
};
var providerRecoveryHintSchema = z31.object({
  kind: providerRecoveryKindSchema,
  message: z31.string().min(1),
  retryable: z31.boolean()
});
var bridgeErrorDataSchema = z31.object({ recovery: providerRecoveryHintSchema.optional() }).passthrough();

// ../provider-bridge-protocol/src/notifications.ts
var BRIDGE_NOTIFICATION_METHODS = {
  threadIdentity: "thread/identity",
  sessionReplaced: "session/replaced",
  providerRaw: "provider/raw",
  providerRecovery: "provider/recovery",
  error: "error"
};
var threadIdentityNotificationSchema = z32.object({
  threadId: z32.string().min(1),
  providerThreadId: z32.string().min(1),
  sessionRestorable: z32.boolean().optional()
}).passthrough();
var sessionReplacedNotificationSchema = z32.object({
  threadId: z32.string().min(1),
  providerThreadId: z32.string().min(1).nullable(),
  reason: z32.string().min(1),
  contextLost: z32.boolean().default(false),
  showRuntimeNote: z32.boolean().default(false)
}).passthrough();
var providerRecoveryNotificationSchema = z32.object({
  threadId: z32.string().min(1).optional(),
  ...providerRecoveryHintSchema.shape
}).passthrough();
var errorNotificationSchema = z32.object({
  threadId: z32.string().min(1).optional(),
  providerThreadId: z32.string().min(1).optional(),
  message: z32.string().min(1)
}).passthrough();

// ../provider-bridge-protocol/src/bridge-requests.ts
import { z as z33 } from "zod";
var toolCallRequestParamsSchema = z33.object({
  providerThreadId: z33.string().min(1),
  threadId: z33.string().min(1).optional(),
  turnId: z33.union([z33.string().min(1), z33.null()]),
  callId: z33.string().min(1),
  tool: z33.string().min(1),
  arguments: z33.unknown()
}).passthrough();
var toolCallResultSchema = z33.object({
  success: z33.boolean(),
  contentItems: z33.array(
    z33.discriminatedUnion("type", [
      z33.object({ type: z33.literal("inputText"), text: z33.string() }),
      z33.object({
        type: z33.literal("inputImage"),
        imageUrl: z33.string().min(1)
      })
    ])
  )
}).passthrough();
var interactionRequestParamsSchema = z33.object({
  providerThreadId: z33.string().min(1),
  threadId: z33.string().min(1).optional(),
  turnId: z33.union([z33.string().min(1), z33.null()]),
  payload: pendingInteractionPayloadSchema
}).passthrough();

// ../provider-bridge-protocol/src/thread-event-grammar.ts
var ITEM_STREAMING_EVENT_TYPES = /* @__PURE__ */ new Set([
  "item/agentMessage/delta",
  "item/plan/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/textDelta",
  "item/mcpToolCall/progress",
  "item/toolCall/progress"
]);
var MAX_ITEM_IDS_PER_THREAD = 512;
var THREAD_EVENT_GRAMMAR_RULES = {
  itemOpensBeforeDelta: "item/opens-before-delta",
  itemSettlesOnce: "item/settles-once",
  turnStartsOnce: "turn/starts-once",
  turnSettlesOnce: "turn/settles-once",
  turnKnown: "turn/known"
};
var OK = { kind: "ok" };
var ThreadEventGrammar = class {
  #byThreadId = /* @__PURE__ */ new Map();
  clear() {
    this.#byThreadId.clear();
  }
  clearThread(threadId) {
    this.#byThreadId.delete(threadId);
  }
  observe(event) {
    const state = this.#stateFor(event.threadId);
    switch (event.type) {
      case "turn/started": {
        const turnId = turnIdOf(event);
        if (turnId === void 0) {
          return OK;
        }
        if (state.completedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnStartsOnce,
            `turn/started for turn "${turnId}", which already completed`
          );
        }
        if (state.startedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnStartsOnce,
            `turn/started for turn "${turnId}", which is already open`
          );
        }
        state.startedTurnIds.add(turnId);
        return OK;
      }
      case "turn/completed": {
        const turnId = turnIdOf(event);
        if (turnId === void 0) {
          return OK;
        }
        if (state.completedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnSettlesOnce,
            `turn/completed for turn "${turnId}", which already completed`
          );
        }
        if (!state.startedTurnIds.has(turnId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.turnKnown,
            `turn/completed for turn "${turnId}", which never started`
          );
        }
        state.startedTurnIds.delete(turnId);
        state.completedTurnIds.add(turnId);
        return OK;
      }
      case "item/started": {
        state.openItemIds.add(event.item.id);
        state.settledItemIds.delete(event.item.id);
        trim(state.openItemIds);
        return OK;
      }
      case "item/completed":
      case "item/backgroundTask/completed":
      case "item/delegation/completed": {
        const itemId = event.item.id;
        if (state.settledItemIds.has(itemId)) {
          return violation(
            THREAD_EVENT_GRAMMAR_RULES.itemSettlesOnce,
            `${event.type} for item "${itemId}", which already settled`
          );
        }
        state.openItemIds.delete(itemId);
        state.settledItemIds.add(itemId);
        trim(state.settledItemIds);
        return OK;
      }
      case "item/backgroundTask/progress":
      case "item/delegation/progress": {
        return this.#checkOpenItem(state, event.type, event.item.id);
      }
      default: {
        if (!ITEM_STREAMING_EVENT_TYPES.has(event.type)) {
          return OK;
        }
        if (!("itemId" in event) || typeof event.itemId !== "string") {
          return OK;
        }
        return this.#checkOpenItem(state, event.type, event.itemId);
      }
    }
  }
  #checkOpenItem(state, eventType, itemId) {
    if (state.openItemIds.has(itemId)) {
      return OK;
    }
    return violation(
      THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta,
      `${eventType} for item "${itemId}" arrived before item/started`
    );
  }
  #stateFor(threadId) {
    const existing = this.#byThreadId.get(threadId);
    if (existing !== void 0) {
      return existing;
    }
    const created = {
      openItemIds: /* @__PURE__ */ new Set(),
      settledItemIds: /* @__PURE__ */ new Set(),
      startedTurnIds: /* @__PURE__ */ new Set(),
      completedTurnIds: /* @__PURE__ */ new Set()
    };
    this.#byThreadId.set(threadId, created);
    return created;
  }
};
function violation(rule, reason) {
  return { kind: "violation", rule, reason };
}
function turnIdOf(event) {
  return "scope" in event ? getThreadEventScopeTurnId(event.scope) : void 0;
}
function trim(itemIds) {
  while (itemIds.size > MAX_ITEM_IDS_PER_THREAD) {
    const oldest = itemIds.values().next();
    if (oldest.done === true) {
      return;
    }
    itemIds.delete(oldest.value);
  }
}

// ../provider-bridge-protocol/src/conformance/scenarios.ts
var IDENTITY_RESULT_SHAPE = "{ providerThreadId, sessionRestorable? }";
function identityProblem(parsed, result2) {
  return `the result must be ${IDENTITY_RESULT_SHAPE} \u2014 the runtime adopts no session without providerThreadId on the result (a thread/identity notification does not substitute for it); issues: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")} (got ${JSON.stringify(result2)})`;
}
var identityNotificationParamsSchema = z34.object({ threadId: z34.string(), providerThreadId: z34.string() }).passthrough();
async function checkIdentityAnnounced(context, args) {
  const { client } = context;
  const announced = await client.waitFor(() => {
    const notified = client.notifications(BRIDGE_NOTIFICATION_METHODS.threadIdentity).some((message) => {
      const params = identityNotificationParamsSchema.safeParse(
        message.params
      );
      return params.success && params.data.threadId === args.threadId && params.data.providerThreadId === args.providerThreadId;
    });
    const assembled = threadEvents(context, args.threadId).some(
      (event) => event.type === "thread/identity" && event.providerThreadId === args.providerThreadId
    );
    return notified || assembled ? true : void 0;
  });
  if (announced === null) {
    const named = client.notifications(BRIDGE_NOTIFICATION_METHODS.threadIdentity).flatMap((message) => {
      const params = identityNotificationParamsSchema.safeParse(
        message.params
      );
      return params.success && params.data.threadId === args.threadId ? [params.data.providerThreadId] : [];
    });
    return fail(
      args.id,
      args.title,
      `${args.request} returned providerThreadId "${args.providerThreadId}" for thread "${args.threadId}", but no thread/identity notification or thread.identity delta announced it${named.length === 0 ? "" : ` (thread/identity named ${named.map((id) => `"${id}"`).join(", ")})`}; bb persists and resumes only sessions announced this way, so every later send would start a new session`
    );
  }
  return pass(args.id, args.title);
}
function pass(id, title) {
  return { id, title, status: "pass", detail: "" };
}
function fail(id, title, detail) {
  return { id, title, status: "fail", detail };
}
function skipped(id, title, detail) {
  return { id, title, status: "skipped", detail };
}
function defaultOptions(fixture) {
  return fixture.options ?? {
    permissionMode: "full",
    permissionScope: "full",
    approvalReviewer: null,
    permissionEscalation: null
  };
}
function threadEvents(context, threadId) {
  context.client.drainIntoLog();
  return context.client.events.filter((entry) => entry.threadId === threadId).map((entry) => entry.event);
}
var persistedEventSchema = z34.preprocess(
  (event) => JSON.parse(JSON.stringify(event)),
  threadEventSchema
);
function errorCode(message) {
  const code = message?.error?.code;
  return typeof code === "number" ? code : void 0;
}
var ITEM_OPENS_BEFORE_DELTA_TITLE = "every item's first event is item/started";
function checkItemOpensBeforeDelta(events) {
  const grammar = new ThreadEventGrammar();
  for (const event of events) {
    const result2 = grammar.observe(event);
    if (result2.kind === "violation" && result2.rule === THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta) {
      return fail(
        THREAD_EVENT_GRAMMAR_RULES.itemOpensBeforeDelta,
        ITEM_OPENS_BEFORE_DELTA_TITLE,
        result2.reason
      );
    }
  }
  if (events.length === 0) {
    return skipped(
      "item/opens-before-delta",
      ITEM_OPENS_BEFORE_DELTA_TITLE,
      "no events to inspect"
    );
  }
  return pass("item/opens-before-delta", ITEM_OPENS_BEFORE_DELTA_TITLE);
}
var PRESENTATION_ICONS_DECLARED_ID = "presentation/icon-namespaced-declared";
var PRESENTATION_ICONS_DECLARED_TITLE = "every namespaced presentation glyph names one of the plugin's declared icons";
function checkPresentationIconsDeclared(events, icons) {
  const declared = new Set(icons.names);
  let inspected = 0;
  for (const event of events) {
    if (!isThreadEventWithItem(event)) {
      continue;
    }
    if (event.item.type === "toolCall" && event.item.server === "bb") {
      continue;
    }
    const glyph = "presentation" in event.item ? event.item.presentation?.icon.glyph : void 0;
    if (glyph === void 0) {
      continue;
    }
    inspected += 1;
    const parsed = parseNamespacedGlyph(glyph);
    if (parsed === null) {
      continue;
    }
    if (parsed.pluginId !== icons.pluginId || !declared.has(parsed.name)) {
      return fail(
        PRESENTATION_ICONS_DECLARED_ID,
        PRESENTATION_ICONS_DECLARED_TITLE,
        `${event.type} ${event.item.type} "${event.item.id}" names presentation.icon "${glyph}", which is not an icon declared by plugin "${icons.pluginId}" (declared: ${icons.names.length === 0 ? "none" : icons.names.join(", ")}); the server would persist it as provider/unhandled`
      );
    }
  }
  if (inspected === 0) {
    return skipped(
      PRESENTATION_ICONS_DECLARED_ID,
      PRESENTATION_ICONS_DECLARED_TITLE,
      "no item carried a presentation to inspect"
    );
  }
  return pass(
    PRESENTATION_ICONS_DECLARED_ID,
    PRESENTATION_ICONS_DECLARED_TITLE
  );
}
async function runRpcHygieneScenarios(client) {
  const results = [];
  let unknownMethodsAnswered = false;
  {
    const id = client.request("bb/conformance/definitely-unknown-method", {});
    const response = await client.waitForResponse(id);
    const title = "unknown method answers METHOD_NOT_FOUND";
    if (response === null) {
      results.push(
        fail("rpc/unknown-method", title, "request was silently dropped")
      );
    } else if (errorCode(response) === BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND) {
      unknownMethodsAnswered = true;
      results.push(pass("rpc/unknown-method", title));
    } else {
      unknownMethodsAnswered = true;
      results.push(
        fail(
          "rpc/unknown-method",
          title,
          `answered with ${JSON.stringify(response.error ?? response.result)}`
        )
      );
    }
  }
  {
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStop, {});
    const response = await client.waitForResponse(id);
    const title = "schema-invalid params answer INVALID_PARAMS, never dropped";
    if (response === null) {
      results.push(
        fail("rpc/invalid-params", title, "request was silently dropped")
      );
    } else if (errorCode(response) === BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS) {
      results.push(pass("rpc/invalid-params", title));
    } else {
      results.push(
        fail(
          "rpc/invalid-params",
          title,
          `answered with ${JSON.stringify(response.error ?? response.result)}`
        )
      );
    }
  }
  {
    const title = "a non-JSON line is ignored and the bridge stays alive";
    if (!unknownMethodsAnswered) {
      results.push(
        skipped(
          "rpc/non-json-ignored",
          title,
          "aliveness probe unavailable: bridge drops unknown methods"
        )
      );
    } else {
      client.sendRaw("this is { not json");
      const probe = client.request("bb/conformance/alive-probe", {});
      const response = await client.waitForResponse(probe);
      results.push(
        response === null ? fail("rpc/non-json-ignored", title, "bridge stopped answering") : pass("rpc/non-json-ignored", title)
      );
    }
  }
  {
    const title = "a response-shaped line is not treated as a request";
    if (!unknownMethodsAnswered) {
      results.push(
        skipped(
          "rpc/response-not-request",
          title,
          "aliveness probe unavailable: bridge drops unknown methods"
        )
      );
    } else {
      client.sendRaw(
        JSON.stringify({ jsonrpc: "2.0", id: 999999, result: {} })
      );
      const probe = client.request("bb/conformance/alive-probe", {});
      const response = await client.waitForResponse(probe);
      const echoed = client.responsesFor(999999).some((message) => message.error !== void 0);
      if (response === null) {
        results.push(
          fail("rpc/response-not-request", title, "bridge stopped answering")
        );
      } else if (echoed) {
        results.push(
          fail(
            "rpc/response-not-request",
            title,
            "bridge answered an unsolicited response with an error"
          )
        );
      } else {
        results.push(pass("rpc/response-not-request", title));
      }
    }
  }
  return results;
}
async function runHandshakeScenario(client, fixture) {
  const id = client.request(BRIDGE_REQUEST_METHODS.initialize, {
    protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
    client: { name: "bb-conformance", version: "0.0.1" },
    grammarVersions: ASSEMBLER_GRAMMAR_VERSIONS
  });
  const response = await client.waitForResponse(id);
  const title = "initialize answers a versioned handshake with capabilities";
  const failed = (detail) => ({
    results: [fail("handshake/initialize", title, detail)],
    capabilities: null
  });
  if (response === null) {
    return failed("no response");
  }
  const parsed = initializeResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return failed(
      `result did not parse: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join(
        "; "
      )} (got ${JSON.stringify(response.result ?? response.error)})`
    );
  }
  if (parsed.data.protocolVersion !== PROVIDER_BRIDGE_PROTOCOL_VERSION) {
    return failed(
      `bridge answered protocol version ${parsed.data.protocolVersion}; this kit (and the runtime) require ${PROVIDER_BRIDGE_PROTOCOL_VERSION}`
    );
  }
  const [bridgeMin, bridgeMax] = parsed.data.capabilities.grammarVersions;
  if (negotiateGrammarVersion(
    ASSEMBLER_GRAMMAR_VERSIONS,
    parsed.data.capabilities.grammarVersions
  ) === null) {
    const [runtimeMin, runtimeMax] = ASSEMBLER_GRAMMAR_VERSIONS;
    return failed(
      `bridge reported grammarVersions [${bridgeMin}, ${bridgeMax}]; the runtime's assembler speaks [${runtimeMin}, ${runtimeMax}], so the handshake would be refused`
    );
  }
  return {
    results: [
      pass("handshake/initialize", title),
      ...await runDeclaredRequestScenario(client, {
        id: "skills/configure-declared",
        method: BRIDGE_REQUEST_METHODS.skillsConfigure,
        params: { roots: [] },
        capability: "skills.configure",
        declared: parsed.data.capabilities.skills.configure
      }),
      ...await runDeclaredRequestScenario(client, {
        id: "commands/list-declared",
        method: BRIDGE_REQUEST_METHODS.commandList,
        params: { cwd: fixture.cwd },
        capability: "commands.list",
        declared: parsed.data.capabilities.commands.list
      })
    ],
    capabilities: parsed.data.capabilities
  };
}
async function runDeclaredRequestScenario(client, args) {
  const title = `${args.method} is handled iff the handshake declares ${args.capability}`;
  const id = client.request(args.method, args.params);
  const response = await client.waitForResponse(id);
  if (response === null) {
    return [fail(args.id, title, `${args.method} was not answered`)];
  }
  if (args.declared) {
    return response.error === void 0 ? [pass(args.id, title)] : [
      fail(
        args.id,
        title,
        `the handshake declares ${args.capability} but the request failed: ${JSON.stringify(response.error)}`
      )
    ];
  }
  return errorCode(response) === BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND ? [pass(args.id, title)] : [
    fail(
      args.id,
      title,
      `the handshake does not declare ${args.capability}, yet the bridge answered the request with ${JSON.stringify(response.error ?? response.result)}; declare it (the runtime never sends an undeclared request)`
    )
  ];
}
var START_IDENTITY_ANNOUNCED_ID = "session/start-identity-announced";
var START_IDENTITY_ANNOUNCED_TITLE = "thread/start announces the returned session through thread/identity";
async function runSessionLifecycleScenarios(context) {
  const { client, fixture } = context;
  const results = [];
  const threadId = "thr_conformance_1";
  {
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStart, {
      threadId,
      cwd: fixture.cwd,
      options: defaultOptions(fixture),
      instructionMode: "append"
    });
    const response = await client.waitForResponse(id);
    const title = "thread/start returns a provider thread identity";
    if (response === null) {
      results.push(fail("session/start-identity", title, "no response"));
    } else if (response.error !== void 0) {
      results.push(
        fail(
          "session/start-identity",
          title,
          `error: ${JSON.stringify(response.error)}`
        )
      );
    } else {
      const parsed = threadIdentityResultSchema.safeParse(response.result);
      if (!parsed.success) {
        results.push(
          fail(
            "session/start-identity",
            title,
            identityProblem(parsed, response.result)
          )
        );
      } else {
        context.providerThreadId = parsed.data.providerThreadId;
        results.push(pass("session/start-identity", title));
      }
    }
  }
  const startSkipDetail = "prerequisite session/start-identity failed";
  results.push(
    context.providerThreadId === void 0 ? skipped(
      START_IDENTITY_ANNOUNCED_ID,
      START_IDENTITY_ANNOUNCED_TITLE,
      startSkipDetail
    ) : await checkIdentityAnnounced(context, {
      id: START_IDENTITY_ANNOUNCED_ID,
      providerThreadId: context.providerThreadId,
      request: "thread/start",
      threadId,
      title: START_IDENTITY_ANNOUNCED_TITLE
    })
  );
  if (context.providerThreadId === void 0) {
    results.push(
      skipped(
        "turn/lifecycle",
        "an accepted turn starts and settles",
        startSkipDetail
      ),
      skipped(
        "events/schema-valid",
        "every assembled event is a valid ThreadEvent",
        startSkipDetail
      ),
      skipped(
        "item/opens-before-delta",
        "every item's first event is item/started",
        startSkipDetail
      )
    );
  } else {
    const id = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
      threadId,
      providerThreadId: context.providerThreadId,
      input: fixture.promptInput,
      clientRequestId: nextConformanceClientRequestId(),
      options: defaultOptions(fixture)
    });
    const started = await client.waitFor(
      () => threadEvents(context, threadId).find(
        (event) => event.type === "turn/started"
      )
    );
    const completed = await client.waitFor(
      () => threadEvents(context, threadId).find(
        (event) => event.type === "turn/completed"
      )
    );
    await client.waitForResponse(id);
    const title = "an accepted turn starts and settles";
    if (started === void 0 || started === null) {
      results.push(
        fail("turn/lifecycle", title, "no turn/started event arrived")
      );
    } else if (completed === void 0 || completed === null) {
      results.push(
        fail("turn/lifecycle", title, "turn never settled (no turn/completed)")
      );
    } else {
      results.push(pass("turn/lifecycle", title));
    }
    {
      client.drainIntoLog();
      const invalid = client.events.filter(
        (entry) => !persistedEventSchema.safeParse(entry.event).success
      );
      const title2 = "every assembled event is a valid ThreadEvent";
      results.push(
        invalid.length === 0 ? pass("events/schema-valid", title2) : fail(
          "events/schema-valid",
          title2,
          `${invalid.length} assembled event(s) failed validation; first: ${JSON.stringify(invalid[0]?.event).slice(0, 400)}`
        )
      );
    }
    results.push(checkItemOpensBeforeDelta(threadEvents(context, threadId)));
    if (fixture.icons !== void 0) {
      results.push(
        checkPresentationIconsDeclared(
          threadEvents(context, threadId),
          fixture.icons
        )
      );
    }
  }
  if (context.providerThreadId === void 0) {
    results.push(
      skipped(
        "stop/release-not-interrupted",
        "a release stop never fabricates an interruption",
        startSkipDetail
      )
    );
  } else {
    const before = threadEvents(context, threadId).length;
    const id = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
      threadId,
      providerThreadId: context.providerThreadId,
      intent: "release",
      activeTurnId: null
    });
    const response = await client.waitForResponse(id);
    await client.settle(150);
    const after = threadEvents(context, threadId).slice(before);
    const fabricated = after.find(
      (event) => event.type === "system/thread/interrupted" || event.type === "turn/completed" && event.status === "interrupted"
    );
    const title = "a release stop never fabricates an interruption";
    if (response === null) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          "no response to thread/stop"
        )
      );
    } else if (response.error !== void 0) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          `error: ${JSON.stringify(response.error)}`
        )
      );
    } else if (fabricated !== void 0) {
      results.push(
        fail(
          "stop/release-not-interrupted",
          title,
          `release emitted ${fabricated.type}`
        )
      );
    } else {
      results.push(pass("stop/release-not-interrupted", title));
    }
  }
  const uniquenessTitle = "turn and item ids never repeat across a resume";
  if (context.providerThreadId === void 0) {
    results.push(
      skipped(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE, startSkipDetail),
      skipped("session/resume-id-uniqueness", uniquenessTitle, startSkipDetail)
    );
  } else {
    const resumeId = client.request(BRIDGE_REQUEST_METHODS.threadResume, {
      threadId,
      cwd: fixture.cwd,
      providerThreadId: context.providerThreadId,
      options: defaultOptions(fixture),
      instructionMode: "append"
    });
    const resumeResponse = await client.waitForResponse(resumeId);
    const title = uniquenessTitle;
    const resumed = resumeResponse === null || resumeResponse.error !== void 0 ? null : threadIdentityResultSchema.safeParse(resumeResponse.result);
    if (resumed === null) {
      const detail = resumeResponse === null ? "thread/resume was not answered" : `thread/resume failed: ${JSON.stringify(resumeResponse.error)}`;
      results.push(
        skipped(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE, detail),
        skipped("session/resume-id-uniqueness", title, detail)
      );
    } else if (!resumed.success) {
      results.push(
        fail(
          RESUME_IDENTITY_ID,
          RESUME_IDENTITY_TITLE,
          identityProblem(resumed, resumeResponse?.result)
        ),
        skipped(
          "session/resume-id-uniqueness",
          title,
          "prerequisite session/resume-identity failed"
        )
      );
    } else {
      context.providerThreadId = resumed.data.providerThreadId;
      results.push(pass(RESUME_IDENTITY_ID, RESUME_IDENTITY_TITLE));
      const turnId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
        threadId,
        providerThreadId: context.providerThreadId,
        input: fixture.promptInput,
        clientRequestId: nextConformanceClientRequestId(),
        options: defaultOptions(fixture)
      });
      const secondCompleted = await client.waitFor(() => {
        const completions = threadEvents(context, threadId).filter(
          (event) => event.type === "turn/completed"
        );
        return completions.length >= 2 ? completions[1] : void 0;
      });
      await client.waitForResponse(turnId);
      if (secondCompleted === null) {
        results.push(
          fail(
            "session/resume-id-uniqueness",
            title,
            "the post-resume turn never settled"
          )
        );
      } else {
        const events = threadEvents(context, threadId);
        const turnIds = [];
        const itemIds = [];
        for (const event of events) {
          if (event.type === "turn/started" && event.scope.kind === "turn") {
            turnIds.push(event.scope.turnId);
          }
          if (event.type === "item/started") {
            itemIds.push(event.item.id);
          }
        }
        const duplicateTurn = turnIds.find(
          (value, index) => turnIds.indexOf(value) !== index
        );
        const duplicateItem = itemIds.find(
          (value, index) => itemIds.indexOf(value) !== index
        );
        if (duplicateTurn !== void 0 || duplicateItem !== void 0) {
          results.push(
            fail(
              "session/resume-id-uniqueness",
              title,
              duplicateTurn !== void 0 ? `turn id reused across resume: ${duplicateTurn}` : `item id reused across resume: ${String(duplicateItem)}`
            )
          );
        } else if (turnIds.length < 2) {
          results.push(
            fail(
              "session/resume-id-uniqueness",
              title,
              `expected two turns, saw ${turnIds.length}`
            )
          );
        } else {
          results.push(pass("session/resume-id-uniqueness", title));
        }
      }
    }
  }
  results.push(...await runForkIdentityScenario(context, threadId));
  results.push(...await runZeroWorkTurnScenario(context, threadId));
  results.push(...await runArchivedResumeRecoveryScenario(context, threadId));
  results.push(...await runThreadsIndependentScenario(context, threadId));
  results.push(...await runInterruptStopScenario(context, threadId));
  if (context.providerThreadId !== void 0) {
    const releaseId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
      threadId,
      providerThreadId: context.providerThreadId,
      intent: "release",
      activeTurnId: null
    });
    await client.waitForResponse(releaseId);
  }
  return results;
}
var RESUME_IDENTITY_ID = "session/resume-identity";
var RESUME_IDENTITY_TITLE = "thread/resume returns a provider thread identity";
var FORK_IDENTITY_ID = "session/fork-identity";
var FORK_IDENTITY_ANNOUNCED_ID = "session/fork-identity-announced";
var FORK_IDENTITY_ANNOUNCED_TITLE = "thread/fork announces the forked session through thread/identity";
var FORK_IDENTITY_TITLE = "thread/fork returns a provider thread identity for the forked session";
async function runForkIdentityScenario(context, threadId) {
  const { client, fixture } = context;
  if (context.fork === "none") {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const forkThreadId = `${threadId}_fork`;
  const forkId = client.request(BRIDGE_REQUEST_METHODS.threadFork, {
    threadId: forkThreadId,
    cwd: fixture.cwd,
    sourceProviderThreadId: context.providerThreadId,
    options: defaultOptions(fixture),
    instructionMode: "append"
  });
  const response = await client.waitForResponse(forkId);
  if (response === null) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        "thread/fork was not answered"
      )
    ];
  }
  if (response.error !== void 0) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        `the handshake declares fork "${context.fork}", yet forking the lifecycle session at its tip failed: ${JSON.stringify(response.error)}`
      )
    ];
  }
  const parsed = threadIdentityResultSchema.safeParse(response.result);
  if (!parsed.success) {
    return [
      fail(
        FORK_IDENTITY_ID,
        FORK_IDENTITY_TITLE,
        identityProblem(parsed, response.result)
      )
    ];
  }
  const announced = await checkIdentityAnnounced(context, {
    id: FORK_IDENTITY_ANNOUNCED_ID,
    providerThreadId: parsed.data.providerThreadId,
    request: "thread/fork",
    threadId: forkThreadId,
    title: FORK_IDENTITY_ANNOUNCED_TITLE
  });
  const releaseId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId: forkThreadId,
    providerThreadId: parsed.data.providerThreadId,
    intent: "release",
    activeTurnId: null
  });
  await client.waitForResponse(releaseId);
  return [pass(FORK_IDENTITY_ID, FORK_IDENTITY_TITLE), announced];
}
var THREADS_INDEPENDENT_ID = "session/threads-independent";
var THREADS_INDEPENDENT_TITLE = "requests on different threads are independent";
async function runThreadsIndependentScenario(context, threadId) {
  const { client, fixture } = context;
  const interruptiblePromptInput = fixture.interruptiblePromptInput;
  if (interruptiblePromptInput === void 0) {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const startedBefore = threadEvents(context, threadId).filter(
    (event) => event.type === "turn/started"
  ).length;
  const holdId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId,
    providerThreadId: context.providerThreadId,
    input: interruptiblePromptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture)
  });
  const held = await client.waitFor(() => {
    const starts = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/started"
    );
    return starts.length > startedBefore ? starts[startedBefore] : void 0;
  });
  await client.waitForResponse(holdId);
  if (held === null) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the interruptible prompt never opened a turn"
      )
    ];
  }
  const otherThreadId = `${threadId}_other`;
  const startId = client.request(BRIDGE_REQUEST_METHODS.threadStart, {
    threadId: otherThreadId,
    cwd: fixture.cwd,
    options: defaultOptions(fixture),
    instructionMode: "append"
  });
  const startResponse = await client.waitForResponse(startId);
  const startResult = threadIdentityResultSchema.safeParse(
    startResponse?.result
  );
  if (startResponse === null || !startResult.success) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        `the second thread did not start while the first held a turn: ${JSON.stringify(startResponse?.error ?? startResponse?.result)}`
      )
    ];
  }
  const turnId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId: otherThreadId,
    providerThreadId: startResult.data.providerThreadId,
    input: fixture.promptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture)
  });
  const completed = await client.waitFor(
    () => threadEvents(context, otherThreadId).find(
      (event) => event.type === "turn/completed"
    )
  );
  await client.waitForResponse(turnId);
  const stopId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId: otherThreadId,
    providerThreadId: startResult.data.providerThreadId,
    intent: "release",
    activeTurnId: null
  });
  await client.waitForResponse(stopId);
  if (completed === null) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the second thread's turn never completed while the first thread held a turn"
      )
    ];
  }
  const firstStillOpen = !threadEvents(context, threadId).some(
    (event) => event.type === "turn/completed" && getThreadEventScopeTurnId(event.scope) === getThreadEventScopeTurnId(held.scope)
  );
  if (!firstStillOpen) {
    return [
      fail(
        THREADS_INDEPENDENT_ID,
        THREADS_INDEPENDENT_TITLE,
        "the held turn on the first thread settled while the second thread ran"
      )
    ];
  }
  return [pass(THREADS_INDEPENDENT_ID, THREADS_INDEPENDENT_TITLE)];
}
var INTERRUPT_SETTLES_ID = "stop/interrupt-settles-before-result";
var INTERRUPT_SETTLES_TITLE = "thread/stop {interrupt} settles the turn before it is answered";
async function runInterruptStopScenario(context, threadId) {
  const { client, fixture } = context;
  const interruptiblePromptInput = fixture.interruptiblePromptInput;
  if (interruptiblePromptInput === void 0) {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  let started = openTurnStart(context, threadId);
  if (started === void 0) {
    const startedBefore = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/started"
    ).length;
    const turnRequestId = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
      threadId,
      providerThreadId: context.providerThreadId,
      input: interruptiblePromptInput,
      clientRequestId: nextConformanceClientRequestId(),
      options: defaultOptions(fixture)
    });
    started = await client.waitFor(() => {
      const starts = threadEvents(context, threadId).filter(
        (event) => event.type === "turn/started"
      );
      return starts.length > startedBefore ? starts[startedBefore] : void 0;
    }) ?? void 0;
    await client.waitForResponse(turnRequestId);
  }
  if (started === void 0 || started.scope.kind !== "turn") {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "the interruptible prompt never opened a turn"
      )
    ];
  }
  const bbTurnId = started.scope.turnId;
  const providerTurnId = context.resolveProviderTurnId(threadId, bbTurnId) ?? bbTurnId;
  const stopId = client.request(BRIDGE_REQUEST_METHODS.threadStop, {
    threadId,
    providerThreadId: context.providerThreadId,
    intent: "interrupt",
    activeTurnId: providerTurnId
  });
  const stopResponse = await client.waitForResponse(stopId);
  if (stopResponse === null) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "thread/stop was not answered"
      )
    ];
  }
  if (stopResponse.error !== void 0) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        `thread/stop failed: ${JSON.stringify(stopResponse.error)}`
      )
    ];
  }
  const responseIndex = client.log.indexOf(stopResponse);
  const completedIndex = client.events.find(
    (entry) => entry.threadId === threadId && entry.event.type === "turn/completed" && getThreadEventScopeTurnId(entry.event.scope) === bbTurnId
  )?.logIndex ?? -1;
  if (completedIndex === -1) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "the interrupted turn never reached turn/completed"
      )
    ];
  }
  if (completedIndex > responseIndex) {
    return [
      fail(
        INTERRUPT_SETTLES_ID,
        INTERRUPT_SETTLES_TITLE,
        "turn/completed arrived after the thread/stop response; the runtime had already detached the thread"
      )
    ];
  }
  return [pass(INTERRUPT_SETTLES_ID, INTERRUPT_SETTLES_TITLE)];
}
var SESSION_ARCHIVED_RECOVERY_ID = "recovery/session-archived";
var SESSION_ARCHIVED_RECOVERY_TITLE = "resuming an archived session is rejected with a sessionArchived hint";
async function runArchivedResumeRecoveryScenario(context, threadId) {
  const { client, fixture } = context;
  const providerThreadId = context.providerThreadId;
  if (providerThreadId === void 0) {
    return [
      skipped(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const archiveId = client.request(BRIDGE_REQUEST_METHODS.threadArchive, {
    threadId,
    providerThreadId
  });
  const archiveResponse = await client.waitForResponse(archiveId);
  if (archiveResponse === null) {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "thread/archive was not answered"
      )
    ];
  }
  if (archiveResponse.error !== void 0) {
    return [];
  }
  const resumeParams = {
    threadId,
    cwd: fixture.cwd,
    providerThreadId,
    options: defaultOptions(fixture),
    instructionMode: "append"
  };
  const resumeId = client.request(
    BRIDGE_REQUEST_METHODS.threadResume,
    resumeParams
  );
  const resumeResponse = await client.waitForResponse(resumeId);
  const unarchiveId = client.request(BRIDGE_REQUEST_METHODS.threadUnarchive, {
    threadId,
    providerThreadId
  });
  await client.waitForResponse(unarchiveId);
  if (resumeResponse === null) {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        "thread/resume of the archived session was not answered"
      )
    ];
  }
  if (resumeResponse.error === void 0) {
    const resumed = threadIdentityResultSchema.safeParse(resumeResponse.result);
    if (!resumed.success) {
      return [
        fail(
          SESSION_ARCHIVED_RECOVERY_ID,
          SESSION_ARCHIVED_RECOVERY_TITLE,
          `the archived session was resumed with a result the runtime cannot adopt: ${identityProblem(resumed, resumeResponse.result)}`
        )
      ];
    }
    context.providerThreadId = resumed.data.providerThreadId;
    return [];
  }
  const reResumeId = client.request(
    BRIDGE_REQUEST_METHODS.threadResume,
    resumeParams
  );
  const reResumeResponse = await client.waitForResponse(reResumeId);
  const data = bridgeErrorDataSchema.safeParse(resumeResponse.error.data);
  const kind = data.success ? data.data.recovery?.kind : void 0;
  if (kind !== "sessionArchived") {
    return [
      fail(
        SESSION_ARCHIVED_RECOVERY_ID,
        SESSION_ARCHIVED_RECOVERY_TITLE,
        `the rejection carried ${kind === void 0 ? "no recovery hint" : `kind "${kind}"`}: ${JSON.stringify(resumeResponse.error)}`
      )
    ];
  }
  const notBack = (detail) => [
    fail(
      SESSION_ARCHIVED_RECOVERY_ID,
      SESSION_ARCHIVED_RECOVERY_TITLE,
      `the session did not come back: ${detail}`
    )
  ];
  if (reResumeResponse === null) {
    return notBack("thread/resume after thread/unarchive was not answered");
  }
  if (reResumeResponse.error !== void 0) {
    return notBack(
      `thread/resume after thread/unarchive failed: ${JSON.stringify(reResumeResponse.error)}`
    );
  }
  const reResumed = threadIdentityResultSchema.safeParse(
    reResumeResponse.result
  );
  if (!reResumed.success) {
    return notBack(identityProblem(reResumed, reResumeResponse.result));
  }
  context.providerThreadId = reResumed.data.providerThreadId;
  return [pass(SESSION_ARCHIVED_RECOVERY_ID, SESSION_ARCHIVED_RECOVERY_TITLE)];
}
var SETTLES_WITHOUT_ACTIVITY_ID = "turn/settles-without-activity";
var SETTLES_WITHOUT_ACTIVITY_TITLE = "a turn the provider completes without activity still settles";
async function runZeroWorkTurnScenario(context, threadId) {
  const { client, fixture } = context;
  const zeroWorkPromptInput = fixture.zeroWorkPromptInput;
  if (zeroWorkPromptInput === void 0) {
    return [];
  }
  if (context.providerThreadId === void 0) {
    return [
      skipped(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        "prerequisite session/start-identity failed"
      )
    ];
  }
  const before = threadEvents(context, threadId).filter(
    (event) => event.type === "turn/completed"
  ).length;
  const id = client.request(BRIDGE_REQUEST_METHODS.turnStart, {
    threadId,
    providerThreadId: context.providerThreadId,
    input: zeroWorkPromptInput,
    clientRequestId: nextConformanceClientRequestId(),
    options: defaultOptions(fixture)
  });
  const settled = await client.waitFor(() => {
    const completions = threadEvents(context, threadId).filter(
      (event) => event.type === "turn/completed"
    );
    return completions.length > before ? completions[before] : void 0;
  });
  const response = await client.waitForResponse(id);
  if (response !== null && response.error !== void 0) {
    return [
      skipped(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        `the zero-work prompt was rejected: ${JSON.stringify(response.error)}`
      )
    ];
  }
  if (settled === null) {
    return [
      fail(
        SETTLES_WITHOUT_ACTIVITY_ID,
        SETTLES_WITHOUT_ACTIVITY_TITLE,
        "the accepted zero-work turn never emitted a terminal turn/completed"
      )
    ];
  }
  return [pass(SETTLES_WITHOUT_ACTIVITY_ID, SETTLES_WITHOUT_ACTIVITY_TITLE)];
}
function openTurnStart(context, threadId) {
  const events = threadEvents(context, threadId);
  const completedTurnIds = new Set(
    events.filter((event) => event.type === "turn/completed").map((event) => getThreadEventScopeTurnId(event.scope))
  );
  return [...events].reverse().find(
    (event) => event.type === "turn/started" && !completedTurnIds.has(getThreadEventScopeTurnId(event.scope))
  );
}

// ../provider-bridge-protocol/src/conformance/recorded.ts
var RECORDED_CONFORMANCE_CELLS = [
  "turn-tools",
  "steer",
  "stop-interrupt",
  "approval-allow",
  "approval-deny",
  "user-question",
  "resume",
  "fork"
];
function result(id, title, detail) {
  return detail === null ? { id, title, status: "pass", detail: "" } : { id, title, status: "fail", detail };
}
function countTurns(events) {
  let started = 0;
  let completed = 0;
  for (const event of events) {
    if (event.type === "turn/started") started += 1;
    if (event.type === "turn/completed") completed += 1;
  }
  return { started, completed };
}
function checkRecordedCellReplay(replay) {
  const prefix = `recorded/${replay.cell}`;
  const results = [];
  const recordedTurns = countTurns(replay.recordedEvents);
  const liveTurns = countTurns(replay.events);
  results.push(
    result(
      `${prefix}/replays`,
      "the bridge answers every recorded runtime request and the replay needs no help",
      replay.stalls.length === 0 ? null : replay.stalls.join("; ")
    )
  );
  results.push(
    result(
      `${prefix}/events-schema-valid`,
      "every assembled event is a valid ThreadEvent",
      (() => {
        for (const [index, event] of replay.events.entries()) {
          const parsed = threadEventSchema.safeParse(event);
          if (!parsed.success) {
            return `event ${index} (${event.type}) failed: ${parsed.error.issues[0]?.message ?? "invalid"}`;
          }
        }
        return null;
      })()
    )
  );
  results.push(
    result(
      `${prefix}/grammar`,
      "the event stream breaks no thread-event grammar rule",
      (() => {
        const grammar = new ThreadEventGrammar();
        for (const event of replay.events) {
          const verdict = grammar.observe(event);
          if (verdict.kind === "violation") {
            return `${verdict.rule} on ${event.type}: ${verdict.reason}`;
          }
        }
        return null;
      })()
    )
  );
  results.push(
    result(
      `${prefix}/turn-lifecycle`,
      "the replay opens and settles as many turns as the recording did",
      liveTurns.started === recordedTurns.started && liveTurns.completed === recordedTurns.completed && liveTurns.started === liveTurns.completed ? null : `replay ${liveTurns.started} started/${liveTurns.completed} completed, recording ${recordedTurns.started}/${recordedTurns.completed}`
    )
  );
  results.push(
    result(
      `${prefix}/not-empty`,
      "a recorded session that produced events still does",
      replay.recordedEvents.length === 0 || replay.events.length > 0 ? null : `the recording assembled ${replay.recordedEvents.length} events, the replay none`
    )
  );
  return results;
}

// ../provider-bridge-protocol/src/conformance/types.ts
var CONFORMANCE_ASSEMBLED_EVENT_METHOD = "conformance/assembledEvent";
function reportPassed(results) {
  return results.every((result2) => result2.status === "pass");
}

// ../provider-bridge-protocol/src/conformance/index.ts
async function runBridgeConformance(options) {
  const collector = createBridgeDeltaEventCollector(options.providerId);
  const client = new ConformanceClient(
    options.transport,
    options.timeoutMs ?? 5e3,
    collector
  );
  const results = [];
  results.push(...await runRpcHygieneScenarios(client));
  const handshake = await runHandshakeScenario(client, options.session);
  results.push(...handshake.results);
  results.push(
    ...await runSessionLifecycleScenarios({
      client,
      fixture: options.session,
      resolveProviderTurnId: (threadId, bbTurnId) => collector.assembler.getProviderTurnId(threadId, bbTurnId),
      fork: handshake.capabilities?.fork ?? "none"
    })
  );
  await options.transport.close?.();
  return { results, passed: reportPassed(results) };
}
function formatConformanceReport(report) {
  return report.results.map(
    (result2) => `${result2.status.padEnd(7)} ${result2.id}${result2.detail === "" ? "" : ` \u2014 ${result2.detail}`}`
  ).join("\n");
}

// ../provider-bridge-protocol/src/testing/bridge-json-rpc-test-helpers.ts
import { z as z35 } from "zod";
var bridgeJsonRpcValueSchema = z35.lazy(
  () => z35.union([
    z35.string(),
    z35.number(),
    z35.boolean(),
    z35.null(),
    z35.array(bridgeJsonRpcValueSchema),
    z35.record(z35.string(), bridgeJsonRpcValueSchema)
  ])
);
var bridgeJsonRpcOutputSchema = z35.object({
  jsonrpc: z35.literal("2.0"),
  id: z35.union([z35.string(), z35.number()]).optional(),
  method: z35.string().optional(),
  params: bridgeJsonRpcValueSchema.optional(),
  result: bridgeJsonRpcValueSchema.optional(),
  error: z35.object({
    code: z35.number(),
    message: z35.string(),
    data: bridgeJsonRpcValueSchema.optional()
  }).optional()
});
function waitForNextBridgeTick() {
  return new Promise((resolve3) => setTimeout(resolve3, 0));
}
function captureBridgeJsonRpcOutput() {
  const messages = [];
  const originalWrite = process.stdout.write;
  const capturingWrite = (buffer) => {
    const text = typeof buffer === "string" ? buffer : Buffer.from(buffer).toString("utf8");
    for (const line of text.split("\n")) {
      if (line.trim().length > 0) {
        messages.push(bridgeJsonRpcOutputSchema.parse(JSON.parse(line)));
      }
    }
    return true;
  };
  process.stdout.write = capturingWrite;
  let drained = 0;
  return {
    messages,
    takeMessages() {
      const fresh = messages.slice(drained);
      drained = messages.length;
      return fresh;
    },
    restore() {
      if (process.stdout.write === capturingWrite) {
        process.stdout.write = originalWrite;
      }
    }
  };
}
function sendBridgeJsonRpcRequest(args) {
  args.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: args.id,
      method: args.method,
      params: args.params
    })
  );
}
async function waitForBridgeJsonRpcResponse(args) {
  const deadline = Date.now() + 15e3;
  while (Date.now() < deadline) {
    const response = args.output.messages.find(
      (message) => message.id === args.id
    );
    if (response) {
      return response;
    }
    await waitForNextBridgeTick();
  }
  throw new Error(`Timed out waiting for JSON-RPC response ${String(args.id)}`);
}
function bridgeJsonRpcResponseExists(args) {
  return args.output.messages.some((message) => message.id === args.id);
}
function createBridgeJsonRpcTestHarness(handleLine) {
  const output = captureBridgeJsonRpcOutput();
  return {
    messages: output.messages,
    takeMessages: output.takeMessages,
    flushWork: waitForNextBridgeTick,
    hasResponse(id) {
      return bridgeJsonRpcResponseExists({ id, output });
    },
    restore() {
      output.restore();
    },
    sendRequest(id, method, params) {
      sendBridgeJsonRpcRequest({ handleLine, id, method, params });
    },
    waitForResponse(id) {
      return waitForBridgeJsonRpcResponse({ id, output });
    }
  };
}

// ../provider-bridge-protocol/src/testing/calibration-diff.ts
var DEFAULT_INTERNED_ID_FIELDS = [
  "turnId",
  "itemId",
  "id",
  "parentToolCallId"
];
var BLANKED_FIELDS = /* @__PURE__ */ new Set(["threadId", "providerThreadId"]);
var DROPPED_FIELDS = /* @__PURE__ */ new Set(["providerCheckpointId"]);
var IdInterner = class {
  assigned = /* @__PURE__ */ new Map();
  intern(value) {
    const existing = this.assigned.get(value);
    if (existing !== void 0) {
      return existing;
    }
    const token = `#${this.assigned.size + 1}`;
    this.assigned.set(value, token);
    return token;
  }
};
function normalizeValue(value, interner, idFields) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, interner, idFields));
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const normalized = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === void 0 || DROPPED_FIELDS.has(key)) {
      continue;
    }
    if (BLANKED_FIELDS.has(key)) {
      normalized[key] = entry === null ? null : "";
      continue;
    }
    if (idFields.has(key) && typeof entry === "string") {
      normalized[key] = interner.intern(entry);
      continue;
    }
    normalized[key] = normalizeValue(entry, interner, idFields);
  }
  return normalized;
}
function normalizeCalibrationEvents(events, options = {}) {
  const interner = new IdInterner();
  const idFields = new Set(
    options.internedIdFields ?? DEFAULT_INTERNED_ID_FIELDS
  );
  const wireShaped = JSON.parse(JSON.stringify(events));
  const list = Array.isArray(wireShaped) ? wireShaped : [];
  return list.map((event) => normalizeValue(event, interner, idFields));
}
function diffCalibrationStreams(legacy, bridge) {
  const left = legacy.map((event) => JSON.stringify(event));
  const right = bridge.map((event) => JSON.stringify(event));
  const lengths = Array.from(
    { length: left.length + 1 },
    () => new Array(right.length + 1).fill(0)
  );
  for (let i2 = left.length - 1; i2 >= 0; i2 -= 1) {
    for (let j2 = right.length - 1; j2 >= 0; j2 -= 1) {
      lengths[i2][j2] = left[i2] === right[j2] ? lengths[i2 + 1][j2 + 1] + 1 : Math.max(lengths[i2 + 1][j2], lengths[i2][j2 + 1]);
    }
  }
  const onlyInLegacy = [];
  const onlyInBridge = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      onlyInLegacy.push(legacy[i]);
      i += 1;
    } else {
      onlyInBridge.push(bridge[j]);
      j += 1;
    }
  }
  onlyInLegacy.push(...legacy.slice(i));
  onlyInBridge.push(...bridge.slice(j));
  return { onlyInLegacy, onlyInBridge };
}
function describeCalibrationEvents(events) {
  return events.map((event) => {
    if (event === null || typeof event !== "object") {
      return String(event);
    }
    const record = { ...event };
    const type = typeof record.type === "string" ? record.type : "?";
    const item = record.item;
    if (item !== null && typeof item === "object" && "type" in item) {
      return `${type}:${String(item.type)}`;
    }
    return type;
  });
}

// ../process-utils/src/host-process.ts
import parse from "cross-spawn/lib/parse.js";
import {
  spawn as nodeSpawn,
  fork as nodeFork,
  execFile as nodeExecFile
} from "node:child_process";
import crossSpawn from "cross-spawn";

// ../process-utils/src/host-toolchain.ts
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  realpathSync,
  statSync
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join
} from "node:path";
import { fileURLToPath } from "node:url";

// ../../node_modules/.pnpm/which-command@0.1.0/node_modules/which-command/index.js
import fs from "node:fs";
import path from "node:path";
import process2 from "node:process";
var isWindows = process2.platform === "win32";
var separatorPattern = isWindows ? new RegExp("[\\/\\\\]", "v") : new RegExp("\\/", "v");
var defaultPathExt = ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC";
function resolveOptions(command, options) {
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("Expected a non-empty string.");
  }
  const {
    cwd = process2.cwd(),
    // On Windows, `process.env.PATH` can be undefined in some contexts (for example, worker threads), where it's only exposed as `Path`.
    path: searchPath = process2.env.PATH ?? (isWindows ? process2.env.Path : void 0) ?? "",
    // `||` (not `??`) so an empty `PATHEXT` falls back to the default instead of disabling all lookup on Windows.
    pathExt = process2.env.PATHEXT || defaultPathExt
  } = options;
  return { cwd, searchPath, pathExt };
}
function windowsExtensions(command, pathExt) {
  const extensions = pathExt.split(path.delimiter).filter(Boolean);
  const commandExtension = path.extname(command).toLowerCase();
  if (commandExtension !== "" && extensions.some((extension) => extension.toLowerCase() === commandExtension)) {
    return ["", ...extensions];
  }
  return extensions;
}
function* candidatePaths(command, { cwd, searchPath, pathExt }) {
  const extensions = isWindows ? windowsExtensions(command, pathExt) : [""];
  if (separatorPattern.test(command)) {
    const base = path.resolve(cwd, command);
    for (const extension of extensions) {
      yield base + extension;
    }
    return;
  }
  const directories = [
    // Windows searches the current directory before `PATH`.
    ...isWindows ? [cwd] : [],
    ...searchPath.split(path.delimiter)
  ];
  for (const directory of directories) {
    const unquoted = isWindows && directory.length > 1 && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
    if (unquoted === "") {
      continue;
    }
    const base = path.resolve(cwd, unquoted, command);
    for (const extension of extensions) {
      yield base + extension;
    }
  }
}
function isExecutableSync(filePath) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch (error) {
    return isWindows && error.code === "EACCES";
  }
  if (!stats.isFile()) {
    return false;
  }
  if (isWindows) {
    return true;
  }
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function whichCommandSync(command, options = {}) {
  const resolved = resolveOptions(command, options);
  for (const candidate of candidatePaths(command, resolved)) {
    if (isExecutableSync(candidate)) {
      return candidate;
    }
  }
  return void 0;
}

// ../process-utils/src/node-network.ts
var NODE_NETWORK_FLAGS = {
  "--use-system-ca": "NODE_USE_SYSTEM_CA",
  "--use-env-proxy": "NODE_USE_ENV_PROXY"
};
var ENV_PROXY_FLAG = "--use-env-proxy";
var PROXY_KEYS = /* @__PURE__ */ new Set(["HTTP_PROXY", "HTTPS_PROXY"]);
var NO_PROXY_KEY = "NO_PROXY";
var LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1", "[::1]"];
function isNodeNetworkFlag(arg) {
  return Object.hasOwn(NODE_NETWORK_FLAGS, arg);
}
function isHttpProxyUrl(value) {
  if (/[\r\n]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
  } catch {
    return false;
  }
}
function proxyEntries(env) {
  return Object.entries(env).filter(
    (entry) => PROXY_KEYS.has(entry[0].toUpperCase()) && entry[1] !== void 0 && entry[1] !== ""
  );
}
function appendLoopback(value) {
  const entries = value.split(/[\s,]+/u).filter(Boolean);
  if (entries.includes("*")) return value;
  const present = new Set(entries.map((entry) => entry.toLowerCase()));
  return [
    ...entries,
    ...LOOPBACK_HOSTS.filter((host) => !present.has(host))
  ].join(",");
}
function withLoopbackNoProxy(env) {
  const result2 = { ...env };
  const keys = Object.keys(result2).filter(
    (key) => key.toUpperCase() === NO_PROXY_KEY && result2[key] !== void 0
  );
  for (const key of keys.length > 0 ? keys : [NO_PROXY_KEY])
    result2[key] = appendLoopback(result2[key] ?? "");
  return result2;
}
function nodeNetworkLaunch(nodeArgs, env) {
  const enabled = nodeArgs.filter(
    (arg) => !isNodeNetworkFlag(arg) || env[NODE_NETWORK_FLAGS[arg]] !== "0"
  );
  if (!enabled.includes(ENV_PROXY_FLAG))
    return { nodeArgs: enabled, env, rejectedProxyKeys: [] };
  const proxies = proxyEntries(env);
  const rejectedProxyKeys = proxies.filter(([, value]) => !isHttpProxyUrl(value)).map(([key]) => key);
  if (rejectedProxyKeys.length > 0)
    return {
      nodeArgs: enabled.filter((arg) => arg !== ENV_PROXY_FLAG),
      env,
      rejectedProxyKeys
    };
  return {
    nodeArgs: enabled,
    env: proxies.length > 0 ? withLoopbackNoProxy(env) : env,
    rejectedProxyKeys: []
  };
}
var warnedProxyKeys = /* @__PURE__ */ new Set();
function prepareNodeNetworkLaunch(nodeArgs, env) {
  const launch = nodeNetworkLaunch(nodeArgs, env);
  const unwarned = launch.rejectedProxyKeys.filter(
    (key) => !warnedProxyKeys.has(key)
  );
  if (unwarned.length > 0) {
    for (const key of unwarned) warnedProxyKeys.add(key);
    process.emitWarning(
      `bb started a Node process without --use-env-proxy because ${unwarned.join(", ")} is not an http:// or https:// URL. Add the scheme, for example http://proxy.example:3128, so bb uses the proxy.`,
      { code: "BB_INVALID_PROXY_ENV" }
    );
  }
  return { nodeArgs: launch.nodeArgs, env: launch.env };
}
function prepareNodeNetworkCommand(args, env) {
  const scriptIndex = args.findIndex(
    (arg) => arg === "--" || !arg.startsWith("-")
  );
  const optionCount = scriptIndex < 0 ? args.length : scriptIndex;
  const launch = prepareNodeNetworkLaunch(args.slice(0, optionCount), env);
  return {
    args: [...launch.nodeArgs, ...args.slice(optionCount)],
    env: launch.env
  };
}

// ../process-utils/src/host-toolchain.ts
var NETWORK_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR"
];
var SHELL_START = "__BB_SHELL_ENV_START__";
var SHELL_END = "__BB_SHELL_ENV_END__";
var PROBE_TIMEOUT_MS = 3e3;
var PROBE_OUTPUT_MAX_CHARS = 1024 * 1024;
function executable(file) {
  try {
    accessSync(
      file,
      process.platform === "win32" ? constants.F_OK : constants.X_OK
    );
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
function envValue(env, key) {
  if (process.platform !== "win32") return env[key];
  return env[Object.keys(env).find(
    (entry) => entry.toUpperCase() === key.toUpperCase()
  ) ?? key];
}
function mergePath(...paths) {
  const seen = /* @__PURE__ */ new Set();
  return paths.flatMap((value) => (value ?? "").split(delimiter)).filter((entry) => {
    if (!entry) return false;
    const key = process.platform === "win32" ? entry.replace(/[\\/]+$/u, "").toLowerCase() : entry;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(delimiter);
}
function onDiskName(file) {
  if (process.platform !== "win32") return file;
  try {
    const name = basename(file).toLowerCase();
    const entry = readdirSync(dirname(file)).find(
      (candidate) => candidate.toLowerCase() === name
    );
    return entry === void 0 ? file : join(dirname(file), entry);
  } catch {
    return file;
  }
}
function runProbe(command, args, env) {
  return new Promise((resolve3) => {
    let stdout = "";
    let settled = false;
    let timer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve3({ status, stdout });
    };
    let child;
    try {
      child = spawn(command, args, {
        cwd: homedir(),
        env,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true
      });
    } catch {
      finish(null);
      return;
    }
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, PROBE_TIMEOUT_MS);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < PROBE_OUTPUT_MAX_CHARS) stdout += chunk;
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => finish(code));
  });
}
async function readShellEnvironment(env, retainPrevious) {
  if (process.platform === "win32") {
    const registry2 = join(
      envValue(env, "SystemRoot") ?? "C:\\Windows",
      "System32",
      "reg.exe"
    );
    const values = { ...env };
    const paths = [];
    for (const key of [
      "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
      "HKCU\\Environment"
    ]) {
      const result2 = await runProbe(registry2, ["query", key], env);
      if (result2.status !== 0) continue;
      for (const match of result2.stdout.matchAll(
        /^ {4}(.+?) {4}REG_[A-Z_]+ {4}(.*)$/gmu
      )) {
        const name = match[1]?.trim();
        if (!name) continue;
        const value = (match[2] ?? "").trim();
        if (name.toUpperCase() === "PATH") paths.push(value);
        else {
          const existing = Object.keys(values).find(
            (key2) => key2.toUpperCase() === name.toUpperCase()
          );
          values[existing ?? name] = value;
        }
      }
    }
    const expand = (value) => {
      for (let depth = 0; depth < 10; depth += 1) {
        const expanded = value.replace(
          /%([^%;\\/]+)%/gu,
          (reference, variable) => envValue(values, variable) ?? reference
        );
        if (expanded === value) break;
        value = expanded;
      }
      return value;
    };
    return paths.length === 0 ? null : { PATH: mergePath(...paths.map(expand), envValue(env, "PATH")) };
  }
  const shell = env.SHELL?.trim() || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const command = `printf '%s\\n' ${SHELL_START}; /usr/bin/env; printf '%s\\n' ${SHELL_END}`;
  const shellArgs = ["sh", "dash"].includes(basename(shell)) ? ["-lc"] : ["-ilc", "-lc"];
  for (const arg of shellArgs) {
    const result2 = await runProbe(shell, [arg, command], env);
    if (result2.status !== 0) {
      if (retainPrevious) return null;
      continue;
    }
    const start = result2.stdout.indexOf(`${SHELL_START}
`);
    const end = result2.stdout.indexOf(`
${SHELL_END}`, start);
    if (start < 0 || end < 0) {
      if (retainPrevious) return null;
      continue;
    }
    const values = {};
    for (const line of result2.stdout.slice(start + SHELL_START.length + 1, end).split("\n")) {
      const separator = line.indexOf("=");
      const key = line.slice(0, separator);
      if (key === "PATH" || NETWORK_KEYS.includes(key))
        values[key] = line.slice(separator + 1);
    }
    if (values.PATH) return values;
  }
  return null;
}
var HostToolchain = class {
  constructor(baseEnv = process.env, runtimePath = process.execPath) {
    this.baseEnv = baseEnv;
    this.runtimePath = runtimePath;
    this.inheritedPath = envValue(baseEnv, "PATH");
    this.nodePath = runtimePath;
  }
  baseEnv;
  runtimePath;
  shellEnv = {};
  inheritedPath;
  misses = /* @__PURE__ */ new Set();
  nodePath;
  refreshing = null;
  refreshedAt = 0;
  refresh() {
    if (this.refreshing !== null) return this.refreshing;
    this.misses.clear();
    this.refreshedAt = Date.now();
    const retainPrevious = this.shellEnv.PATH !== void 0;
    this.refreshing = readShellEnvironment(this.baseEnv, retainPrevious).then((env) => {
      if (env !== null) this.shellEnv = env;
    }).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  invalidateFailure(errorOrCode) {
    const code = typeof errorOrCode === "object" && errorOrCode !== null && "code" in errorOrCode ? errorOrCode.code : errorOrCode;
    if (code === "ENOENT" || code === 127) void this.refresh();
  }
  searchPath(env) {
    const inherited = envValue(env, "PATH");
    const home = envValue(env, process.platform === "win32" ? "USERPROFILE" : "HOME") ?? homedir();
    const fallbacks = [
      join(home, ".local", "bin"),
      join(home, ".local", "share", "mise", "shims"),
      join(home, ".asdf", "shims"),
      join(home, ".asdf", "bin"),
      join(home, ".volta", "bin")
    ];
    if (process.platform === "darwin") fallbacks.push("/opt/homebrew/bin");
    if (process.platform !== "win32")
      fallbacks.push("/usr/local/bin", "/usr/bin", "/bin");
    const [first, second] = inherited === void 0 || inherited === this.inheritedPath ? [this.shellEnv.PATH, inherited] : [inherited, this.shellEnv.PATH];
    return mergePath(
      first,
      second,
      executable(this.nodePath) && /^node(?:\.exe)?$/iu.test(basename(this.nodePath)) ? dirname(this.nodePath) : void 0,
      ...fallbacks
    );
  }
  environment(env = this.baseEnv) {
    const path2 = this.searchPath(env);
    const result2 = { ...env };
    if (process.platform === "win32") {
      for (const key of Object.keys(result2))
        if (key !== "PATH" && key.toUpperCase() === "PATH") delete result2[key];
    }
    if (path2 !== "") result2.PATH = path2;
    const callerKeys = new Set(
      Object.keys(env).filter((key) => env[key] !== void 0).map((key) => key.toUpperCase())
    );
    for (const key of NETWORK_KEYS)
      if (!callerKeys.has(key.toUpperCase()) && this.shellEnv[key] !== void 0)
        result2[key] = this.shellEnv[key];
    return result2;
  }
  lookup(command, options) {
    const env = this.environment(options.env);
    const cwd = options.cwd instanceof URL ? fileURLToPath(options.cwd) : options.cwd ?? process.cwd();
    if (command === "bb") {
      for (const candidate of [
        env.BB_CLI_LAUNCHER,
        env.BB_CLI,
        env.BB_CLI_DIR ? join(env.BB_CLI_DIR, "bb") : void 0
      ]) {
        if (candidate?.trim() && isAbsolute(candidate.trim()) && executable(candidate.trim()))
          return candidate.trim();
      }
    }
    const extension = extname(command);
    const pathExt = envValue(env, "PATHEXT");
    const path2 = envValue(env, "PATH") ?? "";
    const lookupOptions = {
      cwd,
      path: path2,
      pathExt: extension ? `${extension};${pathExt ?? ".EXE;.COM;.CMD;.BAT"}` : pathExt
    };
    const found = command === "bb" ? path2.split(delimiter).filter(isAbsolute).map(
      (directory) => whichCommandSync(join(directory, command), lookupOptions)
    ).find(Boolean) : whichCommandSync(command, lookupOptions);
    return found ? onDiskName(found) : null;
  }
  resolve(command, options = {}) {
    const found = this.lookup(command, options);
    if (found !== null) return found;
    const key = `${command}\0${String(options.cwd ?? "")}\0${envValue(options.env ?? this.baseEnv, "PATH") ?? ""}`;
    const sinceRefresh = Date.now() - this.refreshedAt;
    if (!(this.misses.has(key) && sinceRefresh < 3e4) && (this.misses.size === 0 || sinceRefresh >= 1e3))
      void this.refresh();
    this.misses.add(key);
    return null;
  }
  node(options = {}) {
    if (executable(this.nodePath)) return this.nodePath;
    const stableHomebrew = this.runtimePath.replace(
      /\/Cellar\/([^/]+)\/[^/]+\//u,
      "/opt/$1/"
    );
    const candidates = [
      stableHomebrew,
      process.argv0,
      this.lookup(process.platform === "win32" ? "node.exe" : "node", options)
    ];
    for (const candidate of candidates) {
      if (!candidate || !isAbsolute(candidate) || !executable(candidate))
        continue;
      const probe = spawnSync(
        candidate,
        [
          "-p",
          "JSON.stringify({path:process.execPath,abi:process.versions.modules,electron:!!process.versions.electron})"
        ],
        {
          env: this.environment(options.env),
          cwd: options.cwd,
          encoding: "utf8",
          timeout: PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
          windowsHide: true
        }
      );
      if (probe.status !== 0) continue;
      try {
        const runtime = JSON.parse(probe.stdout.trim());
        if (typeof runtime !== "object" || runtime === null || !("path" in runtime) || typeof runtime.path !== "string" || !("abi" in runtime) || runtime.abi !== process.versions.modules || !("electron" in runtime) || runtime.electron !== Boolean(process.versions.electron))
          continue;
        if (isAbsolute(runtime.path) && executable(runtime.path)) {
          this.nodePath = runtime.path;
          return runtime.path;
        }
      } catch {
      }
    }
    throw Object.assign(
      new Error(
        "The Node runtime was removed and no replacement was found. Reinstall Node or restart bb with an available runtime."
      ),
      { code: "ENOENT" }
    );
  }
  bundledNpmCli(command = "npm") {
    const require2 = createRequire(import.meta.url);
    return join(
      dirname(require2.resolve("npm/package.json")),
      "bin",
      `${command}-cli.js`
    );
  }
  npmCli(command = "npm", options = {}) {
    const bin = `${command}-cli.js`;
    const runtime = process.versions.electron ? null : this.node(options);
    const candidates = [];
    if (runtime !== null)
      for (const cli of [
        join(dirname(runtime), "..", "lib", "node_modules", "npm", "bin", bin),
        join(dirname(runtime), "node_modules", "npm", "bin", bin)
      ])
        candidates.push({ node: runtime, cli });
    const installed = this.resolve(command, options);
    if (installed) {
      try {
        const cli = realpathSync(installed);
        const npmRoot = dirname(dirname(cli));
        const node = [
          join(npmRoot, "..", "..", "..", "bin", "node"),
          join(npmRoot, "..", "..", "node.exe"),
          join(dirname(installed), "node")
        ].find(executable);
        if (basename(cli) === bin && node !== void 0)
          candidates.push({ node: realpathSync(node), cli });
      } catch {
      }
    }
    if (runtime !== null) {
      try {
        candidates.push({ node: runtime, cli: this.bundledNpmCli(command) });
      } catch {
      }
    }
    return candidates.find((candidate) => existsSync(candidate.cli)) ?? null;
  }
  command(command, args = [], options = {}) {
    const file = command === this.runtimePath ? this.node(options) : this.resolve(command, options) ?? command;
    const env = this.environment(options.env);
    if (/(?:^|[\\/])(?:npm|npx)-cli\.js$/u.test(args[0] ?? "")) {
      env.PATH = mergePath(dirname(file), env.PATH);
    }
    const network = prepareNodeNetworkCommand(args, env);
    return { command: file, args: network.args, env: network.env };
  }
};
var toolchainKey = /* @__PURE__ */ Symbol.for("@bb/process-utils/host-toolchain");
var shared = globalThis;
var hostToolchain = shared[toolchainKey] ??= new HostToolchain();

// ../process-utils/src/host-process.ts
function observe(child) {
  child.once("error", (error) => hostToolchain.invalidateFailure(error));
  child.once("exit", (code) => hostToolchain.invalidateFailure(code));
  return child;
}
function spawnHostProcess(command, args = [], options = {}) {
  const launch = options.shell ? { command, args: [...args], env: hostToolchain.environment(options.env) } : hostToolchain.command(command, args, options);
  const spawnOptions = {
    ...options,
    env: launch.env,
    windowsHide: options.windowsHide ?? true
  };
  if (process.platform === "win32" && !options.shell && /[\\/]/u.test(command)) {
    const parsed = parse(launch.command, launch.args, spawnOptions);
    return observe(
      parsed.file ? nodeSpawn(parsed.command, parsed.args, parsed.options) : nodeSpawn(launch.command, launch.args, spawnOptions)
    );
  }
  const spawn2 = options.shell ? nodeSpawn : crossSpawn;
  return observe(spawn2(launch.command, launch.args, spawnOptions));
}

// ../process-utils/src/vcs-process-scheduler.ts
import { AsyncLocalStorage } from "node:async_hooks";
import { availableParallelism } from "node:os";
var ranks = { interactive: 0, status: 1, background: 2 };
function localProcessCapacities(parallelism) {
  const total = Math.min(6, Math.max(4, parallelism - 2));
  return [total, total - 1, total - 2];
}
var capacities = {
  local: localProcessCapacities(availableParallelism()),
  network: [4, 3, 2]
};
var githubCapacity = 2;
var agingMs = 15e3;
var networkGitSubcommands = /* @__PURE__ */ new Set([
  "fetch",
  "pull",
  "push",
  "clone",
  "ls-remote"
]);
var gitGlobalOptionsWithValue = /* @__PURE__ */ new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env"
]);
function isNetworkGitCommand(args) {
  let index = 0;
  while (index < args.length && args[index].startsWith("-")) {
    index += gitGlobalOptionsWithValue.has(args[index]) ? 2 : 1;
  }
  const subcommand = args[index];
  if (subcommand === void 0) return false;
  if (networkGitSubcommands.has(subcommand)) return true;
  const action = args.slice(index + 1).find((arg) => !arg.startsWith("-"));
  return (subcommand === "submodule" || subcommand === "remote") && action === "update";
}
var VcsProcessScheduler = class {
  priority = new AsyncLocalStorage();
  admitted = new AsyncLocalStorage();
  active = { local: 0, network: 0 };
  githubActive = 0;
  queue = [];
  timer;
  acquire(command, args, options) {
    const pool = command === "gh" || isNetworkGitCommand(args) ? "network" : "local";
    const slots = options.slots ?? 1;
    if (!Number.isInteger(slots) || slots < 1 || slots > capacities[pool][ranks.background]) {
      return Promise.reject(new Error("Invalid VCS process slot count"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(this.abortError(options.signal));
    }
    return new Promise((grant, reject) => {
      const waiter = {
        command,
        pool,
        priority: options.priority ?? this.priority.getStore() ?? "status",
        slots,
        queuedAt: performance.now(),
        signal: options.signal,
        grant,
        onAbort: () => {
          const index = this.queue.indexOf(waiter);
          if (index === -1) return;
          this.queue.splice(index, 1);
          reject(this.abortError(options.signal));
          this.drain();
        }
      };
      this.queue.push(waiter);
      options.signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.drain();
    });
  }
  abortError(signal) {
    return Object.assign(
      new Error("The operation was aborted", { cause: signal?.reason }),
      {
        name: "AbortError",
        code: "ABORT_ERR"
      }
    );
  }
  rank(waiter) {
    return Math.max(
      0,
      ranks[waiter.priority] - Math.floor((performance.now() - waiter.queuedAt) / agingMs)
    );
  }
  drain() {
    clearTimeout(this.timer);
    this.queue.sort(
      (a, b) => this.rank(a) - this.rank(b) || a.queuedAt - b.queuedAt
    );
    const blocked = /* @__PURE__ */ new Set();
    for (let index = 0; index < this.queue.length; ) {
      const waiter = this.queue[index];
      if (blocked.has(waiter.pool) || waiter.command === "gh" && this.githubActive + waiter.slots > githubCapacity) {
        index += 1;
        continue;
      }
      if (this.active[waiter.pool] + waiter.slots > capacities[waiter.pool][this.rank(waiter)]) {
        blocked.add(waiter.pool);
        index += 1;
        continue;
      }
      this.queue.splice(index, 1);
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      this.active[waiter.pool] += waiter.slots;
      if (waiter.command === "gh") this.githubActive += waiter.slots;
      let released = false;
      waiter.grant(() => {
        if (released) return;
        released = true;
        this.active[waiter.pool] -= waiter.slots;
        if (waiter.command === "gh") this.githubActive -= waiter.slots;
        this.drain();
      });
    }
    if (this.queue.length > 0) {
      const delay = Math.min(
        ...this.queue.map(
          (waiter) => agingMs - (performance.now() - waiter.queuedAt) % agingMs
        )
      );
      this.timer = setTimeout(() => this.drain(), delay);
    }
  }
};
var registry = globalThis;
var scheduler = registry.__bbVcsProcessScheduler ??= new VcsProcessScheduler();

// ../provider-bridge-protocol/src/testing/parity.ts
import { existsSync as existsSync3, mkdtempSync, realpathSync as realpathSync2, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute as isAbsolute2, join as join3, resolve as resolve2 } from "node:path";
import { fileURLToPath as fileURLToPath3, pathToFileURL } from "node:url";

// ../provider-bridge-protocol/src/bridge-kit/bounded-line-reader.ts
import { StringDecoder } from "node:string_decoder";
var MAX_JSON_RPC_LINE_BYTES = 64 * 1024 * 1024;
function readBoundedLines(args) {
  const maxLineBytes = args.maxLineBytes ?? MAX_JSON_RPC_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarding = false;
  let discardedBytes = 0;
  args.input.on("data", (chunk) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    let start = 0;
    for (; ; ) {
      const newlineIndex = text.indexOf("\n", start);
      if (newlineIndex === -1) {
        break;
      }
      if (discarding) {
        discarding = false;
        args.onOverflow(discardedBytes);
        discardedBytes = 0;
      } else {
        emit(pending + text.slice(start, newlineIndex));
      }
      pending = "";
      start = newlineIndex + 1;
    }
    const tail = text.slice(start);
    if (discarding) {
      discardedBytes += Buffer.byteLength(tail);
      return;
    }
    pending += tail;
    if (Buffer.byteLength(pending) > maxLineBytes) {
      discarding = true;
      discardedBytes = Buffer.byteLength(pending);
      pending = "";
    }
  });
  args.input.on("end", () => {
    if (!discarding && pending.length > 0) {
      emit(pending);
    }
    pending = "";
    args.onClose?.();
  });
  function emit(line) {
    args.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  }
}

// ../provider-bridge-protocol/src/testing/recording.ts
import { existsSync as existsSync2, readdirSync as readdirSync2, readFileSync, statSync as statSync2 } from "node:fs";
import { join as join2, resolve } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// ../provider-bridge-protocol/src/bridge-kit/bridge-recorder.ts
var BRIDGE_RECORDING_DIRECTIONS = [
  "runtime\u2192bridge",
  "bridge\u2192runtime",
  "provider\u2192bridge",
  "bridge\u2192provider"
];
function bridgeRecordingFileName(direction) {
  return `${direction}.ndjson`;
}

// ../provider-bridge-protocol/src/testing/recording.ts
var COMMITTED_RECORDINGS_ROOT = fileURLToPath2(
  new URL("../../recordings", import.meta.url)
);
var RECORDINGS_CHECKOUT_ROOT = resolve(
  COMMITTED_RECORDINGS_ROOT,
  "../../.."
);
function compareRecordingEntries(left, right) {
  return left.run - right.run || left.seq - right.seq;
}
function parseEntry(raw, file, lineNumber) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${file}:${lineNumber}: not JSON (${error instanceof Error ? error.message : String(error)})`
    );
  }
  if (typeof parsed !== "object" || parsed === null || typeof parsed.line !== "string" || typeof parsed.seq !== "number" || typeof parsed.dir !== "string") {
    throw new Error(`${file}:${lineNumber}: not a recording entry`);
  }
  const entry = parsed;
  return { ...entry, run: typeof entry.run === "number" ? entry.run : 0 };
}
function readLaneEntries(file, direction, laneLabel) {
  const entries = [];
  const lines = readFileSync(file, "utf8").split("\n");
  for (const [index, raw] of lines.entries()) {
    if (raw.length === 0) continue;
    const entry = parseEntry(raw, file, index + 1);
    if (entry.dir !== direction) {
      throw new Error(
        `${file}:${index + 1}: entry direction ${entry.dir} in the ${laneLabel}`
      );
    }
    entries.push(entry);
  }
  return entries;
}
function readBridgeRecordingLane(dir, direction) {
  const file = join2(dir, bridgeRecordingFileName(direction));
  if (!existsSync2(file)) {
    return [];
  }
  return readLaneEntries(file, direction, `${direction} lane`);
}
var CURRENT_BRIDGE_LANE_FILE = "bridge\u2192runtime.current.ndjson";
function readCurrentBridgeLane(dir) {
  const file = join2(dir, CURRENT_BRIDGE_LANE_FILE);
  if (!existsSync2(file)) {
    return null;
  }
  return readLaneEntries(file, "bridge\u2192runtime", "current bridge lane");
}
function withCurrentBridgeLane(recording) {
  const current = readCurrentBridgeLane(recording.dir);
  if (current === null) {
    return recording;
  }
  const entries = [
    ...recording.entries.filter((entry) => entry.dir !== "bridge\u2192runtime"),
    ...current
  ];
  entries.sort(compareRecordingEntries);
  return { ...recording, entries };
}
function readBridgeRecording(dir) {
  const manifestPath = join2(dir, "manifest.json");
  const manifest = existsSync2(manifestPath) ? JSON.parse(
    readFileSync(manifestPath, "utf8")
  ) : null;
  const entries = [];
  for (const direction of BRIDGE_RECORDING_DIRECTIONS) {
    entries.push(...readBridgeRecordingLane(dir, direction));
  }
  entries.sort(compareRecordingEntries);
  return { dir, manifest, entries };
}
function listRecordedCells(root) {
  const cells = [];
  if (!existsSync2(root)) {
    return cells;
  }
  for (const provider of readdirSync2(root).sort()) {
    const providerDir = join2(root, provider);
    if (!statSync2(providerDir).isDirectory()) continue;
    for (const cell of readdirSync2(providerDir).sort()) {
      const dir = join2(providerDir, cell);
      if (!statSync2(dir).isDirectory()) continue;
      const hasLane = BRIDGE_RECORDING_DIRECTIONS.some(
        (direction) => existsSync2(join2(dir, bridgeRecordingFileName(direction)))
      );
      if (hasLane) {
        cells.push({ provider, cell, dir });
      }
    }
  }
  return cells;
}

// ../provider-bridge-protocol/src/testing/parity.ts
var REPLAY_CLEANUP_RETRIES = 20;
var REPLAY_CLEANUP_RETRY_DELAY_MS = 100;
var SOURCE_BOOTSTRAP = fileURLToPath3(
  new URL("../bridge-worker-entry.ts", import.meta.url)
);
var BUNDLED_BOOTSTRAP = fileURLToPath3(
  new URL("./provider-bridge-worker-entry.mjs", import.meta.url)
);
function resolveProviderBridgeBootstrapPath() {
  if (existsSync3(SOURCE_BOOTSTRAP)) return SOURCE_BOOTSTRAP;
  if (existsSync3(BUNDLED_BOOTSTRAP)) return BUNDLED_BOOTSTRAP;
  throw new Error(
    `provider-bridge bootstrap not found at ${SOURCE_BOOTSTRAP} or ${BUNDLED_BOOTSTRAP}`
  );
}
function isTypeScriptPath(path2) {
  return /\.[cm]?tsx?$/u.test(path2);
}
function tsxSpecifier() {
  return import.meta.resolve("tsx");
}
function defaultNodeArgs(bootstrapPath, modulePath) {
  if (isTypeScriptPath(bootstrapPath)) {
    return ["--conditions=source", "--import", tsxSpecifier()];
  }
  return isTypeScriptPath(modulePath) ? ["--import", tsxSpecifier()] : [];
}
function resolveProviderBridgeLaunch(options) {
  if (!isAbsolute2(options.modulePath)) {
    throw new Error(
      `bridge module path must be absolute: ${options.modulePath}`
    );
  }
  const bootstrapPath = options.bootstrapPath ?? resolveProviderBridgeBootstrapPath();
  const dataDir = options.dataDir ?? mkdtempSync(join3(tmpdir(), "bb-parity-data-"));
  return {
    command: process.execPath,
    args: [
      ...options.nodeArgs ?? defaultNodeArgs(bootstrapPath, options.modulePath),
      bootstrapPath,
      options.modulePath,
      options.pluginId,
      dataDir
    ],
    cwd: options.cwd ?? process.cwd(),
    env: {}
  };
}
var DEFAULT_REPLAY_PROFILE = {
  dialect: "json-rpc",
  env: () => ({})
};
function rewriteRecordedMachineFacts(line, workspaceDir) {
  if (!line.includes('"PATH"') && !line.includes('"cwd"')) {
    return line;
  }
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return line;
  }
  const params = parsed.params;
  if (params === void 0) {
    return line;
  }
  let changed = false;
  const envVars = params.options?.envVars;
  if (envVars !== void 0 && typeof envVars.PATH === "string") {
    envVars.PATH = process.env.PATH ?? envVars.PATH;
    changed = true;
  }
  if (typeof params.cwd === "string") {
    params.cwd = workspaceDir;
    changed = true;
  }
  return changed ? JSON.stringify(parsed) : line;
}
function recordedWorkspaceDir(recording) {
  for (const entry of recording.entries) {
    if (entry.dir !== "runtime\u2192bridge") continue;
    const message = parseWire(entry.line);
    const cwd = message?.params?.cwd;
    if (typeof cwd === "string" && cwd.length > 0) return cwd;
  }
  return null;
}
function parseWire(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
function isRequest(message) {
  return message.id !== void 0 && typeof message.method === "string";
}
function isResponse(message) {
  return message.id !== void 0 && message.method === void 0;
}
function planRuntimeSteps(recording, assembler) {
  const steps = [];
  const assembled = [];
  for (const entry of recording.entries) {
    if (entry.dir === "bridge\u2192runtime") {
      const message = parseWire(entry.line);
      if (message !== null && message.method === THREAD_DELTA_NOTIFICATION_METHOD) {
        try {
          assembled.push(...assembler.assembleMessage(message));
        } catch {
        }
      }
      continue;
    }
    if (entry.dir !== "runtime\u2192bridge") {
      continue;
    }
    steps.push({
      entry,
      message: parseWire(entry.line),
      gate: countTurns(assembled),
      eventsBefore: assembled.length
    });
  }
  return steps;
}
function methodOfRecordedBridgeRequest(recording, response, id) {
  for (const entry of recording.entries) {
    if (entry.dir !== "bridge\u2192runtime" || entry.run !== response.run) continue;
    const message = parseWire(entry.line);
    if (message !== null && isRequest(message) && String(message.id) === String(id)) {
      return message.method;
    }
  }
  return void 0;
}
var REPLAY_CHILD_PATH = fileURLToPath3(
  new URL("./replay-provider-child.mjs", import.meta.url)
);
var PARITY_INITIALIZE_ID = "parity-initialize";
var BRIDGE_EXIT_STDERR_TAIL_CHARS = 2e3;
function describeBridgeExit(child) {
  if (child.pid === void 0) return "never started";
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  return `code ${String(child.exitCode)}`;
}
function stderrTail(stderr) {
  const trimmed = stderr.trim();
  if (trimmed === "") return "; no stderr";
  return `; stderr: ${trimmed.slice(-BRIDGE_EXIT_STDERR_TAIL_CHARS)}`;
}
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
var REPLAY_STARTUP_CONCURRENCY = 4;
var replayStartupQueue = [];
var startingReplays = 0;
async function acquireReplayStartup() {
  if (startingReplays < REPLAY_STARTUP_CONCURRENCY) {
    startingReplays += 1;
  } else {
    await new Promise(
      (resolveSlot) => replayStartupQueue.push(resolveSlot)
    );
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = replayStartupQueue.shift();
    if (next === void 0) startingReplays -= 1;
    else next();
  };
}
var BRIDGE_STARTUP_ATTEMPTS = 2;
async function replayRecording(options) {
  for (let attempt = 1; ; attempt += 1) {
    const { run, crashedBeforeInitialize } = await replayRecordingAttempt(options);
    if (!crashedBeforeInitialize || attempt >= BRIDGE_STARTUP_ATTEMPTS) {
      return run;
    }
    process.stderr.write(
      `parity replay of ${options.recordingDir}: retrying after a bridge startup crash: ${run.stalls.join("; ")}
`
    );
  }
}
async function replayRecordingAttempt(options) {
  const timeoutMs = options.timeoutMs ?? 15e3;
  const orderTimeoutMs = options.orderTimeoutMs ?? 5e3;
  const settleMs = options.settleMs ?? 750;
  const drainMs = options.drainMs ?? 300;
  const providerId = options.providerId;
  const profile = options.profile ?? DEFAULT_REPLAY_PROFILE;
  const recording = readBridgeRecording(options.recordingDir);
  const stateDir = mkdtempSync(join3(tmpdir(), "bb-parity-replay-"));
  const workspaceDir = realpathSync2(
    mkdtempSync(join3(tmpdir(), "bb-parity-ws-"))
  );
  const replayCommand = [
    process.execPath,
    REPLAY_CHILD_PATH,
    "--recording",
    resolve2(options.recordingDir),
    "--dialect",
    profile.dialect,
    "--state",
    stateDir
  ];
  const cursorPath = join3(stateDir, "cursor");
  const setCursor = (position) => {
    writeFileSync(
      cursorPath,
      position === "end" ? "end" : `${position.run} ${position.seq}`
    );
  };
  const wrapperPath = join3(stateDir, "replay-provider.mjs");
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env node",
      `process.argv.splice(2, 0, ${JSON.stringify(replayCommand.slice(2)).slice(1, -1)});`,
      `await import(${JSON.stringify(pathToFileURL(REPLAY_CHILD_PATH).href)});`,
      ""
    ].join("\n"),
    { mode: 493 }
  );
  profile.prepareState?.({ recording, stateDir, workspaceDir });
  const launch = options.bridge;
  const releaseStartup = await acquireReplayStartup();
  let spawnedChild;
  let childEnded;
  try {
    let write2 = function(line) {
      if (child.stdin?.writable) {
        child.stdin.write(`${line}
`);
      }
    }, answerBridgeRequest2 = function(message) {
      const method = message.method ?? "?";
      const queue = recordedAnswers.get(method);
      const recorded = queue?.shift();
      if (recorded === void 0) {
        stalls.push(
          `no recorded answer for bridge request ${method} (${String(message.id)})`
        );
        write2(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32e3,
              message: "parity replay: no recorded answer"
            }
          })
        );
        return;
      }
      write2(JSON.stringify({ ...recorded, id: message.id }));
    };
    var write = write2, answerBridgeRequest = answerBridgeRequest2;
    const child = spawnHostProcess(launch.command, launch.args, {
      cwd: launch.cwd,
      env: {
        ...process.env,
        ...launch.env,
        ...profile.env({ replayCommand, wrapperPath, stateDir })
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    spawnedChild = child;
    childEnded = new Promise((resolveEnded) => {
      const onEnded = () => {
        releaseStartup();
        resolveEnded();
      };
      child.once("exit", onEnded);
      child.once("error", onEnded);
    });
    const recordedCwd = recordedWorkspaceDir(recording);
    const jsonText = (value) => JSON.stringify(value).slice(1, -1);
    const restoreRecordedWorkspace = (line) => recordedCwd === null || recordedCwd === workspaceDir ? line : line.split(jsonText(workspaceDir)).join(jsonText(recordedCwd));
    const initializeId = PARITY_INITIALIZE_ID;
    const startedAt = Date.now();
    const lines = [];
    const lineTimes = [];
    const lineAfter = [];
    let lastSentRuntimeEntry = null;
    const events = [];
    const grammarViolations = [];
    const stalls = [];
    let stderr = "";
    const grammar = new ThreadEventGrammar();
    const liveAssembler = options.createAssembler(providerId);
    const planAssembler = (options.createPlanAssembler ?? options.createAssembler)(providerId);
    const exactPlan = options.planFromCurrentLane === true;
    const planRecording = exactPlan ? withCurrentBridgeLane(recording) : recording;
    const steps = planRuntimeSteps(planRecording, planAssembler);
    const plannedEventCount = exactPlan ? assembleRecordedEvents(
      planRecording,
      options.createPlanAssembler ?? options.createAssembler,
      providerId
    ).events.length : null;
    const answeredIds = /* @__PURE__ */ new Set();
    const sentRequestIds = [];
    const pendingBridgeRequests = [];
    const recordedAnswers = /* @__PURE__ */ new Map();
    for (const step of steps) {
      if (step.message !== null && isResponse(step.message)) {
        const method = methodOfRecordedBridgeRequest(
          recording,
          step.entry,
          step.message.id
        ) ?? "?";
        const queue = recordedAnswers.get(method) ?? [];
        queue.push(step.message);
        recordedAnswers.set(method, queue);
      }
    }
    let lastOutputAt = Date.now();
    const exited = new Promise((resolveExit) => {
      child.on("exit", (code) => resolveExit(code));
      child.on("error", (error) => {
        stalls.push(`bridge spawn failed: ${error.message}`);
        resolveExit(null);
      });
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    readBoundedLines({
      input: child.stdout,
      onLine: (rawLine) => {
        const line = restoreRecordedWorkspace(rawLine);
        lastOutputAt = Date.now();
        lines.push(line);
        lineTimes.push(lastOutputAt - startedAt);
        lineAfter.push(lastSentRuntimeEntry);
        const message = parseWire(line);
        if (message === null) return;
        if (isResponse(message)) {
          answeredIds.add(String(message.id));
          return;
        }
        if (isRequest(message)) {
          pendingBridgeRequests.push({
            id: message.id,
            method: message.method
          });
          answerBridgeRequest2(message);
          return;
        }
        if (message.method === THREAD_DELTA_NOTIFICATION_METHOD) {
          let assembled;
          try {
            assembled = liveAssembler.assembleMessage(message);
          } catch (error) {
            stalls.push(
              `invalid thread/delta: ${error instanceof Error ? error.message : String(error)}`
            );
            return;
          }
          for (const event of assembled) {
            const result2 = grammar.observe(event);
            if (result2.kind === "violation") {
              grammarViolations.push({
                rule: result2.rule,
                reason: result2.reason,
                eventType: event.type
              });
              continue;
            }
            events.push(event);
          }
        }
      },
      onOverflow: (bytes) => {
        stalls.push(`oversized bridge line (${bytes} bytes)`);
      }
    });
    let reportedBridgeExit = false;
    async function waitFor(label, predicate, limitMs = timeoutMs, reportStall = true) {
      const diagnostic = () => JSON.stringify({
        events: events.length,
        plannedEvents: plannedEventCount,
        grammarViolationCount: grammarViolations.length,
        grammarViolations: grammarViolations.slice(-5),
        unansweredRequests: sentRequestIds.filter(
          (id) => !answeredIds.has(id)
        ),
        exitCode: child.exitCode,
        signal: child.signalCode,
        millisecondsSinceOutput: Date.now() - lastOutputAt,
        stderrTail: stderr.slice(-2e3)
      });
      const deadline = Date.now() + limitMs;
      while (!predicate()) {
        if (child.exitCode !== null || child.signalCode !== null || child.pid === void 0) {
          stalls.push(
            `bridge exited (${describeBridgeExit(child)}) while waiting for ${label}${reportedBridgeExit ? "" : stderrTail(stderr)}: ${diagnostic()}`
          );
          reportedBridgeExit = true;
          return;
        }
        if (Date.now() > deadline) {
          if (reportStall)
            stalls.push(`timed out waiting for ${label}: ${diagnostic()}`);
          return;
        }
        await sleep(10);
      }
    }
    const firstStep = steps.find(
      (step) => step.message !== null && isRequest(step.message)
    );
    setCursor(
      firstStep === void 0 ? "end" : { run: firstStep.entry.run, seq: firstStep.entry.seq }
    );
    write2(
      JSON.stringify({
        jsonrpc: "2.0",
        id: initializeId,
        method: "initialize",
        params: {
          protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
          client: { name: "bb-parity", version: "0" }
        }
      })
    );
    await waitFor("initialize response", () => answeredIds.has(initializeId));
    const initialized = answeredIds.has(initializeId);
    const crashedBeforeInitialize = !initialized && (child.pid === void 0 || child.exitCode !== null || child.signalCode !== null);
    if (!initialized) {
      if (child.pid !== void 0 && child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await childEnded;
    }
    releaseStartup();
    if (crashedBeforeInitialize) {
      return {
        run: {
          providerId,
          recordingDir: options.recordingDir,
          lines,
          lineTimes,
          lineAfter,
          events,
          grammarViolations,
          stalls,
          stderr,
          exitCode: child.exitCode
        },
        crashedBeforeInitialize
      };
    }
    for (const step of initialized ? steps : []) {
      if (step.message === null || !isRequest(step.message)) {
        if (step.message !== null && !isResponse(step.message)) {
          lastSentRuntimeEntry = {
            run: step.entry.run,
            seq: step.entry.seq,
            ts: step.entry.ts
          };
          write2(step.entry.line);
        }
        continue;
      }
      const request = step.message;
      const method = request.method;
      await waitFor(
        `earlier requests before ${method}`,
        () => sentRequestIds.every((id) => answeredIds.has(id))
      );
      await waitFor(
        `${step.gate.started} turn/started and ${step.gate.completed} turn/completed before ${method}`,
        () => {
          const live = countTurns(events);
          return live.started >= step.gate.started && live.completed >= step.gate.completed;
        }
      );
      await waitFor(
        `${step.eventsBefore} events before ${method}`,
        () => events.length >= step.eventsBefore || !exactPlan && Date.now() - lastOutputAt >= orderTimeoutMs,
        timeoutMs,
        exactPlan
      );
      await waitFor(
        `the stream to drain before ${method}`,
        () => Date.now() - lastOutputAt >= drainMs,
        timeoutMs,
        false
      );
      if (child.exitCode !== null) break;
      if (method === "thread/stop" && typeof request.params === "object" && request.params !== null && request.params.intent === "release") {
        const threadId = request.params.threadId;
        if (typeof threadId === "string") grammar.clearThread(threadId);
      }
      const rewritten = rewriteRecordedMachineFacts(
        step.entry.line,
        workspaceDir
      );
      const line = profile.rewriteRuntimeLine === void 0 ? rewritten : profile.rewriteRuntimeLine(rewritten, { replayCommand });
      lastSentRuntimeEntry = {
        run: step.entry.run,
        seq: step.entry.seq,
        ts: step.entry.ts
      };
      write2(line);
      sentRequestIds.push(String(request.id));
      const nextStep = steps.slice(steps.indexOf(step) + 1).find(
        (candidate) => candidate.message !== null && isRequest(candidate.message)
      );
      setCursor(
        nextStep === void 0 ? "end" : { run: nextStep.entry.run, seq: nextStep.entry.seq }
      );
    }
    setCursor("end");
    await waitFor(
      "the last responses",
      () => sentRequestIds.every((id) => answeredIds.has(id))
    );
    if (plannedEventCount !== null) {
      await waitFor(
        `all ${plannedEventCount} planned events before closing the bridge`,
        () => events.length >= plannedEventCount
      );
    }
    await waitFor(
      "the stream to settle",
      () => Date.now() - lastOutputAt >= settleMs
    );
    child.stdin?.end();
    let shutdownTimer;
    const exitCode = await Promise.race([
      exited,
      new Promise((resolveTimeout) => {
        shutdownTimer = setTimeout(() => {
          stalls.push("bridge did not exit after stdin closed; killed");
          child.kill("SIGKILL");
          resolveTimeout(null);
        }, timeoutMs);
      })
    ]);
    clearTimeout(shutdownTimer);
    return {
      run: {
        providerId,
        recordingDir: options.recordingDir,
        lines,
        lineTimes,
        lineAfter,
        events,
        grammarViolations,
        stalls,
        stderr,
        exitCode
      },
      crashedBeforeInitialize: false
    };
  } finally {
    if (spawnedChild !== void 0 && spawnedChild.pid !== void 0 && spawnedChild.exitCode === null && spawnedChild.signalCode === null) {
      spawnedChild.kill("SIGKILL");
      await childEnded;
    }
    releaseStartup();
    for (const directory of [stateDir, workspaceDir]) {
      await rm(directory, {
        force: true,
        maxRetries: REPLAY_CLEANUP_RETRIES,
        recursive: true,
        retryDelay: REPLAY_CLEANUP_RETRY_DELAY_MS
      });
    }
  }
}
function assembleRecordedEvents(recording, createAssembler, providerId) {
  const assembler = createAssembler(providerId);
  const grammar = new ThreadEventGrammar();
  const events = [];
  const grammarViolations = [];
  const invalidDeltas = [];
  for (const entry of recording.entries) {
    if (entry.dir === "runtime\u2192bridge") {
      const message2 = parseWire(entry.line);
      if (message2 !== null && message2.method === "thread/stop" && typeof message2.params === "object" && message2.params !== null && message2.params.intent === "release") {
        const threadId = message2.params.threadId;
        if (typeof threadId === "string") grammar.clearThread(threadId);
      }
      continue;
    }
    if (entry.dir !== "bridge\u2192runtime") continue;
    const message = parseWire(entry.line);
    if (message === null || message.method !== THREAD_DELTA_NOTIFICATION_METHOD)
      continue;
    let assembled;
    try {
      assembled = assembler.assembleMessage(message);
    } catch (error) {
      invalidDeltas.push(
        error instanceof Error ? error.message : String(error)
      );
      continue;
    }
    for (const event of assembled) {
      const result2 = grammar.observe(event);
      if (result2.kind === "violation") {
        grammarViolations.push({
          rule: result2.rule,
          reason: result2.reason,
          eventType: event.type
        });
        continue;
      }
      events.push(event);
    }
  }
  return { events, grammarViolations, invalidDeltas };
}
var TIME_FIELDS = /* @__PURE__ */ new Set([
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "startedAtMs",
  "completedAtMs",
  "timestamp",
  "ts",
  "resetsAtMs",
  "resetsAt",
  "expiresAt"
]);
function blankTimeFields(value) {
  if (Array.isArray(value)) {
    return value.map(blankTimeFields);
  }
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = TIME_FIELDS.has(key) && (typeof entry === "number" || typeof entry === "string") ? 0 : blankTimeFields(entry);
    }
    return out;
  }
  return value;
}
var ROW_ID_FIELDS = [
  "turnId",
  "itemId",
  "id",
  "parentToolCallId",
  "toolCallId",
  "callId",
  "requestId",
  "messageId",
  "rowId",
  "reasoningId",
  "agentId",
  "taskId",
  "backgroundTaskId",
  "sourceItemId",
  "interactionId"
];
function normalizeParityEvents(events) {
  return blankTimeFields(normalizeCalibrationEvents(events));
}
function normalizeParityRows(rows) {
  return blankTimeFields(
    normalizeCalibrationEvents(rows, {
      internedIdFields: ROW_ID_FIELDS
    })
  );
}
function pointerSegments(path2) {
  return path2.split("/").filter((segment) => segment.length > 0);
}
function maskPath(value, path2) {
  const segments = pointerSegments(path2);
  if (segments.length === 0) {
    if (!Array.isArray(value)) return 0;
    const removed2 = value.length;
    value.length = 0;
    return removed2;
  }
  let removed = 0;
  const visit = (node, index) => {
    if (index >= segments.length || node === null || typeof node !== "object") {
      return;
    }
    const segment = segments[index];
    const last = index === segments.length - 1;
    if (segment === "**") {
      visit(node, index + 1);
      for (const child of Object.values(node)) {
        visit(child, index);
      }
      return;
    }
    const keys = segment === "*" ? Object.keys(node) : Object.hasOwn(node, segment) ? [segment] : [];
    for (const key of keys) {
      if (last) {
        if (Array.isArray(node)) {
          node[Number(key)] = null;
        } else {
          delete node[key];
        }
        removed += 1;
      } else {
        visit(node[key], index + 1);
      }
    }
  };
  visit(value, 0);
  return removed;
}
function entryApplies(entry, provider, cell) {
  return (entry.provider === "*" || entry.provider === provider) && (entry.cell === "*" || entry.cell === cell);
}
function compareParity(oldRun, newRun, allowlist, scope) {
  const layers = {
    events: [
      normalizeParityEvents(oldRun.events),
      normalizeParityEvents(newRun.events)
    ],
    rows: [normalizeParityRows(oldRun.rows), normalizeParityRows(newRun.rows)]
  };
  const staleAllowlist = [];
  for (const entry of allowlist) {
    if (!entryApplies(entry, scope.provider, scope.cell)) continue;
    const [oldSide, newSide] = layers[entry.layer];
    const removed = maskPath(oldSide, entry.path) + maskPath(newSide, entry.path);
    if (removed === 0) {
      staleAllowlist.push(entry);
    }
  }
  const events = diffLayer(layers.events[0], layers.events[1]);
  const rows = diffLayer(layers.rows[0], layers.rows[1]);
  const grammar = diffLayer(
    (oldRun.grammarViolations ?? []).map(
      (violation2) => `${violation2.rule}:${violation2.eventType}`
    ),
    (newRun.grammarViolations ?? []).map(
      (violation2) => `${violation2.rule}:${violation2.eventType}`
    )
  );
  const clean = (diff) => diff.onlyInOld.length === 0 && diff.onlyInNew.length === 0;
  return {
    provider: scope.provider,
    cell: scope.cell,
    events,
    rows,
    grammar,
    staleAllowlist,
    passed: clean(events) && clean(rows) && clean(grammar) && staleAllowlist.length === 0
  };
}
function diffLayer(oldSide, newSide) {
  const diff = diffCalibrationStreams(oldSide, newSide);
  return { onlyInOld: diff.onlyInLegacy, onlyInNew: diff.onlyInBridge };
}

// ../provider-bridge-protocol/src/testing/rerecord.ts
import { writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";
var BRIDGE_TO_RUNTIME = "bridge\u2192runtime";
function parseWireLine(line) {
  try {
    const parsed = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
async function rerecordCurrentBridgeLane(options) {
  const recording = readBridgeRecording(options.recordingDir);
  const run = await replayRecording({ ...options, planFromCurrentLane: false });
  if (run.stalls.length > 0) {
    return {
      file: null,
      lines: 0,
      events: run.events.length,
      stalls: run.stalls
    };
  }
  const firstRuntime = recording.entries.find(
    (entry) => entry.dir === "runtime\u2192bridge"
  );
  const recordedRequestIds = /* @__PURE__ */ new Map();
  for (const entry of recording.entries) {
    if (entry.dir !== BRIDGE_TO_RUNTIME) continue;
    const message = parseWireLine(entry.line);
    if (message?.method === void 0 || message.id === void 0) continue;
    const queue = recordedRequestIds.get(message.method) ?? [];
    queue.push(message.id);
    recordedRequestIds.set(message.method, queue);
  }
  const entries = [];
  const perAnchor = /* @__PURE__ */ new Map();
  run.lines.forEach((rawLine, index) => {
    let line = rawLine;
    const message = parseWireLine(rawLine);
    if (message?.id === PARITY_INITIALIZE_ID) {
      return;
    }
    if (message?.method !== void 0 && message.id !== void 0) {
      const recordedId = recordedRequestIds.get(message.method)?.shift();
      if (recordedId !== void 0 && recordedId !== message.id) {
        line = JSON.stringify({ ...message, id: recordedId });
      }
    }
    const anchor = run.lineAfter[index] ?? (firstRuntime ? {
      run: firstRuntime.run,
      seq: firstRuntime.seq - 1,
      ts: firstRuntime.ts
    } : { run: 0, seq: 0, ts: 0 });
    const anchorKey = `${anchor.run}:${anchor.seq}`;
    const ordinal = (perAnchor.get(anchorKey) ?? 0) + 1;
    perAnchor.set(anchorKey, ordinal);
    entries.push({
      ts: anchor.ts + ordinal,
      run: anchor.run,
      seq: anchor.seq + ordinal / (run.lines.length + 1),
      dir: BRIDGE_TO_RUNTIME,
      line
    });
  });
  const file = join4(options.recordingDir, CURRENT_BRIDGE_LANE_FILE);
  writeFileSync2(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length > 0 ? "\n" : "")
  );
  return { file, lines: entries.length, events: run.events.length, stalls: [] };
}
export {
  ASSEMBLER_GRAMMAR_VERSIONS,
  CONFORMANCE_ASSEMBLED_EVENT_METHOD,
  CURRENT_BRIDGE_LANE_FILE,
  DEFAULT_REPLAY_PROFILE,
  PARITY_INITIALIZE_ID,
  RECORDED_CONFORMANCE_CELLS,
  assembleCapturedThreadEvents as experimental_assembleCapturedThreadEvents,
  assembleRecordedEvents as experimental_assembleRecordedEvents,
  captureBridgeJsonRpcOutput as experimental_captureBridgeJsonRpcOutput,
  checkRecordedCellReplay as experimental_checkRecordedCellReplay,
  compareParity as experimental_compareParity,
  createBridgeDeltaEventCollector as experimental_createBridgeDeltaEventCollector,
  createBridgeJsonRpcTestHarness as experimental_createBridgeJsonRpcTestHarness,
  createDeltaAssembler as experimental_createDeltaAssembler,
  describeCalibrationEvents as experimental_describeCalibrationEvents,
  formatConformanceReport as experimental_formatConformanceReport,
  listRecordedCells as experimental_listRecordedCells,
  normalizeCalibrationEvents as experimental_normalizeCalibrationEvents,
  readBridgeRecording as experimental_readBridgeRecording,
  replayRecording as experimental_replayRecording,
  rerecordCurrentBridgeLane as experimental_rerecordCurrentBridgeLane,
  resolveProviderBridgeLaunch as experimental_resolveProviderBridgeLaunch,
  runBridgeConformance as experimental_runBridgeConformance,
  withCurrentBridgeLane as experimental_withCurrentBridgeLane
};
