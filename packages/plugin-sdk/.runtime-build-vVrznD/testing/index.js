// src/internal/ai-generation.ts
import { z } from "zod";

// src/ai-generation.ts
var experimental_AI_MODEL_ID_MAX_LENGTH = 12288;
var experimental_AiGenerationError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AiGenerationError";
  }
  code;
};

// src/internal/ai-generation.ts
var modelSchema = z.object({
  id: z.string().min(1).max(512),
  displayName: z.string().min(1).max(256),
  provider: z.string().min(1).max(256),
  hostId: z.string().min(1).max(256),
  profile: z.string().min(1).max(256),
  capabilities: z.object({
    maxOutputTokens: z.boolean(),
    temperature: z.boolean(),
    reasoningEfforts: z.array(z.string().min(1).max(64)).max(32),
    serviceTiers: z.array(z.string().min(1).max(64)).max(32).default([])
  }).strict()
}).strict();
var requestSchema = z.object({
  model: z.string().min(1).max(experimental_AI_MODEL_ID_MAX_LENGTH),
  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string()
    }).strict()
  ).min(1).max(256),
  maxOutputTokens: z.number().int().min(1).max(131072).nullable(),
  temperature: z.number().min(0).max(2).nullable(),
  reasoningEffort: z.string().min(1).max(64).nullable(),
  serviceTier: z.string().min(1).max(64).nullable().default(null),
  timeoutMs: z.number().int().min(100).max(6e4)
}).strict();
var usageNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
var resultSchema = z.object({
  text: z.string(),
  model: z.string().min(1),
  actualModel: z.string().min(1).max(512).nullable(),
  actualServiceTier: z.string().min(1).max(64).nullable().default(null),
  finishReason: z.enum(["stop", "length"]),
  usage: z.object({
    inputTokens: usageNumber,
    outputTokens: usageNumber,
    cachedInputTokens: usageNumber.nullable()
  }).strict().nullable()
}).strict();
var byteLength = (text) => new TextEncoder().encode(text).length;
var key = (s) => `${s.pluginId}/${s.id}`;
var qualified = (s, m) => `${key(s)}/${encodeURIComponent(m.hostId)}/${encodeURIComponent(m.profile)}/${encodeURIComponent(m.id)}`;
function createAiGenerationDispatcher(list) {
  const active = /* @__PURE__ */ new Map();
  let slots = 0;
  async function bounded(owner, signal, timeoutMs, work, sanitize = true) {
    if (signal?.aborted)
      throw new experimental_AiGenerationError(
        signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        "AI request ended before dispatch"
      );
    if (slots >= 4) throw new experimental_AiGenerationError("busy", "AI generation is busy");
    slots++;
    const controller = new AbortController();
    active.set(controller, owner);
    const cancel = () => controller.abort(
      signal?.reason?.name === "TimeoutError" ? new experimental_AiGenerationError("timeout", "AI request timed out") : new experimental_AiGenerationError("cancelled", "Generation was cancelled")
    );
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(
      () => controller.abort(new experimental_AiGenerationError("timeout", "AI request timed out")),
      timeoutMs
    );
    let rejectAbort;
    const aborted = new Promise((_, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort?.(
      controller.signal.reason instanceof experimental_AiGenerationError ? controller.signal.reason : new experimental_AiGenerationError("cancelled", "Generation was cancelled")
    );
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return work(controller.signal);
    }).finally(() => {
      slots--;
      active.delete(controller);
    });
    try {
      return await Promise.race([pending, aborted]);
    } catch (error) {
      if (error instanceof experimental_AiGenerationError || !sanitize) throw error;
      throw new experimental_AiGenerationError("failed", "AI service request failed");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }
  async function entries(signal, owner) {
    if (signal?.aborted)
      throw new experimental_AiGenerationError(
        signal.reason?.name === "TimeoutError" ? "timeout" : "cancelled",
        "AI request ended before dispatch"
      );
    const found = [];
    for (const service of list()) {
      if (!service.experimental_text || owner !== void 0 && key(service) !== owner)
        continue;
      try {
        const models = await bounded(
          key(service),
          signal,
          1e4,
          (s) => service.experimental_text.models({ signal: s })
        );
        if (!list().includes(service)) continue;
        const parsed = z.array(modelSchema).max(2048).parse(models);
        const ids = /* @__PURE__ */ new Set();
        for (const native of parsed) {
          const id = qualified(service, native);
          if (id.length > experimental_AI_MODEL_ID_MAX_LENGTH)
            throw new experimental_AiGenerationError(
              "failed",
              "Qualified model identity exceeds the shared limit"
            );
          if (ids.has(id))
            throw new experimental_AiGenerationError("failed", "Duplicate model identity");
          ids.add(id);
        }
        found.push(
          ...parsed.map((native) => ({
            service,
            native,
            model: { ...native, id: qualified(service, native) }
          }))
        );
      } catch (error) {
        if (signal?.aborted || error instanceof experimental_AiGenerationError && error.code === "busy")
          throw error;
      }
    }
    return found;
  }
  return {
    async models(options = {}) {
      const signal = AbortSignal.any([
        AbortSignal.timeout(1e4),
        ...options.signal ? [options.signal] : []
      ]);
      return (await entries(signal)).map((item) => item.model);
    },
    async generate(input, options = {}) {
      const parsed = requestSchema.safeParse(input);
      if (!parsed.success || byteLength(JSON.stringify(input)) > 262144)
        throw new experimental_AiGenerationError(
          "invalid_request",
          "Invalid or oversized generation request"
        );
      const request = parsed.data;
      const conversationStart = request.messages.findIndex(
        (message) => message.role !== "system"
      );
      if (conversationStart !== -1 && request.messages.slice(conversationStart).some((message) => message.role === "system")) {
        throw new experimental_AiGenerationError(
          "unsupported",
          "System messages must precede conversation messages"
        );
      }
      const signal = AbortSignal.any([
        AbortSignal.timeout(request.timeoutMs),
        ...options.signal ? [options.signal] : []
      ]);
      const selected = (await entries(signal, request.model.split("/").slice(0, 2).join("/"))).find((item) => item.model.id === request.model);
      if (!selected)
        throw new experimental_AiGenerationError("unavailable", "Selected model is unavailable");
      const { service, native } = selected;
      if (request.maxOutputTokens !== null && !native.capabilities.maxOutputTokens || request.temperature !== null && !native.capabilities.temperature || request.serviceTier !== null && !native.capabilities.serviceTiers.includes(request.serviceTier) || request.reasoningEffort !== null && !native.capabilities.reasoningEfforts.includes(
        request.reasoningEffort
      ))
        throw new experimental_AiGenerationError(
          "unsupported",
          "Selected model does not support the requested options"
        );
      return bounded(
        key(service),
        signal,
        request.timeoutMs,
        async (signal2) => {
          if (!list().includes(service) || !service.experimental_text)
            throw new experimental_AiGenerationError("unavailable", "Selected service is unavailable");
          const raw = await service.experimental_text.generate(
            { ...request, model: native.id },
            { signal: signal2, model: native }
          );
          const result = resultSchema.parse(raw);
          if (!list().includes(service))
            throw new experimental_AiGenerationError("unavailable", "Selected service was replaced");
          if (result.model !== native.id || byteLength(result.text) > 1048576)
            throw new experimental_AiGenerationError(
              "failed",
              "AI service returned an invalid result"
            );
          if (result.usage?.cachedInputTokens != null && result.usage.cachedInputTokens > result.usage.inputTokens)
            throw new experimental_AiGenerationError("failed", "AI service returned invalid usage");
          return { ...result, model: request.model };
        }
      );
    },
    complete(service, prompt, signal) {
      return bounded(
        key(service),
        signal,
        6e4,
        async (current) => {
          if (!list().includes(service) || !service.complete)
            throw new experimental_AiGenerationError("unavailable", "AI service is unavailable");
          if (byteLength(prompt) > 262144)
            throw new experimental_AiGenerationError("invalid_request", "Prompt is too large");
          const text = await service.complete(prompt, { signal: current });
          if (typeof text !== "string" || byteLength(text) > 1048576)
            throw new experimental_AiGenerationError(
              "failed",
              "AI service returned an invalid result"
            );
          return text;
        },
        false
      );
    },
    invalidate(owner) {
      for (const [controller, id] of active)
        if (id === owner)
          controller.abort(
            new experimental_AiGenerationError("unavailable", "AI service was unloaded")
          );
    }
  };
}

// src/rpc-contract.ts
var rpcErrorCodes = [
  "forbidden",
  "not_found",
  "conflict",
  "invalid",
  "invalid_json",
  "invalid_input",
  "handler_error",
  "invalid_output",
  "non_json_result",
  "unknown_method",
  "transport_error",
  "invalid_response",
  "unknown_error"
];
var callErrorBrand = /* @__PURE__ */ Symbol.for("@get-bb/plugin-sdk/rpc-call-error");
var experimental_PluginRpcCallError = class _experimental_PluginRpcCallError extends Error {
  /** Recognizes errors across the packed SDK's separately bundled entries. */
  static [Symbol.hasInstance](value) {
    return typeof value === "object" && value !== null && Reflect.get(value, callErrorBrand) === true && rpcErrorCodes.some((code) => code === Reflect.get(value, "code")) && typeof Reflect.get(value, "message") === "string";
  }
  code;
  issues;
  status;
  serverCode;
  constructor(args) {
    super(args.message);
    this.name = "experimental_PluginRpcCallError";
    Object.defineProperty(this, callErrorBrand, { value: true });
    this.code = args.code;
    this.issues = args.issues;
    this.status = args.status;
    this.serverCode = args.serverCode;
  }
  /** Normalize failures at the RPC boundary; preserves an existing client error. */
  static from(error, fallback = "transport_error") {
    if (error instanceof _experimental_PluginRpcCallError) return error;
    const record = typeof error === "object" && error !== null ? error : {};
    const rawCode = Reflect.get(record, "code");
    const code = rpcErrorCodes.find((value) => value === rawCode);
    const message = Reflect.get(record, "message");
    const status = Reflect.get(record, "status");
    const rawIssues = Reflect.get(record, "issues");
    const issues = [];
    if (Array.isArray(rawIssues))
      for (const issue of rawIssues) {
        if (typeof issue !== "object" || issue === null || typeof Reflect.get(issue, "message") !== "string")
          continue;
        const path = Reflect.get(issue, "path");
        if (path !== void 0 && (!Array.isArray(path) || !path.every(
          (part) => typeof part === "string" || typeof part === "number" && Number.isFinite(part)
        )))
          continue;
        issues.push({
          message: Reflect.get(issue, "message"),
          ...path === void 0 ? {} : { path }
        });
      }
    return new _experimental_PluginRpcCallError({
      code: code ?? (typeof rawCode === "string" ? "unknown_error" : fallback),
      message: typeof message === "string" ? message : typeof error === "string" ? error : "Plugin RPC request failed",
      ...issues.length === 0 ? {} : { issues },
      ...typeof status === "number" ? { status } : {},
      ...typeof rawCode === "string" && code === void 0 ? { serverCode: rawCode } : {}
    });
  }
};
var refusalBrand = /* @__PURE__ */ Symbol.for("@get-bb/plugin-sdk/rpc-refusal");
var experimental_PluginRpcRefusal = class extends Error {
  [refusalBrand] = true;
  code;
  issues;
  constructor(args) {
    super(args.message);
    this.name = "experimental_PluginRpcRefusal";
    this.code = args.code;
    this.issues = args.issues;
  }
};

// src/internal/rpc-tags.ts
import { z as z2 } from "zod";
var rpcInvalidationTags = z2.array(z2.string().min(1)).min(1);
function rpcResponseTags(declarations, input, output) {
  const tags = z2.array(z2.string().min(1)).parse(declarations.tags?.(input, output) ?? []);
  const keyTags = {};
  if (declarations.keyTags && typeof output === "object" && output !== null && !Array.isArray(output)) {
    for (const [key2, value] of Object.entries(output)) {
      keyTags[key2] = z2.array(z2.string().min(1)).parse(declarations.keyTags(key2, value));
    }
  }
  const invalidated = z2.array(z2.string().min(1)).parse(declarations.invalidates?.(input, output) ?? []);
  return { tags, keyTags, invalidated };
}

// ../domain/src/provider-skill-roots.ts
function isAbsoluteProviderSkillRootPath(value) {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  const drive = /^[a-zA-Z]:\//u.exec(normalized);
  const rest = drive ? normalized.slice(drive[0].length) : normalized.slice(1);
  if (!drive && !normalized.startsWith("/")) {
    return false;
  }
  return rest.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
function isRelativeProviderSkillRootPath(value) {
  if (value.length === 0) {
    return false;
  }
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[a-zA-Z]:\//u.test(normalized) && normalized.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

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

// ../domain/src/native-roots.ts
import { z as z4 } from "zod";
var PROVIDER_NATIVE_ROOTS_MAX = 32;
var PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}:$/u;
var nativeRootNamePrefixSchema = z4.string().refine(
  (value) => value === "" || PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN.test(value),
  "A root name prefix is a plugin-name-like token ending in ':'"
);
var nativeRootManifestPathSchema = z4.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "A manifest marker is a relative path without dot segments"
);
var relativeNativeRootPathSchema = z4.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Roots must be relative paths without dot segments"
);
var absoluteNativeRootPathSchema = z4.string().min(1).refine(
  isAbsoluteProviderSkillRootPath,
  "Absolute roots must be absolute paths without dot segments"
);
var providerNativeRootInputSchema = z4.union([
  z4.string().min(1),
  z4.object({
    path: z4.string().min(1),
    /** Skills nest in subdirectories (the agent scans recursively). */
    recursive: z4.boolean().optional(),
    /**
     * Scan the same relative directory in every ancestor of the workspace
     * up to the repository root (`project` roots only).
     */
    ancestors: z4.boolean().optional(),
    /**
     * Prepended to every name under the root, a vendor plugin's
     * `plugin-name:`; a prefixed root is listed as a plugin root.
     */
    namePrefix: nativeRootNamePrefixSchema.optional(),
    /**
     * A file, relative to a skill directory under this root, that marks the
     * directory as a vendor plugin rather than a skill (Claude's
     * `.claude-plugin/plugin.json`): bb skips such a directory. The plugin
     * that knows the vendor layout declares it; core names no vendor path.
     */
    skipIfManifest: nativeRootManifestPathSchema.optional()
  }).strict()
]);
var providerNativeRootsInputSchema = z4.object({
  user: z4.array(providerNativeRootInputSchema).optional(),
  project: z4.array(providerNativeRootInputSchema).optional()
}).strict();
var providerNativeRootSchema = z4.object({
  path: z4.string().min(1),
  recursive: z4.boolean(),
  ancestors: z4.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  /** Absent: every skill-shaped directory under the root is a skill. */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
function uniqueByPath(roots) {
  return new Set(roots.map((root) => root.path)).size === roots.length;
}
function nativeRootSideSchema(side) {
  return z4.array(
    providerNativeRootSchema.extend({ path: relativeNativeRootPathSchema }).superRefine((root, context) => {
      if (root.ancestors && side !== "project") {
        context.addIssue({
          code: "custom",
          message: "Only project roots may walk ancestors"
        });
      }
    })
  ).max(PROVIDER_NATIVE_ROOTS_MAX).refine(uniqueByPath, "Roots must not repeat a path");
}
var providerNativeRootsSchema = z4.object({
  user: nativeRootSideSchema("user"),
  project: nativeRootSideSchema("project")
}).strict();
var EMPTY_PROVIDER_NATIVE_ROOTS = Object.freeze({
  user: Object.freeze([]),
  project: Object.freeze([])
});
function normalizeProviderNativeRoot(entry) {
  if (typeof entry === "string") {
    return { path: entry, recursive: false, ancestors: false, namePrefix: "" };
  }
  return {
    path: entry.path,
    recursive: entry.recursive ?? false,
    ancestors: entry.ancestors ?? false,
    namePrefix: entry.namePrefix ?? "",
    ...entry.skipIfManifest === void 0 ? {} : { skipIfManifest: entry.skipIfManifest }
  };
}
function normalizeProviderNativeRoots(roots) {
  return {
    user: (roots?.user ?? []).map(normalizeProviderNativeRoot),
    project: (roots?.project ?? []).map(normalizeProviderNativeRoot)
  };
}
var providerResolvedNativeRootShapeSchema = z4.enum([
  "skills",
  "skill",
  "skill-file",
  "commands",
  "command-file"
]);
var resolvedNativeRootFieldsSchema = z4.object({
  path: absoluteNativeRootPathSchema,
  origin: z4.enum(["user", "project"]),
  recursive: z4.boolean(),
  /** Only with origin `project`, for a path inside the workspace. */
  ancestors: z4.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  shape: providerResolvedNativeRootShapeSchema,
  /**
   * `skill-file` only: the skill name when the file's frontmatter names
   * none. A vendor plugin's root SKILL.md takes the plugin's name; absent
   * means the parent directory's name.
   */
  fallbackName: z4.string().min(1).optional(),
  /**
   * `skills` only: a file, relative to a skill directory under this root,
   * that marks the directory as a vendor plugin rather than a skill; the
   * daemon skips such a directory (see the declared root's `skipIfManifest`).
   */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
var providerResolvedNativeRootSchema = resolvedNativeRootFieldsSchema.superRefine((root, context) => {
  if (root.skipIfManifest !== void 0 && root.shape !== "skills") {
    context.addIssue({
      code: "custom",
      message: "Only a skills root carries a manifest marker"
    });
  }
  if (root.ancestors && root.origin !== "project") {
    context.addIssue({
      code: "custom",
      message: "Only project roots may walk ancestors"
    });
  }
  if (root.fallbackName !== void 0 && root.shape !== "skill-file") {
    context.addIssue({
      code: "custom",
      message: "Only a skill-file root carries a fallback name"
    });
  }
});
var providerResolvedNativeRootInputSchema = resolvedNativeRootFieldsSchema.partial({
  recursive: true,
  ancestors: true,
  namePrefix: true,
  shape: true
});
var resolvedSkillShapes = /* @__PURE__ */ new Set([
  "skills",
  "skill",
  "skill-file"
]);
var resolvedCommandShapes = /* @__PURE__ */ new Set([
  "commands",
  "command-file"
]);
var PROVIDER_RESOLVED_NATIVE_ROOTS_MAX = 256;
var providerResolvedNativeRootsSchema = z4.object({
  skills: z4.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedSkillShapes.has(root.shape),
      "A skills root needs a skill shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX),
  commands: z4.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedCommandShapes.has(root.shape),
      "A commands root needs a command shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX)
}).strict();
var EMPTY_PROVIDER_RESOLVED_NATIVE_ROOTS = Object.freeze({
  skills: Object.freeze([]),
  commands: Object.freeze([])
});
var providerNativeRootSetSchema = z4.object({
  skills: providerNativeRootsSchema,
  commands: providerNativeRootsSchema,
  resolved: providerResolvedNativeRootsSchema
}).strict();

// ../domain/src/completed-turn-display.ts
import { z as z5 } from "zod";
var COMPLETED_TURN_DISPLAY_VALUES = ["collapse", "flat"];
var completedTurnDisplaySchema = z5.enum(COMPLETED_TURN_DISPLAY_VALUES);
var DEFAULT_COMPLETED_TURN_DISPLAY = "collapse";

// ../domain/src/plugin-interaction-limits.ts
var PLUGIN_INTERACTION_MAX_TITLE_LENGTH = 160;
var PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES = 64 * 1024;
var PLUGIN_INTERACTION_MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1e3;

// ../domain/src/plugin-icon.ts
function isPluginOwnedIconPath(icon) {
  return icon.startsWith("./");
}
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

// ../domain/src/plugin-metadata.ts
var PLUGIN_METADATA_MAX_BYTES = 256 * 1024;
function exceedsPluginMetadataLimit(metadataJson) {
  return new TextEncoder().encode(metadataJson).byteLength > PLUGIN_METADATA_MAX_BYTES;
}
var pluginMetadataSchema = jsonObjectSchema.superRefine(
  (value, ctx) => {
    if (exceedsPluginMetadataLimit(JSON.stringify(value))) {
      ctx.addIssue({
        code: "custom",
        message: "pluginMetadata exceeds 256 KiB"
      });
    }
  }
);
function assertPlainJsonData(value, seen) {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) throw new Error("pluginMetadata contains a cycle");
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) {
    throw new Error("pluginMetadata must contain plain JSON data");
  }
  seen.add(value);
  for (const child of array ? value : Object.values(value)) {
    assertPlainJsonData(child, seen);
  }
  seen.delete(value);
}
function validatePluginMetadata(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("pluginMetadata must be a plain JSON object");
  }
  assertPlainJsonData(value, /* @__PURE__ */ new Set());
  return pluginMetadataSchema.parse(value);
}
function deepFreezeJsonValue(value) {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) deepFreezeJsonValue(child);
  Object.freeze(value);
}
function deepFreezePluginMetadata(metadata) {
  deepFreezeJsonValue(metadata);
  return metadata;
}

// ../domain/src/provider-fork.ts
import { z as z6 } from "zod";
var PROVIDER_FORK_VALUES = ["none", "tip", "checkpoint"];
var providerForkSchema = z6.enum(PROVIDER_FORK_VALUES);

// src/internal/host-policy.ts
import { createHash } from "node:crypto";
import { z as z7 } from "zod";

// ../domain/src/plugin-cli.ts
var RESERVED_BB_CLI_COMMANDS = [
  "browser",
  "diagnostics",
  "environment",
  "file",
  "guide",
  "help",
  "machine",
  "marketplace",
  "plugin",
  "project",
  "prompt-history",
  "provider",
  "server",
  "settings",
  "skill",
  "status",
  "terminal",
  "theme",
  "thread",
  "updates",
  "voice"
];

// src/backend-contract.ts
var PLUGIN_CLI_OUTPUT_MAX_BYTES = 32 * 1024 * 1024;

// src/internal/host-policy.ts
function pluginCliCollisionWarning(pluginId, commandName) {
  if (!RESERVED_BB_CLI_COMMANDS.includes(commandName)) return null;
  return `CLI command "${commandName}" collides with core command "bb ${commandName}"; core keeps the short form. Use "bb plugin run ${pluginId}" to invoke this plugin.`;
}
var RESERVED_AGENT_TOOL_NAMES = [
  "update_environment_directory",
  "bb_update_plan"
];
var KV_VALUE_MAX_BYTES = 256 * 1024;
var PLUGIN_HTTP_METHODS = /* @__PURE__ */ new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS"
]);
var RPC_METHOD_PATTERN = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/;
var BACKGROUND_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
var CLI_COMMAND_NAME_PATTERN = /^[a-z0-9-]+$/;
var AGENT_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
var PLUGIN_PROVIDER_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
var PLUGIN_PROVIDER_ENV_MAX_ENTRIES = 32;
var pluginProviderEnvEntrySchema = z7.object({
  name: z7.string().regex(PLUGIN_PROVIDER_ENV_NAME_PATTERN),
  value: z7.union([
    z7.string(),
    z7.object({ serverPath: z7.string().startsWith("/") }).strict()
  ]),
  reason: z7.string()
}).strict();
var pluginProviderEnvEntriesSchema = z7.array(pluginProviderEnvEntrySchema).max(PLUGIN_PROVIDER_ENV_MAX_ENTRIES).superRefine((entries, context) => {
  const names = /* @__PURE__ */ new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const name = entries[index]?.name;
    if (name !== void 0 && names.has(name)) {
      context.addIssue({
        code: "custom",
        path: [index, "name"],
        message: "must be unique within one resolver"
      });
    }
    if (name !== void 0) names.add(name);
  }
});
function validatePluginProviderEnvEntries(value) {
  const parsed = pluginProviderEnvEntriesSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `[${issue.path.join(".")}] ` : "";
    throw new Error(
      `provider environment contribution ${path}${issue?.message ?? "is invalid"}`
    );
  }
  return parsed.data;
}
var PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS = 4096;
var PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS = 80;
var PLUGIN_AGENT_SELECTION_MAX_IDS = 256;
var PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS = 32768;
var PLUGIN_AGENT_TOOL_PARAMETERS_MAX_BYTES = 128 * 1024;
var MENTION_PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
var PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
var PLUGIN_PROVIDER_BRIDGE_OPTIONS_MAX_BYTES = 64 * 1024;
var SETTING_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
var settingsBaseFields = {
  label: z7.string().min(1),
  description: z7.string().min(1).optional()
};
var stringSettingSchemaSchema = z7.custom(
  (value) => isStandardSchema(value)
);
var booleanSettingSchemaSchema = z7.custom(
  (value) => isStandardSchema(value)
);
var numberSettingSchemaSchema = z7.custom(
  (value) => isStandardSchema(value)
);
var settingDescriptorSchema = z7.discriminatedUnion("type", [
  z7.object({
    type: z7.literal("string"),
    ...settingsBaseFields,
    secret: z7.literal(true).optional(),
    experimental_multiline: z7.boolean().optional(),
    experimental_schema: stringSettingSchemaSchema.optional(),
    default: z7.string().optional()
  }).strict().refine(
    (descriptor) => !(descriptor.secret === true && descriptor.experimental_multiline === true),
    {
      message: "a secret setting cannot be experimental_multiline",
      path: ["experimental_multiline"]
    }
  ),
  z7.object({
    type: z7.literal("boolean"),
    ...settingsBaseFields,
    experimental_schema: booleanSettingSchemaSchema.optional(),
    default: z7.boolean().optional()
  }).strict(),
  z7.object({
    type: z7.literal("number"),
    ...settingsBaseFields,
    experimental_schema: numberSettingSchemaSchema.optional(),
    default: z7.number().finite().optional()
  }).strict(),
  z7.object({
    type: z7.literal("select"),
    ...settingsBaseFields,
    options: z7.array(z7.string().min(1)).min(1),
    experimental_optionLabels: z7.record(z7.string().min(1), z7.string().min(1)).optional(),
    experimental_schema: stringSettingSchemaSchema.optional(),
    default: z7.string().optional()
  }).strict(),
  z7.object({
    type: z7.literal("project"),
    ...settingsBaseFields,
    experimental_schema: stringSettingSchemaSchema.optional(),
    default: z7.string().optional()
  }).strict()
]);
function registerSettingDescriptors(target, added) {
  const validated = {};
  for (const [key2, raw] of Object.entries(added)) {
    if (!SETTING_KEY_PATTERN.test(key2)) {
      throw new Error(
        `invalid setting key "${key2}" \u2014 use letters, digits, "-" and "_"`
      );
    }
    if (key2 === "__proto__") {
      throw new Error(`setting key "${key2}" is reserved`);
    }
    if (Object.hasOwn(target, key2)) {
      throw new Error(`setting "${key2}" is already defined`);
    }
    const parsed = settingDescriptorSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      throw new Error(
        `invalid descriptor for setting "${key2}"${path ? ` (${path})` : ""}: ${issue?.message ?? "unknown error"}`
      );
    }
    const descriptor = parsed.data;
    if (descriptor.type === "select" && descriptor.default !== void 0 && !descriptor.options.includes(descriptor.default)) {
      throw new Error(
        `default for setting "${key2}" must be one of its options`
      );
    }
    if (descriptor.type === "select") {
      const unknownLabel = Object.keys(
        descriptor.experimental_optionLabels ?? {}
      ).find((option) => !descriptor.options.includes(option));
      if (unknownLabel !== void 0) {
        throw new Error(
          `label for setting "${key2}" names "${unknownLabel}", which is not one of its options`
        );
      }
    }
    if (descriptor.default !== void 0) {
      const errors = validateSettingsUpdate(
        { [key2]: descriptor },
        { [key2]: descriptor.default }
      );
      if (errors.length > 0) {
        throw new Error(`invalid default for setting "${key2}": ${errors[0]}`);
      }
    }
    validated[key2] = descriptor;
  }
  Object.assign(target, validated);
  return validated;
}
function settingSchemaError(key2, schema, value) {
  if (schema === void 0) return null;
  try {
    const result = schema["~standard"].validate(value);
    if (result instanceof Promise) {
      return `schema for setting "${key2}" must validate synchronously`;
    }
    if (result.issues !== void 0) {
      return result.issues[0]?.message ?? `schema for setting "${key2}" rejected the value`;
    }
    if (result.value !== value) {
      return `schema for setting "${key2}" must not transform its value`;
    }
    return null;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return `schema for setting "${key2}" failed: ${detail}`;
  }
}
function validateSettingsUpdate(descriptors, values) {
  const errors = [];
  for (const [key2, value] of Object.entries(values)) {
    const descriptor = Object.hasOwn(
      descriptors,
      key2
    ) ? descriptors[key2] : void 0;
    if (!descriptor) {
      errors.push(`unknown setting "${key2}"`);
      continue;
    }
    if (value === null) continue;
    if (descriptor.type === "boolean") {
      if (typeof value !== "boolean") {
        errors.push(`setting "${key2}" expects a boolean`);
        continue;
      }
      const validationError2 = settingSchemaError(
        key2,
        descriptor.experimental_schema,
        value
      );
      if (validationError2 !== null) {
        errors.push(validationError2);
      }
      continue;
    }
    if (descriptor.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`setting "${key2}" expects a finite number`);
        continue;
      }
      const validationError2 = settingSchemaError(
        key2,
        descriptor.experimental_schema,
        value
      );
      if (validationError2 !== null) {
        errors.push(validationError2);
      }
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`setting "${key2}" expects a string`);
      continue;
    }
    if (descriptor.type === "select" && !descriptor.options.includes(value)) {
      errors.push(
        `setting "${key2}" must be one of: ${descriptor.options.join(", ")}`
      );
      continue;
    }
    const validationError = settingSchemaError(
      key2,
      descriptor.experimental_schema,
      value
    );
    if (validationError !== null) {
      errors.push(validationError);
    }
  }
  return errors;
}
function coerceStoredPluginSettingValue(descriptor, value) {
  let coerced = value;
  if (descriptor.type === "number" && typeof coerced === "string") {
    const legacyNumber = Number(coerced.trim());
    coerced = coerced.trim().length > 0 && Number.isFinite(legacyNumber) ? legacyNumber : void 0;
  }
  if (descriptor.type === "number" && typeof coerced === "number" && !Number.isFinite(coerced)) {
    coerced = void 0;
  }
  const expected = descriptor.type === "boolean" ? "boolean" : descriptor.type === "number" ? "number" : "string";
  if (typeof coerced !== expected) coerced = void 0;
  if (descriptor.type === "select" && typeof coerced === "string" && !descriptor.options.includes(coerced)) {
    coerced = void 0;
  }
  return coerced ?? descriptor.default;
}
var PLUGIN_MENTION_TRIGGER_VALUES = [
  "@",
  "#",
  "$",
  "!",
  "~"
];
var DEFAULT_PLUGIN_MENTION_TRIGGERS = [
  "@"
];
function isPluginMentionTrigger(value) {
  return typeof value === "string" && PLUGIN_MENTION_TRIGGER_VALUES.includes(value);
}
function normalizeMentionProviderTriggers(providerId, triggers) {
  if (triggers === void 0) {
    return DEFAULT_PLUGIN_MENTION_TRIGGERS;
  }
  if (!Array.isArray(triggers)) {
    throw new Error(
      `mention provider "${providerId}" triggers must be an array`
    );
  }
  if (triggers.length === 0) {
    throw new Error(
      `mention provider "${providerId}" triggers must include at least one trigger`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const trigger of triggers) {
    if (!isPluginMentionTrigger(trigger)) {
      throw new Error(
        `mention provider "${providerId}" trigger ${JSON.stringify(trigger)} is invalid; use one of ${PLUGIN_MENTION_TRIGGER_VALUES.join(" ")}`
      );
    }
    if (seen.has(trigger)) {
      throw new Error(
        `mention provider "${providerId}" trigger ${JSON.stringify(trigger)} is duplicated`
      );
    }
    seen.add(trigger);
    normalized.push(trigger);
  }
  return normalized;
}
var PLUGIN_PROVIDER_DISPLAY_NAME_MAX_CHARS = 80;
var PLUGIN_PROVIDER_PERMISSION_MODE_VALUES = [
  "accept-edits",
  "auto",
  "full"
];
var PLUGIN_PROVIDER_REASONING_LEVEL_VALUES = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra"
];
var PLUGIN_PROVIDER_COMPOSER_ACTION_VALUES = [
  "plan",
  "goal"
];
function validateProviderRelativePath(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`provider ${label} must be a non-blank relative path`);
  }
  if (value.includes("\\")) {
    throw new Error(
      `provider ${label} must use "/" separators, got ${JSON.stringify(value)}`
    );
  }
  if (value.startsWith("/")) {
    throw new Error(
      `provider ${label} must be relative, got ${JSON.stringify(value)}`
    );
  }
  if (value.split("/").some((segment) => segment === "..")) {
    throw new Error(
      `provider ${label} must not escape the plugin directory, got ${JSON.stringify(value)}`
    );
  }
  return value;
}
function validateProviderLiteralArray(args) {
  const { providerId, field, value, allowed, requireNonEmpty } = args;
  if (!Array.isArray(value)) {
    throw new Error(`provider "${providerId}" ${field} must be an array`);
  }
  if (requireNonEmpty && value.length === 0) {
    throw new Error(
      `provider "${providerId}" ${field} must include at least one entry`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const normalized = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.includes(entry)) {
      throw new Error(
        `provider "${providerId}" ${field} entry ${JSON.stringify(entry)} is invalid; use one of ${allowed.join(", ")}`
      );
    }
    const literal = entry;
    if (seen.has(literal)) {
      throw new Error(
        `provider "${providerId}" ${field} entry ${JSON.stringify(entry)} is duplicated`
      );
    }
    seen.add(literal);
    normalized.push(literal);
  }
  return Object.freeze(normalized);
}
function normalizeProviderBridgeOptions(providerId, value, label = "experimental_bridgeOptions") {
  const active = /* @__PURE__ */ new Set();
  function visit(current, path) {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(
          `provider "${providerId}" ${label}${path} must be finite JSON`
        );
      }
      return current;
    }
    if (typeof current !== "object") {
      throw new Error(`provider "${providerId}" ${label}${path} must be JSON`);
    }
    if (active.has(current)) {
      throw new Error(
        `provider "${providerId}" experimental_bridgeOptions must not contain cycles`
      );
    }
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const normalized3 = current.map(
          (entry, index) => visit(entry, `${path}[${index}]`)
        );
        Object.freeze(normalized3);
        return normalized3;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error(
          `provider "${providerId}" ${label}${path} must contain only plain JSON objects`
        );
      }
      const normalized2 = Object.fromEntries(
        Object.entries(current).map(([key2, entry]) => [
          key2,
          visit(entry, `${path}.${key2}`)
        ])
      );
      Object.freeze(normalized2);
      return normalized2;
    } finally {
      active.delete(current);
    }
  }
  const normalized = visit(value, "");
  if (normalized === null || Array.isArray(normalized) || typeof normalized !== "object") {
    throw new Error(`provider "${providerId}" ${label} must be an object`);
  }
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > PLUGIN_PROVIDER_BRIDGE_OPTIONS_MAX_BYTES) {
    throw new Error(
      `provider "${providerId}" ${label} exceeds ${PLUGIN_PROVIDER_BRIDGE_OPTIONS_MAX_BYTES} bytes`
    );
  }
  return normalized;
}
var PROVIDER_STRING_MAX_CHARS = 512;
var PROVIDER_EXTENSION_KIND_NAME_PATTERN = /^[a-z0-9-]+$/u;
var PROVIDER_EXTENSION_KINDS_MAX = 32;
function requireNonBlankString(args) {
  const { providerId, field, value } = args;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > PROVIDER_STRING_MAX_CHARS) {
    throw new Error(
      `provider "${providerId}" ${field} must be a non-blank string of at most ${PROVIDER_STRING_MAX_CHARS} characters`
    );
  }
  return value;
}
function validateProviderStrings(providerId, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`provider "${providerId}" strings must be an object`);
  }
  const record = Object.fromEntries(
    Object.entries(value)
  );
  const required = (field) => requireNonBlankString({
    providerId,
    field: `strings.${field}`,
    value: record[field]
  });
  const optional = (field) => record[field] === void 0 ? void 0 : requireNonBlankString({
    providerId,
    field: `strings.${field}`,
    value: record[field]
  });
  let iconTint;
  if (record.iconTint !== void 0) {
    const tint = record.iconTint;
    if (typeof tint !== "object" || tint === null || Array.isArray(tint)) {
      throw new Error(
        `provider "${providerId}" strings.iconTint must be { light, dark }`
      );
    }
    const tintRecord = Object.fromEntries(
      Object.entries(tint)
    );
    iconTint = Object.freeze({
      light: requireNonBlankString({
        providerId,
        field: "strings.iconTint.light",
        value: tintRecord.light
      }),
      dark: requireNonBlankString({
        providerId,
        field: "strings.iconTint.dark",
        value: tintRecord.dark
      })
    });
  }
  const brandPrefix = optional("brandPrefix");
  const planModeCopy = optional("planModeCopy");
  return Object.freeze({
    signInHint: required("signInHint"),
    expiredHint: required("expiredHint"),
    installUrl: required("installUrl"),
    ...brandPrefix === void 0 ? {} : { brandPrefix },
    ...planModeCopy === void 0 ? {} : { planModeCopy },
    ...iconTint === void 0 ? {} : { iconTint }
  });
}
function validateProviderOptionDescriptors(args) {
  const { providerId, field, value } = args;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `provider "${providerId}" ${field} must be a non-empty array of { id, label, description? }`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  const normalized = value.map(
    (entry, index) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(
          `provider "${providerId}" ${field}[${index}] must be { id, label, description? }`
        );
      }
      const record = Object.fromEntries(
        Object.entries(entry)
      );
      const id = requireNonBlankString({
        providerId,
        field: `${field}[${index}].id`,
        value: record.id
      });
      if (seen.has(id)) {
        throw new Error(
          `provider "${providerId}" ${field} id ${JSON.stringify(id)} is duplicated`
        );
      }
      seen.add(id);
      const label = requireNonBlankString({
        providerId,
        field: `${field}[${index}].label`,
        value: record.label
      });
      const description = record.description === void 0 ? void 0 : requireNonBlankString({
        providerId,
        field: `${field}[${index}].description`,
        value: record.description
      });
      const icon = record.experimental_icon === void 0 ? void 0 : requireNonBlankString({
        providerId,
        field: `${field}[${index}].experimental_icon`,
        value: record.experimental_icon
      });
      if (icon !== void 0 && !isNamespacedGlyph(icon) && /[/\\]/u.test(icon)) {
        throw new Error(
          `provider "${providerId}" ${field}[${index}].experimental_icon must be a host glyph name ("Zap") or a declared icon ("<pluginId>/<name>")`
        );
      }
      return Object.freeze({
        id,
        label,
        ...description === void 0 ? {} : { description },
        ...icon === void 0 ? {} : { experimental_icon: icon }
      });
    }
  );
  return Object.freeze(normalized);
}
function validateProviderExtensionKinds(providerId, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `provider "${providerId}" extensionKinds must be an object keyed by kind name`
    );
  }
  const entries = Object.entries(value);
  if (entries.length > PROVIDER_EXTENSION_KINDS_MAX) {
    throw new Error(
      `provider "${providerId}" extensionKinds declares more than ${PROVIDER_EXTENSION_KINDS_MAX} kinds`
    );
  }
  const normalized = {};
  for (const [name, declaration] of entries) {
    if (!PROVIDER_EXTENSION_KIND_NAME_PATTERN.test(name)) {
      throw new Error(
        `provider "${providerId}" extensionKinds name ${JSON.stringify(name)} must match ${PROVIDER_EXTENSION_KIND_NAME_PATTERN}`
      );
    }
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
      throw new Error(
        `provider "${providerId}" extensionKinds.${name} must be { item?, state? }`
      );
    }
    const item = Reflect.get(declaration, "item");
    const state = Reflect.get(declaration, "state");
    if (item === void 0 && state === void 0) {
      throw new Error(
        `provider "${providerId}" extensionKinds.${name} must declare an item schema, a state schema, or both`
      );
    }
    if (item !== void 0 && !isStandardSchema(item)) {
      throw new Error(
        `provider "${providerId}" extensionKinds.${name}.item must be a Standard Schema v1 validator`
      );
    }
    if (state !== void 0 && !isStandardSchema(state)) {
      throw new Error(
        `provider "${providerId}" extensionKinds.${name}.state must be a Standard Schema v1 validator`
      );
    }
    normalized[name] = Object.freeze({
      ...item === void 0 ? {} : { item },
      ...state === void 0 ? {} : { state }
    });
  }
  return Object.freeze(normalized);
}
var PROVIDER_FALLBACK_MODELS_MAX = 64;
var PROVIDER_ENV_PASSTHROUGH_MAX = 32;
var PROVIDER_ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/u;
function validateProviderEnvPassthrough(providerId, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `provider "${providerId}" env must be { passthrough: [...] }`
    );
  }
  const passthrough = Reflect.get(value, "passthrough");
  if (!Array.isArray(passthrough)) {
    throw new Error(
      `provider "${providerId}" env.passthrough must be an array of variable names`
    );
  }
  if (passthrough.length > PROVIDER_ENV_PASSTHROUGH_MAX) {
    throw new Error(
      `provider "${providerId}" env.passthrough names more than ${PROVIDER_ENV_PASSTHROUGH_MAX} variables`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  for (const name of passthrough) {
    if (typeof name !== "string" || !PROVIDER_ENV_NAME_PATTERN.test(name)) {
      throw new Error(
        `provider "${providerId}" env.passthrough entries must match ${PROVIDER_ENV_NAME_PATTERN}`
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `provider "${providerId}" env.passthrough repeats ${JSON.stringify(name)}`
      );
    }
    seen.add(name);
  }
  return Object.freeze([...seen]);
}
function validateProviderNativeRoots(providerId, field, value) {
  const input = providerNativeRootsInputSchema.safeParse(value);
  if (!input.success) {
    const issue = input.error.issues[0];
    const where = issue?.path.length ? `.${issue.path.join(".")}` : "";
    throw new Error(
      `provider "${providerId}" ${field}${where} ${issue?.message ?? "is invalid"}`
    );
  }
  const normalized = normalizeProviderNativeRoots(input.data);
  const wire = providerNativeRootsSchema.safeParse(normalized);
  if (!wire.success) {
    const issue = wire.error.issues[0];
    const where = issue?.path.length ? `.${issue.path.join(".")}` : "";
    throw new Error(
      `provider "${providerId}" ${field}${where} ${issue?.message ?? "is invalid"}`
    );
  }
  return Object.freeze({
    user: Object.freeze(wire.data.user.map((root) => Object.freeze(root))),
    project: Object.freeze(
      wire.data.project.map((root) => Object.freeze(root))
    )
  });
}
var PROVIDER_MODEL_CATALOG_SCOPES = [
  "host",
  "workspace"
];
function validateProviderModelCatalogScope(providerId, value) {
  if (value === void 0) {
    return "workspace";
  }
  if (typeof value !== "string" || !PROVIDER_MODEL_CATALOG_SCOPES.includes(value)) {
    throw new Error(
      `provider "${providerId}" models.scope must be one of ${PROVIDER_MODEL_CATALOG_SCOPES.join(", ")}`
    );
  }
  return value;
}
var PROVIDER_COMPLETED_TURN_DISPLAYS = COMPLETED_TURN_DISPLAY_VALUES;
function validateProviderCompletedTurnDisplay(providerId, value) {
  if (value === void 0) {
    return DEFAULT_COMPLETED_TURN_DISPLAY;
  }
  if (typeof value !== "string" || !PROVIDER_COMPLETED_TURN_DISPLAYS.includes(value)) {
    throw new Error(
      `provider "${providerId}" completedTurnDisplay must be one of ${PROVIDER_COMPLETED_TURN_DISPLAYS.join(", ")}`
    );
  }
  return value;
}
function validateProviderFallbackModels(providerId, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`provider "${providerId}" models must be an object`);
  }
  const fallback = Reflect.get(value, "fallback");
  if (fallback === void 0) {
    return void 0;
  }
  if (!Array.isArray(fallback)) {
    throw new Error(
      `provider "${providerId}" models.fallback must be an array`
    );
  }
  if (fallback.length > PROVIDER_FALLBACK_MODELS_MAX) {
    throw new Error(
      `provider "${providerId}" models.fallback lists more than ${PROVIDER_FALLBACK_MODELS_MAX} models`
    );
  }
  const seen = /* @__PURE__ */ new Set();
  let defaults = 0;
  const normalized = fallback.map(
    (entry, index) => {
      const field = `models.fallback[${index}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new Error(`provider "${providerId}" ${field} must be an object`);
      }
      const record = Object.fromEntries(
        Object.entries(entry)
      );
      const id = requireNonBlankString({
        providerId,
        field: `${field}.id`,
        value: record.id
      });
      if (seen.has(id)) {
        throw new Error(
          `provider "${providerId}" models.fallback id ${JSON.stringify(id)} is duplicated`
        );
      }
      seen.add(id);
      const displayName = requireNonBlankString({
        providerId,
        field: `${field}.displayName`,
        value: record.displayName
      });
      const description = requireNonBlankString({
        providerId,
        field: `${field}.description`,
        value: record.description
      });
      const efforts = record.supportedReasoningEfforts;
      if (!Array.isArray(efforts) || efforts.length === 0) {
        throw new Error(
          `provider "${providerId}" ${field}.supportedReasoningEfforts must be a non-empty array`
        );
      }
      const levels = /* @__PURE__ */ new Set();
      const supportedReasoningEfforts = efforts.map(
        (effort, effortIndex) => {
          if (typeof effort !== "object" || effort === null || Array.isArray(effort)) {
            throw new Error(
              `provider "${providerId}" ${field}.supportedReasoningEfforts[${effortIndex}] must be { reasoningEffort, description }`
            );
          }
          const level = requireNonBlankString({
            providerId,
            field: `${field}.supportedReasoningEfforts[${effortIndex}].reasoningEffort`,
            value: Reflect.get(effort, "reasoningEffort")
          });
          const label = Reflect.get(effort, "label");
          if (levels.has(level)) {
            throw new Error(
              `provider "${providerId}" ${field}.supportedReasoningEfforts repeats ${JSON.stringify(level)}`
            );
          }
          levels.add(level);
          return Object.freeze({
            reasoningEffort: level,
            ...label === void 0 ? {} : {
              label: requireNonBlankString({
                providerId,
                field: `${field}.supportedReasoningEfforts[${effortIndex}].label`,
                value: label
              })
            },
            description: requireNonBlankString({
              providerId,
              field: `${field}.supportedReasoningEfforts[${effortIndex}].description`,
              value: Reflect.get(effort, "description")
            })
          });
        }
      );
      const defaultReasoningEffort = record.defaultReasoningEffort;
      if (typeof defaultReasoningEffort !== "string" || !levels.has(defaultReasoningEffort)) {
        throw new Error(
          `provider "${providerId}" ${field}.defaultReasoningEffort must be one of its supportedReasoningEfforts`
        );
      }
      if (typeof record.isDefault !== "boolean") {
        throw new Error(
          `provider "${providerId}" ${field}.isDefault must be a boolean`
        );
      }
      if (record.isDefault) defaults += 1;
      return Object.freeze({
        id,
        displayName,
        description,
        supportedReasoningEfforts: Object.freeze(supportedReasoningEfforts),
        defaultReasoningEffort,
        isDefault: record.isDefault
      });
    }
  );
  if (normalized.length > 0 && defaults !== 1) {
    throw new Error(
      `provider "${providerId}" models.fallback must mark exactly one model isDefault (found ${defaults})`
    );
  }
  return Object.freeze(normalized);
}
var RESERVED_AI_SERVICE_IDS = /* @__PURE__ */ new Set([
  "automatic",
  "off"
]);
function optionalAiServiceFunction(id, name, value) {
  if (value === void 0) return null;
  if (typeof value !== "function") {
    throw new Error(`AI service "${id}" ${name} must be a function`);
  }
  return value;
}
function validatePluginAiServiceDeclaration(declaration) {
  if (typeof declaration !== "object" || declaration === null) {
    throw new Error("AI service declaration must be an object");
  }
  const id = declaration.id;
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid AI service id ${JSON.stringify(id)} \u2014 use 2-64 lowercase letters, digits, and "-", starting with a letter or digit`
    );
  }
  if (RESERVED_AI_SERVICE_IDS.has(id)) {
    throw new Error(
      `AI service id "${id}" is reserved: bb uses "automatic" and "off" as selection modes. Choose another id.`
    );
  }
  const displayName = typeof declaration.displayName === "string" ? declaration.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > 64) {
    throw new Error(`AI service "${id}" displayName must be 1-64 characters`);
  }
  const complete = optionalAiServiceFunction(
    id,
    "complete",
    declaration.complete
  );
  const transcribe = optionalAiServiceFunction(
    id,
    "transcribe",
    declaration.transcribe
  );
  const status = optionalAiServiceFunction(id, "status", declaration.status);
  const experimental_text = declaration.experimental_text ?? null;
  if (experimental_text !== null && (typeof experimental_text !== "object" || typeof experimental_text.models !== "function" || typeof experimental_text.generate !== "function"))
    throw new Error("Invalid AI text service");
  if (complete === null && transcribe === null && experimental_text === null) {
    throw new Error(
      `AI service "${id}" must declare complete, transcribe, or both`
    );
  }
  return Object.freeze({
    id,
    displayName,
    complete,
    transcribe,
    status,
    experimental_text
  });
}
function aiServiceAlreadyRegisteredMessage(id) {
  return `AI service "${id}" is already registered by this plugin.`;
}
function providerAlreadyRegisteredMessage(id) {
  return `Provider "${id}" is already registered; a plugin cannot shadow an existing provider.`;
}
var RENAMED_PROVIDER_DECLARATION_FIELDS = Object.freeze({
  experimental_family: "family",
  experimental_strings: "strings",
  experimental_serviceTiers: "serviceTiers",
  experimental_reasoningLevels: "reasoningLevels",
  experimental_extensionKinds: "extensionKinds",
  experimental_models: "models",
  experimental_env: "env",
  experimental_deriveProviderOptions: "deriveProviderOptions"
});
var MOVED_PROVIDER_CAPABILITY_FIELDS = Object.freeze({
  experimental_providerHealth: "maintenance.health",
  experimental_providerUsage: "maintenance.usage",
  experimental_providerInstallation: "maintenance.installation"
});
var READ_EXPERIMENTAL_PROVIDER_DECLARATION_FIELDS = /* @__PURE__ */ new Set([
  "experimental_bridgeOptions",
  "experimental_visibility",
  "experimental_nativeSkillRoots",
  "experimental_nativeCommandRoots",
  "experimental_resolvesNativeRoots"
]);
var RENAMED_PROVIDER_FIELDS_SDK_VERSION = "0.4.16";
function rejectStaleExperimentalFields(args) {
  for (const key2 of Object.keys(args.value)) {
    if (!key2.startsWith("experimental_") || args.read.has(key2)) {
      continue;
    }
    const replacement = Object.hasOwn(args.renamed, key2) ? args.renamed[key2] : void 0;
    const field = `${args.scope}${key2}`;
    if (replacement === void 0) {
      throw new Error(
        `provider "${args.providerId}": unknown declaration field "${field}"`
      );
    }
    throw new Error(
      `provider "${args.providerId}": "${field}" was ${args.verb} to "${replacement}" in SDK ${RENAMED_PROVIDER_FIELDS_SDK_VERSION}`
    );
  }
}
function validatePluginProviderDeclaration(declaration) {
  if (typeof declaration !== "object" || declaration === null) {
    throw new Error("provider declaration must be an object");
  }
  const id = declaration.id;
  if (typeof id !== "string" || !PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid provider id ${JSON.stringify(id)} \u2014 use 2-64 lowercase letters, digits, and "-", starting with a letter or digit`
    );
  }
  rejectStaleExperimentalFields({
    providerId: id,
    value: declaration,
    scope: "",
    read: READ_EXPERIMENTAL_PROVIDER_DECLARATION_FIELDS,
    renamed: RENAMED_PROVIDER_DECLARATION_FIELDS,
    verb: "renamed"
  });
  const family = declaration.family;
  if (family !== void 0 && (typeof family !== "string" || !PROVIDER_ID_PATTERN.test(family))) {
    throw new Error(
      `provider "${id}" family must use the provider id grammar (2-64 lowercase letters, digits, and "-")`
    );
  }
  const displayName = typeof declaration.displayName === "string" ? declaration.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > PLUGIN_PROVIDER_DISPLAY_NAME_MAX_CHARS) {
    throw new Error(
      `provider "${id}" displayName must be 1-${PLUGIN_PROVIDER_DISPLAY_NAME_MAX_CHARS} non-blank characters`
    );
  }
  let icon;
  if (declaration.icon !== void 0) {
    if (typeof declaration.icon !== "string" || declaration.icon.trim() === "") {
      throw new Error(
        `provider "${id}" icon must be a non-blank string \u2014 a named host glyph ("Zap"), a plugin-relative path ("./icons/agent.svg"), or a declared icon ("<pluginId>/<name>")`
      );
    }
    if (isPluginOwnedIconPath(declaration.icon)) {
      icon = validateProviderRelativePath(declaration.icon, `"${id}" icon`);
    } else if (isNamespacedGlyph(declaration.icon)) {
      icon = declaration.icon;
    } else if (/[/\\]/u.test(declaration.icon)) {
      throw new Error(
        `provider "${id}" icon looks like a path but does not start with "./" \u2014 use "./icons/agent.svg" for a plugin file, "<pluginId>/<name>" for a declared icon, or a bare host glyph name like "Zap"`
      );
    } else {
      icon = declaration.icon;
    }
  }
  const capabilities = declaration.capabilities;
  if (typeof capabilities !== "object" || capabilities === null) {
    throw new Error(`provider "${id}" capabilities must be an object`);
  }
  rejectStaleExperimentalFields({
    providerId: id,
    value: capabilities,
    scope: "capabilities.",
    read: /* @__PURE__ */ new Set(),
    renamed: MOVED_PROVIDER_CAPABILITY_FIELDS,
    verb: "moved"
  });
  const maintenance = declaration.maintenance ?? {};
  if (typeof maintenance !== "object" || maintenance === null) {
    throw new Error(`provider "${id}" maintenance must be an object`);
  }
  for (const key2 of ["health", "usage", "installation"]) {
    const value = maintenance[key2];
    if (value !== void 0 && typeof value !== "boolean") {
      throw new Error(`provider "${id}" maintenance.${key2} must be a boolean`);
    }
  }
  const normalizedMaintenance = Object.freeze({
    health: maintenance.health ?? false,
    usage: maintenance.usage ?? false,
    installation: maintenance.installation ?? false
  });
  const booleanCapabilityFields = [
    "supportsServiceTier",
    "supportsNativeUserQuestion",
    "supportsManualCompaction",
    "supportsThreadArchive",
    "supportsThreadRename"
  ];
  for (const field of booleanCapabilityFields) {
    if (typeof capabilities[field] !== "boolean") {
      throw new Error(
        `provider "${id}" capabilities.${field} must be a boolean`
      );
    }
  }
  if (!PROVIDER_FORK_VALUES.includes(capabilities.fork)) {
    throw new Error(
      `provider "${id}" capabilities.fork must be one of ${PROVIDER_FORK_VALUES.join(", ")}`
    );
  }
  const normalizedCapabilities = Object.freeze({
    supportsServiceTier: capabilities.supportsServiceTier,
    supportsNativeUserQuestion: capabilities.supportsNativeUserQuestion,
    fork: capabilities.fork,
    supportsManualCompaction: capabilities.supportsManualCompaction,
    supportsThreadArchive: capabilities.supportsThreadArchive,
    supportsThreadRename: capabilities.supportsThreadRename,
    permissionModes: validateProviderLiteralArray({
      providerId: id,
      field: "capabilities.permissionModes",
      value: capabilities.permissionModes,
      allowed: PLUGIN_PROVIDER_PERMISSION_MODE_VALUES,
      requireNonEmpty: true
    }),
    reasoningLevels: validateProviderLiteralArray({
      providerId: id,
      field: "capabilities.reasoningLevels",
      value: capabilities.reasoningLevels,
      allowed: PLUGIN_PROVIDER_REASONING_LEVEL_VALUES,
      requireNonEmpty: true
    })
  });
  const composerActions = validateProviderLiteralArray({
    providerId: id,
    field: "composerActions",
    value: declaration.composerActions,
    allowed: PLUGIN_PROVIDER_COMPOSER_ACTION_VALUES,
    requireNonEmpty: false
  });
  const completedTurnDisplay = validateProviderCompletedTurnDisplay(
    id,
    declaration.completedTurnDisplay
  );
  const bridgeOptions = declaration.experimental_bridgeOptions === void 0 ? void 0 : normalizeProviderBridgeOptions(
    id,
    declaration.experimental_bridgeOptions
  );
  const visibility = declaration.experimental_visibility ?? "always";
  if (visibility !== "always" && visibility !== "installed") {
    throw new Error(
      `provider "${id}" experimental_visibility must be "always" or "installed"`
    );
  }
  if (visibility === "installed" && !normalizedMaintenance.health) {
    throw new Error(
      `provider "${id}" experimental_visibility "installed" requires maintenance.health`
    );
  }
  const strings = declaration.strings === void 0 ? void 0 : validateProviderStrings(id, declaration.strings);
  const serviceTiers = declaration.serviceTiers === void 0 ? void 0 : validateProviderOptionDescriptors({
    providerId: id,
    field: "serviceTiers",
    value: declaration.serviceTiers
  });
  const reasoningLevels = declaration.reasoningLevels === void 0 ? void 0 : validateProviderOptionDescriptors({
    providerId: id,
    field: "reasoningLevels",
    value: declaration.reasoningLevels
  });
  const extensionKinds = declaration.extensionKinds === void 0 ? void 0 : validateProviderExtensionKinds(id, declaration.extensionKinds);
  const fallbackModels = declaration.models === void 0 ? void 0 : validateProviderFallbackModels(id, declaration.models);
  const modelCatalogScope = validateProviderModelCatalogScope(
    id,
    declaration.models?.scope
  );
  const envPassthrough = declaration.env === void 0 ? void 0 : validateProviderEnvPassthrough(id, declaration.env);
  const nativeSkillRoots = declaration.experimental_nativeSkillRoots === void 0 ? void 0 : validateProviderNativeRoots(
    id,
    "experimental_nativeSkillRoots",
    declaration.experimental_nativeSkillRoots
  );
  const nativeCommandRoots = declaration.experimental_nativeCommandRoots === void 0 ? void 0 : validateProviderNativeRoots(
    id,
    "experimental_nativeCommandRoots",
    declaration.experimental_nativeCommandRoots
  );
  const resolvesNativeRoots = declaration.experimental_resolvesNativeRoots;
  if (resolvesNativeRoots !== void 0 && typeof resolvesNativeRoots !== "boolean") {
    throw new Error(
      `provider "${id}" experimental_resolvesNativeRoots must be a boolean`
    );
  }
  const guidedSignIn = declaration.internal_DO_NOT_USE_guidedSignIn;
  if (guidedSignIn !== void 0 && typeof guidedSignIn !== "boolean") {
    throw new Error(
      `provider "${id}" internal_DO_NOT_USE_guidedSignIn must be a boolean`
    );
  }
  const deriveProviderOptions = declaration.deriveProviderOptions;
  if (deriveProviderOptions !== void 0 && typeof deriveProviderOptions !== "function") {
    throw new Error(
      `provider "${id}" deriveProviderOptions must be a function (context) => providerOptions`
    );
  }
  return Object.freeze({
    id,
    displayName,
    ...family === void 0 ? {} : { family },
    ...icon === void 0 ? {} : { icon },
    ...bridgeOptions === void 0 ? {} : { experimental_bridgeOptions: bridgeOptions },
    experimental_visibility: visibility,
    maintenance: normalizedMaintenance,
    capabilities: normalizedCapabilities,
    composerActions,
    completedTurnDisplay,
    ...strings === void 0 ? {} : { strings },
    ...serviceTiers === void 0 ? {} : { serviceTiers },
    ...reasoningLevels === void 0 ? {} : { reasoningLevels },
    ...extensionKinds === void 0 ? {} : { extensionKinds },
    models: Object.freeze({
      ...fallbackModels === void 0 ? {} : { fallback: fallbackModels },
      scope: modelCatalogScope
    }),
    ...envPassthrough === void 0 ? {} : { env: Object.freeze({ passthrough: envPassthrough }) },
    ...nativeSkillRoots === void 0 ? {} : { experimental_nativeSkillRoots: nativeSkillRoots },
    ...nativeCommandRoots === void 0 ? {} : { experimental_nativeCommandRoots: nativeCommandRoots },
    experimental_resolvesNativeRoots: resolvesNativeRoots ?? false,
    internal_DO_NOT_USE_guidedSignIn: guidedSignIn ?? false,
    ...deriveProviderOptions === void 0 ? {} : { deriveProviderOptions }
  });
}
function isStandardSchema(value) {
  if (typeof value !== "object" || value === null) return false;
  const standard = Reflect.get(value, "~standard");
  return typeof standard === "object" && standard !== null && Reflect.get(standard, "version") === 1 && typeof Reflect.get(standard, "vendor") === "string" && typeof Reflect.get(standard, "validate") === "function";
}
var rpcDescriptionSchema = z7.string().trim().min(1).max(4096).optional().transform((value) => value ?? null);
var rpcPublicationOptionsSchema = z7.object({
  experimental_discoverable: z7.boolean().default(false),
  experimental_description: rpcDescriptionSchema
}).strict();
function readRpcMethodContract(method, value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `rpc method "${method}" contract must provide input and output Standard Schemas`
    );
  }
  const input = Reflect.get(value, "input");
  const output = Reflect.get(value, "output");
  if (!isStandardSchema(input)) {
    throw new Error(
      `rpc method "${method}" input must be a Standard Schema v1 validator`
    );
  }
  if (!isStandardSchema(output)) {
    throw new Error(
      `rpc method "${method}" output must be a Standard Schema v1 validator`
    );
  }
  const description = rpcDescriptionSchema.parse(
    Reflect.get(value, "experimental_description")
  );
  const declarations = {};
  for (const name of ["tags", "keyTags", "invalidates"]) {
    const declaration = Reflect.get(value, name);
    if (declaration !== void 0) {
      if (typeof declaration !== "function")
        throw new Error(`rpc ${method} ${name} must be a function`);
      Reflect.set(declarations, name, declaration);
    }
  }
  return {
    input,
    output,
    ...declarations,
    ...description === null ? {} : { experimental_description: description }
  };
}
function readRpcPublicationOptions(value) {
  return rpcPublicationOptionsSchema.parse(value ?? {});
}
function publishedRpcSchema(schema, direction) {
  const converter = schema["~standard"].jsonSchema;
  if (converter === void 0 || typeof converter[direction] !== "function") {
    throw new Error(
      "discoverable RPC requires Standard JSON Schema export support"
    );
  }
  const serialized = JSON.stringify(
    converter[direction]({ target: "draft-2020-12" })
  );
  if (serialized === void 0 || new TextEncoder().encode(serialized).byteLength > 128 * 1024) {
    throw new Error("published RPC schema must be JSON and at most 128 KiB");
  }
  const result = z7.record(z7.string(), jsonValueSchema).parse(JSON.parse(serialized));
  const inspect = (value) => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    for (const [key2, item] of Object.entries(value)) {
      if ((key2 === "$ref" || key2 === "$dynamicRef") && typeof item === "string" && !item.startsWith("#")) {
        throw new Error("published RPC schemas must use local references");
      }
      inspect(item);
    }
  };
  inspect(result);
  return result;
}
function publishRpcMethod(method, contract, options) {
  if (!options.experimental_discoverable) return null;
  try {
    return {
      method,
      registrationDescription: options.experimental_description,
      methodDescription: contract.experimental_description ?? null,
      inputSchema: publishedRpcSchema(contract.input, "input"),
      outputSchema: publishedRpcSchema(contract.output, "output")
    };
  } catch (error) {
    throw new Error(
      `rpc method "${method}" cannot be published: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
function isZodSchemaLike(value) {
  return typeof value === "object" && value !== null && typeof value.safeParse === "function";
}
function standardSchemaToJsonSchema(schema) {
  if (isZodSchemaLike(schema)) {
    return zodSchemaToJsonSchema(schema);
  }
  const convertible = schema;
  if (typeof convertible.toJSONSchema === "function") {
    return convertible.toJSONSchema();
  }
  throw new Error("the validator exposes no JSON Schema conversion");
}
function zodSchemaToJsonSchema(schema) {
  if (typeof schema.toJSONSchema === "function") {
    return schema.toJSONSchema({ io: "input" });
  }
  return z7.toJSONSchema(schema, { io: "input" });
}
var SINGLE_SCHEMA_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties"
];
var SCHEMA_ARRAY_KEYWORDS = [
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems"
];
var SCHEMA_MAP_KEYWORDS = [
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties"
];
function isJsonSchemaObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function decodeJsonPointerToken(token) {
  return token.replaceAll("~1", "/").replaceAll("~0", "~");
}
function resolveLocalJsonSchemaReference(document, anchors, reference) {
  if (!reference.startsWith("#")) return void 0;
  let pointer;
  try {
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    return void 0;
  }
  if (pointer.length === 0) return document;
  if (!pointer.startsWith("/")) return anchors.get(pointer);
  let current = document;
  for (const encodedToken of pointer.slice(1).split("/")) {
    const token = decodeJsonPointerToken(encodedToken);
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(token)) return void 0;
      current = current[Number(token)];
      continue;
    }
    if (!isJsonSchemaObject(current) || !Object.hasOwn(current, token)) {
      return void 0;
    }
    current = current[token];
  }
  return current;
}
function forEachJsonSchemaChild(schema, visit) {
  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const child = schema[keyword];
    if (Array.isArray(child)) {
      for (const entry of child) visit(entry);
    } else {
      visit(child);
    }
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    for (const child of children) visit(child);
  }
  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const children = schema[keyword];
    if (!isJsonSchemaObject(children)) continue;
    for (const child of Object.values(children)) visit(child);
  }
  const dependencies = schema.dependencies;
  if (isJsonSchemaObject(dependencies)) {
    for (const dependency of Object.values(dependencies)) {
      if (!Array.isArray(dependency)) visit(dependency);
    }
  }
}
function assertNoRecursiveJsonSchemaReferences(schema, subject) {
  if (!isJsonSchemaObject(schema)) return;
  const document = schema;
  const anchors = /* @__PURE__ */ new Map();
  const indexed = /* @__PURE__ */ new Set();
  function indexAnchors(candidate) {
    if (!isJsonSchemaObject(candidate) || indexed.has(candidate)) return;
    indexed.add(candidate);
    for (const keyword of ["$anchor", "$dynamicAnchor"]) {
      const anchor = candidate[keyword];
      if (typeof anchor === "string") anchors.set(anchor, candidate);
    }
    for (const keyword of ["$id", "id"]) {
      const id = candidate[keyword];
      if (typeof id === "string" && /^#[^/]+$/.test(id)) {
        anchors.set(id.slice(1), candidate);
      }
    }
    forEachJsonSchemaChild(candidate, indexAnchors);
  }
  indexAnchors(document);
  const visited = /* @__PURE__ */ new Set();
  const visiting = /* @__PURE__ */ new Set();
  function visit(candidate, viaReference) {
    if (typeof candidate === "boolean" || !isJsonSchemaObject(candidate)) {
      return;
    }
    if (visiting.has(candidate)) {
      throw new Error(
        `${subject} contains recursive JSON Schema ${viaReference?.keyword ?? "$ref"} ${JSON.stringify(viaReference?.value ?? "#")}`
      );
    }
    if (visited.has(candidate)) return;
    visiting.add(candidate);
    for (const keyword of ["$ref", "$recursiveRef", "$dynamicRef"]) {
      const reference = candidate[keyword];
      if (typeof reference === "string" && reference.startsWith("#")) {
        const target = resolveLocalJsonSchemaReference(
          document,
          anchors,
          reference
        );
        if (target !== void 0) {
          visit(target, { keyword, value: reference });
        }
      }
    }
    forEachJsonSchemaChild(candidate, visit);
    visiting.delete(candidate);
    visited.add(candidate);
  }
  visit(schema);
}
var RENAMED_AGENT_TOOL_FIELDS = /* @__PURE__ */ new Map([
  [
    "experimental_presentation",
    '"experimental_presentation" was renamed to "presentation" in SDK 0.4.16'
  ],
  [
    "experimental_statusLabels",
    '"experimental_statusLabels" was folded into "presentation" (labels) in SDK 0.4.16'
  ]
]);
function rejectStaleAgentToolFields(toolName, tool) {
  const unknownKeys = [];
  for (const key2 of Object.keys(tool).sort()) {
    const renamed = RENAMED_AGENT_TOOL_FIELDS.get(key2);
    if (renamed !== void 0) {
      throw new Error(`registerTool: ${renamed} (tool "${toolName}")`);
    }
    if (key2.startsWith("experimental_")) {
      unknownKeys.push(key2);
    }
  }
  if (unknownKeys.length > 0) {
    throw new Error(
      `registerTool: tool "${toolName}" contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
    );
  }
}
function parsePluginRowPresentation(subject, value) {
  if (value === void 0) {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${subject} presentation must be an object`);
  }
  const declared = value;
  const presentation = {};
  if (declared.label !== void 0) {
    const label = declared.label;
    if (typeof label !== "object" || label === null || typeof label.pending !== "string" || typeof label.completed !== "string") {
      throw new Error(
        `${subject} presentation.label must provide pending and completed strings`
      );
    }
    const { pending, completed } = label;
    if (pending.trim().length === 0 || completed.trim().length === 0 || pending.length > PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS || completed.length > PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS) {
      throw new Error(
        `${subject} presentation.label strings must be non-empty and at most ${PLUGIN_AGENT_STATUS_LABEL_MAX_CHARS} characters`
      );
    }
    presentation.label = { pending, completed };
  }
  if (declared.icon !== void 0) {
    const icon = declared.icon;
    if (typeof icon !== "object" || icon === null || typeof icon.glyph !== "string" || icon.glyph.trim().length === 0) {
      throw new Error(`${subject} presentation.icon must be { glyph: string }`);
    }
    presentation.icon = { glyph: icon.glyph };
  }
  if (declared.suppress !== void 0) {
    if (typeof declared.suppress !== "boolean") {
      throw new Error(`${subject} presentation.suppress must be a boolean`);
    }
    presentation.suppress = declared.suppress;
  }
  if (declared.experimental_ownerPost !== void 0) {
    if (typeof declared.experimental_ownerPost !== "boolean") {
      throw new Error(
        `${subject} presentation.experimental_ownerPost must be a boolean`
      );
    }
    presentation.experimental_ownerPost = declared.experimental_ownerPost;
  }
  if (declared.tint !== void 0) {
    const tint = declared.tint;
    if (typeof tint !== "object" || tint === null || typeof tint.light !== "string" || typeof tint.dark !== "string") {
      throw new Error(
        `${subject} presentation.tint must provide light and dark strings`
      );
    }
    presentation.tint = {
      light: tint.light,
      dark: tint.dark
    };
  }
  return presentation;
}
function summarizeParseIssues(error) {
  const issues = error?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues.map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join(".") : "(input)";
      return `${path}: ${issue.message ?? "invalid"}`;
    }).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
function enforcePluginCliOutputLimit(result, jsonOutput) {
  const stdoutBytes = Buffer.byteLength(result.stdout, "utf8");
  const stderrBytes = Buffer.byteLength(result.stderr, "utf8");
  const totalBytes = stdoutBytes + stderrBytes;
  if (totalBytes <= PLUGIN_CLI_OUTPUT_MAX_BYTES) return result;
  const error = {
    code: "plugin_cli_output_too_large",
    message: `Plugin CLI output is ${totalBytes} bytes (${stdoutBytes} stdout + ${stderrBytes} stderr), exceeding the ${PLUGIN_CLI_OUTPUT_MAX_BYTES}-byte limit. Narrow the query, request a smaller page, or use a file/streaming command.`,
    maxBytes: PLUGIN_CLI_OUTPUT_MAX_BYTES,
    stdoutBytes,
    stderrBytes,
    totalBytes
  };
  return jsonOutput ? {
    exitCode: 1,
    stdout: JSON.stringify({ error }),
    stderr: "",
    error
  } : { exitCode: 1, stdout: "", stderr: error.message, error };
}
function adoptHttpRouteResponse(value) {
  if (value instanceof Response) return value;
  if (!isResponseLike(value)) {
    throw new Error("http route handler must return a Response");
  }
  const status = value.status;
  const isNullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
  const init = {
    status,
    statusText: typeof value.statusText === "string" ? value.statusText : "",
    headers: new Headers(value.headers)
  };
  if (isNullBodyStatus || value.body === null) {
    return new Response(null, init);
  }
  return new Response(adoptBodyStream(value), init);
}
function adoptBodyStream(value) {
  const source = value.body;
  if (!isReadableStreamLike(source)) {
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(await value.arrayBuffer()));
        controller.close();
      }
    });
  }
  const reader = source.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value: chunk } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    }
  });
}
function isReadableStreamLike(value) {
  return value !== null && typeof value === "object" && typeof value.getReader === "function";
}
function isResponseLike(value) {
  if (value === null || typeof value !== "object") return false;
  const candidate = value;
  return typeof candidate.status === "number" && typeof candidate.headers === "object" && candidate.headers !== null && typeof candidate.arrayBuffer === "function" && typeof candidate.clone === "function";
}
function undeclaredIconProblem(pluginId, declaredIconNames, glyph) {
  const parsed = parseNamespacedGlyph(glyph);
  if (parsed === null) {
    return null;
  }
  if (parsed.pluginId !== pluginId || !declaredIconNames.has(parsed.name)) {
    return `"${glyph}" is not an icon declared by plugin "${pluginId}"`;
  }
  return null;
}
function providerIconRefusalMessage(providerId, problem) {
  return `provider "${providerId}" icon ${problem}`;
}
function providerDeclarationIconRefusal(pluginId, declaredIconNames, declaration) {
  const iconProblem = declaration.icon === void 0 ? null : undeclaredIconProblem(pluginId, declaredIconNames, declaration.icon);
  if (iconProblem !== null) {
    return providerIconRefusalMessage(declaration.id, iconProblem);
  }
  for (const [index, tier] of (declaration.serviceTiers ?? []).entries()) {
    const tierProblem = tier.experimental_icon === void 0 ? null : undeclaredIconProblem(
      pluginId,
      declaredIconNames,
      tier.experimental_icon
    );
    if (tierProblem !== null) {
      return `provider "${declaration.id}" serviceTiers[${index}].experimental_icon ${tierProblem}`;
    }
  }
  return null;
}
function agentToolIconRefusalMessage(toolName, problem) {
  return `tool "${toolName}" presentation.icon ${problem}`;
}
function providerWithoutBridgeMessage(providerId) {
  return `provider "${providerId}" has no bridge to run on: this plugin declares no "bb.host" entry in its manifest`;
}
function storePluginHook(records, hook, handler) {
  records[hook] = handler;
}
function pluginHookAlreadyRegisteredMessage(hook) {
  return `a "${hook}" hook handler is already registered by this plugin`;
}
var ENVIRONMENT_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
var ENVIRONMENT_PROVIDER_DISPLAY_NAME_MAX_CHARS = 80;
var ENVIRONMENT_PROVIDER_DESCRIPTION_MAX_CHARS = 200;
var ENVIRONMENT_PROVIDER_REQUIREMENT_NAMES = [
  "projectCheckout",
  "gitCheckout",
  "gitRemote",
  "projectless"
];
var environmentCompositionSchema = z7.object({
  id: z7.string().regex(ENVIRONMENT_PROVIDER_ID_PATTERN),
  displayName: z7.string().trim().min(1).max(ENVIRONMENT_PROVIDER_DISPLAY_NAME_MAX_CHARS),
  description: z7.string().trim().min(1).max(ENVIRONMENT_PROVIDER_DESCRIPTION_MAX_CHARS).optional().transform((value) => value ?? null),
  icon: z7.string().trim().min(1).transform(
    (icon) => isPluginOwnedIconPath(icon) ? validateProviderRelativePath(icon, "Composition icon") : icon
  ).optional().transform((value) => value ?? null),
  machineProviderId: z7.string().regex(ENVIRONMENT_PROVIDER_ID_PATTERN),
  environmentProviderId: z7.string().regex(ENVIRONMENT_PROVIDER_ID_PATTERN)
}).strict();
function requireProviderIdAndDisplayName(noun, declaration) {
  if (typeof declaration !== "object" || declaration === null) {
    throw new Error(`${noun} declaration must be an object`);
  }
  const id = declaration.id;
  if (typeof id !== "string" || !ENVIRONMENT_PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid ${noun} id ${JSON.stringify(id)} \u2014 use 2-64 lowercase letters, digits, or "-", starting with a letter or digit`
    );
  }
  const displayName = typeof declaration.displayName === "string" ? declaration.displayName.trim() : "";
  if (displayName.length === 0 || displayName.length > ENVIRONMENT_PROVIDER_DISPLAY_NAME_MAX_CHARS) {
    throw new Error(
      `${noun} "${id}" needs a displayName of 1-${ENVIRONMENT_PROVIDER_DISPLAY_NAME_MAX_CHARS} characters`
    );
  }
  return { id, displayName };
}
function assertProviderIconShape(noun, id, icon) {
  if (isPluginOwnedIconPath(icon)) {
    validateProviderRelativePath(icon, `"${id}" icon`);
  } else if (!isNamespacedGlyph(icon) && /[/\\]/u.test(icon)) {
    throw new Error(
      `${noun} "${id}" icon must be a glyph, declared icon, or plugin-relative path`
    );
  }
}
function assertOptionalFunction(noun, id, value, phrase) {
  if (value !== void 0 && typeof value !== "function") {
    throw new Error(
      `${noun} "${id}" declares ${phrase} that is not a function`
    );
  }
}
function normalizeProviderInputs(noun, id, inputs) {
  if (inputs === void 0) {
    return null;
  }
  if (!isStandardSchema(inputs)) {
    throw new Error(
      `${noun} "${id}" declares an inputs that is not a Standard Schema v1 validator`
    );
  }
  let converted;
  try {
    converted = JSON.parse(JSON.stringify(standardSchemaToJsonSchema(inputs)));
  } catch (error) {
    throw new Error(
      `${noun} "${id}" declares an inputs validator that cannot be published as JSON Schema (${error instanceof Error ? error.message : String(error)}) \u2014 declare it with zod 4 or a validator exposing toJSONSchema()`
    );
  }
  const jsonSchema = jsonValueSchema.safeParse(converted);
  if (!jsonSchema.success) {
    throw new Error(
      `${noun} "${id}" declares an inputs schema whose JSON Schema is not JSON-serializable`
    );
  }
  return { schema: inputs, jsonSchema: jsonSchema.data };
}
function validatePluginEnvironmentProviderDeclaration(declaration) {
  const { id, displayName } = requireProviderIdAndDisplayName(
    "environment provider",
    declaration
  );
  const description = z7.string().trim().min(1).max(ENVIRONMENT_PROVIDER_DESCRIPTION_MAX_CHARS).optional().transform((value) => value ?? null).parse(declaration.description);
  const icon = z7.string().trim().min(1).optional().transform((value) => value ?? null).parse(declaration.icon);
  if (icon !== null) {
    assertProviderIconShape("environment provider", id, icon);
  }
  const requires = normalizeEnvironmentProviderRequirements(id, declaration);
  const inputs = normalizeProviderInputs(
    "environment provider",
    id,
    declaration.inputs
  );
  if (typeof declaration.create !== "function" || typeof declaration.remove !== "function") {
    throw new Error(
      `environment provider "${id}" must declare create and remove functions`
    );
  }
  assertOptionalFunction(
    "environment provider",
    id,
    declaration.validate,
    "a validate"
  );
  assertOptionalFunction(
    "environment provider",
    id,
    declaration.availability,
    "availability"
  );
  assertOptionalFunction(
    "environment provider",
    id,
    declaration.experimental_existingPath,
    "experimental_existingPath"
  );
  assertOptionalFunction(
    "environment provider",
    id,
    declaration.restore,
    "a restore"
  );
  return {
    id,
    displayName,
    description,
    icon,
    requires,
    inputs: inputs === null ? null : inputs.schema,
    inputsJsonSchema: inputs === null ? null : inputs.jsonSchema,
    availability: declaration.availability ?? null,
    validate: declaration.validate ?? null,
    experimental_existingPath: declaration.experimental_existingPath ?? null,
    create: declaration.create,
    restore: declaration.restore ?? null,
    remove: declaration.remove,
    policy: environmentProviderPolicySchema.parse(declaration.policy ?? {})
  };
}
function normalizeEnvironmentProviderRequirements(id, declaration) {
  const requires = declaration.requires ?? {};
  if (typeof requires !== "object" || requires === null || Array.isArray(requires)) {
    throw new Error(
      `environment provider "${id}" declares a requires that is not an object`
    );
  }
  const normalized = {};
  for (const name of ENVIRONMENT_PROVIDER_REQUIREMENT_NAMES) {
    const value = requires[name];
    if (value !== void 0 && typeof value !== "boolean") {
      throw new Error(
        `environment provider "${id}" declares a requires.${name} that is not a boolean`
      );
    }
    normalized[name] = value === true;
  }
  if (normalized.gitCheckout) {
    normalized.projectCheckout = true;
  }
  if (normalized.projectless && (normalized.projectCheckout || normalized.gitRemote)) {
    throw new Error(
      `environment provider "${id}" declares requires.projectless together with a project requirement \u2014 a projectless thread has no checkout or remote`
    );
  }
  return normalized;
}
var environmentProviderPolicySchema = z7.object({
  retireGraceMs: z7.number().int().nonnegative().nullable().default(3e5),
  pathKeys: z7.enum(["per-thread", "per-attempt"]).default("per-thread")
}).strict();
var MACHINE_PROVIDER_DESCRIPTION_MAX_CHARS = 200;
function validatePluginMachineProviderDeclaration(declaration) {
  const { id, displayName } = requireProviderIdAndDisplayName(
    "machine provider",
    declaration
  );
  const description = z7.string().trim().min(1).max(MACHINE_PROVIDER_DESCRIPTION_MAX_CHARS).parse(declaration.description);
  const icon = z7.string().trim().min(1).parse(declaration.icon);
  assertProviderIconShape("machine provider", id, icon);
  const ephemeral = z7.boolean().default(false).parse(declaration.ephemeral);
  const inputs = normalizeProviderInputs(
    "machine provider",
    id,
    declaration.inputs
  );
  if (typeof declaration.create !== "function" || typeof declaration.reconcileCleanup !== "function" || typeof declaration.remove !== "function") {
    throw new Error(
      `machine provider "${id}" must declare create, reconcileCleanup and remove functions`
    );
  }
  const hasSuspend = typeof declaration.suspend === "function";
  const hasResume = typeof declaration.resume === "function";
  if (hasSuspend !== hasResume) {
    throw new Error(
      `machine provider "${id}" must declare suspend and resume together`
    );
  }
  assertOptionalFunction(
    "machine provider",
    id,
    declaration.validate,
    "a validate"
  );
  assertOptionalFunction(
    "machine provider",
    id,
    declaration.availability,
    "availability"
  );
  return {
    id,
    displayName,
    description,
    icon,
    ephemeral,
    inputs: inputs === null ? null : inputs.schema,
    inputsJsonSchema: inputs === null ? null : inputs.jsonSchema,
    availability: declaration.availability ?? null,
    validate: declaration.validate ?? null,
    reconcileCleanup: declaration.reconcileCleanup,
    create: declaration.create,
    suspend: declaration.suspend ?? null,
    resume: declaration.resume ?? null,
    remove: declaration.remove
  };
}
function validateServerAccessProviderDeclaration(declaration) {
  if (typeof declaration !== "object" || declaration === null)
    throw new Error("Invalid server access provider declaration");
  if (typeof declaration.id !== "string" || !/^[a-z][a-z0-9-]*$/u.test(declaration.id) || declaration.id === "direct")
    throw new Error("Invalid or reserved server access provider id");
  if (typeof declaration.displayName !== "string" || !declaration.displayName.trim() || typeof declaration.description !== "string" || !declaration.description.trim() || typeof declaration.availability !== "function" || typeof declaration.acquire !== "function" || typeof declaration.release !== "function")
    throw new Error("Invalid server access provider declaration");
  return declaration;
}
var LEGACY_UNKNOWN_MIGRATION_HASH = "legacy-unknown";
function migrationStatementHash(statement) {
  return createHash("sha256").update(statement).digest("hex");
}
function runPluginStorageMigrations(database, statements) {
  database.exec(
    "CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, statement_hash TEXT)"
  );
  const migrationColumns = database.prepare("PRAGMA table_info(_bb_migrations)").all();
  if (!migrationColumns.some((column) => column.name === "statement_hash")) {
    database.exec("ALTER TABLE _bb_migrations ADD COLUMN statement_hash TEXT");
  }
  const rows = database.prepare(
    "SELECT id, statement_hash FROM _bb_migrations ORDER BY id"
  ).all();
  const applied = /* @__PURE__ */ new Map();
  for (const row of rows) applied.set(row.id, row.statement_hash);
  const statementHashes = statements.map(migrationStatementHash);
  statementHashes.forEach((statementHash, index) => {
    const recordedHash = applied.get(index);
    if (recordedHash !== void 0 && recordedHash !== null && recordedHash !== statementHash) {
      throw new Error(
        `migration ${index} does not match the recorded statement; append a new migration instead of changing or reusing an index`
      );
    }
  });
  const adopt = database.prepare(
    "UPDATE _bb_migrations SET statement_hash = ? WHERE id = ? AND statement_hash IS NULL"
  );
  const record = database.prepare(
    "INSERT INTO _bb_migrations (id, applied_at, statement_hash) VALUES (?, ?, ?)"
  );
  database.transaction(() => {
    for (const row of rows) {
      if (row.statement_hash !== null) continue;
      adopt.run(
        statementHashes[row.id] ?? LEGACY_UNKNOWN_MIGRATION_HASH,
        row.id
      );
    }
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      database.exec(statement);
      record.run(index, Date.now(), statementHashes[index]);
    });
  })();
}
function normalizeHttpRouteRegistration(method, path, handler, opts, existingRoutes) {
  const normalizedMethod = String(method).toUpperCase();
  if (!PLUGIN_HTTP_METHODS.has(normalizedMethod)) {
    throw new Error(
      `invalid http method "${String(method)}" \u2014 use one of: ${[...PLUGIN_HTTP_METHODS].join(", ")}`
    );
  }
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(
      `http route path must be a string starting with "/", got ${JSON.stringify(path)}`
    );
  }
  if (typeof handler !== "function") {
    throw new Error(
      `http route handler for ${normalizedMethod} ${path} must be a function`
    );
  }
  const auth = opts?.auth ?? "local";
  if (auth !== "local" && auth !== "token" && auth !== "none") {
    throw new Error(
      `invalid auth mode "${String(auth)}" for ${normalizedMethod} ${path} \u2014 use "local", "token", or "none"`
    );
  }
  if (existingRoutes.some(
    (route) => route.method === normalizedMethod && route.path === path
  )) {
    throw new Error(
      `http route ${normalizedMethod} ${path} is already registered`
    );
  }
  return { method: normalizedMethod, path, auth };
}
function normalizeWebSocketRouteRegistration(path, handler, opts, existingRoutes) {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Error(
      `websocket route path must be a string starting with "/", got ${JSON.stringify(path)}`
    );
  }
  if (typeof handler !== "function") {
    throw new Error(`websocket route handler for ${path} must be a function`);
  }
  const auth = opts?.auth ?? "local";
  if (auth !== "local" && auth !== "token" && auth !== "none") {
    throw new Error(
      `invalid auth mode "${String(auth)}" for websocket ${path} \u2014 use "local", "token", or "none"`
    );
  }
  if (existingRoutes.some((route) => route.path === path)) {
    throw new Error(`websocket route ${path} is already registered`);
  }
  return { path, auth };
}
function normalizeRpcRegistration(contract, handlers, registered, options) {
  if (typeof contract !== "object" || contract === null || Array.isArray(contract)) {
    throw new Error("rpc.register contract must be an object");
  }
  if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) {
    throw new Error("rpc.register handlers must be an object");
  }
  const publicationOptions = readRpcPublicationOptions(options);
  const pending = [];
  const contractEntries = Object.entries(contract);
  const contractNames = new Set(contractEntries.map(([name]) => name));
  for (const extraName of Object.keys(handlers)) {
    if (!contractNames.has(extraName)) {
      throw new Error(
        `rpc handler "${extraName}" has no matching contract method`
      );
    }
  }
  for (const [name, methodContractValue] of contractEntries) {
    if (!RPC_METHOD_PATTERN.test(name)) {
      throw new Error(
        `invalid rpc method name "${name}" \u2014 use dot-separated segments with letters, digits, "-" and "_"`
      );
    }
    const methodContract = readRpcMethodContract(name, methodContractValue);
    const handler = Reflect.get(handlers, name);
    if (typeof handler !== "function") {
      throw new Error(`rpc method "${name}" must provide a handler function`);
    }
    if (registered.has(name)) {
      throw new Error(`rpc method "${name}" is already registered`);
    }
    pending.push([
      name,
      {
        publication: publishRpcMethod(name, methodContract, publicationOptions),
        declarations: methodContract,
        inputSchema: methodContract.input,
        outputSchema: methodContract.output,
        handler
      }
    ]);
  }
  return pending;
}
function normalizeRealtimePayload(channel, payload) {
  if (typeof channel !== "string" || channel.length === 0) {
    throw new Error("realtime channel must be a non-empty string");
  }
  if (payload === void 0) return null;
  let json;
  try {
    json = JSON.stringify(payload);
  } catch {
    json = void 0;
  }
  if (json === void 0) {
    throw new Error(
      `realtime payload for channel "${channel}" is not JSON-serializable`
    );
  }
  return JSON.parse(json);
}
function validateBackgroundServiceRegistration(name, service, existing) {
  if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid service name ${JSON.stringify(name)} \u2014 use letters, digits, "-" and "_"`
    );
  }
  if (existing.some((record) => record.name === name)) {
    throw new Error(`background service "${name}" is already registered`);
  }
  if (typeof service?.start !== "function") {
    throw new Error(
      `background service "${name}" must provide a start(signal) function`
    );
  }
  return { name, start: service.start.bind(service) };
}
function validateScheduleRegistration(name, cron, fn, existing, parseCron) {
  if (typeof name !== "string" || !BACKGROUND_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid schedule name ${JSON.stringify(name)} \u2014 use letters, digits, "-" and "_"`
    );
  }
  if (existing.some((record) => record.name === name)) {
    throw new Error(`schedule "${name}" is already registered`);
  }
  try {
    parseCron(String(cron));
  } catch (error) {
    throw new Error(
      `invalid cron ${JSON.stringify(cron)} for schedule "${name}": ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (typeof fn !== "function") {
    throw new Error(`schedule "${name}" must provide a function`);
  }
  return { name, cron: String(cron), fn };
}
function normalizeCliRegistration(registration, alreadyRegistered) {
  if (alreadyRegistered) {
    throw new Error("cli command is already registered");
  }
  const name = registration?.name;
  if (typeof name !== "string" || !CLI_COMMAND_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid cli command name ${JSON.stringify(name)} \u2014 use lowercase letters, digits, and "-"`
    );
  }
  if (typeof registration.summary !== "string" || registration.summary.trim().length === 0) {
    throw new Error(`cli command "${name}" must provide a summary`);
  }
  const commands = registration.commands ?? [];
  if (!Array.isArray(commands)) {
    throw new Error(`cli command "${name}" commands must be an array`);
  }
  const validatedCommands = commands.map((command, index) => {
    if (typeof command?.name !== "string" || !CLI_COMMAND_NAME_PATTERN.test(command.name) || typeof command.summary !== "string" || typeof command.usage !== "string") {
      throw new Error(
        `cli command "${name}" commands[${index}] must be { name: [a-z0-9-]+, summary, usage }`
      );
    }
    return {
      name: command.name,
      summary: command.summary,
      usage: command.usage
    };
  });
  if (typeof registration.run !== "function") {
    throw new Error(
      `cli command "${name}" must provide a run(argv, ctx) function`
    );
  }
  return {
    name,
    summary: registration.summary,
    commands: validatedCommands,
    rendersHelp: registration.rendersHelp === true,
    run: registration.run.bind(registration)
  };
}
function normalizeAgentToolRegistration(args) {
  const { pluginId, declaredIconNames, tool } = args;
  const name = tool?.name;
  if (typeof name !== "string" || !AGENT_TOOL_NAME_PATTERN.test(name)) {
    throw new Error(
      `invalid tool name ${JSON.stringify(name)} \u2014 use letters, digits, "-" and "_"`
    );
  }
  if (RESERVED_AGENT_TOOL_NAMES.includes(name)) {
    throw new Error(
      `tool name "${name}" is a built-in bb tool \u2014 pick another name`
    );
  }
  rejectStaleAgentToolFields(name, tool);
  if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
    throw new Error(`tool "${name}" must provide a description`);
  }
  if (tool.instructions !== void 0 && typeof tool.instructions !== "string") {
    throw new Error(`tool "${name}" instructions must be a string`);
  }
  if (typeof tool.instructions === "string" && tool.instructions.length > PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(
      `tool "${name}" instructions exceed the ${PLUGIN_AGENT_STATIC_INSTRUCTIONS_MAX_CHARS}-character limit`
    );
  }
  const presentation = parsePluginRowPresentation(
    `tool "${name}"`,
    tool.presentation
  );
  if (presentation?.icon !== void 0) {
    const problem = undeclaredIconProblem(
      pluginId,
      declaredIconNames,
      presentation.icon.glyph
    );
    if (problem !== null) {
      throw new Error(agentToolIconRefusalMessage(name, problem));
    }
  }
  if (typeof tool.execute !== "function") {
    throw new Error(
      `tool "${name}" must provide an execute(params, ctx) function`
    );
  }
  const parameters = tool.parameters;
  let inputSchema;
  let parse;
  if (isZodSchemaLike(parameters)) {
    try {
      inputSchema = zodSchemaToJsonSchema(parameters);
    } catch (error) {
      throw new Error(
        `tool "${name}" parameters look like a zod schema but could not be converted to JSON Schema (${error instanceof Error ? error.message : String(error)}) \u2014 use zod 4, or pass a plain JSON-schema object`
      );
    }
    parse = (input) => {
      const result = parameters.safeParse(input);
      if (result.success) return { ok: true, value: result.data };
      return { ok: false, error: summarizeParseIssues(result.error) };
    };
  } else if (typeof parameters === "object" && parameters !== null && !Array.isArray(parameters)) {
    try {
      inputSchema = JSON.parse(JSON.stringify(parameters));
    } catch {
      throw new Error(
        `tool "${name}" parameters JSON schema is not JSON-serializable`
      );
    }
    parse = (input) => ({ ok: true, value: input });
  } else {
    throw new Error(
      `tool "${name}" parameters must be a zod schema or a JSON-schema object`
    );
  }
  assertNoRecursiveJsonSchemaReferences(
    inputSchema,
    `tool "${name}" parameters`
  );
  return {
    name,
    description: tool.description,
    presentation,
    instructions: tool.instructions !== void 0 && tool.instructions.trim().length > 0 ? tool.instructions : null,
    inputSchema,
    parse,
    execute: tool.execute.bind(tool)
  };
}
function normalizeMentionProviderRegistration(provider, existing) {
  const id = provider?.id;
  if (typeof id !== "string" || !MENTION_PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(
      `invalid mention provider id ${JSON.stringify(id)} \u2014 use letters, digits, "-" and "_"`
    );
  }
  if (existing.some((record) => record.id === id)) {
    throw new Error(`mention provider "${id}" is already registered`);
  }
  if (typeof provider.label !== "string" || provider.label.trim().length === 0) {
    throw new Error(`mention provider "${id}" must provide a label`);
  }
  if (typeof provider.search !== "function") {
    throw new Error(
      `mention provider "${id}" must provide a search({ query, projectId, threadId }) function`
    );
  }
  if (typeof provider.resolve !== "function") {
    throw new Error(
      `mention provider "${id}" must provide a resolve(itemId) function`
    );
  }
  return {
    id,
    label: provider.label.trim(),
    triggers: normalizeMentionProviderTriggers(id, provider.triggers),
    search: provider.search.bind(provider),
    resolve: provider.resolve.bind(provider)
  };
}
function normalizeInteractionRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("ui.requestInput requires an options object");
  }
  if (typeof request.threadId !== "string" || request.threadId.length === 0) {
    throw new Error("ui.requestInput threadId must be a non-empty string");
  }
  if (typeof request.rendererId !== "string" || !/^[a-zA-Z0-9_-]+$/.test(request.rendererId)) {
    throw new Error(
      "ui.requestInput rendererId must use letters, digits, '-' or '_'"
    );
  }
  if (typeof request.title !== "string" || request.title.trim().length === 0 || request.title.trim().length > PLUGIN_INTERACTION_MAX_TITLE_LENGTH) {
    throw new Error(
      `ui.requestInput title must be 1-${PLUGIN_INTERACTION_MAX_TITLE_LENGTH} characters`
    );
  }
  let payload;
  try {
    const json = JSON.stringify(request.payload);
    if (json === void 0) throw new Error();
    if (Buffer.byteLength(json, "utf8") > PLUGIN_INTERACTION_MAX_PAYLOAD_BYTES) {
      throw new Error("ui.requestInput payload exceeds 64 KiB");
    }
    payload = JSON.parse(json);
  } catch (error) {
    if (error instanceof Error && error.message.includes("64 KiB")) {
      throw error;
    }
    throw new Error("ui.requestInput payload must be JSON-serializable");
  }
  const timeoutMs = request.timeoutMs ?? 10 * 60 * 1e3;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > PLUGIN_INTERACTION_MAX_TIMEOUT_MS) {
    throw new Error(
      `ui.requestInput timeoutMs must be between 1 and ${PLUGIN_INTERACTION_MAX_TIMEOUT_MS}`
    );
  }
  if (request.describeSubmission !== void 0 && typeof request.describeSubmission !== "function") {
    throw new Error("ui.requestInput describeSubmission must be a function");
  }
  return {
    threadId: request.threadId,
    rendererId: request.rendererId,
    title: request.title.trim(),
    payload,
    timeoutMs,
    presentation: parsePluginRowPresentation(
      `ui.requestInput form "${request.rendererId}"`,
      request.presentation
    ),
    describeSubmission: request.describeSubmission ?? null
  };
}
function validateProviderEnvContribution(label, providerId, resolve2, registered) {
  if (typeof providerId !== "string" || providerId.trim().length === 0) {
    throw new Error(`${label} requires a provider id`);
  }
  if (registered.has(providerId)) {
    throw new Error(`${label} for "${providerId}" is already registered`);
  }
  if (typeof resolve2 !== "function") {
    throw new Error(`${label} requires a resolver function`);
  }
}
function normalizePluginAgentToolParameters(args) {
  const { index, value } = args;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      `configure() output.tools[${index}].parameters must be a JSON-schema object`
    );
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(
      `configure() output.tools[${index}].parameters is not JSON-serializable`
    );
  }
  if (serialized === void 0) {
    throw new Error(
      `configure() output.tools[${index}].parameters is not JSON-serializable`
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > PLUGIN_AGENT_TOOL_PARAMETERS_MAX_BYTES) {
    throw new Error(
      `configure() output.tools[${index}].parameters exceeds the ${PLUGIN_AGENT_TOOL_PARAMETERS_MAX_BYTES}-byte limit`
    );
  }
  const parameters = JSON.parse(serialized);
  if (parameters.type !== "object") {
    throw new Error(
      `configure() output.tools[${index}].parameters must have root type "object"`
    );
  }
  assertNoRecursiveJsonSchemaReferences(
    parameters,
    `configure() output.tools[${index}].parameters`
  );
  return parameters;
}
function normalizePluginAgentToolSelections(args) {
  if (!Array.isArray(args.value)) {
    throw new Error("configure() output.tools must be an array");
  }
  if (args.value.length > PLUGIN_AGENT_SELECTION_MAX_IDS) {
    throw new Error(
      `configure() output.tools exceeds the ${PLUGIN_AGENT_SELECTION_MAX_IDS}-id limit`
    );
  }
  const toolIds = [];
  const parameterOverrides = /* @__PURE__ */ new Map();
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.value.length; index += 1) {
    const entry = args.value[index];
    let name;
    let parameters = null;
    if (typeof entry === "string") {
      name = entry;
    } else if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const typed = entry;
      const unknownKeys = Object.keys(typed).filter((key2) => !["name", "parameters"].includes(key2)).sort();
      if (unknownKeys.length > 0) {
        throw new Error(
          `configure() output.tools[${index}] contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
        );
      }
      name = typed.name;
      parameters = normalizePluginAgentToolParameters({
        index,
        value: typed.parameters
      });
    } else {
      throw new Error(
        `configure() output.tools[${index}] must be a tool name or { name, parameters }`
      );
    }
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `configure() output.tools[${index}] must ${typeof entry === "string" ? "be" : "name"} a non-empty string`
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `configure() output.tools contains duplicate id ${JSON.stringify(name)}`
      );
    }
    if (!args.knownIds.has(name)) {
      throw new Error(
        `configure() selected unknown tool id ${JSON.stringify(name)} owned by plugin ${JSON.stringify(args.pluginId)}`
      );
    }
    seen.add(name);
    toolIds.push(name);
    if (parameters !== null) parameterOverrides.set(name, parameters);
  }
  return { toolIds, parameterOverrides };
}
function normalizePluginAgentSelectionIds(args) {
  if (!Array.isArray(args.value)) {
    throw new Error("configure() output.skills must be an array");
  }
  if (args.value.length > PLUGIN_AGENT_SELECTION_MAX_IDS) {
    throw new Error(
      `configure() output.skills exceeds the ${PLUGIN_AGENT_SELECTION_MAX_IDS}-id limit`
    );
  }
  const selected = [];
  const seen = /* @__PURE__ */ new Set();
  for (let index = 0; index < args.value.length; index += 1) {
    const id = args.value[index];
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(
        `configure() output.skills[${index}] must be a non-empty string`
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `configure() output.skills contains duplicate id ${JSON.stringify(id)}`
      );
    }
    if (!args.knownIds.has(id)) {
      throw new Error(
        `configure() selected unknown skill id ${JSON.stringify(id)} owned by plugin ${JSON.stringify(args.pluginId)}`
      );
    }
    seen.add(id);
    selected.push(id);
  }
  return selected;
}
function normalizePluginAgentConfiguration(args) {
  if (typeof args.value !== "object" || args.value === null || Array.isArray(args.value)) {
    throw new Error(
      "configure() must return { tools: string[], skills: string[], instructions?: string }"
    );
  }
  const output = args.value;
  const unknownKeys = Object.keys(output).filter((key2) => !["tools", "skills", "instructions"].includes(key2)).sort();
  if (unknownKeys.length > 0) {
    throw new Error(
      `configure() output contains unknown field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`
    );
  }
  if (output.instructions !== void 0 && typeof output.instructions !== "string") {
    throw new Error("configure() output.instructions must be a string");
  }
  const instructions = typeof output.instructions === "string" && output.instructions.trim().length > 0 ? output.instructions.slice(0, PLUGIN_DYNAMIC_INSTRUCTIONS_MAX_CHARS) : null;
  const toolSelections = normalizePluginAgentToolSelections({
    knownIds: args.knownToolIds,
    pluginId: args.pluginId,
    value: output.tools
  });
  return {
    toolIds: toolSelections.toolIds,
    toolParameterOverrides: toolSelections.parameterOverrides,
    skillIds: normalizePluginAgentSelectionIds({
      knownIds: args.knownSkillIds,
      pluginId: args.pluginId,
      value: output.skills
    }),
    instructions
  };
}
function normalizeRpcIssuePath(path) {
  if (path === void 0) return void 0;
  const segments = Array.isArray(path) ? path : [path];
  const normalized = segments.map((segment) => {
    const key2 = typeof segment === "object" && segment !== null ? Reflect.get(segment, "key") : segment;
    return typeof key2 === "number" ? key2 : String(key2);
  });
  return normalized.length > 0 ? normalized : void 0;
}
function normalizeRpcIssues(issues) {
  return issues.map((issue) => {
    const path = normalizeRpcIssuePath(issue.path);
    return {
      message: issue.message,
      ...path !== void 0 ? { path } : {}
    };
  });
}
var rpcRefusalSchema = z7.object({
  code: z7.enum(["forbidden", "not_found", "conflict", "invalid"]),
  message: z7.string(),
  issues: z7.array(
    z7.object({
      message: z7.string(),
      path: z7.array(z7.union([z7.string(), z7.number()])).optional()
    })
  ).optional()
});
function readPluginRpcRefusal(error) {
  if (typeof error !== "object" || error === null || Reflect.get(error, /* @__PURE__ */ Symbol.for("@get-bb/plugin-sdk/rpc-refusal")) !== true)
    return null;
  const parsed = rpcRefusalSchema.safeParse(error);
  return parsed.success ? parsed.data : null;
}
async function validateRpcValue(schema, value, phase, fail) {
  let result;
  try {
    result = await schema["~standard"].validate(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail({
      code: phase === "input" ? "invalid_input" : "invalid_output",
      message: `rpc ${phase} validator failed: ${detail}`,
      issues: [{ message: detail }]
    });
  }
  if (result.issues !== void 0) {
    return fail({
      code: phase === "input" ? "invalid_input" : "invalid_output",
      message: `rpc ${phase} validation failed`,
      issues: normalizeRpcIssues(result.issues)
    });
  }
  return result.value;
}
function normalizeRpcJsonResult(value, fail) {
  const ancestors = /* @__PURE__ */ new Set();
  function visit(current, path) {
    if (current === null || typeof current === "string" || typeof current === "boolean") {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        return fail({
          code: "non_json_result",
          message: `rpc result at ${path} contains a non-finite number`
        });
      }
      return current;
    }
    if (typeof current !== "object") {
      return fail({
        code: "non_json_result",
        message: `rpc result at ${path} is not a JSON value (${typeof current})`
      });
    }
    if (ancestors.has(current)) {
      return fail({
        code: "non_json_result",
        message: `rpc result at ${path} is cyclic`
      });
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        return current.map((item, index) => visit(item, `${path}[${index}]`));
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return fail({
          code: "non_json_result",
          message: `rpc result at ${path} must be a plain JSON object`
        });
      }
      if (Reflect.ownKeys(current).some((key2) => typeof key2 === "symbol")) {
        return fail({
          code: "non_json_result",
          message: `rpc result at ${path} contains a symbol key`
        });
      }
      const normalized = {};
      for (const [key2, child] of Object.entries(current)) {
        normalized[key2] = visit(child, `${path}.${key2}`);
      }
      return normalized;
    } finally {
      ancestors.delete(current);
    }
  }
  return visit(value, "$result");
}

// src/testing/fake-plugin-host.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { CronExpressionParser } from "cron-parser";
import { Hono } from "hono";

// src/testing/fake-sdk.ts
function withThreadAttribution(pluginId, args) {
  const [first, ...rest] = args;
  if (typeof first !== "object" || first === null) return args;
  const threadArgs = first;
  if (threadArgs.pluginMetadata !== void 0) {
    return [
      {
        ...threadArgs,
        pluginMetadata: validatePluginMetadata(threadArgs.pluginMetadata),
        origin: "plugin",
        originPluginId: pluginId
      },
      ...rest
    ];
  }
  const origin = threadArgs.origin ?? "plugin";
  return [
    {
      ...threadArgs,
      origin,
      ...origin === "plugin" ? { originPluginId: threadArgs.originPluginId ?? pluginId } : {}
    },
    ...rest
  ];
}
function withPluginMetadataTarget(pluginId, args, validateSet) {
  const [first, ...rest] = args;
  if (typeof first !== "object" || first === null) return args;
  const input = first;
  return [
    {
      ...input,
      pluginId: input.pluginId ?? pluginId,
      ...validateSet && input.set !== void 0 ? { set: validatePluginMetadata(input.set) } : {}
    },
    ...rest
  ];
}
function normalizeCallArgs(pluginId, path, args) {
  switch (path) {
    case "threads.spawn":
    case "threads.fork":
      return withThreadAttribution(pluginId, args);
    case "threads.getPluginMetadata":
    case "threads.experimental_listPluginMetadata":
      return withPluginMetadataTarget(pluginId, args, false);
    case "threads.updatePluginMetadata":
      return withPluginMetadataTarget(pluginId, args, true);
    default:
      return args;
  }
}
function createFakeSdk(options) {
  const calls = [];
  const stubs = /* @__PURE__ */ new Map();
  function addOverrides(prefix, value) {
    if (typeof value === "function") {
      stubs.set(prefix, value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key2, child] of Object.entries(value)) {
      addOverrides(prefix.length === 0 ? key2 : `${prefix}.${key2}`, child);
    }
  }
  addOverrides("", options.overrides ?? {});
  function invoke(path, rawArgs) {
    let args;
    try {
      args = normalizeCallArgs(options.pluginId, path, rawArgs);
    } catch (error) {
      return Promise.reject(error);
    }
    calls.push({ path, args });
    const stub = stubs.get(path);
    if (!stub) {
      throw new Error(
        `bb.sdk.${path} is not stubbed \u2014 pass an implementation via createFakePluginHost({ sdk: { ... } }) or harness.sdk.stub("${path}", fn)`
      );
    }
    return stub(...args);
  }
  const nodes = /* @__PURE__ */ new Map();
  function node(path) {
    const cached = nodes.get(path);
    if (cached) return cached;
    const created = new Proxy(function() {
    }, {
      get(_target, prop) {
        if (typeof prop !== "string" || prop === "then") return void 0;
        return node(path === "" ? prop : `${path}.${prop}`);
      },
      apply(_target, _thisArg, args) {
        return invoke(path, args);
      }
    });
    nodes.set(path, created);
    return created;
  }
  const harness = {
    calls,
    callsTo(path) {
      return calls.filter((call) => call.path === path).map((call) => call.args);
    },
    stub(path, implementation) {
      stubs.set(path, implementation);
    }
  };
  return { sdk: node(""), harness };
}

// src/testing/fake-plugin-host.ts
var PluginContextStaleError = class extends Error {
  constructor(pluginId) {
    super(
      `plugin "${pluginId}" used a stale API handle \u2014 it was reloaded or disabled; re-entry happens via a fresh factory call`
    );
    this.name = "PluginContextStaleError";
  }
};
function readSettingsValues(descriptors, stored) {
  const values = {};
  for (const [key2, descriptor] of Object.entries(descriptors)) {
    values[key2] = coerceStoredPluginSettingValue(descriptor, stored.get(key2));
  }
  return values;
}
function isNeedsConfigurationError(error) {
  return error instanceof Error && error.name === "NeedsConfigurationError";
}
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
function jsonRoundTrip(value, what) {
  if (value === void 0) return void 0;
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    json = void 0;
  }
  if (json === void 0) {
    throw new Error(`${what} is not JSON-serializable`);
  }
  return JSON.parse(json);
}
function throwRpcError(error) {
  throw new experimental_PluginRpcCallError(error);
}
var FAKE_TUNNEL_INGRESS_FIRST_PORT = 41e3;
var fakeHostDisposers = /* @__PURE__ */ new WeakMap();
function createFakePluginHost(options = {}) {
  return createFakePluginHostInternal(options);
}
function createFakePluginHostInternal(options, sharedState) {
  const persistentState = sharedState ?? {
    kvRows: /* @__PURE__ */ new Map(),
    storageRoot: mkdtempSync(join(tmpdir(), "bb-fake-plugin-host-")),
    storedSettings: new Map(
      Object.entries(options.settings ?? {})
    )
  };
  const pluginId = options.pluginId ?? "test-plugin";
  const declaredIconNames = new Set(
    options.experimental_declaredIconNames ?? []
  );
  const agentSkillIds = [...options.agentSkillIds ?? []];
  if (new Set(agentSkillIds).size !== agentSkillIds.length) {
    throw new Error("agentSkillIds must not contain duplicates");
  }
  let invalidated = false;
  let disposed = false;
  function assertLive() {
    if (invalidated) throw new PluginContextStaleError(pluginId);
  }
  const logEntries = [];
  function emitLog(level, message) {
    logEntries.push({ level, message });
  }
  const log = {
    debug: (message) => emitLog("debug", message),
    info: (message) => emitLog("info", message),
    warn: (message) => emitLog("warn", message),
    error: (message) => emitLog("error", message)
  };
  const kvRows = persistentState.kvRows;
  const kv = {
    async get(key2) {
      assertLive();
      const raw = kvRows.get(key2);
      if (raw === void 0) return void 0;
      return JSON.parse(raw);
    },
    async set(key2, value) {
      assertLive();
      const json = JSON.stringify(value);
      if (json === void 0) {
        throw new Error(`kv value for "${key2}" is not JSON-serializable`);
      }
      const bytes = Buffer.byteLength(json, "utf8");
      if (bytes > KV_VALUE_MAX_BYTES) {
        throw new Error(
          `kv value for "${key2}" is ${bytes} bytes; the limit is ${KV_VALUE_MAX_BYTES} (256KB). Store large data in storage.database() instead.`
        );
      }
      kvRows.set(key2, json);
    },
    async delete(key2) {
      assertLive();
      kvRows.delete(key2);
    },
    async list(prefix) {
      assertLive();
      return [...kvRows.keys()].filter((key2) => prefix === void 0 || key2.startsWith(prefix)).sort();
    }
  };
  const storageRoot = persistentState.storageRoot;
  let databaseHandle;
  const storage = {
    kv,
    database() {
      assertLive();
      if (!databaseHandle?.open) {
        databaseHandle = new Database(join(storageRoot, "data.db"));
        databaseHandle.pragma("auto_vacuum = INCREMENTAL");
        databaseHandle.pragma("journal_mode = WAL");
        databaseHandle.pragma("busy_timeout = 5000");
      }
      return databaseHandle;
    },
    migrate(database, statements) {
      assertLive();
      runPluginStorageMigrations(database, statements);
    }
  };
  const settingsDescriptors = {};
  const settingsListeners = [];
  const storedSettings = persistentState.storedSettings;
  async function setSettingsValues(values) {
    const errors = validateSettingsUpdate(settingsDescriptors, values);
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
    const prev = readSettingsValues(settingsDescriptors, storedSettings);
    for (const [key2, value] of Object.entries(values)) {
      if (value === null) storedSettings.delete(key2);
      else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        storedSettings.set(key2, value);
      } else {
        throw new Error(`setting "${key2}" has an unsupported value`);
      }
    }
    const next = readSettingsValues(settingsDescriptors, storedSettings);
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    for (const listener of settingsListeners) {
      try {
        listener(next, prev);
      } catch (error) {
        emitLog(
          "warn",
          `settings onChange listener failed: ${errorMessage(error)}`
        );
      }
    }
  }
  const settings = {
    define(descriptors) {
      assertLive();
      const validated = registerSettingDescriptors(
        settingsDescriptors,
        descriptors
      );
      return {
        async get() {
          assertLive();
          return readSettingsValues(validated, storedSettings);
        },
        async experimental_set(values) {
          assertLive();
          const rawValues = {};
          for (const [key2, value] of Object.entries(values)) {
            rawValues[key2] = value;
          }
          const errors = validateSettingsUpdate(validated, rawValues);
          if (errors.length > 0) {
            throw new Error(errors.join("; "));
          }
          await setSettingsValues(rawValues);
          return readSettingsValues(validated, storedSettings);
        },
        onChange(listener) {
          assertLive();
          settingsListeners.push(
            listener
          );
        }
      };
    }
  };
  const httpRoutes = [];
  const websocketRoutes = [];
  const websocketSessions = /* @__PURE__ */ new Set();
  const http = {
    route(method, path, handler, opts) {
      assertLive();
      const route = normalizeHttpRouteRegistration(
        method,
        path,
        handler,
        opts,
        httpRoutes
      );
      httpRoutes.push({ ...route, handler });
    },
    experimental_websocket(path, handler, opts) {
      assertLive();
      const route = normalizeWebSocketRouteRegistration(
        path,
        handler,
        opts,
        websocketRoutes
      );
      websocketRoutes.push({ ...route, handler });
    }
  };
  const rpcHandlers = /* @__PURE__ */ new Map();
  const rpcInvalidations = [];
  const invalidationListeners = /* @__PURE__ */ new Set();
  const watchProducers = /* @__PURE__ */ new Map();
  const activeWatches = /* @__PURE__ */ new Set();
  const rpc = {
    experimental_whileWatched(method, handler) {
      assertLive();
      if (!rpcHandlers.has(method))
        throw new Error(`Unknown RPC method: ${method}`);
      watchProducers.set(method, handler);
    },
    experimental_invalidate(tags) {
      assertLive();
      for (const listener of invalidationListeners) listener();
      rpcInvalidations.push(rpcInvalidationTags.parse(tags));
    },
    experimental_invalidateAll() {
      assertLive();
      for (const listener of invalidationListeners) listener();
      rpcInvalidations.push(null);
    },
    register(contract, handlers, registrationOptions) {
      assertLive();
      for (const [name, record] of normalizeRpcRegistration(
        contract,
        handlers,
        rpcHandlers,
        registrationOptions
      )) {
        rpcHandlers.set(name, record);
      }
    }
  };
  const realtimeSignals = [];
  const realtime = {
    publish(channel, payload) {
      assertLive();
      realtimeSignals.push({
        channel,
        payload: normalizeRealtimePayload(channel, payload)
      });
    }
  };
  const services = [];
  const schedules = [];
  const background = {
    service(name, service) {
      assertLive();
      services.push(
        validateBackgroundServiceRegistration(name, service, services)
      );
    },
    schedule(name, cron, fn) {
      assertLive();
      schedules.push(
        validateScheduleRegistration(
          name,
          cron,
          fn,
          schedules,
          (expression) => {
            CronExpressionParser.parse(expression);
          }
        )
      );
    }
  };
  const cliRecord = {
    registration: null
  };
  const cli = {
    register(registration) {
      assertLive();
      const record = normalizeCliRegistration(
        registration,
        cliRecord.registration !== null
      );
      cliRecord.registration = record;
      const warning = pluginCliCollisionWarning(pluginId, record.name);
      if (warning) emitLog("warn", warning);
    }
  };
  const agentTools = [];
  const providerRegistrations = [];
  const providerEnvResolvers = /* @__PURE__ */ new Map();
  const providerEnvHealthResolvers = /* @__PURE__ */ new Map();
  let agentConfigurationProvider = null;
  let instructionProvider = null;
  function registerProviderDeclaration(declaration) {
    assertLive();
    const normalized = validatePluginProviderDeclaration(declaration);
    const iconRefusal = providerDeclarationIconRefusal(
      pluginId,
      declaredIconNames,
      normalized
    );
    if (iconRefusal !== null) {
      throw new Error(iconRefusal);
    }
    if (options.experimental_hostEntry === false) {
      throw new Error(providerWithoutBridgeMessage(normalized.id));
    }
    if (providerRegistrations.some((existing) => existing.id === normalized.id)) {
      throw new Error(providerAlreadyRegisteredMessage(normalized.id));
    }
    providerRegistrations.push(normalized);
    let disposed2 = false;
    const dispose = () => {
      if (disposed2) return;
      disposed2 = true;
      const index = providerRegistrations.indexOf(normalized);
      if (index !== -1) providerRegistrations.splice(index, 1);
    };
    disposeHooks.push(dispose);
    return { dispose };
  }
  const aiServiceRegistrations = [];
  const attentionPolicies = /* @__PURE__ */ new Map();
  const experimental_threads = {
    experimental_serviceTurnCapabilities() {
      return { serviceTurns: { version: 1 } };
    },
    experimental_childNoticeCapabilities() {
      return { childNotices: { version: 1 } };
    },
    async experimental_sendService(args) {
      return sdk.threads.send({
        ...args,
        originPluginId: pluginId,
        mode: "queue-if-active",
        serviceTurn: {
          version: 1,
          visibility: "hidden",
          reason: args.reason,
          deliveryId: args.deliveryId,
          automaticRedelivery: args.automaticRedelivery,
          origin: { pluginId, senderThreadId: args.senderThreadId ?? null }
        }
      });
    },
    setAttentionPolicy(threadId, policy) {
      assertLive();
      if (policy === null) attentionPolicies.delete(threadId);
      else attentionPolicies.set(threadId, { ...policy });
    }
  };
  const generationServices = /* @__PURE__ */ new Map();
  const generation = createAiGenerationDispatcher(() => [
    ...generationServices.values()
  ]);
  const generationLifetime = new AbortController();
  const experimental_aiServices = {
    experimental_models(args = {}) {
      assertLive();
      return generation.models({
        signal: args.signal ? AbortSignal.any([args.signal, generationLifetime.signal]) : generationLifetime.signal
      });
    },
    experimental_generate(request, args = {}) {
      assertLive();
      return generation.generate(request, {
        signal: args.signal ? AbortSignal.any([args.signal, generationLifetime.signal]) : generationLifetime.signal
      });
    },
    register(declaration) {
      assertLive();
      const normalized = validatePluginAiServiceDeclaration(declaration);
      if (aiServiceRegistrations.some((existing) => existing.id === normalized.id)) {
        throw new Error(aiServiceAlreadyRegisteredMessage(normalized.id));
      }
      const registration = Object.freeze({
        id: normalized.id,
        displayName: normalized.displayName,
        ...normalized.complete === null ? {} : { complete: normalized.complete },
        ...normalized.transcribe === null ? {} : { transcribe: normalized.transcribe },
        ...normalized.status === null ? {} : { status: normalized.status },
        ...normalized.experimental_text === null ? {} : { experimental_text: normalized.experimental_text }
      });
      aiServiceRegistrations.push(registration);
      generationServices.set(normalized.id, { ...normalized, pluginId });
      let disposed2 = false;
      const dispose = () => {
        if (disposed2) return;
        disposed2 = true;
        const index = aiServiceRegistrations.indexOf(registration);
        if (index !== -1) aiServiceRegistrations.splice(index, 1);
        generation.invalidate(`${pluginId}/${normalized.id}`);
        generationServices.delete(normalized.id);
      };
      disposeHooks.push(dispose);
      return { dispose };
    }
  };
  const agents = {
    experimental_toolContextCapabilities() {
      return {
        callerIdentity: true,
        exactTurnOrigin: false,
        perCallTurnOrigin: true
      };
    },
    configure(provider) {
      assertLive();
      if (agentConfigurationProvider !== null) {
        throw new Error("agent configuration is already registered");
      }
      if (typeof provider !== "function") {
        throw new Error(
          "configure requires a provider function (context) => ({ tools, skills, instructions? })"
        );
      }
      agentConfigurationProvider = provider;
    },
    contributeInstructions(provider) {
      assertLive();
      if (instructionProvider !== null) {
        throw new Error("agent instructions are already registered");
      }
      if (typeof provider !== "function") {
        throw new Error(
          "contributeInstructions requires a provider function (ctx) => string | null"
        );
      }
      instructionProvider = provider;
    },
    registerTool(tool) {
      assertLive();
      const record = normalizeAgentToolRegistration({
        pluginId,
        declaredIconNames,
        tool
      });
      if (agentTools.some((existing) => existing.name === record.name)) {
        throw new Error(`tool "${record.name}" is already registered`);
      }
      agentTools.push(record);
    }
  };
  const mentionProviders = [];
  const ui = {
    requestInput,
    registerMentionProvider(provider) {
      assertLive();
      mentionProviders.push(
        normalizeMentionProviderRegistration(provider, mentionProviders)
      );
    }
  };
  let requestedDrains = 0;
  const needsConfigurationMessages = [];
  const status = {
    needsConfiguration(message) {
      assertLive();
      needsConfigurationMessages.push(
        typeof message === "string" && message.length > 0 ? message : "needs configuration"
      );
    }
  };
  const appUrl = options.appUrl ?? null;
  const loopbackBaseUrl = options.loopbackBaseUrl ?? "http://127.0.0.1:38886";
  const dataDir = options.dataDir ?? "/tmp/bb-fake-data-dir";
  const server = {
    get experimental_appUrl() {
      assertLive();
      return appUrl;
    },
    get loopbackBaseUrl() {
      assertLive();
      return loopbackBaseUrl;
    },
    get experimental_dataDir() {
      assertLive();
      return dataDir;
    },
    async internal_DO_NOT_USE_openTunnelIngress(ingressOptions) {
      assertLive();
      const audience = ingressOptions?.audience;
      if (typeof audience !== "string" || audience.length === 0) {
        throw new Error(
          "bb.server.internal_DO_NOT_USE_openTunnelIngress needs a non-empty audience"
        );
      }
      const shared = tunnelIngresses.find(
        (entry2) => entry2.audience === audience && !entry2.closed
      );
      const entry = {
        audience,
        baseUrl: shared?.baseUrl ?? `http://127.0.0.1:${FAKE_TUNNEL_INGRESS_FIRST_PORT + tunnelIngresses.length}`,
        closed: false
      };
      tunnelIngresses.push(entry);
      const close = async () => {
        entry.closed = true;
        const index = disposeHooks.indexOf(close);
        if (index !== -1) disposeHooks.splice(index, 1);
      };
      disposeHooks.push(close);
      return { baseUrl: entry.baseUrl, close };
    }
  };
  const tunnelIngresses = [];
  const { sdk, harness: sdkHarness } = createFakeSdk({
    pluginId,
    overrides: options.sdk
  });
  const threadEventHandlers = {
    "experimental_thread.events": [],
    "experimental_thread.parentChanged": [],
    "experimental_thread.ownerPost": [],
    "experimental_thread.read": [],
    "experimental_terminal.input": [],
    "experimental_host.deleted": [],
    "experimental_environment.removed": [],
    "thread.created": [],
    "thread.active": [],
    "thread.idle": [],
    "thread.failed": [],
    "thread.archived": [],
    "thread.deleted": [],
    "interaction.pending": [],
    "message.queued": [],
    "message.dispatched": [],
    "turn.failed": [],
    "message.cancelled": [],
    "thread.unarchived": []
  };
  const hooks = {
    "message.dispatch": null
  };
  const environmentCompositions = /* @__PURE__ */ new Map();
  const environmentProviders = /* @__PURE__ */ new Map();
  const machineProviders = /* @__PURE__ */ new Map();
  const serverAccessProviders = /* @__PURE__ */ new Map();
  const disposeHooks = [
    () => generationLifetime.abort()
  ];
  const installHandlers = [];
  const serviceControllers = [];
  let nextInteractionId = 1;
  const pendingInteractions = /* @__PURE__ */ new Map();
  function requestInput(request, requestOptions) {
    assertLive();
    const normalized = normalizeInteractionRequest(request);
    const normalizedRequest = {
      threadId: normalized.threadId,
      rendererId: normalized.rendererId,
      title: normalized.title,
      payload: normalized.payload,
      timeoutMs: normalized.timeoutMs,
      ...normalized.presentation === null ? {} : { presentation: normalized.presentation },
      ...normalized.describeSubmission === null ? {} : { describeSubmission: normalized.describeSubmission }
    };
    const id = `fake-interaction-${nextInteractionId++}`;
    return new Promise((resolve2) => {
      const settleAborted = () => {
        const pending = pendingInteractions.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingInteractions.delete(id);
        resolve2({ outcome: "cancelled", reason: "request-aborted" });
      };
      requestOptions?.signal?.addEventListener("abort", settleAborted, {
        once: true
      });
      const timer = setTimeout(() => {
        pendingInteractions.delete(id);
        resolve2({ outcome: "cancelled", reason: "timeout" });
      }, normalized.timeoutMs);
      pendingInteractions.set(id, {
        request: normalizedRequest,
        resolve: resolve2,
        timer
      });
    });
  }
  const sharedPortDeclarations = [];
  let nextTunnelConfig = null;
  let nextTunnelStatuses = [];
  const nextTunnelListeners = /* @__PURE__ */ new Set();
  const hostRpcCalls = [];
  const hostWorkerExitSubscriptions = [];
  const hostSignalSubscriptions = [];
  const hosts = {
    experimental_client({ contract, experimental_signals }) {
      return {
        async call(method, input, callOptions) {
          assertLive();
          const methodContract = contract[method];
          if (methodContract === void 0) {
            throw new Error(`unknown host rpc method "${String(method)}"`);
          }
          if (typeof callOptions !== "object" || callOptions === null || typeof callOptions.hostId !== "string" || callOptions.hostId.length === 0) {
            throw new Error(
              `host rpc method "${String(method)}" requires a host id`
            );
          }
          if (callOptions.signal?.aborted) {
            throw Object.assign(new Error("Host plugin call was cancelled"), {
              name: "AbortError"
            });
          }
          const validatedInput = normalizeRpcJsonResult(
            await validateRpcValue(
              methodContract.input,
              input,
              "input",
              throwRpcError
            ),
            throwRpcError
          );
          const call = {
            method: String(method),
            input: validatedInput,
            hostId: callOptions.hostId,
            ...callOptions.signal === void 0 ? {} : { signal: callOptions.signal }
          };
          hostRpcCalls.push(call);
          if (options.experimental_callHostRpc === void 0) {
            throw new Error(
              `fake plugin host has no experimental_callHostRpc stub for "${String(method)}"`
            );
          }
          const rawOutput = await options.experimental_callHostRpc(call);
          const validatedOutput = await validateRpcValue(
            methodContract.output,
            rawOutput,
            "output",
            throwRpcError
          );
          return normalizeRpcJsonResult(
            validatedOutput,
            throwRpcError
          );
        },
        experimental_onWorkerExit(handler) {
          assertLive();
          if (typeof handler !== "function") {
            throw new Error("host worker exit subscription requires a handler");
          }
          hostWorkerExitSubscriptions.push(handler);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostWorkerExitSubscriptions.indexOf(handler);
            if (index >= 0) hostWorkerExitSubscriptions.splice(index, 1);
          };
        },
        experimental_onSignal(signal, handler) {
          assertLive();
          const descriptor = experimental_signals?.[signal];
          if (typeof signal !== "string" || signal.length === 0 || typeof descriptor !== "object" || descriptor === null || !isStandardSchema(descriptor.payload)) {
            throw new Error(`unknown host signal "${String(signal)}"`);
          }
          if (typeof handler !== "function") {
            throw new Error("host signal subscription requires a handler");
          }
          const record = {
            signal,
            payloadSchema: descriptor.payload,
            handler
          };
          hostSignalSubscriptions.push(record);
          let subscribed = true;
          return () => {
            if (!subscribed) return;
            subscribed = false;
            const index = hostSignalSubscriptions.indexOf(record);
            if (index >= 0) hostSignalSubscriptions.splice(index, 1);
          };
        }
      };
    },
    async ensureSharedPortTunnel(hostId) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("shared-port hostId must be non-empty");
      }
      const identity = options.sharedPortTunnelIdentities?.[hostId];
      if (!identity) {
        throw new Error(`host ${hostId} has no shared-port tunnel identity`);
      }
      return { ...identity };
    },
    declareSharedPorts(hostId, ports) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("shared-port hostId must be non-empty");
      }
      const normalizedPorts = [...new Set(ports)].sort((a, b) => a - b);
      for (const port of normalizedPorts) {
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          throw new Error(
            `shared port ${String(port)} must be an integer between 1 and 65535`
          );
        }
      }
      const replacement = {
        hostId,
        ports: normalizedPorts
      };
      const existingIndex = sharedPortDeclarations.findIndex(
        (declaration) => declaration.hostId === hostId
      );
      if (existingIndex === -1) {
        sharedPortDeclarations.push(replacement);
      } else {
        sharedPortDeclarations[existingIndex] = replacement;
      }
    },
    internal_DO_NOT_USE_setNextTunnels(config) {
      assertLive();
      nextTunnelConfig = config === null ? null : { domain: config.domain, server: { ...config.server } };
    },
    internal_DO_NOT_USE_nextTunnelStatuses() {
      assertLive();
      return structuredClone(nextTunnelStatuses);
    },
    internal_DO_NOT_USE_onNextTunnelStatusChange(listener) {
      assertLive();
      nextTunnelListeners.add(listener);
      return () => {
        nextTunnelListeners.delete(listener);
      };
    }
  };
  disposeHooks.push(() => {
    sharedPortDeclarations.length = 0;
    nextTunnelConfig = null;
    nextTunnelListeners.clear();
  });
  const events = {
    on(event, handler) {
      assertLive();
      const handlers = threadEventHandlers[event];
      if (handlers === void 0) {
        throw new Error(
          `unknown event "${String(event)}" \u2014 supported events: ${Object.keys(
            threadEventHandlers
          ).join(", ")}`
        );
      }
      handlers.push(handler);
    }
  };
  const providers = {
    register(declaration) {
      return registerProviderDeclaration(declaration);
    },
    experimental_contributeEnv(providerId, resolve2) {
      assertLive();
      validateProviderEnvContribution(
        "provider environment contribution",
        providerId,
        resolve2,
        providerEnvResolvers
      );
      providerEnvResolvers.set(providerId, resolve2);
    },
    experimental_contributeEnvHealth(providerId, resolve2) {
      assertLive();
      validateProviderEnvContribution(
        "provider environment health contribution",
        providerId,
        resolve2,
        providerEnvHealthResolvers
      );
      providerEnvHealthResolvers.set(providerId, resolve2);
    }
  };
  const experimental_hooks = {
    on(hook, handler) {
      if (hooks[hook] !== null) {
        throw new Error(pluginHookAlreadyRegisteredMessage(hook));
      }
      storePluginHook(hooks, hook, handler);
    },
    async recheck(_hook) {
      assertLive();
      requestedDrains += 1;
    }
  };
  const experimental_environments = {
    register(declaration) {
      assertLive();
      if ("machineProviderId" in declaration) {
        const composition = environmentCompositionSchema.parse(declaration);
        const problem2 = composition.icon === null ? null : undeclaredIconProblem(
          pluginId,
          declaredIconNames,
          composition.icon
        );
        if (problem2 !== null)
          throw new Error(providerIconRefusalMessage(composition.id, problem2));
        if (environmentProviders.has(composition.id))
          throw new Error(
            "Environment ID is already registered as a concrete provider"
          );
        environmentCompositions.set(composition.id, composition);
        return;
      }
      if (environmentCompositions.has(declaration.id))
        throw new Error(
          "Environment ID is already registered as a composition"
        );
      const target = validatePluginEnvironmentProviderDeclaration(declaration);
      const problem = target.icon === null ? null : undeclaredIconProblem(pluginId, declaredIconNames, target.icon);
      if (problem !== null)
        throw new Error(providerIconRefusalMessage(target.id, problem));
      environmentProviders.set(target.id, target);
    },
    async recheck() {
      assertLive();
      requestedDrains += 1;
    }
  };
  const unavailableMachineBootstrap = () => {
    throw new Error(
      "Configure machineBootstrap in createFakePluginHost to exercise machine bootstrap"
    );
  };
  const experimental_machines = {
    async getResource(hostId) {
      assertLive();
      return options.machineResource ? options.machineResource(hostId) : null;
    },
    ...options.machineBootstrap ?? {
      bootstrap: unavailableMachineBootstrap
    },
    register(declaration) {
      assertLive();
      const target = validatePluginMachineProviderDeclaration(declaration);
      const problem = target.icon === null ? null : undeclaredIconProblem(pluginId, declaredIconNames, target.icon);
      if (problem !== null) {
        throw new Error(providerIconRefusalMessage(target.id, problem));
      }
      machineProviders.set(target.id, target);
    }
  };
  const bb = {
    internal_DO_NOT_USE_recordPluginUse() {
      assertLive();
    },
    pluginId,
    log,
    settings,
    storage,
    http,
    rpc,
    realtime,
    background,
    cli,
    agents,
    providers,
    ui,
    events,
    experimental_hooks,
    experimental_environments,
    experimental_machines,
    experimental_serverAccess: {
      register(declaration) {
        assertLive();
        validateServerAccessProviderDeclaration(declaration);
        if (serverAccessProviders.has(declaration.id))
          throw new Error(
            `Server access provider "${declaration.id}" is already registered`
          );
        serverAccessProviders.set(declaration.id, declaration);
      },
      recheck() {
        assertLive();
        requestedDrains += 1;
      }
    },
    status,
    server,
    hosts,
    experimental_aiServices,
    experimental_threads,
    experimental_questionResolution: void 0,
    experimental_questionResolutionScope: {
      register() {
        throw new Error(
          "Question scope requires the real host authority service"
        );
      }
    },
    get sdk() {
      assertLive();
      return sdk;
    },
    onDispose(hook) {
      assertLive();
      disposeHooks.push(hook);
    },
    onInstall(handler) {
      assertLive();
      if (typeof handler !== "function") {
        throw new Error("onInstall expects a function");
      }
      installHandlers.push(handler);
    }
  };
  const hostLifetime = new AbortController();
  async function disposeHost(cleanupStorage) {
    if (disposed) return;
    disposed = true;
    hostLifetime.abort();
    for (const [id, pending] of pendingInteractions) {
      clearTimeout(pending.timer);
      pendingInteractions.delete(id);
      pending.resolve({ outcome: "cancelled", reason: "plugin-disposed" });
    }
    for (const session of [...websocketSessions]) {
      await session.closeForReload();
    }
    for (const controller of serviceControllers) controller.abort();
    for (const controller of activeWatches) controller.abort();
    activeWatches.clear();
    for (const hook of [...disposeHooks].reverse()) {
      try {
        await hook();
      } catch (error) {
        emitLog("warn", `dispose hook failed: ${errorMessage(error)}`);
      }
    }
    if (databaseHandle) {
      try {
        databaseHandle.close();
      } catch (error) {
        emitLog("warn", `database close failed: ${errorMessage(error)}`);
      }
    }
    if (cleanupStorage) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
    hostWorkerExitSubscriptions.splice(0);
    hostSignalSubscriptions.splice(0);
    invalidated = true;
  }
  const harness = {
    get behavior() {
      return this;
    },
    get inspection() {
      return this;
    },
    get lifecycle() {
      return this;
    },
    pluginId,
    logEntries,
    experimental_onRpcInvalidation(listener) {
      invalidationListeners.add(listener);
      return () => {
        invalidationListeners.delete(listener);
      };
    },
    experimental_rpcInvalidations: rpcInvalidations,
    realtimeSignals,
    needsConfigurationMessages,
    get recheckCount() {
      return requestedDrains;
    },
    internal_DO_NOT_USE_tunnelIngresses: tunnelIngresses,
    sharedPortDeclarations,
    get internal_DO_NOT_USE_nextTunnelConfig() {
      return nextTunnelConfig;
    },
    internal_DO_NOT_USE_setNextTunnelStatuses(statuses) {
      nextTunnelStatuses = structuredClone([...statuses]);
      for (const listener of [...nextTunnelListeners]) listener();
    },
    experimental_hostRpcCalls: hostRpcCalls,
    sdk: sdkHarness,
    registrations: {
      settingsDescriptors,
      httpRoutes,
      websocketRoutes,
      get experimental_publishedRpcMethods() {
        return [...rpcHandlers.values()].flatMap(
          (record) => record.publication === null ? [] : [record.publication]
        );
      },
      get rpcMethods() {
        return [...rpcHandlers.keys()];
      },
      services,
      schedules,
      get cli() {
        return cliRecord.registration;
      },
      agentTools,
      get agentConfigurationProvider() {
        return agentConfigurationProvider;
      },
      get instructionProvider() {
        return instructionProvider;
      },
      get threadEventHandlers() {
        return {
          "experimental_thread.events": threadEventHandlers["experimental_thread.events"].length,
          "experimental_thread.parentChanged": threadEventHandlers["experimental_thread.parentChanged"].length,
          "experimental_thread.ownerPost": threadEventHandlers["experimental_thread.ownerPost"].length,
          "experimental_thread.read": threadEventHandlers["experimental_thread.read"].length,
          "experimental_terminal.input": threadEventHandlers["experimental_terminal.input"].length,
          "experimental_environment.removed": threadEventHandlers["experimental_environment.removed"].length,
          "experimental_host.deleted": threadEventHandlers["experimental_host.deleted"].length,
          "thread.created": threadEventHandlers["thread.created"].length,
          "thread.active": threadEventHandlers["thread.active"].length,
          "thread.idle": threadEventHandlers["thread.idle"].length,
          "thread.failed": threadEventHandlers["thread.failed"].length,
          "thread.archived": threadEventHandlers["thread.archived"].length,
          "thread.deleted": threadEventHandlers["thread.deleted"].length,
          "interaction.pending": threadEventHandlers["interaction.pending"].length,
          "message.queued": threadEventHandlers["message.queued"].length,
          "message.dispatched": threadEventHandlers["message.dispatched"].length,
          "turn.failed": threadEventHandlers["turn.failed"].length,
          "message.cancelled": threadEventHandlers["message.cancelled"].length,
          "thread.unarchived": threadEventHandlers["thread.unarchived"].length
        };
      },
      get hooks() {
        return { ...hooks };
      },
      get environmentCompositions() {
        return new Map(environmentCompositions);
      },
      get environmentProviders() {
        return new Map(environmentProviders);
      },
      get serverAccessProviders() {
        return new Map(serverAccessProviders);
      },
      get machineProviders() {
        return new Map(machineProviders);
      },
      mentionProviders,
      providerRegistrations,
      providerEnvResolvers,
      providerEnvHealthResolvers,
      aiServiceRegistrations,
      attentionPolicies
    },
    get pendingInteractions() {
      return [...pendingInteractions].map(([id, pending]) => ({
        id,
        ...pending.request
      }));
    },
    async experimental_emitHostWorkerExit(hostId) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("host worker exit hostId must be non-empty");
      }
      for (const handler of [...hostWorkerExitSubscriptions]) {
        await handler({ hostId });
      }
    },
    async resolveProviderEnv(providerId, context) {
      assertLive();
      const resolve2 = providerEnvResolvers.get(providerId);
      if (resolve2 === void 0) return [];
      try {
        return validatePluginProviderEnvEntries(await resolve2(context));
      } catch (error) {
        emitLog(
          "warn",
          `provider environment contribution failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return [];
      }
    },
    async resolveProviderEnvHealth(providerId, context) {
      assertLive();
      if (!providerEnvResolvers.has(providerId)) return null;
      const resolve2 = providerEnvHealthResolvers.get(providerId);
      if (resolve2 === void 0) return null;
      try {
        const value = await resolve2(context);
        if (value === null) return null;
        if (value.label.trim().length === 0) {
          throw new Error("label must not be empty");
        }
        if (value.statusMessage.trim().length === 0) {
          throw new Error("statusMessage must not be empty");
        }
        return value;
      } catch (error) {
        emitLog(
          "warn",
          `provider environment health contribution failed: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    },
    async experimental_emitHostSignal(hostId, signal, payload) {
      assertLive();
      if (hostId.trim().length === 0) {
        throw new Error("host signal hostId must be non-empty");
      }
      const subscriptions = hostSignalSubscriptions.filter(
        (subscription) => subscription.signal === signal
      );
      for (const subscription of subscriptions) {
        const normalized = normalizeRpcJsonResult(
          await validateRpcValue(
            subscription.payloadSchema,
            payload,
            "input",
            throwRpcError
          ),
          throwRpcError
        );
        const parsed = await validateRpcValue(
          subscription.payloadSchema,
          normalized,
          "input",
          throwRpcError
        );
        await subscription.handler({ hostId, payload: parsed });
      }
    },
    submitInteraction(id, value) {
      const pending = pendingInteractions.get(id);
      if (!pending) throw new Error(`no pending interaction "${id}"`);
      clearTimeout(pending.timer);
      pendingInteractions.delete(id);
      pending.resolve({ outcome: "submitted", value });
    },
    cancelInteraction(id) {
      const pending = pendingInteractions.get(id);
      if (!pending) throw new Error(`no pending interaction "${id}"`);
      clearTimeout(pending.timer);
      pendingInteractions.delete(id);
      pending.resolve({ outcome: "cancelled", reason: "user" });
    },
    async setSettings(values) {
      await setSettingsValues(values);
    },
    experimental_watchRpc(method, read) {
      const producer = watchProducers.get(method);
      if (producer === void 0) {
        throw new Error(`rpc method "${method}" has no watch producer`);
      }
      const controller = new AbortController();
      activeWatches.add(controller);
      void producer(read, controller.signal);
      return () => {
        activeWatches.delete(controller);
        controller.abort();
      };
    },
    async callRpc(method, input, options2 = {}) {
      const record = rpcHandlers.get(method);
      if (!record) {
        return throwRpcError({
          code: "unknown_method",
          message: `plugin "${pluginId}" has no rpc method "${method}"`
        });
      }
      const parsedInput = input === void 0 ? null : jsonRoundTrip(input, `rpc "${method}" input`);
      const validatedInput = await validateRpcValue(
        record.inputSchema,
        parsedInput,
        "input",
        throwRpcError
      );
      let result;
      try {
        result = await record.handler(validatedInput, {
          experimental_caller: options2.experimental_caller ?? {
            kind: "client"
          },
          experimental_signal: options2.signal === void 0 ? hostLifetime.signal : AbortSignal.any([options2.signal, hostLifetime.signal])
        });
      } catch (error) {
        const refusal = readPluginRpcRefusal(error);
        if (refusal !== null) return throwRpcError(refusal);
        return throwRpcError({
          code: "handler_error",
          message: errorMessage(error)
        });
      }
      const validatedOutput = await validateRpcValue(
        record.outputSchema,
        result,
        "output",
        throwRpcError
      );
      const jsonResult = normalizeRpcJsonResult(validatedOutput, throwRpcError);
      const { invalidated: invalidated2 } = rpcResponseTags(
        record.declarations,
        validatedInput,
        validatedOutput
      );
      if (invalidated2.length > 0) rpc.experimental_invalidate(invalidated2);
      return jsonResult;
    },
    async runCli(argv, ctx = {}) {
      const registration = cliRecord.registration;
      if (!registration) {
        throw new Error(`plugin "${pluginId}" registers no CLI command`);
      }
      try {
        const result = await registration.run(argv, ctx);
        if (typeof result?.exitCode !== "number") {
          throw new Error(
            "cli run() must return { exitCode: number, stdout?, stderr? }"
          );
        }
        return enforcePluginCliOutputLimit(
          {
            exitCode: result.exitCode,
            stdout: typeof result.stdout === "string" ? result.stdout : "",
            stderr: typeof result.stderr === "string" ? result.stderr : ""
          },
          argv.includes("--json")
        );
      } catch (error) {
        return enforcePluginCliOutputLimit(
          {
            exitCode: 1,
            stdout: "",
            stderr: `bb ${registration.name} failed: ${errorMessage(error)}`
          },
          argv.includes("--json")
        );
      }
    },
    async fetchHttp(method, path, init) {
      const normalizedMethod = String(method).toUpperCase();
      const pathname = new URL(path, "http://plugin.test").pathname;
      const route = httpRoutes.find(
        (candidate) => candidate.method === normalizedMethod && candidate.path === pathname
      );
      if (!route) {
        throw new Error(
          `no http route ${normalizedMethod} ${pathname} is registered \u2014 registered: ${httpRoutes.map((r) => `${r.method} ${r.path}`).join(", ") || "(none)"}`
        );
      }
      const app = new Hono();
      app.on(route.method, route.path, async (context) => {
        try {
          return adoptHttpRouteResponse(await route.handler(context));
        } catch (error) {
          const message = errorMessage(error);
          emitLog(
            "warn",
            `http ${route.method} ${route.path} failed: ${message}`
          );
          return context.json(
            { ok: false, error: `plugin route failed: ${message}` },
            500
          );
        }
      });
      return app.request(path, { ...init, method: normalizedMethod });
    },
    async experimental_openWebSocket(path, init) {
      assertLive();
      const url = new URL(path, "http://plugin.test");
      const route = websocketRoutes.find(
        (candidate) => candidate.path === url.pathname
      );
      if (!route) {
        throw new Error(
          `no websocket route ${url.pathname} is registered \u2014 registered: ${websocketRoutes.map((candidate) => candidate.path).join(", ") || "(none)"}`
        );
      }
      const request = new Request(url, { ...init, method: "GET" });
      let handlers;
      try {
        handlers = route.handler({
          request,
          url,
          headers: request.headers
        });
        if (typeof handlers !== "object" || handlers === null || Array.isArray(handlers)) {
          throw new Error("websocket route handler must return an object");
        }
        for (const name of [
          "onOpen",
          "onMessage",
          "onClose",
          "onError"
        ]) {
          const callback = handlers[name];
          if (callback !== void 0 && typeof callback !== "function") {
            throw new Error(
              `websocket route handler ${name} must be a function`
            );
          }
        }
      } catch (error) {
        emitLog(
          "warn",
          `websocket ${route.path} connect failed: ${errorMessage(error)}`
        );
        throw error;
      }
      const sent = [];
      const closeCalls = [];
      let readyState = 0;
      let closeNotified = false;
      let eventQueue = Promise.resolve();
      const invoke = async (event, run) => {
        eventQueue = eventQueue.then(async () => {
          try {
            await run();
          } catch (error) {
            emitLog(
              "warn",
              `websocket ${route.path} ${event} failed: ${errorMessage(error)}`
            );
          }
        });
        await eventQueue;
      };
      const socket = {
        send(data) {
          sent.push(typeof data === "string" ? data : new Uint8Array(data));
        },
        close(code, reason) {
          closeCalls.push({ code: code ?? null, reason: reason ?? null });
          if (readyState < 2) readyState = 2;
        },
        get readyState() {
          return readyState;
        }
      };
      const notifyClose = async (code, reason) => {
        if (closeNotified) return;
        closeNotified = true;
        readyState = 3;
        websocketSessions.delete(session);
        if (handlers.onClose !== void 0) {
          await invoke(
            "close",
            () => handlers.onClose?.(socket, { code, reason })
          );
        }
      };
      const session = {
        sent,
        closeCalls,
        get readyState() {
          return readyState;
        },
        async receive(data) {
          if (readyState !== 1) {
            throw new Error(
              "cannot receive a websocket message while not open"
            );
          }
          if (handlers.onMessage !== void 0) {
            await invoke("message", () => handlers.onMessage?.(socket, data));
          }
        },
        async close(code = 1e3, reason = "") {
          if (readyState < 2) socket.close(code, reason);
          await notifyClose(code, reason);
        },
        async error(error) {
          if (handlers.onError !== void 0) {
            await invoke("error", () => handlers.onError?.(socket, error));
          }
        },
        async closeForReload() {
          socket.close(1012, "Plugin reloaded or disabled");
          await notifyClose(1012, "Plugin reloaded or disabled");
        }
      };
      websocketSessions.add(session);
      readyState = 1;
      if (handlers.onOpen !== void 0) {
        await invoke("open", () => handlers.onOpen?.(socket));
      }
      return session;
    },
    runService(name) {
      const service = services.find((record) => record.name === name);
      if (!service) {
        throw new Error(`no background service "${name}" is registered`);
      }
      const controller = new AbortController();
      serviceControllers.push(controller);
      let started;
      try {
        started = Promise.resolve(service.start(controller.signal)).then(
          () => void 0
        );
      } catch (error) {
        started = Promise.reject(error);
      }
      const done = started.catch((error) => {
        if (isNeedsConfigurationError(error)) {
          needsConfigurationMessages.push(error.message);
          return void 0;
        }
        throw error;
      });
      return { controller, done };
    },
    async runSchedule(name) {
      const schedule = schedules.find((record) => record.name === name);
      if (!schedule) {
        throw new Error(`no schedule "${name}" is registered`);
      }
      await schedule.fn();
    },
    async emitThreadEvent(event, payload) {
      const errors = [];
      for (const handler of [...threadEventHandlers[event]]) {
        try {
          await handler(payload);
        } catch (error) {
          errors.push(error);
          emitLog("warn", `${event} handler failed: ${errorMessage(error)}`);
        }
      }
      return { errors };
    },
    async callAgentTool(name, input, ctx) {
      const record = agentTools.find((tool) => tool.name === name);
      if (!record) {
        throw new Error(`no agent tool "${name}" is registered`);
      }
      const parsed = record.parse(input);
      if (!parsed.ok) {
        throw new Error(
          `tool "${name}" arguments are invalid: ${parsed.error}`
        );
      }
      return record.execute(parsed.value, {
        threadId: ctx?.threadId ?? "thread-test",
        projectId: ctx?.projectId ?? "project-test",
        signal: ctx?.signal ?? new AbortController().signal
      });
    },
    async resolveAgentConfiguration(context) {
      if (agentConfigurationProvider === null) {
        return {
          tools: [...agentTools],
          skills: [...agentSkillIds],
          instructions: null
        };
      }
      const pluginMetadata = deepFreezePluginMetadata(
        validatePluginMetadata(context.pluginMetadata ?? {})
      );
      try {
        const normalized = normalizePluginAgentConfiguration({
          knownSkillIds: new Set(agentSkillIds),
          knownToolIds: new Set(agentTools.map((tool) => tool.name)),
          pluginId,
          value: agentConfigurationProvider({ ...context, pluginMetadata })
        });
        const selectedTools = new Set(normalized.toolIds);
        return {
          tools: agentTools.filter((tool) => selectedTools.has(tool.name)).map((tool) => {
            const parameters = normalized.toolParameterOverrides.get(
              tool.name
            );
            return parameters === void 0 ? tool : { ...tool, inputSchema: parameters };
          }),
          skills: normalized.skillIds,
          instructions: normalized.instructions
        };
      } catch (error) {
        emitLog("warn", `agent configure failed: ${errorMessage(error)}`);
        return { tools: [], skills: [], instructions: null };
      }
    },
    async reload(factory) {
      assertLive();
      const replacement = createFakePluginHostInternal(
        options,
        persistentState
      );
      try {
        await factory(replacement.bb);
      } catch (error) {
        await fakeHostDisposers.get(replacement.harness)?.(false);
        throw error;
      }
      await disposeHost(false);
      return replacement;
    },
    async dispose() {
      await disposeHost(true);
    },
    async install() {
      assertLive();
      for (const handler of [...installHandlers]) {
        try {
          await handler();
        } catch (error) {
          emitLog("warn", `install handler failed: ${errorMessage(error)}`);
        }
      }
    }
  };
  fakeHostDisposers.set(harness, disposeHost);
  return { bb, harness };
}

// src/testing/fixtures.ts
function makeHostResponse(overrides = {}) {
  return {
    id: "host-1",
    name: "Test host",
    type: "persistent",
    status: "connected",
    machineProviderId: null,
    lifecycle: {
      phase: "active",
      suspendedAt: null,
      message: null,
      pendingLog: "",
      teardown: null
    },
    maxPermissionMode: "full",
    lastSeenAt: null,
    lastRejectedProtocolVersion: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}
function makeThreadResponse(overrides = {}) {
  return {
    id: "thread-1",
    projectId: "project-1",
    environmentId: null,
    providerId: "test-provider",
    title: null,
    titleFallback: null,
    sectionId: null,
    status: "idle",
    parentThreadId: null,
    lifecycleOwnerThreadId: null,
    sourceThreadId: null,
    originKind: null,
    originPluginId: null,
    visibility: "visible",
    parentNotifications: "auto",
    archivedAt: null,
    pinnedAt: null,
    deletedAt: null,
    lastReadAt: null,
    latestAttentionAt: 0,
    createdAt: 0,
    updatedAt: 0,
    runtime: { displayStatus: "idle" },
    activeBackgroundAgentCount: 0,
    canRestoreEnvironment: false,
    canEditMessages: true,
    canSpawnChild: true,
    queuedMessageCount: 0,
    ...overrides
  };
}
function makePluginAgentConfigurationContext(overrides = {}) {
  const context = {
    pluginMetadata: {},
    thread: {
      id: "thread-test",
      title: null,
      parentThreadId: null,
      sourceThreadId: null
    },
    project: {
      id: "project-test",
      kind: "standard",
      name: "Test project",
      gitRemoteUrl: null
    },
    environment: {
      id: "environment-test",
      name: null,
      path: "/tmp/test",
      branchName: null,
      workspaceProvisionType: null
    },
    host: { id: "host-test", name: "Test host" },
    provider: {
      id: "test-provider",
      model: "test-model",
      capabilities: { supportsNativeUserQuestion: false }
    },
    origin: { kind: null, pluginId: null }
  };
  return {
    pluginMetadata: overrides.pluginMetadata ?? context.pluginMetadata,
    thread: { ...context.thread, ...overrides.thread },
    project: { ...context.project, ...overrides.project },
    environment: { ...context.environment, ...overrides.environment },
    host: { ...context.host, ...overrides.host },
    provider: {
      ...context.provider,
      ...overrides.provider,
      capabilities: {
        ...context.provider.capabilities,
        ...overrides.provider?.capabilities
      }
    },
    origin: { ...context.origin, ...overrides.origin }
  };
}
function makeMessageDispatchHookContext(overrides = {}) {
  const context = {
    thread: makeThreadResponse({ status: "pending" }),
    project: {
      id: "project-1",
      kind: "standard",
      name: "Test project",
      gitRemoteUrl: null,
      createdAt: 0,
      updatedAt: 0
    },
    environment: null,
    host: null,
    input: { blocks: [], text: "Test message" },
    requestedExecution: {
      providerId: "test-provider",
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null
    },
    executionSources: {
      providerId: null,
      model: null,
      reasoningLevel: null,
      serviceTier: null,
      permissionMode: null
    },
    attempt: "start-turn",
    initiator: "user",
    senderThreadId: null,
    queuedMessages: [],
    experimental_submission: null,
    origin: null,
    originPluginId: null,
    parentThreadId: null,
    environmentIntent: null
  };
  const environmentDefaults = {
    id: "environment-1",
    name: null,
    projectId: "project-1",
    hostId: "host-1",
    path: "/tmp/test",
    isGitRepo: true,
    isWorktree: false,
    branchName: "main",
    baseBranch: null,
    defaultBranch: "main",
    mergeBaseBranch: null,
    environmentProviderId: null,
    environmentProviderSelection: null,
    environmentProviderInstanceKey: null,
    lifecycle: { phase: "active", retireAt: null, teardown: null },
    hostLifecycle: "active",
    managed: false,
    workspaceProvisionType: null,
    status: "ready",
    createdAt: 0,
    updatedAt: 0
  };
  const hostDefaults = makeHostResponse();
  const project = { ...context.project, ...overrides.project };
  const host = overrides.host === void 0 ? context.host : overrides.host === null ? null : { ...hostDefaults, ...overrides.host };
  const environment = overrides.environment === void 0 ? context.environment : overrides.environment === null ? null : {
    ...environmentDefaults,
    projectId: project.id,
    hostId: host?.id ?? environmentDefaults.hostId,
    ...overrides.environment
  };
  const thread = {
    ...context.thread,
    projectId: project.id,
    environmentId: environment?.id ?? null,
    ...overrides.thread
  };
  return {
    ...context,
    ...overrides,
    thread,
    project,
    environment,
    host,
    input: { ...context.input, ...overrides.input },
    requestedExecution: {
      ...context.requestedExecution,
      ...overrides.requestedExecution
    },
    executionSources: {
      ...context.executionSources,
      ...overrides.executionSources
    },
    queuedMessages: (overrides.queuedMessages ?? context.queuedMessages).map(
      (message) => makeQueueEntry({ threadId: thread.id, ...message })
    )
  };
}
function makeQueueEntry(overrides = {}) {
  return {
    id: "queued_1",
    origin: null,
    originPluginId: null,
    initiator: "user",
    senderThreadId: null,
    threadId: "thread-1",
    content: [{ type: "text", text: "Queued turn", mentions: [] }],
    model: "test-model",
    reasoningLevel: "medium",
    permissionMode: "auto",
    serviceTier: "default",
    groupWithNext: false,
    sendAt: null,
    state: "waiting",
    waitingOn: {
      kind: "plugin",
      pluginId: "test-plugin",
      reason: "Waiting"
    },
    failureReason: null,
    payload: { kind: "inline" },
    systemNotice: null,
    editable: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  };
}
function makeTurnFailedEvent(overrides = {}) {
  return {
    threadId: "thread-1",
    requestId: "creq_2222222222",
    turnId: "turn-1",
    errorInfo: null,
    inputAccepted: true,
    rateLimits: null,
    attemptNumber: 1,
    originPluginId: null,
    ...overrides
  };
}
function makePanelController(overrides = {}) {
  return {
    openTab: () => false,
    toggleTab: () => false,
    close: () => false,
    getTabs: () => ({ open: false, selectedKey: null, tabs: [] }),
    selectTab: () => false,
    closeTab: () => false,
    ...overrides
  };
}

// src/testing/public-sdk-only.ts
import { readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join as join2, relative, resolve, sep } from "node:path";

// src/testing/module-references.ts
var JsxMismatch = class extends Error {
};
var IDENTIFIER_START = /[\p{ID_Start}$_]/u;
var IDENTIFIER_PART = /[\p{ID_Continue}$‌‍]/u;
var JSX_NAME_PART = /[\p{ID_Continue}$\-:.]/u;
var NUMBER_PART = /[\w.]/u;
var WHITESPACE = /\s/u;
var MULTI_CHARACTER_PUNCTUATORS = ["...", "?.", "=>", "++", "--"];
var KEYWORDS_BEFORE_EXPRESSION = /* @__PURE__ */ new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
  "yield"
]);
var DECLARATION_MODIFIERS = /* @__PURE__ */ new Set(["type", "typeof", "defer", "source"]);
function tokenize(source, jsx) {
  const tokens = [];
  let pos = source.startsWith("#!") ? source.indexOf("\n") + 1 || source.length : 0;
  const push = (kind, value, start) => {
    tokens.push({ kind, value, start, end: pos });
  };
  const expressionMayStart = () => {
    const last = tokens.at(-1);
    if (last === void 0) return true;
    if (last.kind === "punct") {
      return ![")", "]", "++", "--"].includes(last.value);
    }
    return last.kind === "name" && KEYWORDS_BEFORE_EXPRESSION.has(last.value);
  };
  const skipComment = () => {
    if (source[pos] !== "/") return false;
    if (source[pos + 1] === "/") {
      const newline = source.indexOf("\n", pos);
      pos = newline === -1 ? source.length : newline;
      return true;
    }
    if (source[pos + 1] === "*") {
      const close = source.indexOf("*/", pos + 2);
      pos = close === -1 ? source.length : close + 2;
      return true;
    }
    return false;
  };
  const readString = () => {
    const start = pos;
    const quote = source[pos];
    pos++;
    while (pos < source.length) {
      const char = source[pos];
      if (char === "\\") {
        pos += 2;
        continue;
      }
      if (char === "\n") break;
      if (char === quote) {
        pos++;
        push("string", source.slice(start + 1, pos - 1), start);
        return;
      }
      pos++;
    }
    push("literal", source.slice(start, pos), start);
  };
  const readTemplate = () => {
    push("literal", "`", pos);
    pos++;
    while (pos < source.length) {
      const char = source[pos];
      if (char === "\\") {
        pos += 2;
        continue;
      }
      if (char === "`") {
        pos++;
        break;
      }
      if (char === "$" && source[pos + 1] === "{") {
        pos += 2;
        scan(true);
        continue;
      }
      pos++;
    }
    push("literal", "`", pos);
  };
  const readRegex = () => {
    const start = pos;
    let inClass = false;
    pos++;
    while (pos < source.length) {
      const char = source[pos];
      if (char === "\\") {
        pos += 2;
        continue;
      }
      if (char === "\n") break;
      pos++;
      if (inClass) {
        if (char === "]") inClass = false;
      } else if (char === "[") {
        inClass = true;
      } else if (char === "/") {
        while (pos < source.length && IDENTIFIER_PART.test(source[pos] ?? "")) {
          pos++;
        }
        break;
      }
    }
    push("literal", source.slice(start, pos), start);
  };
  const readWhile = (pattern) => {
    const start = pos;
    while (pos < source.length && pattern.test(source[pos] ?? "")) pos++;
    return source.slice(start, pos);
  };
  const skipJsxSpace = () => {
    while (pos < source.length) {
      if (WHITESPACE.test(source[pos] ?? "")) {
        pos++;
      } else if (!skipComment()) {
        return;
      }
    }
  };
  const readJsxName = () => IDENTIFIER_START.test(source[pos] ?? "") ? readWhile(JSX_NAME_PART) : "";
  const readJsxContainer = () => {
    push("punct", "{", pos);
    pos++;
    if (!scan(true)) throw new JsxMismatch();
    push("punct", "}", pos - 1);
  };
  const readJsxElement = () => {
    const start = pos;
    pos++;
    skipJsxSpace();
    const name = readJsxName();
    skipJsxSpace();
    if (name === "" && source[pos] !== ">") throw new JsxMismatch();
    if (source[pos] === "," || source.startsWith("extends", pos) && !IDENTIFIER_PART.test(source[pos + "extends".length] ?? "")) {
      throw new JsxMismatch();
    }
    push("literal", "<", start);
    for (; ; ) {
      skipJsxSpace();
      const char = source[pos];
      if (char === "/" && source[pos + 1] === ">") {
        pos += 2;
        return;
      }
      if (char === ">") {
        pos++;
        break;
      }
      if (char === "{") {
        readJsxContainer();
        continue;
      }
      if (readJsxName() === "") throw new JsxMismatch();
      skipJsxSpace();
      if (source[pos] !== "=") continue;
      pos++;
      skipJsxSpace();
      const value = source[pos];
      if (value === '"' || value === "'") {
        const close = source.indexOf(value, pos + 1);
        if (close === -1) throw new JsxMismatch();
        pos = close + 1;
      } else if (value === "{") {
        readJsxContainer();
      } else if (value === "<") {
        readJsxElement();
      } else {
        throw new JsxMismatch();
      }
    }
    while (pos < source.length) {
      const char = source[pos];
      if (char === "{") {
        readJsxContainer();
      } else if (char === "<") {
        const tagStart = pos;
        pos++;
        skipJsxSpace();
        if (source[pos] !== "/") {
          pos = tagStart;
          readJsxElement();
          continue;
        }
        pos++;
        skipJsxSpace();
        const closing = readJsxName();
        skipJsxSpace();
        if (closing !== name || source[pos] !== ">") throw new JsxMismatch();
        pos++;
        return;
      } else {
        pos++;
      }
    }
    throw new JsxMismatch();
  };
  const tryJsx = () => {
    const savedPos = pos;
    const savedLength = tokens.length;
    try {
      readJsxElement();
      return true;
    } catch (error) {
      if (!(error instanceof JsxMismatch)) throw error;
      pos = savedPos;
      tokens.length = savedLength;
      return false;
    }
  };
  function scan(untilClosingBrace) {
    let depth = 0;
    while (pos < source.length) {
      const char = source[pos] ?? "";
      const start = pos;
      if (WHITESPACE.test(char) || skipComment()) {
        if (pos === start) pos++;
      } else if (char === '"' || char === "'") {
        readString();
      } else if (char === "`") {
        readTemplate();
      } else if (char === "/" && expressionMayStart()) {
        readRegex();
      } else if (char === "<" && jsx && expressionMayStart() && tryJsx()) {
        continue;
      } else if (/\d/u.test(char) || char === "." && /\d/u.test(source[pos + 1] ?? "")) {
        push("literal", readWhile(NUMBER_PART), start);
      } else if (IDENTIFIER_START.test(char)) {
        push("name", readWhile(IDENTIFIER_PART), start);
      } else {
        if (char === "{") depth++;
        if (char === "}") {
          if (depth === 0 && untilClosingBrace) {
            pos++;
            return true;
          }
          depth--;
        }
        const punct = MULTI_CHARACTER_PUNCTUATORS.find(
          (candidate) => source.startsWith(candidate, pos) && !(candidate === "?." && /\d/u.test(source[pos + 2] ?? ""))
        ) ?? char;
        pos += punct.length;
        push("punct", punct, start);
      }
    }
    return false;
  }
  scan(false);
  return tokens;
}
function isPunct(token, value) {
  return token?.kind === "punct" && token.value === value;
}
function isName(token, value) {
  return token?.kind === "name" && (value === void 0 || token.value === value);
}
function closingIndex(tokens, open, opener, closer) {
  let depth = 0;
  for (let index = open; index < tokens.length; index++) {
    if (isPunct(tokens[index], opener)) depth++;
    if (isPunct(tokens[index], closer) && --depth === 0) return index;
  }
  return -1;
}
function specifierAfterFrom(tokens, index) {
  const specifier = tokens[index + 1];
  return isName(tokens[index], "from") && specifier?.kind === "string" ? specifier.value : void 0;
}
function importDeclarationSpecifier(tokens, keyword) {
  let index = keyword + 1;
  const first = tokens[index];
  if (first?.kind === "string") return first.value;
  const afterModifier = tokens[index + 1];
  if (first?.kind === "name" && DECLARATION_MODIFIERS.has(first.value) && (isPunct(afterModifier, "{") || isPunct(afterModifier, "*") || isName(afterModifier) && afterModifier?.value !== "from")) {
    index++;
  }
  if (isName(tokens[index])) {
    index++;
    if (!isPunct(tokens[index], ",")) return specifierAfterFrom(tokens, index);
    index++;
  }
  if (isPunct(tokens[index], "{")) {
    const close = closingIndex(tokens, index, "{", "}");
    return close === -1 ? void 0 : specifierAfterFrom(tokens, close + 1);
  }
  if (isPunct(tokens[index], "*") && isName(tokens[index + 1], "as")) {
    return specifierAfterFrom(tokens, index + 3);
  }
  return void 0;
}
function exportDeclarationSpecifier(tokens, keyword) {
  let index = keyword + 1;
  if (isName(tokens[index], "type")) index++;
  if (isPunct(tokens[index], "*")) {
    return isName(tokens[index + 1], "as") ? specifierAfterFrom(tokens, index + 3) : specifierAfterFrom(tokens, index + 1);
  }
  if (isPunct(tokens[index], "{")) {
    const close = closingIndex(tokens, index, "{", "}");
    return close === -1 ? void 0 : specifierAfterFrom(tokens, close + 1);
  }
  return void 0;
}
function moduleReferences(source, options) {
  const tokens = tokenize(source, options.jsx);
  const references = [];
  tokens.forEach((token, index) => {
    if (token.kind !== "name") return;
    const previous = tokens[index - 1];
    if ([".", "?.", "#"].some((value) => isPunct(previous, value))) return;
    const keyword = token.value;
    if ((keyword === "import" || keyword === "require") && isPunct(tokens[index + 1], "(")) {
      const close = closingIndex(tokens, index + 1, "(", ")");
      const after = tokens[close + 1];
      if (close === -1 || close === index + 2 || isPunct(after, "{") || isPunct(after, ":") && !isPunct(previous, "?")) {
        return;
      }
      const argument = tokens[index + 2];
      const argumentEnd = tokens[index + 3];
      if (argument?.kind === "string" && (isPunct(argumentEnd, ")") || isPunct(argumentEnd, ","))) {
        references.push({ specifier: argument.value, dynamic: false });
        return;
      }
      const open = tokens[index + 1];
      const closeToken = tokens[close];
      if (open === void 0 || closeToken === void 0) return;
      references.push({
        specifier: source.slice(open.end, closeToken.start).trim(),
        dynamic: true
      });
      return;
    }
    const specifier = keyword === "import" ? importDeclarationSpecifier(tokens, index) : keyword === "export" ? exportDeclarationSpecifier(tokens, index) : void 0;
    if (specifier !== void 0) {
      references.push({ specifier, dynamic: false });
    }
  });
  return references;
}

// src/testing/public-sdk-only.ts
var SKIPPED_DIRECTORIES = /* @__PURE__ */ new Set(["node_modules", "dist"]);
var SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]s|tsx)$/u;
var TEST_FILE_PATTERN = /\.test\.[cm]?[jt]sx?$/u;
var PRIVATE_PACKAGE_PREFIX = "@bb/";
var PLUGIN_IMPORT_ALLOWLIST = [
  /^@get-bb\/plugin-sdk$/u,
  /^@get-bb\/plugin-sdk\/(?:host|app|provider-bridge|provider-bridge\/acp)$/u,
  /^zod$/u,
  /^node:/u,
  /^\.\.?\//u
];
var TEST_IMPORT_ALLOWLIST = [
  /^@get-bb\/plugin-sdk\/(?:testing|testing\/app|testing\/host|provider-bridge\/testing)$/u,
  /^vitest$/u
];
var RELATIVE_SPECIFIER_PATTERN = /^\.\.?\//u;
function listSourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) {
        files.push(...listSourceFiles(join2(directory, entry.name)));
      }
      continue;
    }
    if (SOURCE_EXTENSIONS.test(entry.name)) {
      files.push(join2(directory, entry.name));
    }
  }
  return files;
}
function escapesPackage(packageRoot, file, specifier) {
  const target = relative(packageRoot, resolve(dirname(file), specifier));
  return isAbsolute(target) || target === ".." || target.startsWith(`..${sep}`);
}
function declaredDependencyNames(packageRoot) {
  const manifest = JSON.parse(
    readFileSync(join2(packageRoot, "package.json"), "utf8")
  );
  const names = [];
  for (const field of ["dependencies", "devDependencies"]) {
    const block = typeof manifest === "object" && manifest !== null && field in manifest ? manifest[field] : void 0;
    if (typeof block === "object" && block !== null) {
      names.push(...Object.keys(block));
    }
  }
  return names;
}
function scanPublicSdkOnly(packageRoot, options = {}) {
  const extra = options.allow ?? [];
  const pluginAllowlist = [...PLUGIN_IMPORT_ALLOWLIST, ...extra];
  const testAllowlist = [...pluginAllowlist, ...TEST_IMPORT_ALLOWLIST];
  const files = [];
  const violations = [];
  for (const path of listSourceFiles(packageRoot)) {
    const file = relative(packageRoot, path);
    files.push(file);
    const allowlist = TEST_FILE_PATTERN.test(path) ? testAllowlist : pluginAllowlist;
    const references = moduleReferences(readFileSync(path, "utf8"), {
      jsx: path.endsWith(".tsx")
    });
    for (const { specifier, dynamic } of references) {
      if (dynamic) {
        violations.push({ file, specifier, reason: "dynamic-specifier" });
      } else if (specifier.startsWith(PRIVATE_PACKAGE_PREFIX)) {
        violations.push({ file, specifier, reason: "private-package" });
      } else if (RELATIVE_SPECIFIER_PATTERN.test(specifier) && escapesPackage(packageRoot, path, specifier) && !extra.some((pattern) => pattern.test(specifier))) {
        violations.push({ file, specifier, reason: "outside-package" });
      } else if (!allowlist.some((pattern) => pattern.test(specifier))) {
        violations.push({ file, specifier, reason: "outside-allowlist" });
      }
    }
  }
  return {
    files,
    violations,
    privateDependencies: declaredDependencyNames(packageRoot).filter(
      (name) => name.startsWith(PRIVATE_PACKAGE_PREFIX)
    )
  };
}
export {
  PluginContextStaleError,
  createFakePluginHost,
  createFakeSdk,
  makePanelController as experimental_makePanelController,
  scanPublicSdkOnly as experimental_scanPublicSdkOnly,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeQueueEntry,
  makeThreadResponse,
  makeTurnFailedEvent
};
