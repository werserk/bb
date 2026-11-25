import type {
  PlacementBinding,
  PlacementPhase,
  PlacementReason,
  AgentSelection,
  WorkerObservation,
  WorkerCustody,
  JsonObject,
  PlacementPermissionProvenance,
} from "@bb/domain";
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import {
  placementStepKinds,
  placementEffectStates,
  placementRetryStates,
} from "@bb/domain";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  queuedMessageDeliveryModeValues,
  queuedMessageStateValues,
} from "@bb/domain/queued-message-lifecycle";
import { threadStatusValues } from "@bb/domain/thread-status";
import { startedOnBehalfOfInitiatorValues } from "@bb/domain/started-on-behalf-of";
import { threadCreateOriginValues } from "@bb/domain/thread-create-origin";
import { threadOriginKindValues } from "@bb/domain/thread-origin-kind";
import { threadParentNotificationsValues } from "@bb/domain/thread-parent-notifications";
import { threadVisibilityValues } from "@bb/domain/thread-visibility";
import type {
  ServiceTurnDescriptor,
  EnvironmentProviderSelection,
  JsonValue,
  EnvironmentStatus,
  FaviconColorPreference,
  PendingInteractionStatus,
  ConversationQuestionStatus,
  PermissionMode,
  PromptHistoryScope,
  ProjectSourceType,
  QueuedMessagePayloadKind,
  QueuedMessageWaitHolder,
  ReasoningLevel,
  ServiceTier,
  TerminalSessionCloseReason,
  TerminalSessionStatus,
  ThreadDynamicContextFileStatus,
  ThreadSearchSourceKind,
  ThreadEventItemType,
  ThreadEventScopeKind,
  ThreadEventType,
  ProjectKind,
} from "@bb/domain";
import type { RetainedEventOutputPath } from "./retained-event-output.js";

export const authUsers = sqliteTable(
  "user",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("emailVerified", { mode: "boolean" }).notNull(),
    image: text("image"),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [uniqueIndex("user_email_unique").on(table.email)],
);

export const authApiKeys = sqliteTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("referenceId")
      .notNull()
      .references(() => authUsers.id, { onDelete: "cascade" }),
    refillInterval: integer("refillInterval"),
    refillAmount: integer("refillAmount"),
    lastRefillAt: integer("lastRefillAt", { mode: "timestamp_ms" }),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    rateLimitEnabled: integer("rateLimitEnabled", {
      mode: "boolean",
    }).notNull(),
    rateLimitTimeWindow: integer("rateLimitTimeWindow").notNull(),
    rateLimitMax: integer("rateLimitMax").notNull(),
    requestCount: integer("requestCount").notNull(),
    remaining: integer("remaining"),
    lastRequest: integer("lastRequest", { mode: "timestamp_ms" }),
    expiresAt: integer("expiresAt", { mode: "timestamp_ms" }),
    createdAt: integer("createdAt", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updatedAt", { mode: "timestamp_ms" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
    configId: text("configId").notNull(),
  },
  (table) => [
    uniqueIndex("apikey_key_unique").on(table.key),
    index("apikey_reference_id_idx").on(table.referenceId),
    index("apikey_config_id_idx").on(table.configId),
  ],
);

export const hosts = sqliteTable(
  "hosts",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    type: text("type").$type<"persistent" | "ephemeral">().notNull(),
    connectMachineId: text("connect_machine_id"),
    machineProviderId: text("machine_provider_id"),
    launchKey: text("launch_key"),
    inputs: text("machine_inputs", { mode: "json" }).$type<JsonValue>(),
    attempt: integer("machine_attempt").notNull().default(0),
    pendingLog: text("pending_log").notNull().default(""),
    machineOperationId: text("machine_operation_id"),
    serverAccessProviderId: text("server_access_provider_id"),
    serverAccessGrantId: text("server_access_grant_id"),
    resource: text("resource", { mode: "json" }).$type<JsonValue>(),
    phase: text("phase")
      .$type<
        | "creating"
        | "active"
        | "suspending"
        | "suspended"
        | "resuming"
        | "removing"
        | "destroyed"
      >()
      .notNull()
      .default("active"),
    suspendedAt: integer("suspended_at"),
    statusMessage: text("status_message"),
    suspendRetryAt: integer("suspend_retry_at"),
    removeRetryAt: integer("remove_retry_at"),
    teardownAttempt: integer("teardown_attempt").notNull().default(0),
    teardownStatus: text("teardown_status").$type<
      "running" | "failed" | "removed"
    >(),
    maxPermissionMode: text("max_permission_mode")
      .$type<PermissionMode>()
      .notNull()
      .default("full"),
    destroyedAt: integer("destroyed_at"),
    lastSeenAt: integer("last_seen_at"),
    lastRejectedProtocolVersion: integer("last_rejected_protocol_version"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("hosts_last_seen_idx").on(table.lastSeenAt),
    index("hosts_pending_provider_idx")
      .on(table.machineProviderId)
      .where(
        sql`${table.destroyedAt} IS NULL AND ${table.phase} <> 'destroyed'`,
      ),
    uniqueIndex("hosts_live_launch_key_idx")
      .on(table.launchKey)
      .where(sql`${table.destroyedAt} is null`),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<ProjectKind>().notNull().default("standard"),
    name: text("name").notNull(),
    gitRemoteUrl: text("git_remote_url"),
    sortKey: text("sort_key").notNull().default("V"),
    deletedAt: integer("deleted_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("projects_updated_idx").on(table.updatedAt),
    index("projects_deleted_idx").on(table.deletedAt),
    index("projects_sort_idx").on(table.sortKey, table.id),
    uniqueIndex("projects_personal_singleton_idx")
      .on(table.kind)
      .where(sql`${table.kind} = 'personal'`),
  ],
);

export const projectExecutionDefaults = sqliteTable(
  "project_execution_defaults",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    serviceTier: text("service_tier").$type<ServiceTier>().notNull(),
    reasoningLevel: text("reasoning_level").$type<ReasoningLevel>().notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("project_execution_defaults_project_idx").on(table.projectId),
  ],
);

export const systemExperiments = sqliteTable("system_experiments", {
  key: text("key").primaryKey(),
  value: integer("value", { mode: "boolean" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const environmentVariables = sqliteTable(
  "environment_variables",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    encryptionVersion: integer("encryption_version").notNull(),
    note: text("note"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environment_variables_global_name")
      .on(table.name)
      .where(sql`${table.projectId} IS NULL`),
    uniqueIndex("environment_variables_project_name")
      .on(table.projectId, table.name)
      .where(sql`${table.projectId} IS NOT NULL`),
  ],
);

export const appSettingsValues = sqliteTable("app_settings_values", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const uiPreferenceDefaults = sqliteTable("ui_preference_defaults", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
});

export const uiPreferences = sqliteTable("ui_preferences", {
  key: text("key").primaryKey(),
  valueJson: text("value_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const appSettings = sqliteTable("app_settings", {
  id: text("id").primaryKey(),
  caffeinate: integer("caffeinate", { mode: "boolean" })
    .notNull()
    .default(false),
  showKeyboardHints: integer("show_keyboard_hints", { mode: "boolean" })
    .notNull()
    .default(true),
  steerActiveThreadOnEnter: integer("steer_active_thread_on_enter", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  showUnhandledProviderEvents: integer("show_unhandled_provider_events", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  codexMemoryEnabled: integer("codex_memory_enabled", { mode: "boolean" })
    .notNull()
    .default(true),
  claudeCodeMemoryEnabled: integer("claude_code_memory_enabled", {
    mode: "boolean",
  })
    .notNull()
    .default(true),
  codexSubagentsDisabled: integer("codex_subagents_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  claudeCodeSubagentsDisabled: integer("claude_code_subagents_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  claudeCodeWorkflowsDisabled: integer("claude_code_workflows_disabled", {
    mode: "boolean",
  })
    .notNull()
    .default(false),
  keybindingOverrides: text("keybinding_overrides").notNull().default("[]"),
  onboardingCompletedAt: text("onboarding_completed_at"),
  updatedAt: integer("updated_at").notNull(),
});

export const installedPlugins = sqliteTable("plugins", {
  id: text("id").primaryKey(),
  source: text("source").notNull(),
  provenance: text("provenance", {
    enum: ["builtin", "direct", "catalog"],
  })
    .notNull()
    .default("direct"),
  catalogEntryId: text("catalog_entry_id"),
  catalogMarketplaceName: text("catalog_marketplace_name"),
  sourceKind: text("source_kind", {
    enum: ["path", "builtin", "npm", "git"],
  })
    .notNull()
    .default("path"),
  sourcePath: text("source_path"),
  sourceBuiltinName: text("source_builtin_name"),
  sourceNpmPackage: text("source_npm_package"),
  sourceNpmRegistry: text("source_npm_registry"),
  sourceNpmRequestedSpec: text("source_npm_requested_spec"),
  sourceNpmSpecKind: text("source_npm_spec_kind", {
    enum: ["default", "exact", "tag", "range"],
  }),
  sourceGitUrl: text("source_git_url"),
  sourceGitSubdirectory: text("source_git_subdirectory"),
  sourceGitRequestedRef: text("source_git_requested_ref"),
  sourceGitRefKind: text("source_git_ref_kind", {
    enum: ["branch", "tag", "commit"],
  }),
  sourceGitRange: text("source_git_range"),
  sourceGitTagPrefix: text("source_git_tag_prefix"),
  sourceGitResolvedTag: text("source_git_resolved_tag"),
  npmResolvedVersion: text("npm_resolved_version"),
  npmIntegrity: text("npm_integrity"),
  gitResolvedCommit: text("git_resolved_commit"),
  lastUpdateCheckAt: integer("last_update_check_at"),
  availableCompatibleVersion: text("available_compatible_version"),
  newestIncompatibleVersion: text("newest_incompatible_version"),
  updateStatusDetail: text("update_status_detail"),
  lastFailureVersion: text("last_failure_version"),
  lastFailureAt: integer("last_failure_at"),
  lastFailureDetail: text("last_failure_detail"),
  activeArtifactId: text("active_artifact_id").references(
    (): AnySQLiteColumn => pluginArtifacts.id,
  ),
  normalizationVersion: integer("normalization_version").notNull().default(0),
  rootDir: text("root_dir").notNull(),
  version: text("version").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  enabledFollowsDefault: integer("enabled_follows_default", { mode: "boolean" })
    .notNull()
    .default(false),
  removedAt: integer("removed_at"),
  installedAt: integer("installed_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginArtifacts = sqliteTable(
  "plugin_artifacts",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    sourceKind: text("source_kind", { enum: ["npm", "git"] }).notNull(),
    npmResolvedVersion: text("npm_resolved_version"),
    gitResolvedCommit: text("git_resolved_commit"),
    gitCheckoutRoot: text("git_checkout_root"),
    path: text("path").notNull(),
    integrity: text("integrity"),
    contentHash: text("content_hash"),
    validationResult: text("validation_result", {
      enum: ["pending", "valid"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    validatedAt: integer("validated_at"),
  },
  (table) => [index("plugin_artifacts_plugin_idx").on(table.pluginId)],
);

export const pluginMarketplaces = sqliteTable("plugin_marketplaces", {
  name: text("name").primaryKey(),
  sourceKind: text("source_kind", { enum: ["https", "git", "path"] })
    .notNull()
    .default("https"),
  manifestUrl: text("manifest_url").notNull(),
  sourceGitRef: text("source_git_ref"),
  sourceGitSubdirectory: text("source_git_subdirectory"),
  sourceGitCommit: text("source_git_commit"),
  manifestJson: text("manifest_json").notNull(),
  statsJson: text("stats_json"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  lastSuccessfulRefreshAt: integer("last_successful_refresh_at"),
  lastAttemptedRefreshAt: integer("last_attempted_refresh_at"),
  lastError: text("last_error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const pluginMarketplaceIcons = sqliteTable(
  "plugin_marketplace_icons",
  {
    marketplaceName: text("marketplace_name").notNull(),
    entryId: text("entry_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    contentType: text("content_type").notNull(),
    etag: text("etag"),
    contentHash: text("content_hash").notNull(),
    bytes: blob("bytes", { mode: "buffer" }).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.marketplaceName, table.entryId] })],
);

export const pluginStateSnapshots = sqliteTable(
  "plugin_state_snapshots",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    fromArtifactId: text("from_artifact_id"),
    toArtifactId: text("to_artifact_id").notNull(),
    snapshotPath: text("snapshot_path").notNull(),
    databasePath: text("database_path"),
    statePath: text("state_path").notNull(),
    secretsPath: text("secrets_path"),
    registrationPath: text("registration_path"),
    status: text("status", {
      enum: [
        "pending",
        "ready",
        "rollback-pending",
        "restoring",
        "restored",
        "failed",
      ],
    }).notNull(),
    rollbackCandidateVersion: text("rollback_candidate_version"),
    rollbackSourceFingerprint: text("rollback_source_fingerprint"),
    rollbackBbVersion: text("rollback_bb_version"),
    rollbackSdkVersion: text("rollback_sdk_version"),
    rollbackDetail: text("rollback_detail"),
    createdAt: integer("created_at").notNull(),
    retainedUntil: integer("retained_until").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("plugin_state_snapshots_plugin_idx").on(table.pluginId),
    index("plugin_state_snapshots_retention_idx").on(table.retainedUntil),
  ],
);

export const pluginKv = sqliteTable(
  "plugin_kv",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginSettings = sqliteTable(
  "plugin_settings",
  {
    pluginId: text("plugin_id").notNull(),
    key: text("key").notNull(),
    value: text("value").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.key] })],
);

export const pluginSchedules = sqliteTable(
  "plugin_schedules",
  {
    pluginId: text("plugin_id").notNull(),
    name: text("name").notNull(),
    cron: text("cron").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    lastRunAt: integer("last_run_at"),
    lastStatus: text("last_status").$type<"running" | "ok" | "error">(),
    lastError: text("last_error"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.pluginId, table.name] })],
);

export const appTheme = sqliteTable("app_theme", {
  id: text("id").primaryKey(),
  themeId: text("theme_id").notNull(),
  faviconColor: text("favicon_color")
    .$type<FaviconColorPreference>()
    .notNull()
    .default("default"),
  updatedAt: integer("updated_at").notNull(),
});

export const projectSources = sqliteTable(
  "project_sources",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").$type<ProjectSourceType>().notNull(),
    hostId: text("host_id").references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path"),
    ownsPath: integer("owns_path", { mode: "boolean" })
      .notNull()
      .default(false),
    isDefault: integer("is_default", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("project_sources_project_idx").on(table.projectId),
    index("project_sources_host_idx").on(table.hostId),
    uniqueIndex("project_sources_project_host_idx").on(
      table.projectId,
      table.hostId,
    ),
    check(
      "project_sources_shape_check",
      sql`(
        ${table.type} = 'local_path' AND ${table.hostId} IS NOT NULL AND ${table.path} IS NOT NULL
      )`,
    ),
  ],
);

export const environments = sqliteTable(
  "environments",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    path: text("path"),
    isGitRepo: integer("is_git_repo", { mode: "boolean" })
      .notNull()
      .default(false),
    isWorktree: integer("is_worktree", { mode: "boolean" })
      .notNull()
      .default(false),
    branchName: text("branch_name"),
    baseBranch: text("base_branch"),
    defaultBranch: text("default_branch"),
    mergeBaseBranch: text("merge_base_branch"),
    environmentProviderId: text("environment_provider_id"),
    environmentProviderPluginId: text("environment_provider_plugin_id"),
    providerOwnsPath: integer("provider_owns_path", { mode: "boolean" })
      .notNull()
      .default(false),
    environmentProviderSelection: text("environment_provider_selection", {
      mode: "json",
    }).$type<EnvironmentProviderSelection>(),
    environmentProviderInstanceKey: text("environment_provider_instance_key"),
    retireAt: integer("retire_at"),
    teardownAttempt: integer("teardown_attempt").notNull().default(0),
    teardownStatus: text("teardown_status").$type<
      "running" | "failed" | "removed"
    >(),
    teardownMessage: text("teardown_message"),
    resource: text("resource", { mode: "json" }).$type<JsonValue>(),
    ownerThreadId: text("owner_thread_id"),
    ownerPlacementOperationId: text("owner_placement_operation_id").references(
      (): AnySQLiteColumn => placementOperations.id,
    ),
    attempt: integer("attempt").notNull().default(0),
    statusMessage: text("status_message"),
    pendingLog: text("pending_log").notNull().default(""),
    claimPath: text("claim_path"),
    status: text("status")
      .$type<EnvironmentStatus>()
      .notNull()
      .default("provisioning"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("environments_project_host_path_idx").on(
      table.projectId,
      table.hostId,
      table.path,
    ),
    index("environments_host_path_lookup_idx").on(table.hostId, table.path),
    uniqueIndex("environments_owner_placement_idx")
      .on(table.ownerPlacementOperationId)
      .where(sql`${table.ownerPlacementOperationId} IS NOT NULL`),
    check(
      "environments_single_owner_check",
      sql`${table.ownerThreadId} IS NULL OR ${table.ownerPlacementOperationId} IS NULL`,
    ),
    uniqueIndex("environments_owner_thread_idx")
      .on(table.ownerThreadId)
      .where(sql`${table.ownerThreadId} IS NOT NULL`),
    index("environments_claim_idx").on(table.hostId, table.claimPath),
    index("environments_project_idx").on(table.projectId),
    index("environments_status_idx").on(table.status),
    index("environments_provider_instance_idx").on(
      table.environmentProviderId,
      table.environmentProviderInstanceKey,
    ),
    index("environments_provider_lifecycle_idx")
      .on(table.environmentProviderId)
      .where(
        sql`${table.status} <> 'destroyed' OR ${table.teardownStatus} IS NOT 'removed'`,
      ),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    providerId: text("provider_id").notNull(),
    modelOverride: text("model_override"),
    reasoningLevelOverride: text(
      "reasoning_level_override",
    ).$type<ReasoningLevel>(),
    title: text("title"),
    titleFallback: text("title_fallback"),
    sectionId: text("section_id").references(() => threadSections.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: threadStatusValues })
      .notNull()
      .default("starting"),
    statusChangedAt: integer("status_changed_at").notNull().default(0),
    startupContext: text("startup_context"),
    parentThreadId: text("parent_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    lifecycleOwnerThreadId: text("lifecycle_owner_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "restrict" },
    ),
    sourceThreadId: text("source_thread_id").references(
      (): AnySQLiteColumn => threads.id,
      { onDelete: "set null" },
    ),
    originKind: text("origin_kind", {
      enum: threadOriginKindValues,
    }),
    originPluginId: text("origin_plugin_id"),
    visibility: text("visibility", { enum: threadVisibilityValues })
      .notNull()
      .default("visible"),
    parentNotifications: text("parent_notifications", {
      enum: threadParentNotificationsValues,
    })
      .notNull()
      .default("auto"),
    archivedAt: integer("archived_at"),
    pinnedAt: integer("pinned_at"),
    pinSortKey: text("pin_sort_key"),
    deletedAt: integer("deleted_at"),
    storageDeletedAt: integer("storage_deleted_at"),
    lastReadAt: integer("last_read_at"),
    latestAttentionAt: integer("latest_attention_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("threads_project_id_idx").on(table.projectId, table.id),
    index("threads_project_updated_idx").on(table.projectId, table.updatedAt),
    index("threads_project_archived_deleted_idx").on(
      table.projectId,
      table.archivedAt,
      table.deletedAt,
      table.id,
    ),
    index("threads_pin_sort_idx")
      .on(table.archivedAt, table.deletedAt, table.pinSortKey, table.id)
      .where(sql`${table.pinnedAt} IS NOT NULL`),
    index("threads_environment_idx").on(table.environmentId),
    index("threads_lifecycle_owner_idx").on(table.lifecycleOwnerThreadId),
    index("threads_parent_idx").on(table.parentThreadId),
    index("threads_source_origin_idx").on(
      table.sourceThreadId,
      table.originKind,
    ),
    index("threads_origin_plugin_archived_idx").on(
      table.originPluginId,
      table.archivedAt,
    ),
    index("threads_section_archived_deleted_idx").on(
      table.sectionId,
      table.archivedAt,
      table.deletedAt,
      table.id,
    ),
    index("threads_archived_status_idx").on(table.archivedAt, table.status),
    index("threads_deleted_cleanup_idx")
      .on(table.deletedAt)
      .where(sql`${table.deletedAt} IS NOT NULL`),
    index("threads_environment_archived_deleted_idx").on(
      table.environmentId,
      table.archivedAt,
      table.deletedAt,
    ),
    index("threads_active_maintenance_idx")
      .on(table.status)
      .where(sql`${table.deletedAt} IS NULL`),
  ],
);

export const threadPluginMetadata = sqliteTable(
  "thread_plugin_metadata",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    metadataJson: text("metadata_json").notNull(),
  },
  (table) => [primaryKey({ columns: [table.threadId, table.pluginId] })],
);

export const threadTabs = sqliteTable("thread_tabs", {
  threadId: text("thread_id")
    .primaryKey()
    .references(() => threads.id, { onDelete: "cascade" }),
  tabsJson: text("tabs_json").notNull(),
  revision: integer("revision").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const threadSections = sqliteTable(
  "thread_sections",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [uniqueIndex("thread_sections_name_idx").on(table.name)],
);

export const threadSearchSegments = sqliteTable(
  "thread_search_segments",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").$type<ThreadSearchSourceKind>().notNull(),
    sourceKey: text("source_key").notNull(),
    sourceSeq: integer("source_seq"),
    text: text("text").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_search_segments_source_idx").on(
      table.threadId,
      table.sourceKind,
      table.sourceKey,
    ),
    index("thread_search_segments_thread_source_seq_idx").on(
      table.threadId,
      table.sourceSeq,
    ),
  ],
);

export const threadConversationOutlines = sqliteTable(
  "thread_conversation_outlines",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "cascade" }),
    projectionKey: text("projection_key").notNull(),
    itemsJson: text("items_json").notNull(),
  },
);

export const threadDynamicContextFileStates = sqliteTable(
  "thread_dynamic_context_file_states",
  {
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    fileKey: text("file_key").notNull(),
    contentStatus: text("content_status")
      .$type<ThreadDynamicContextFileStatus>()
      .notNull(),
    contentHash: text("content_hash").notNull(),
    shownAt: integer("shown_at").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("thread_dynamic_context_file_states_thread_file_idx").on(
      table.threadId,
      table.fileKey,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "set null",
    }),
    scopeKind: text("scope_kind").$type<ThreadEventScopeKind>().notNull(),
    turnId: text("turn_id"),
    providerThreadId: text("provider_thread_id"),
    sequence: integer("sequence").notNull(),
    type: text("type").$type<ThreadEventType>().notNull(),
    itemId: text("item_id"),
    itemKind: text("item_kind").$type<ThreadEventItemType>(),
    parentToolCallId: text("parent_tool_call_id"),
    data: text("data").notNull().default("{}"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("events_thread_sequence_idx").on(
      table.threadId,
      table.sequence,
    ),
    index("events_delegating_item_lookup_idx")
      .on(table.threadId, table.itemId, table.sequence, table.itemKind)
      .where(sql`${table.itemKind} IN ('toolCall', 'delegation')`),
    index("events_plan_steps_thread_sequence_idx")
      .on(table.threadId, table.sequence)
      .where(
        sql`(${table.itemKind} = 'planSteps' AND ${table.type} = 'item/completed') OR ${table.type} = 'turn/plan/updated'`,
      ),
    index("events_parent_tool_call_thread_parent_sequence_idx")
      .on(table.threadId, table.parentToolCallId, table.sequence)
      .where(sql`${table.parentToolCallId} IS NOT NULL`),
    index("events_thread_type_item_kind_sequence_idx").on(
      table.threadId,
      table.type,
      table.itemKind,
      table.sequence,
    ),
    index("events_background_task_thread_type_item_sequence_idx")
      .on(table.threadId, table.type, table.itemId, table.sequence)
      .where(sql`${table.itemKind} = 'backgroundTask'`),
    index("events_thread_type_sequence_idx").on(
      table.threadId,
      table.type,
      table.sequence,
    ),
    index("events_thread_turn_type_item_sequence_idx").on(
      table.threadId,
      table.turnId,
      table.type,
      table.itemId,
      table.sequence,
    ),
    index("events_item_lifecycle_thread_item_sequence_idx")
      .on(table.threadId, table.itemId, table.sequence)
      .where(
        sql`${table.type} IN ('item/started', 'item/completed', 'item/backgroundTask/completed')`,
      ),
    index("events_environment_idx").on(table.environmentId),
    index("events_provider_identity_idx")
      .on(table.providerThreadId, table.createdAt)
      .where(sql`${table.type} = 'thread/identity'`),
    index("events_completed_item_truncation_idx")
      .on(table.itemKind, table.createdAt, table.id)
      .where(sql`${table.type} = 'item/completed'`),
    index("events_thread_state_thread_sequence_idx")
      .on(table.threadId, table.sequence)
      .where(
        sql`${table.type} IN ('thread/goal/updated', 'thread/goal/cleared', 'thread/extensionState/updated')`,
      ),
    check(
      "events_scope_shape_check",
      sql`(
        (${table.scopeKind} = 'turn' AND ${table.turnId} IS NOT NULL)
        OR
        (${table.scopeKind} = 'thread' AND ${table.turnId} IS NULL)
      )`,
    ),
  ],
);

export const retainedEventOutputs = sqliteTable(
  "retained_event_outputs",
  {
    eventId: text("event_id")
      .primaryKey()
      .references(() => events.id, { onDelete: "cascade" }),
    outputPath: text("output_path").$type<RetainedEventOutputPath>().notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("retained_event_outputs_expiry_idx").on(
      table.expiresAt,
      table.eventId,
    ),
  ],
);

export const threadPruningCursors = sqliteTable(
  "thread_pruning_cursors",
  {
    policy: text("policy").notNull(),
    scope: text("scope").notNull().default(""),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    version: integer("version").notNull(),
    lastThreadId: text("last_thread_id").notNull().default(""),
    currentThreadId: text("current_thread_id"),
    step: integer("step").notNull().default(0),
    sequence: integer("sequence").notNull().default(0),
    upperSequence: integer("upper_sequence").notNull().default(0),
    workRevision: integer("work_revision").notNull().default(0),
    cycle: integer("cycle").notNull().default(0),
    latestRootSequence: integer("latest_root_sequence").notNull().default(0),
    latestContextSequence: integer("latest_context_sequence")
      .notNull()
      .default(0),
    probeEventId: text("probe_event_id"),
    probePhase: integer("probe_phase").notNull().default(0),
    probeSequence: integer("probe_sequence").notNull().default(0),
    probeWitnessId: text("probe_witness_id"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.policy, table.scope] }),
    index("thread_pruning_cursors_thread_idx").on(table.threadId),
    check(
      "thread_pruning_cursors_scope_check",
      sql`${table.scope} = coalesce(${table.threadId}, '')`,
    ),
  ],
);

export const maintenanceScanCursors = sqliteTable(
  "maintenance_scan_cursors",
  {
    id: text("id").primaryKey(),
    policy: text("policy").notNull(),
    version: integer("version").notNull(),
    itemKind: text("item_kind").$type<ThreadEventItemType>().notNull(),
    outputPath: text("output_path").notNull(),
    lastCreatedAt: integer("last_created_at").notNull().default(0),
    lastEventId: text("last_event_id").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("maintenance_scan_cursors_path_idx").on(
      table.policy,
      table.version,
      table.itemKind,
      table.outputPath,
    ),
  ],
);

export const promptHistoryEntries = sqliteTable(
  "prompt_history_entries",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    scope: text("scope").$type<PromptHistoryScope>().notNull(),
    requestSequence: integer("request_sequence").notNull(),
    input: text("input").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("prompt_history_entries_thread_request_idx").on(
      table.threadId,
      table.requestSequence,
    ),
    index("prompt_history_entries_project_scope_created_idx").on(
      table.projectId,
      table.scope,
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
    index("prompt_history_entries_created_idx").on(
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
    index("prompt_history_entries_thread_scope_created_idx").on(
      table.threadId,
      table.scope,
      table.createdAt,
      table.requestSequence,
      table.id,
    ),
  ],
);

export const queuedThreadMessages = sqliteTable(
  "queued_thread_messages",
  {
    id: text("id").primaryKey(),
    placementOperationId: text("placement_operation_id").references(
      (): AnySQLiteColumn => placementOperations.id,
    ),
    placementFence: integer("placement_fence"),
    systemNotice: text("system_notice"),
    serviceTurn: text("service_turn", {
      mode: "json",
    }).$type<ServiceTurnDescriptor>(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    senderThreadId: text("sender_thread_id"),
    origin: text("origin", { enum: threadCreateOriginValues }),
    originPluginId: text("origin_plugin_id"),
    requestedByInitiator: text("requested_by_initiator", {
      enum: startedOnBehalfOfInitiatorValues,
    }),
    requestedByThreadId: text("requested_by_thread_id"),
    model: text("model").notNull(),
    reasoningLevel: text("reasoning_level").notNull(),
    permissionMode: text("permission_mode").$type<PermissionMode>().notNull(),
    serviceTier: text("service_tier").notNull(),
    groupWithNext: integer("group_with_next", { mode: "boolean" })
      .notNull()
      .default(false),
    state: text("state", { enum: queuedMessageStateValues }).notNull(),
    sendAt: integer("send_at"),
    waitingOn: text("waiting_on"),
    waitHolder: text("wait_holder").$type<QueuedMessageWaitHolder>(),
    failureReason: text("failure_reason"),
    failureCount: integer("failure_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    payloadKind: text("payload_kind")
      .$type<QueuedMessagePayloadKind>()
      .notNull()
      .default("inline"),
    retryOfTurnRequestId: text("retry_of_turn_request_id"),
    retryAttempt: integer("retry_attempt"),
    retryReason: text("retry_reason"),
    deliveryMode: text("delivery_mode", {
      enum: queuedMessageDeliveryModeValues,
    })
      .notNull()
      .default("steer"),
    coalesceKey: text("coalesce_key"),
    coalesceState: text("coalesce_state"),
    questionId: text("question_id"),
    questionRevision: integer("question_revision"),
    claimedAt: integer("claimed_at"),
    claimToken: text("claim_token"),
    editHeldUntil: integer("edit_held_until"),
    sortKey: text("sort_key").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("queued_thread_messages_placement_idx").on(
      table.placementOperationId,
    ),
    check(
      "queued_thread_messages_placement_check",
      sql`${table.placementFence} IS NULL OR (${table.placementOperationId} IS NOT NULL AND ${table.placementFence} > 0)`,
    ),
    index("queued_thread_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
      table.id,
    ),
    index("queued_thread_messages_thread_sort_idx").on(
      table.threadId,
      table.sortKey,
      table.id,
    ),
    index("queued_thread_messages_due_idx").on(
      table.state,
      table.sendAt,
      table.id,
    ),
    index("queued_thread_messages_retry_idx").on(
      table.state,
      table.nextAttemptAt,
      table.id,
    ),
    index("queued_thread_messages_coalesce_idx")
      .on(table.threadId, table.coalesceKey)
      .where(sql`${table.coalesceKey} IS NOT NULL`),
    index("queued_thread_messages_wait_holder_idx")
      .on(table.waitHolder, table.id)
      .where(sql`${table.waitHolder} IS NOT NULL`),
    check(
      "queued_thread_messages_state_check",
      sql`CASE ${table.state}
        WHEN 'claimed' THEN ${table.claimedAt} IS NOT NULL
        WHEN 'failed_retrying' THEN ${table.claimedAt} IS NULL AND ${table.failureReason} IS NOT NULL AND ${table.nextAttemptAt} IS NOT NULL
        WHEN 'failed_exhausted' THEN ${table.claimedAt} IS NULL AND ${table.failureReason} IS NOT NULL AND ${table.nextAttemptAt} IS NULL
        WHEN 'scheduled' THEN ${table.claimedAt} IS NULL AND ${table.failureReason} IS NULL AND ${table.sendAt} IS NOT NULL
        WHEN 'waiting' THEN ${table.claimedAt} IS NULL AND ${table.failureReason} IS NULL AND ${table.sendAt} IS NULL AND ${table.waitingOn} IS NOT NULL
        WHEN 'queued' THEN ${table.claimedAt} IS NULL AND ${table.failureReason} IS NULL AND ${table.sendAt} IS NULL AND ${table.waitingOn} IS NULL
        ELSE 0
      END`,
    ),
    check(
      "queued_thread_messages_claim_check",
      sql`(${table.claimedAt} IS NULL) = (${table.claimToken} IS NULL)`,
    ),
    check(
      "queued_thread_messages_failure_check",
      sql`(${table.failureReason} IS NULL AND ${table.failureCount} = 0 AND ${table.nextAttemptAt} IS NULL)
        OR (${table.failureReason} IS NOT NULL AND ${table.failureCount} > 0)`,
    ),
    check(
      "queued_thread_messages_schedule_check",
      sql`${table.sendAt} IS NULL OR ${table.waitingOn} IS NOT NULL`,
    ),
    check(
      "queued_thread_messages_wait_holder_check",
      sql`${table.waitHolder} IS (CASE WHEN json_extract(${table.waitingOn}, '$.kind') = 'plugin' THEN 'plugin:' || json_extract(${table.waitingOn}, '$.pluginId') END)`,
    ),
  ],
);
export const hostDaemonSessions = sqliteTable(
  "host_daemon_sessions",
  {
    id: text("id").primaryKey(),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    hostName: text("host_name").notNull(),
    dataDir: text("data_dir").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    heartbeatIntervalMs: integer("heartbeat_interval_ms").notNull(),
    leaseTimeoutMs: integer("lease_timeout_ms").notNull(),
    status: text("status").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    closedAt: integer("closed_at"),
    closeReason: text("close_reason"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("host_daemon_sessions_host_status_idx").on(
      table.hostId,
      table.status,
    ),
    index("host_daemon_sessions_host_latest_idx").on(
      table.hostId,
      table.updatedAt,
      table.createdAt,
      table.id,
    ),
    index("host_daemon_sessions_closed_prune_idx").on(
      table.status,
      table.closedAt,
      table.id,
    ),
  ],
);

export const providerModelCatalogs = sqliteTable(
  "provider_model_catalogs",
  {
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    scopeKey: text("scope_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    modelsJson: text("models_json").notNull(),
    selectedOnlyModelsJson: text("selected_only_models_json").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.hostId, table.providerId, table.scopeKey],
    }),
  ],
);

export const terminalSessions = sqliteTable(
  "terminal_sessions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "cascade",
    }),
    environmentId: text("environment_id").references(() => environments.id, {
      onDelete: "cascade",
    }),
    hostId: text("host_id")
      .notNull()
      .references(() => hosts.id, { onDelete: "cascade" }),
    daemonSessionId: text("daemon_session_id").references(
      () => hostDaemonSessions.id,
      { onDelete: "set null" },
    ),
    title: text("title").notNull(),
    initialCwd: text("initial_cwd").notNull(),
    cols: integer("cols").notNull(),
    rows: integer("rows").notNull(),
    status: text("status").$type<TerminalSessionStatus>().notNull(),
    exitCode: integer("exit_code"),
    closeReason: text("close_reason").$type<TerminalSessionCloseReason>(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    lastUserInputAt: integer("last_user_input_at"),
  },
  (table) => [
    index("terminal_sessions_thread_status_updated_idx").on(
      table.threadId,
      table.status,
      table.updatedAt,
    ),
    index("terminal_sessions_environment_status_idx").on(
      table.environmentId,
      table.status,
    ),
    index("terminal_sessions_status_thread_idx").on(
      table.status,
      table.threadId,
    ),
    index("terminal_sessions_host_status_idx").on(table.hostId, table.status),
    index("terminal_sessions_daemon_session_idx").on(table.daemonSessionId),
    index("terminal_sessions_exited_prune_idx")
      .on(table.updatedAt, table.id)
      .where(sql`${table.status} = 'exited'`),
  ],
);

export const conversationQuestions = sqliteTable(
  "conversation_questions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
    sourceTurnId: text("source_turn_id"),
    sourceCallId: text("source_call_id"),
    status: text("status")
      .$type<ConversationQuestionStatus>()
      .notNull()
      .default("open"),
    publication: text("publication").notNull(),
    materialManifest: text("material_manifest").notNull(),
    response: text("response"),
    queuedMessageId: text("queued_message_id"),
    dispatchedAt: integer("dispatched_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("conversation_questions_thread_created_idx").on(
      table.threadId,
      table.createdAt,
      table.id,
    ),
    index("conversation_questions_thread_status_idx").on(
      table.threadId,
      table.status,
    ),
    uniqueIndex("conversation_questions_source_idx").on(
      table.threadId,
      table.sourceTurnId,
      table.sourceCallId,
    ),
    check(
      "conversation_questions_answer_custody",
      sql`${table.status} != 'answered' OR (${table.response} IS NOT NULL AND ${table.queuedMessageId} IS NOT NULL)`,
    ),
  ],
);

export const questionResolutionEvents = sqliteTable(
  "question_resolution_events",
  {
    id: text("id").primaryKey(),
    targetKind: text("target_kind").$type<"qst" | "pint">().notNull(),
    targetId: text("target_id").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    initial: integer("initial", { mode: "boolean" }).notNull(),
    principal: text("principal").notNull(),
    operationId: text("operation_id").notNull(),
    request: text("request").notNull(),
    attribution: text("attribution").notNull(),
    deliveryId: text("delivery_id"),
    submittedAt: integer("submitted_at"),
  },
  (table) => [
    uniqueIndex("question_resolution_operation_idx").on(
      table.principal,
      table.operationId,
    ),
    uniqueIndex("question_resolution_delivery_idx").on(table.deliveryId),
    uniqueIndex("question_resolution_initial_idx")
      .on(table.targetKind, table.targetId, table.revision)
      .where(sql`${table.initial} = 1`),
    index("question_resolution_target_idx").on(
      table.targetKind,
      table.targetId,
    ),
  ],
);

export const pendingInteractions = sqliteTable(
  "pending_interactions",
  {
    id: text("id").primaryKey(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    originKind: text("origin_kind")
      .$type<"provider" | "plugin">()
      .notNull()
      .default("provider"),
    turnId: text("turn_id"),
    providerId: text("provider_id"),
    providerThreadId: text("provider_thread_id"),
    providerRequestId: text("provider_request_id"),
    pluginId: text("plugin_id"),
    rendererId: text("renderer_id"),
    status: text("status").$type<PendingInteractionStatus>().notNull(),
    payload: text("payload").notNull(),
    resolution: text("resolution"),
    statusReason: text("status_reason"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    resolvedAt: integer("resolved_at"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("pending_interactions_provider_request_idx").on(
      table.providerId,
      table.providerThreadId,
      table.providerRequestId,
    ),
    index("pending_interactions_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("pending_interactions_thread_status_created_idx").on(
      table.threadId,
      table.status,
      table.createdAt,
    ),
    index("pending_interactions_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("pending_interactions_plugin_status_created_idx").on(
      table.pluginId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const environmentHookOperations = sqliteTable(
  "environment_hook_operations",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id").notNull(),
    hostId: text("host_id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").$type<"setup" | "teardown">().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    error: text("error"),
  },
);

export const projectAttachments = sqliteTable(
  "project_attachments",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storedPath: text("stored_path").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull(),
    createdAt: integer("created_at").notNull(),
    readyAt: integer("ready_at"),
    deletionClaimedAt: integer("deletion_claimed_at"),
  },
  (table) => [
    uniqueIndex("project_attachments_project_path_idx").on(
      table.projectId,
      table.storedPath,
    ),
    index("project_attachments_project_created_idx").on(
      table.projectId,
      table.createdAt,
    ),
    index("project_attachments_deletion_idx")
      .on(table.projectId, table.deletionClaimedAt, table.id)
      .where(sql`${table.deletionClaimedAt} IS NOT NULL`),
    check("project_attachments_size_check", sql`${table.sizeBytes} >= 0`),
  ],
);

export const projectAttachmentThreads = sqliteTable(
  "project_attachment_threads",
  {
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => projectAttachments.id, { onDelete: "cascade" }),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.attachmentId, table.threadId] }),
    index("project_attachment_threads_thread_idx").on(table.threadId),
  ],
);

export const threadPruningWork = sqliteTable(
  "thread_pruning_work",
  {
    policy: text("policy").notNull(),
    threadId: text("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.policy, table.threadId] }),
    index("thread_pruning_work_thread_idx").on(table.threadId),
  ],
);

export const projectAttachmentBackfills = sqliteTable(
  "project_attachment_backfills",
  {
    projectId: text("project_id")
      .primaryKey()
      .references(() => projects.id, { onDelete: "cascade" }),
    phase: text("phase")
      .$type<
        | "files"
        | "events"
        | "queue"
        | "history-thread"
        | "history-project"
        | "done"
      >()
      .notNull(),
    threadCursor: text("thread_cursor").notNull(),
    inputCursor: integer("input_cursor").notNull(),
    inputId: text("input_id").notNull(),
    inputSequence: integer("input_sequence").notNull(),
    attemptedAt: integer("attempted_at").notNull(),
    error: text("error"),
  },
);

export const placementOwners = sqliteTable(
  "placement_owner",
  {
    providerId: text("provider_id").primaryKey(),
    ownerPluginId: text("owner_plugin_id").notNull(),
    mode: text("mode", { enum: ["disabled", "managed"] })
      .notNull()
      .default("disabled"),
    revision: integer("revision").notNull(),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    check("placement_owner_mode", sql`${t.mode} IN ('disabled','managed')`),
    check("placement_owner_revision", sql`${t.revision} > 0`),
  ],
);
export const placementCounters = sqliteTable(
  "placement_counter",
  {
    id: integer("id").primaryKey(),
    acceptedSeq: integer("accepted_seq").notNull().default(0),
    allocationSeq: integer("allocation_seq").notNull().default(0),
  },
  (t) => [
    check(
      "placement_counter_singleton",
      sql`${t.id} = 1 AND ${t.acceptedSeq} >= 0 AND ${t.allocationSeq} >= 0`,
    ),
  ],
);
export const placementWorkspaces = sqliteTable(
  "placement_workspace",
  {
    workspaceBindingId: text("workspace_binding_id").notNull(),
    revision: integer("revision").notNull(),
    workspaceDigest: text("workspace_digest").notNull(),
    locationSnapshot: text("location_snapshot").notNull(),
    canonicalDescriptor: text("canonical_descriptor").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceBindingId, t.revision] }),
    uniqueIndex("placement_workspace_ref").on(
      t.workspaceBindingId,
      t.revision,
      t.workspaceDigest,
    ),
  ],
);
export const placementOperations = sqliteTable(
  "placement_operation",
  {
    id: text("id").primaryKey(),
    principalScope: text("principal_scope").notNull(),
    submissionKey: text("submission_key").notNull(),
    acceptedSeq: integer("accepted_seq").notNull().unique(),
    schemaVersion: integer("schema_version").notNull().default(1),
    ownerPluginId: text("owner_plugin_id").notNull(),
    providerId: text("provider_id").notNull(),
    workerId: text("worker_id"),
    kind: text("kind", {
      enum: ["independent", "continuation", "fork", "retry"],
    }).notNull(),
    requestedSelection: text("requested_selection", {
      mode: "json",
    }).$type<AgentSelection>(),
    canonicalRequest: text("canonical_request").notNull(),
    payloadDigest: text("payload_digest").notNull(),
    preparedRequest: text("prepared_request"),
    preparedExecution: text("prepared_execution"),
    attachmentReceipts: text("attachment_receipts"),
    reservedThreadId: text("reserved_thread_id").unique(),
    resolvedWorkspaceId: text("resolved_workspace_id"),
    resolvedWorkspaceRevision: integer("resolved_workspace_revision"),
    resolvedWorkspaceDigest: text("resolved_workspace_digest"),
    phase: text("phase").$type<PlacementPhase>().notNull(),
    revision: integer("revision").notNull().default(1),
    reason: text("reason").$type<PlacementReason>(),
    failedStage: text("failed_stage"),
    binding: text("binding", { mode: "json" }).$type<PlacementBinding>(),
    threadId: text("thread_id"),
    reservationId: text("reservation_id"),
    fence: integer("fence"),
    queuedMessageId: text("queued_message_id").unique(),
    clientTurnRequestId: text("client_turn_request_id"),
    cancelRequested: integer("cancel_requested", { mode: "boolean" })
      .notNull()
      .default(false),
    failedOperationId: text("failed_operation_id"),
    sourceOperationId: text("source_operation_id"),
    consentId: text("consent_id"),
    retryDerivation: text("retry_derivation", {
      mode: "json",
    }).$type<JsonObject>(),
    retryScheduleState: text("retry_schedule_state", {
      enum: ["awaiting_scheduler", "queued"],
    }),
    sendAt: integer("send_at"),
    schedulerRevision: integer("scheduler_revision"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("placement_operation_latest_request_idx").on(t.clientTurnRequestId),
    uniqueIndex("placement_operation_submission").on(
      t.principalScope,
      t.submissionKey,
    ),
    index("placement_operation_pending").on(
      t.ownerPluginId,
      t.providerId,
      t.phase,
      t.acceptedSeq,
      t.id,
    ),
    index("placement_operation_worker_pending").on(
      t.workerId,
      t.phase,
      t.acceptedSeq,
      t.id,
    ),
    foreignKey({
      columns: [
        t.resolvedWorkspaceId,
        t.resolvedWorkspaceRevision,
        t.resolvedWorkspaceDigest,
      ],
      foreignColumns: [
        placementWorkspaces.workspaceBindingId,
        placementWorkspaces.revision,
        placementWorkspaces.workspaceDigest,
      ],
    }),
    check(
      "placement_operation_version",
      sql`${t.schemaVersion} = 1 AND ${t.revision} > 0 AND ${t.acceptedSeq} > 0`,
    ),
    check(
      "placement_operation_kind",
      sql`${t.kind} IN ('independent','continuation','fork','retry')`,
    ),
    check(
      "placement_operation_phase",
      sql`${t.phase} IN ('accepted','materializing','pending','reserved','creating','queued','admitted','starting','active','completed','failed','cancel_requested','cancelled','unknown','refused')`,
    ),
    check(
      "placement_operation_retry",
      sql`(${t.kind} = 'retry' AND ${t.consentId} IS NOT NULL AND ${t.failedOperationId} IS NOT NULL AND ${t.retryScheduleState} IS NOT NULL AND ${t.schedulerRevision} IS NOT NULL AND ${t.retryScheduleState} IN ('awaiting_scheduler','queued') AND ${t.schedulerRevision} >= 0) OR (${t.kind} != 'retry' AND ${t.retryScheduleState} IS NULL AND ${t.schedulerRevision} IS NULL)`,
    ),
    check(
      "placement_operation_reserved_thread",
      sql`${t.reservedThreadId} IS NULL OR ${t.kind} IN ('independent','fork')`,
    ),
    check(
      "placement_operation_workspace",
      sql`(${t.resolvedWorkspaceId} IS NULL AND ${t.resolvedWorkspaceRevision} IS NULL AND ${t.resolvedWorkspaceDigest} IS NULL) OR (${t.resolvedWorkspaceId} IS NOT NULL AND ${t.resolvedWorkspaceRevision} IS NOT NULL AND ${t.resolvedWorkspaceDigest} IS NOT NULL)`,
    ),
  ],
);
export const placementWorkers = sqliteTable(
  "placement_worker",
  {
    ownerPluginId: text("owner_plugin_id").notNull(),
    workerId: text("worker_id").notNull(),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    agentHostId: text("agent_host_id").notNull(),
    generation: text("generation").notNull(),
    providerVersion: text("provider_version").notNull(),
    observationRevision: integer("observation_revision").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    observation: text("observation", { mode: "json" })
      .$type<WorkerObservation>()
      .notNull(),
    available: integer("available", { mode: "boolean" })
      .notNull()
      .default(true),
    slotState: text("slot_state", {
      enum: [
        "free",
        "reserved",
        "resident",
        "active",
        "reclaiming",
        "maintenance",
        "unknown",
      ],
    }).notNull(),
    ownerOperationId: text("owner_operation_id"),
    threadId: text("thread_id"),
    fence: integer("fence").notNull().default(0),
    lastAssignedSeq: integer("last_assigned_seq"),
    reclaimOperationId: text("reclaim_operation_id"),
    reclaimSourceFence: integer("reclaim_source_fence"),
    reclaimHolder: text("reclaim_holder", { mode: "json" }).$type<
      NonNullable<WorkerCustody["holder"]>
    >(),
    physicalLock: text("physical_lock").unique(),
    fenceLock: text("fence_lock", { mode: "json" }).$type<
      NonNullable<WorkerCustody["lock"]>
    >(),
    nativeCustody: text("native_custody", {
      mode: "json",
    }).$type<WorkerCustody>(),
  },
  (t) => [
    primaryKey({ columns: [t.ownerPluginId, t.workerId] }),
    index("placement_worker_provider").on(t.providerId, t.available),
    check(
      "placement_worker_slot",
      sql`${t.slotState} IN ('free','reserved','resident','active','reclaiming','maintenance','unknown')`,
    ),
    check(
      "placement_worker_owner",
      sql`(${t.slotState} != 'free' OR (${t.ownerOperationId} IS NULL AND ${t.threadId} IS NULL AND ${t.reclaimOperationId} IS NULL)) AND (${t.slotState} NOT IN ('reserved','resident','active','reclaiming') OR ${t.ownerOperationId} IS NOT NULL) AND (${t.slotState} != 'reclaiming' OR (${t.reclaimOperationId} IS NOT NULL AND ${t.reclaimSourceFence} IS NOT NULL))`,
    ),
    check(
      "placement_worker_lock_pin",
      sql`(${t.ownerOperationId} IS NULL AND ${t.physicalLock} IS NULL AND ${t.fenceLock} IS NULL) OR (${t.ownerOperationId} IS NOT NULL AND ${t.physicalLock} IS NOT NULL AND json_type(${t.physicalLock},'$[0]') IS 'text' AND json_type(${t.fenceLock},'$.device') IS 'text' AND json_type(${t.fenceLock},'$.inode') IS 'text' AND NOT(json_extract(${t.fenceLock},'$.device') GLOB '0[0-9]*' AND json_extract(${t.fenceLock},'$.device') NOT GLOB '*[^0-9]*') AND NOT(json_extract(${t.fenceLock},'$.inode') GLOB '0[0-9]*' AND json_extract(${t.fenceLock},'$.inode') NOT GLOB '*[^0-9]*') AND ${t.physicalLock}=json_array(json_extract(${t.physicalLock},'$[0]'),json_extract(${t.fenceLock},'$.device'),json_extract(${t.fenceLock},'$.inode')))`,
    ),
    check("placement_worker_fence", sql`${t.fence} >= 0`),
  ],
);
export const placementBindings = sqliteTable(
  "placement_binding",
  {
    threadId: text("thread_id")
      .primaryKey()
      .references(() => threads.id),
    ownerPluginId: text("owner_plugin_id").notNull(),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    workerId: text("worker_id").notNull(),
    agentHostId: text("agent_host_id").notNull(),
    generation: text("generation").notNull(),
    workspaceId: text("workspace_id").notNull(),
    workspaceRevision: integer("workspace_revision").notNull(),
    workspaceDigest: text("workspace_digest").notNull(),
    boundFromOperationId: text("bound_from_operation_id")
      .notNull()
      .unique()
      .references(() => placementOperations.id),
    sourceProviderThreadId: text("source_provider_thread_id"),
    sourceCheckpoint: text("source_checkpoint"),
    runtimeRootKey: text("runtime_root_key").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.workspaceRevision, t.workspaceDigest],
      foreignColumns: [
        placementWorkspaces.workspaceBindingId,
        placementWorkspaces.revision,
        placementWorkspaces.workspaceDigest,
      ],
    }),
  ],
);
export const placementRetryConsents = sqliteTable(
  "placement_retry_consent",
  {
    id: text("consent_id").primaryKey(),
    actionId: text("action_id").notNull(),
    principalScope: text("principal_scope").notNull(),
    submissionKey: text("submission_key").notNull(),
    failedOperationId: text("failed_operation_id")
      .notNull()
      .references(() => placementOperations.id),
    bindingDigest: text("binding_digest").notNull(),
    failedPayloadDigest: text("failed_payload_digest").notNull(),
    allowedAttempts: integer("allowed_attempts").notNull().default(1),
    consumedByOperationId: text("consumed_by_operation_id")
      .unique()
      .references(() => placementOperations.id),
    revokedAt: integer("revoked_at"),
    permissionProvenance: text("permission_provenance", { mode: "json" })
      .$type<PlacementPermissionProvenance>()
      .notNull(),
  },
  (t) => [
    uniqueIndex("placement_consent_action").on(t.principalScope, t.actionId),
    uniqueIndex("placement_consent_submission").on(
      t.principalScope,
      t.submissionKey,
    ),
    check("placement_consent_budget", sql`${t.allowedAttempts} = 1`),
  ],
);

export const placementActionIdentities = sqliteTable(
  "placement_action_identity",
  {
    op: text("op")
      .notNull()
      .primaryKey()
      .references(() => placementOperations.id),
    protocol: text("native_protocol"),
    submissionUuid: text("submission_uuid").unique(),
    authority: text("authority").notNull(),
  },
  (t) => [
    check(
      "placement_action_protocol",
      sql`(${t.protocol} IS NULL)=(${t.submissionUuid} IS NOT NULL)`,
    ),
    check(
      "placement_submission_normalized",
      sql`${t.submissionUuid} IS NULL OR ${t.submissionUuid}=lower(${t.submissionUuid})`,
    ),
    check("placement_authority_json", sql`json_valid(${t.authority})`),
  ],
);
export const placementSteps = sqliteTable(
  "placement_step",
  {
    op: text("op")
      .notNull()
      .references(() => placementActionIdentities.op),
    step: integer("step").notNull(),
    kind: text("kind", { enum: placementStepKinds }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.op, t.step] }),
    check("placement_step_number", sql`${t.step}>=0`),
    check(
      "placement_step_kind",
      sql`${t.kind} IN ('compact','input','retry','answer','clear')`,
    ),
  ],
);
export function unresolvedPlacementEffect(state: AnySQLiteColumn) {
  return sql`${state} IN ('possibly_sent','prepared')`;
}
export const placementRejectionReasons = [
  "managed_execution_unsupported",
  "managed_admission_unavailable",
] as const;
export const placementEffects = sqliteTable(
  "placement_effect",
  {
    request: text("request").notNull().primaryKey(),
    eventId: text("event_id").notNull().unique(),
    requestSequence: integer("request_sequence").notNull(),
    liveEventId: text("live_event_id")
      .unique()
      .references(() => events.id, { onDelete: "set null" }),
    rejectionEventId: text("rejection_event_id").unique(),
    liveRejectionEventId: text("live_rejection_event_id")
      .unique()
      .references(() => events.id, { onDelete: "set null" }),
    rejectionReason: text("rejection_reason", { enum: placementRejectionReasons }),
    thread: text("thread")
      .notNull()
      .references(() => threads.id),
    root: text("root")
      .notNull()
      .references((): AnySQLiteColumn => placementEffects.request),
    executionOwnerOperationId: text("execution_owner_operation_id")
      .notNull()
      .references(() => placementOperations.id),
    nativeExecutionId: text("native_execution_id").unique(),
    agentSessionId: text("agent_session_id"),
    commandId: text("command_id").unique(),
    binding: text("binding").notNull(),
    fence: integer("fence").notNull(),
    execution: text("execution").notNull(),
    state: text("state", { enum: placementEffectStates }).notNull(),
  },
  (t) => [
    check(
      "placement_effect_live_identity",
      sql`${t.liveEventId} IS NULL OR ${t.liveEventId}=${t.eventId}`,
    ),
    check(
      "placement_effect_rejection",
      sql`(${t.rejectionEventId} IS NULL AND ${t.liveRejectionEventId} IS NULL AND ${t.rejectionReason} IS NULL) OR (${t.state} IN ('refused','refused_unsent') AND ${t.rejectionEventId} IS NOT NULL AND (${t.liveRejectionEventId} IS NULL OR ${t.liveRejectionEventId} IS ${t.rejectionEventId}) AND (${t.rejectionReason} IS NULL OR ${t.rejectionReason} IN ('managed_execution_unsupported','managed_admission_unavailable')))`,
    ),
    index("placement_active_effect_owner_fence")
      .on(t.executionOwnerOperationId, t.fence)
      .where(unresolvedPlacementEffect(t.state)),
    check(
      "placement_effect_command_tuple",
      sql`(${t.commandId} IS NULL)=(${t.nativeExecutionId} IS NULL) AND (${t.commandId} IS NULL)=(${t.agentSessionId} IS NULL) AND (${t.commandId} IS NOT NULL OR ${t.state} IN ('prepared','refused_unsent','cancelled'))`,
    ),
    check("placement_effect_fence", sql`${t.fence}>0`),
    check(
      "placement_effect_state",
      sql`${t.state} IN ('prepared','possibly_sent','succeeded','failed_accepted','refused','refused_unsent','cancelled')`,
    ),
  ],
);
export const placementAttempts = sqliteTable(
  "placement_attempt",
  {
    op: text("op").notNull(),
    step: integer("step").notNull(),
    attempt: integer("attempt").notNull(),
    queueId: text("queue_id"),
    queueDigest: text("queue_digest"),
    queueOrdinal: integer("queue_ordinal"),
    request: text("request").references(() => placementEffects.request),
    ordinal: integer("ordinal"),
  },
  (t) => [
    primaryKey({ columns: [t.op, t.step, t.attempt] }),
    foreignKey({
      columns: [t.op, t.step],
      foreignColumns: [placementSteps.op, placementSteps.step],
    }),
    uniqueIndex("placement_attempt_request_member").on(t.request, t.ordinal),
    uniqueIndex("placement_attempt_queue_member").on(t.queueId, t.queueOrdinal),
    index("placement_attempt_queue").on(t.queueId),
    check(
      "placement_attempt_numbers",
      sql`${t.attempt}>=0 AND (${t.queueOrdinal} IS NULL OR ${t.queueOrdinal}>=0) AND (${t.ordinal} IS NULL OR ${t.ordinal}>=0)`,
    ),
    check(
      "placement_attempt_links",
      sql`(${t.queueId} IS NULL)=(${t.queueDigest} IS NULL) AND (${t.queueId} IS NULL)=(${t.queueOrdinal} IS NULL) AND (${t.request} IS NULL)=(${t.ordinal} IS NULL)`,
    ),
  ],
);
export const placementRetryTargets = sqliteTable(
  "placement_retry_target",
  {
    consent: text("consent")
      .notNull()
      .primaryKey()
      .references(() => placementRetryConsents.id),
    failedRequest: text("failed_request")
      .notNull()
      .references(() => placementEffects.request),
    root: text("root")
      .notNull()
      .references(() => placementEffects.request),
    groupDigest: text("group_digest").notNull(),
    state: text("state", { enum: placementRetryStates }).notNull(),
  },
  (t) => [
    uniqueIndex("placement_one_retry")
      .on(t.failedRequest)
      .where(sql`${t.state} IN ('held','scheduled','spent')`),
    uniqueIndex("placement_one_live_chain_retry")
      .on(t.root)
      .where(sql`${t.state} IN ('held','scheduled')`),
    check(
      "placement_retry_state",
      sql`${t.state} IN ('held','scheduled','spent','revoked','expired','superseded')`,
    ),
  ],
);
export const placementGrantKeys = sqliteTable(
  "placement_grant_key",
  {
    principal: text("principal").notNull(),
    transportKey: text("transport_key").notNull(),
    consent: text("consent")
      .notNull()
      .references(() => placementRetryConsents.id),
  },
  (t) => [primaryKey({ columns: [t.principal, t.transportKey] })],
);

export const placementSourceFacts = sqliteTable(
  "placement_source_fact",
  {
    source: text("source").primaryKey().notNull(),
    revision: integer("revision").notNull(),
    bytes: text("bytes").notNull(),
    blockedLock: text("blocked_lock"),
  },
  (t) => [
    index("placement_source_blocked_lock")
      .on(t.blockedLock)
      .where(sql`${t.blockedLock} IS NOT NULL`),
  ],
);
