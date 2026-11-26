// src/host-contract.ts
function experimental_defineHostEntry(args) {
  return {
    experimental_apiVersion: 1,
    contract: args.contract,
    handlers: args.handlers,
    ...args.experimental_signals === void 0 ? {} : { experimental_signals: args.experimental_signals },
    ...args.dispose === void 0 ? {} : { dispose: args.dispose }
  };
}

// src/native-roots-contract.ts
import { z as z2 } from "zod";

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

// ../domain/src/native-roots.ts
import { z } from "zod";
var PROVIDER_NATIVE_ROOTS_MAX = 32;
var PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}:$/u;
var nativeRootNamePrefixSchema = z.string().refine(
  (value) => value === "" || PROVIDER_NATIVE_ROOT_NAME_PREFIX_PATTERN.test(value),
  "A root name prefix is a plugin-name-like token ending in ':'"
);
var nativeRootManifestPathSchema = z.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "A manifest marker is a relative path without dot segments"
);
var relativeNativeRootPathSchema = z.string().min(1).refine(
  isRelativeProviderSkillRootPath,
  "Roots must be relative paths without dot segments"
);
var absoluteNativeRootPathSchema = z.string().min(1).refine(
  isAbsoluteProviderSkillRootPath,
  "Absolute roots must be absolute paths without dot segments"
);
var providerNativeRootInputSchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    /** Skills nest in subdirectories (the agent scans recursively). */
    recursive: z.boolean().optional(),
    /**
     * Scan the same relative directory in every ancestor of the workspace
     * up to the repository root (`project` roots only).
     */
    ancestors: z.boolean().optional(),
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
var providerNativeRootsInputSchema = z.object({
  user: z.array(providerNativeRootInputSchema).optional(),
  project: z.array(providerNativeRootInputSchema).optional()
}).strict();
var providerNativeRootSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean(),
  ancestors: z.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  /** Absent: every skill-shaped directory under the root is a skill. */
  skipIfManifest: nativeRootManifestPathSchema.optional()
}).strict();
function uniqueByPath(roots) {
  return new Set(roots.map((root) => root.path)).size === roots.length;
}
function nativeRootSideSchema(side) {
  return z.array(
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
var providerNativeRootsSchema = z.object({
  user: nativeRootSideSchema("user"),
  project: nativeRootSideSchema("project")
}).strict();
var EMPTY_PROVIDER_NATIVE_ROOTS = Object.freeze({
  user: Object.freeze([]),
  project: Object.freeze([])
});
var providerResolvedNativeRootShapeSchema = z.enum([
  "skills",
  "skill",
  "skill-file",
  "commands",
  "command-file"
]);
var resolvedNativeRootFieldsSchema = z.object({
  path: absoluteNativeRootPathSchema,
  origin: z.enum(["user", "project"]),
  recursive: z.boolean(),
  /** Only with origin `project`, for a path inside the workspace. */
  ancestors: z.boolean(),
  namePrefix: nativeRootNamePrefixSchema,
  shape: providerResolvedNativeRootShapeSchema,
  /**
   * `skill-file` only: the skill name when the file's frontmatter names
   * none. A vendor plugin's root SKILL.md takes the plugin's name; absent
   * means the parent directory's name.
   */
  fallbackName: z.string().min(1).optional(),
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
function normalizeProviderResolvedNativeRoot(root, side) {
  return {
    path: root.path,
    origin: root.origin,
    recursive: root.recursive ?? false,
    ancestors: root.ancestors ?? false,
    namePrefix: root.namePrefix ?? "",
    shape: root.shape ?? (side === "skills" ? "skills" : "commands"),
    ...root.fallbackName === void 0 ? {} : { fallbackName: root.fallbackName },
    ...side === "skills" && root.skipIfManifest !== void 0 ? { skipIfManifest: root.skipIfManifest } : {}
  };
}
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
var providerResolvedNativeRootsSchema = z.object({
  skills: z.array(
    providerResolvedNativeRootSchema.refine(
      (root) => resolvedSkillShapes.has(root.shape),
      "A skills root needs a skill shape"
    )
  ).max(PROVIDER_RESOLVED_NATIVE_ROOTS_MAX),
  commands: z.array(
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
var providerNativeRootSetSchema = z.object({
  skills: providerNativeRootsSchema,
  commands: providerNativeRootsSchema,
  resolved: providerResolvedNativeRootsSchema
}).strict();

// src/rpc-contract.ts
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
function defineRpcContract(contract) {
  return contract;
}

// src/native-roots-contract.ts
var experimental_nativeRootsResolveInputSchema = z2.object({
  /**
   * The provider being listed. One plugin may register several providers
   * (the ACP plugin registers one per agent) from one host entry.
   */
  providerId: z2.string().min(1),
  /** The workspace, or null when bb lists without one (user roots only). */
  cwd: z2.string().min(1).nullable()
}).strict();
var experimental_nativeRootsResolveOutputSchema = z2.object({
  skills: z2.array(providerResolvedNativeRootInputSchema).optional(),
  commands: z2.array(providerResolvedNativeRootInputSchema).optional()
}).strict().transform((value) => ({
  skills: (value.skills ?? []).slice(0, PROVIDER_RESOLVED_NATIVE_ROOTS_MAX).map((root) => normalizeProviderResolvedNativeRoot(root, "skills")),
  commands: (value.commands ?? []).slice(0, PROVIDER_RESOLVED_NATIVE_ROOTS_MAX).map((root) => normalizeProviderResolvedNativeRoot(root, "commands"))
})).pipe(providerResolvedNativeRootsSchema);
function describeIssues(issues) {
  return issues.map(
    (issue) => issue.path.length === 0 ? issue.message : `${issue.path.map(String).join(".")}: ${issue.message}`
  ).join("; ");
}
function filterResolvedRootSide(side, roots, dropped, warn, warned) {
  const rootSchema = providerResolvedNativeRootsSchema.shape[side].element;
  const kept = [];
  for (const root of roots) {
    const shape = providerResolvedNativeRootInputSchema.safeParse(root);
    const result = shape.success ? rootSchema.safeParse(normalizeProviderResolvedNativeRoot(root, side)) : shape;
    if (result.success) {
      kept.push(root);
      continue;
    }
    const reason = describeIssues(result.error.issues);
    dropped.push({ side, path: root.path, reason });
    warnOnce(
      warned,
      warn,
      `${side}\0${root.path}\0${reason}`,
      `resolveNativeRoots: dropped the ${side} root "${root.path}": ${reason}`
    );
  }
  if (kept.length <= PROVIDER_RESOLVED_NATIVE_ROOTS_MAX) {
    return { kept, truncated: 0 };
  }
  const truncated = kept.length - PROVIDER_RESOLVED_NATIVE_ROOTS_MAX;
  warnOnce(
    warned,
    warn,
    `${side}\0truncated\0${kept.length}`,
    `resolveNativeRoots: kept the first ${PROVIDER_RESOLVED_NATIVE_ROOTS_MAX} of ${kept.length} ${side} roots; dropped ${truncated} from "${kept[PROVIDER_RESOLVED_NATIVE_ROOTS_MAX]?.path}" on`
  );
  return { kept: kept.slice(0, PROVIDER_RESOLVED_NATIVE_ROOTS_MAX), truncated };
}
var warnedForWorker = /* @__PURE__ */ new Set();
function warnOnce(warned, warn, key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}
function experimental_filterResolvedNativeRoots(answer, options) {
  const dropped = [];
  const warned = options.warned ?? warnedForWorker;
  const skills = filterResolvedRootSide(
    "skills",
    answer.skills ?? [],
    dropped,
    options.warn,
    warned
  );
  const commands = filterResolvedRootSide(
    "commands",
    answer.commands ?? [],
    dropped,
    options.warn,
    warned
  );
  return {
    answer: { skills: skills.kept, commands: commands.kept },
    dropped,
    truncated: { skills: skills.truncated, commands: commands.truncated }
  };
}
var experimental_nativeRootsHostContract = defineRpcContract({
  resolveNativeRoots: {
    input: experimental_nativeRootsResolveInputSchema,
    output: experimental_nativeRootsResolveOutputSchema
  }
});

// src/vendor-plugin-roots.ts
import fs from "node:fs/promises";
import path from "node:path";
import { z as z3 } from "zod";
var RootCollector = class {
  skills = [];
  commands = [];
  seen = {
    skills: /* @__PURE__ */ new Set(),
    commands: /* @__PURE__ */ new Set()
  };
  add(side, root) {
    if (this.seen[side].has(root.path)) {
      return;
    }
    this.seen[side].add(root.path);
    this[side].push(root);
  }
};
function normalizePluginPathList(value) {
  if (value === void 0) {
    return [];
  }
  return typeof value === "string" ? [value] : [...value];
}
function isPathWithinDirectory(directoryPath, candidatePath) {
  const relativePath = path.relative(directoryPath, candidatePath);
  return relativePath === "" || !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
function resolvePluginRelativePath(pluginRootPath, relativePath) {
  if (path.isAbsolute(relativePath)) {
    return null;
  }
  const resolvedPath = path.resolve(pluginRootPath, relativePath);
  return isPathWithinDirectory(pluginRootPath, resolvedPath) ? resolvedPath : null;
}
async function resolvePluginComponentKind(componentPath, origin) {
  try {
    const stat = await fs.lstat(componentPath);
    if (stat.isFile()) {
      return "file";
    }
    if (stat.isDirectory()) {
      return "directory";
    }
    if (!stat.isSymbolicLink() || origin !== "user") {
      return "missing";
    }
    const targetStat = await fs.stat(componentPath);
    if (targetStat.isFile()) {
      return "file";
    }
    return targetStat.isDirectory() ? "directory" : "missing";
  } catch {
    return "missing";
  }
}
async function resolveSkillDirectoryShape(componentPath, origin) {
  const skillFileKind = await resolvePluginComponentKind(
    path.join(componentPath, "SKILL.md"),
    origin
  );
  return skillFileKind === "file" ? "skill" : "skills";
}
async function addConventionalRoots(collector, plugin, namePrefix) {
  const rootSkillFilePath = path.join(plugin.rootPath, "SKILL.md");
  const rootSkillFileKind = await resolvePluginComponentKind(
    rootSkillFilePath,
    plugin.origin
  );
  if (rootSkillFileKind === "file") {
    collector.add("skills", {
      path: rootSkillFilePath,
      origin: plugin.origin,
      namePrefix,
      shape: "skill-file",
      fallbackName: plugin.name
    });
  }
  const skillsRootPath = path.join(plugin.rootPath, "skills");
  const skillsRootKind = await resolvePluginComponentKind(
    skillsRootPath,
    plugin.origin
  );
  if (skillsRootKind === "directory") {
    collector.add("skills", {
      path: skillsRootPath,
      origin: plugin.origin,
      namePrefix,
      shape: "skills"
    });
  }
  const commandsRootPath = path.join(plugin.rootPath, "commands");
  const commandsRootStat = await fs.lstat(commandsRootPath).catch(() => null);
  if (commandsRootStat?.isDirectory()) {
    collector.add("commands", {
      path: commandsRootPath,
      origin: plugin.origin,
      namePrefix,
      shape: "commands"
    });
  }
}
async function addManifestSkillRoots(collector, plugin, namePrefix, recursive) {
  for (const entry of normalizePluginPathList(plugin.skills)) {
    const componentPath = resolvePluginRelativePath(plugin.rootPath, entry);
    if (componentPath === null) {
      continue;
    }
    const componentKind = await resolvePluginComponentKind(
      componentPath,
      plugin.origin
    );
    if (componentKind === "file" && path.basename(componentPath) === "SKILL.md") {
      collector.add("skills", {
        path: componentPath,
        origin: plugin.origin,
        namePrefix,
        shape: "skill-file"
      });
      continue;
    }
    if (componentKind !== "directory") {
      continue;
    }
    if (recursive) {
      collector.add("skills", {
        path: componentPath,
        origin: plugin.origin,
        recursive: true,
        namePrefix,
        shape: "skills"
      });
      continue;
    }
    collector.add("skills", {
      path: componentPath,
      origin: plugin.origin,
      namePrefix,
      shape: await resolveSkillDirectoryShape(componentPath, plugin.origin)
    });
  }
}
async function addManifestCommandRoots(collector, plugin, namePrefix) {
  for (const entry of normalizePluginPathList(plugin.commands)) {
    const componentPath = resolvePluginRelativePath(plugin.rootPath, entry);
    if (componentPath === null) {
      continue;
    }
    const stat = await fs.lstat(componentPath).catch(() => null);
    if (stat === null) {
      continue;
    }
    if (stat.isFile() && componentPath.endsWith(".md")) {
      collector.add("commands", {
        path: componentPath,
        origin: plugin.origin,
        namePrefix,
        shape: "command-file"
      });
      continue;
    }
    if (stat.isDirectory()) {
      collector.add("commands", {
        path: componentPath,
        origin: plugin.origin,
        namePrefix,
        shape: "commands"
      });
    }
  }
}
async function experimental_resolveVendorPluginRoots(args) {
  const collector = new RootCollector();
  for (const plugin of args.plugins) {
    const namePrefix = `${plugin.name}:`;
    if (args.layout === "claude") {
      await addConventionalRoots(collector, plugin, namePrefix);
    }
    await addManifestSkillRoots(
      collector,
      plugin,
      namePrefix,
      args.layout === "grok"
    );
    await addManifestCommandRoots(collector, plugin, namePrefix);
  }
  return { skills: collector.skills, commands: collector.commands };
}
var CLAUDE_DIR_NAME = ".claude";
var CLAUDE_PLUGIN_MANIFEST_PATH = path.join(".claude-plugin", "plugin.json");
var CLAUDE_PLUGIN_INSTALLED_FILE_NAME = "installed_plugins.json";
var claudePluginScopeSchema = z3.enum(["managed", "project", "local", "user"]);
var claudeSettingsSchema = z3.object({
  enabledPlugins: z3.record(z3.string(), z3.boolean()).optional()
}).passthrough();
var claudeInstalledPluginEntrySchema = z3.object({
  gitCommitSha: z3.string().nullable().optional(),
  installPath: z3.string().min(1),
  scope: claudePluginScopeSchema
}).passthrough();
var claudeInstalledPluginsFileSchema = z3.object({
  plugins: z3.record(z3.string(), z3.array(claudeInstalledPluginEntrySchema))
}).passthrough();
var claudePluginPathListSchema = z3.union([z3.string(), z3.array(z3.string())]);
var claudePluginManifestSchema = z3.object({
  name: z3.string().min(1).optional(),
  defaultEnabled: z3.boolean().optional(),
  skills: claudePluginPathListSchema.optional(),
  commands: claudePluginPathListSchema.optional()
}).passthrough();
function resolveStoredPath(homeDir, storedPath) {
  if (storedPath === "~") {
    return homeDir;
  }
  if (storedPath.startsWith("~/")) {
    return path.join(homeDir, storedPath.slice(2));
  }
  return path.resolve(homeDir, storedPath);
}
function resolveClaudeConfigDir(homeDir, env) {
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolveStoredPath(homeDir, configured) : path.join(homeDir, CLAUDE_DIR_NAME);
}
async function readJsonFile(filePath, schema) {
  let content;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  let parsedJson;
  try {
    parsedJson = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = schema.safeParse(parsedJson);
  return parsed.success ? parsed.data : null;
}
async function readDirectoryEntries(directoryPath) {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function directoryHasClaudePluginManifest(directoryPath) {
  try {
    const stat = await fs.lstat(
      path.join(directoryPath, CLAUDE_PLUGIN_MANIFEST_PATH)
    );
    return stat.isFile();
  } catch {
    return false;
  }
}
function readClaudePluginManifest(pluginRootPath) {
  return readJsonFile(
    path.join(pluginRootPath, CLAUDE_PLUGIN_MANIFEST_PATH),
    claudePluginManifestSchema
  );
}
function parseMarketplacePluginId(pluginId) {
  const separatorIndex = pluginId.lastIndexOf("@");
  if (separatorIndex <= 0 || separatorIndex === pluginId.length - 1) {
    return null;
  }
  return {
    pluginName: pluginId.slice(0, separatorIndex),
    marketplaceName: pluginId.slice(separatorIndex + 1)
  };
}
function originForClaudePluginScope(scope) {
  return scope === "project" || scope === "local" ? "project" : "user";
}
function shouldIncludeInstalledClaudePlugin(cwd, plugin) {
  if (plugin.scope === "managed" || plugin.scope === "user") {
    return true;
  }
  return cwd !== null && isPathWithinDirectory(cwd, plugin.installPath);
}
async function readClaudeEnabledPluginSettings(settingsFiles) {
  const enabledPlugins = /* @__PURE__ */ new Map();
  for (const settingsFile of settingsFiles) {
    const settings = await readJsonFile(settingsFile, claudeSettingsSchema);
    for (const [pluginId, enabled] of Object.entries(
      settings?.enabledPlugins ?? {}
    )) {
      enabledPlugins.set(pluginId, enabled);
    }
  }
  return enabledPlugins;
}
function resolveClaudeSettingsFiles(dirs) {
  const files = [path.join(dirs.claudeDir, "settings.json")];
  if (dirs.cwd !== null) {
    files.push(
      path.join(dirs.cwd, CLAUDE_DIR_NAME, "settings.json"),
      path.join(dirs.cwd, CLAUDE_DIR_NAME, "settings.local.json")
    );
  }
  return files;
}
async function readClaudeInstalledPluginReferences(dirs) {
  const installedPlugins = await readJsonFile(
    path.join(dirs.claudeDir, "plugins", CLAUDE_PLUGIN_INSTALLED_FILE_NAME),
    claudeInstalledPluginsFileSchema
  );
  if (!installedPlugins) {
    return [];
  }
  const references = [];
  for (const [id, entries] of Object.entries(installedPlugins.plugins)) {
    for (const entry of entries) {
      references.push({
        id,
        installPath: resolveStoredPath(dirs.homeDir, entry.installPath),
        scope: entry.scope,
        gitCommitSha: entry.gitCommitSha ?? null
      });
    }
  }
  return references;
}
async function findFallbackClaudePluginRoot(dirs, plugin) {
  const pluginId = parseMarketplacePluginId(plugin.id);
  if (!pluginId) {
    return null;
  }
  const pluginCacheRootPath = path.join(
    dirs.claudeDir,
    "plugins",
    "cache",
    pluginId.marketplaceName,
    pluginId.pluginName
  );
  const candidates = [];
  for (const entry of await readDirectoryEntries(pluginCacheRootPath)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidatePath = path.join(pluginCacheRootPath, entry.name);
    if (!await directoryHasClaudePluginManifest(candidatePath)) {
      continue;
    }
    try {
      const stat = await fs.stat(candidatePath);
      candidates.push({ rootPath: candidatePath, modifiedAtMs: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  const commitPrefix = plugin.gitCommitSha?.slice(0, 12);
  if (commitPrefix) {
    const commitMatch = candidates.find(
      (candidate) => path.basename(candidate.rootPath).startsWith(commitPrefix)
    );
    if (commitMatch) {
      return commitMatch.rootPath;
    }
  }
  return candidates.sort((left, right) => right.modifiedAtMs - left.modifiedAtMs)[0]?.rootPath ?? null;
}
function isPluginEnabled(enabledPlugins, pluginId, manifest) {
  return enabledPlugins.get(pluginId) ?? manifest.defaultEnabled ?? true;
}
function vendorPlugin(rootPath, name, origin, manifest) {
  return {
    rootPath,
    name,
    origin,
    skills: manifest.skills,
    commands: manifest.commands
  };
}
async function resolveInstalledClaudePlugins(dirs, enabledPlugins) {
  const plugins = [];
  for (const plugin of await readClaudeInstalledPluginReferences(dirs)) {
    if (!shouldIncludeInstalledClaudePlugin(dirs.cwd, plugin)) {
      continue;
    }
    const rootPath = await directoryHasClaudePluginManifest(
      plugin.installPath
    ) ? plugin.installPath : await findFallbackClaudePluginRoot(dirs, plugin);
    if (rootPath === null) {
      continue;
    }
    const manifest = await readClaudePluginManifest(rootPath);
    if (!manifest || !isPluginEnabled(enabledPlugins, plugin.id, manifest)) {
      continue;
    }
    const pluginId = parseMarketplacePluginId(plugin.id);
    plugins.push(
      vendorPlugin(
        rootPath,
        manifest.name ?? pluginId?.pluginName ?? path.basename(rootPath),
        originForClaudePluginScope(plugin.scope),
        manifest
      )
    );
  }
  return plugins;
}
async function isSkillsDirectoryPluginEntry(entry, entryPath, origin) {
  if (entry.isDirectory()) {
    return directoryHasClaudePluginManifest(entryPath);
  }
  if (!entry.isSymbolicLink() || origin !== "user") {
    return false;
  }
  try {
    const stat = await fs.stat(entryPath);
    return stat.isDirectory() && await directoryHasClaudePluginManifest(entryPath);
  } catch {
    return false;
  }
}
async function resolveSkillsDirectoryClaudePlugins(skillsRootPath, origin, enabledPlugins) {
  const plugins = [];
  const entries = (await readDirectoryEntries(skillsRootPath)).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  for (const entry of entries) {
    const pluginRootPath = path.join(skillsRootPath, entry.name);
    if (!await isSkillsDirectoryPluginEntry(entry, pluginRootPath, origin)) {
      continue;
    }
    const manifest = await readClaudePluginManifest(pluginRootPath);
    if (!manifest) {
      continue;
    }
    const pluginName = manifest.name ?? entry.name;
    if (!isPluginEnabled(enabledPlugins, `${pluginName}@skills-dir`, manifest)) {
      continue;
    }
    plugins.push(vendorPlugin(pluginRootPath, pluginName, origin, manifest));
  }
  return plugins;
}
async function experimental_resolveClaudePluginRoots(args) {
  const dirs = {
    claudeDir: resolveClaudeConfigDir(args.homeDir, args.env),
    cwd: args.cwd === null ? null : path.resolve(args.cwd),
    homeDir: args.homeDir
  };
  const enabledPlugins = await readClaudeEnabledPluginSettings(
    resolveClaudeSettingsFiles(dirs)
  );
  const plugins = await resolveInstalledClaudePlugins(dirs, enabledPlugins);
  if (dirs.cwd !== null) {
    plugins.push(
      ...await resolveSkillsDirectoryClaudePlugins(
        path.join(dirs.cwd, CLAUDE_DIR_NAME, "skills"),
        "project",
        enabledPlugins
      )
    );
  }
  plugins.push(
    ...await resolveSkillsDirectoryClaudePlugins(
      path.join(dirs.claudeDir, "skills"),
      "user",
      enabledPlugins
    )
  );
  const roots = await experimental_resolveVendorPluginRoots({
    plugins,
    layout: "claude"
  });
  return { claudeDir: dirs.claudeDir, ...roots };
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
import fs2 from "node:fs";
import path2 from "node:path";
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
  const extensions = pathExt.split(path2.delimiter).filter(Boolean);
  const commandExtension = path2.extname(command).toLowerCase();
  if (commandExtension !== "" && extensions.some((extension) => extension.toLowerCase() === commandExtension)) {
    return ["", ...extensions];
  }
  return extensions;
}
function* candidatePaths(command, { cwd, searchPath, pathExt }) {
  const extensions = isWindows ? windowsExtensions(command, pathExt) : [""];
  if (separatorPattern.test(command)) {
    const base = path2.resolve(cwd, command);
    for (const extension of extensions) {
      yield base + extension;
    }
    return;
  }
  const directories = [
    // Windows searches the current directory before `PATH`.
    ...isWindows ? [cwd] : [],
    ...searchPath.split(path2.delimiter)
  ];
  for (const directory of directories) {
    const unquoted = isWindows && directory.length > 1 && directory.startsWith('"') && directory.endsWith('"') ? directory.slice(1, -1) : directory;
    if (unquoted === "") {
      continue;
    }
    const base = path2.resolve(cwd, unquoted, command);
    for (const extension of extensions) {
      yield base + extension;
    }
  }
}
function isExecutableSync(filePath) {
  let stats;
  try {
    stats = fs2.statSync(filePath);
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
    fs2.accessSync(filePath, fs2.constants.X_OK);
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
  const result = { ...env };
  const keys = Object.keys(result).filter(
    (key) => key.toUpperCase() === NO_PROXY_KEY && result[key] !== void 0
  );
  for (const key of keys.length > 0 ? keys : [NO_PROXY_KEY])
    result[key] = appendLoopback(result[key] ?? "");
  return result;
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
  return new Promise((resolve2) => {
    let stdout = "";
    let settled = false;
    let timer;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve2({ status, stdout });
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
      const result = await runProbe(registry2, ["query", key], env);
      if (result.status !== 0) continue;
      for (const match of result.stdout.matchAll(
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
    const result = await runProbe(shell, [arg, command], env);
    if (result.status !== 0) {
      if (retainPrevious) return null;
      continue;
    }
    const start = result.stdout.indexOf(`${SHELL_START}
`);
    const end = result.stdout.indexOf(`
${SHELL_END}`, start);
    if (start < 0 || end < 0) {
      if (retainPrevious) return null;
      continue;
    }
    const values = {};
    for (const line of result.stdout.slice(start + SHELL_START.length + 1, end).split("\n")) {
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
    const path4 = this.searchPath(env);
    const result = { ...env };
    if (process.platform === "win32") {
      for (const key of Object.keys(result))
        if (key !== "PATH" && key.toUpperCase() === "PATH") delete result[key];
    }
    if (path4 !== "") result.PATH = path4;
    const callerKeys = new Set(
      Object.keys(env).filter((key) => env[key] !== void 0).map((key) => key.toUpperCase())
    );
    for (const key of NETWORK_KEYS)
      if (!callerKeys.has(key.toUpperCase()) && this.shellEnv[key] !== void 0)
        result[key] = this.shellEnv[key];
    return result;
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
    const path4 = envValue(env, "PATH") ?? "";
    const lookupOptions = {
      cwd,
      path: path4,
      pathExt: extension ? `${extension};${pathExt ?? ".EXE;.COM;.CMD;.BAT"}` : pathExt
    };
    const found = command === "bb" ? path4.split(delimiter).filter(isAbsolute).map(
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
function prepareExecFile(command, args, options) {
  const launch = hostToolchain.command(command, args, options);
  const parsed = process.platform === "win32" && hostToolchain.resolve(launch.command, {
    env: launch.env,
    cwd: options.cwd
  }) === null ? { command: launch.command, args: launch.args, options } : parse(launch.command, launch.args, { ...options, env: launch.env });
  return {
    command: parsed.command,
    args: parsed.args,
    options: {
      ...options,
      ...parsed.options,
      env: launch.env,
      windowsHide: options.windowsHide ?? true
    }
  };
}
function execHostFileCallback(command, args, options, callback) {
  const launch = prepareExecFile(command, args, options);
  return observe(
    nodeExecFile(
      launch.command,
      launch.args,
      { ...launch.options, encoding: options.encoding ?? "utf8" },
      callback
    )
  );
}
function settleExecFile(start) {
  let resolve2;
  let reject;
  const promise = new Promise(
    (resolvePromise, rejectPromise) => {
      resolve2 = resolvePromise;
      reject = rejectPromise;
    }
  );
  const child = start((error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve2({ stdout, stderr });
  });
  return Object.assign(promise, { child });
}
function execHostFile(command, args = [], options = {}) {
  return settleExecFile(
    (callback) => execHostFileCallback(command, args, options, callback)
  );
}

// ../process-utils/src/spawn.ts
function spawnPortableProcess(request) {
  return spawnHostProcess(request.command, request.args, {
    cwd: request.cwd,
    detached: request.detached,
    env: request.env,
    stdio: request.stdio,
    windowsHide: true
  });
}
function assertPortableOutputProcess(child) {
  if (child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Portable child process did not attach output-only stdio");
  }
}
function spawnPortableOutputProcess(request) {
  const child = spawnPortableProcess({
    ...request,
    stdio: ["ignore", "pipe", "pipe"]
  });
  assertPortableOutputProcess(child);
  return child;
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
      const delay2 = Math.min(
        ...this.queue.map(
          (waiter) => agingMs - (performance.now() - waiter.queuedAt) % agingMs
        )
      );
      this.timer = setTimeout(() => this.drain(), delay2);
    }
  }
};
var registry = globalThis;
var scheduler = registry.__bbVcsProcessScheduler ??= new VcsProcessScheduler();
async function runVcsProcess(command, args, operation, options = {}) {
  if (scheduler.admitted.getStore()) {
    options.signal?.throwIfAborted();
    return operation();
  }
  const release = await scheduler.acquire(command, args, options);
  try {
    options.signal?.throwIfAborted();
    return await scheduler.admitted.run(true, operation);
  } finally {
    release();
  }
}

// ../process-utils/src/cwd-processes.ts
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { basename as basename2, dirname as dirname2, join as join2, resolve, sep } from "node:path";
function isPathUnderDirectory(candidate, directory) {
  const normalized = candidate.endsWith(" (deleted)") ? candidate.slice(0, -" (deleted)".length) : candidate;
  return normalized === directory || normalized.startsWith(`${directory}${sep}`);
}
async function listLinuxProcessCwds() {
  const entries = await readdir("/proc");
  const results = [];
  await Promise.all(
    entries.map(async (entry) => {
      if (!/^\d+$/.test(entry)) {
        return;
      }
      try {
        const cwd = await readlink(`/proc/${entry}/cwd`);
        results.push({ pid: Number(entry), cwd });
      } catch {
      }
    })
  );
  return results;
}
async function listLsofProcessCwds() {
  const child = spawnPortableOutputProcess({
    command: "lsof",
    args: ["-a", "-d", "cwd", "-F", "pn", "-w", "-n"]
  });
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  child.stderr.resume();
  await new Promise((resolveExit) => {
    child.once("error", () => resolveExit());
    child.once("exit", () => resolveExit());
  });
  const results = [];
  let pid = null;
  for (const line of Buffer.concat(chunks).toString("utf8").split("\n")) {
    if (line.startsWith("p")) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n") && pid !== null) {
      results.push({ pid, cwd: line.slice(1) });
    }
  }
  return results;
}
async function resolveSweepDirectory(directory) {
  const resolved = resolve(directory);
  let ancestor = dirname2(resolved);
  const missing = [basename2(resolved)];
  for (; ; ) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch {
    }
    const parent = dirname2(ancestor);
    if (parent === ancestor) {
      break;
    }
    missing.unshift(basename2(ancestor));
    ancestor = parent;
  }
  const canonical = join2(ancestor, ...missing);
  try {
    if ((await lstat(canonical)).isSymbolicLink()) {
      return null;
    }
  } catch {
  }
  return canonical;
}
async function listProcessesWithCwdUnder(args) {
  if (process.platform === "win32") {
    return [];
  }
  const directories = (await Promise.all(args.directories.map(resolveSweepDirectory))).filter((directory) => directory !== null);
  if (directories.length === 0) {
    return [];
  }
  const all = process.platform === "linux" ? await listLinuxProcessCwds() : await listLsofProcessCwds();
  return all.filter(
    (entry) => entry.pid !== process.pid && directories.some(
      (directory) => isPathUnderDirectory(entry.cwd, directory)
    )
  );
}
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function delay(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
var MAX_CWD_SWEEP_ROUNDS = 5;
function signalProcesses(targets, signal, signalled) {
  for (const target of targets) {
    try {
      process.kill(target.pid, signal);
      signalled.set(target.pid, target);
    } catch {
    }
  }
}
async function killProcessesWithCwdUnder(args) {
  const graceMs = args.graceMs ?? 2e3;
  const signalled = /* @__PURE__ */ new Map();
  for (let round = 0; round < MAX_CWD_SWEEP_ROUNDS; round += 1) {
    const targets = await listProcessesWithCwdUnder({
      directories: args.directories
    });
    if (targets.length === 0) {
      break;
    }
    signalProcesses(targets, "SIGTERM", signalled);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && targets.some((target) => isProcessAlive(target.pid))) {
      await delay(50);
    }
    const survivors = await listProcessesWithCwdUnder({
      directories: args.directories
    });
    if (survivors.length === 0) {
      break;
    }
    signalProcesses(survivors, "SIGKILL", signalled);
    await delay(50);
  }
  return Array.from(signalled.values());
}

// ../process-utils/src/environment.ts
function sanitizeInheritedChildProcessEnv(args) {
  const sanitizedEnv = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === void 0) {
      continue;
    }
    const normalizedKey = process.platform === "win32" ? key.toUpperCase() : key;
    if (normalizedKey === "NODE_ENV" || normalizedKey.startsWith("BB_")) {
      continue;
    }
    sanitizedEnv[normalizedKey === "PATH" ? "PATH" : key] = value;
  }
  if (args.shellPath !== void 0) {
    sanitizedEnv.PATH = args.shellPath;
  }
  return sanitizedEnv;
}

// ../process-utils/src/process-info.ts
import path3 from "node:path";
var execFileAsync = execHostFile;
async function readProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "win32") return readWindowsProcess(pid);
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "etime=", "-o", "command="],
      {
        timeout: 5e3,
        maxBuffer: 1024 * 1024
      }
    );
    const match = stdout.trim().match(/^(\S+)\s+([\s\S]+)$/u);
    if (match === null) return null;
    const elapsed = parseElapsedSeconds(match[1] ?? "");
    return {
      command: match[2] ?? null,
      startedAt: elapsed === null ? null : Date.now() - elapsed * 1e3
    };
  } catch {
    return null;
  }
}
async function readWindowsProcess(pid) {
  try {
    const pending = execFileAsync(
      path3.join(
        process.env.SystemRoot ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
          `Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | ForEach-Object { @{ command = $_.CommandLine; startedAt = ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress }`
        ].join("; ")
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3e4,
        maxBuffer: 1024 * 1024
      }
    );
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const value = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || !("command" in value) || !("startedAt" in value) || typeof value.command !== "string" && value.command !== null || typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt))
      return null;
    return { command: value.command, startedAt: value.startedAt };
  } catch {
    return null;
  }
}
function parseElapsedSeconds(rawElapsed) {
  const match = rawElapsed.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d{1,2}):(\d{2})$/u);
  if (match === null) {
    return null;
  }
  const days = Number(match[1] ?? "0");
  const hours = Number(match[2] ?? "0");
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

// src/kill-processes.ts
function experimental_killProcessesWithCwdUnder(args) {
  if ("directory" in args && typeof args.directory === "string")
    return killProcessesWithCwdUnder({
      ...args,
      directories: [args.directory]
    });
  return killProcessesWithCwdUnder(args);
}

// src/process-identity.ts
function experimental_readProcessIdentity(pid) {
  return readProcessIdentity(pid);
}
export {
  experimental_defineHostEntry,
  experimental_filterResolvedNativeRoots,
  experimental_killProcessesWithCwdUnder,
  experimental_nativeRootsHostContract,
  experimental_nativeRootsResolveInputSchema,
  experimental_nativeRootsResolveOutputSchema,
  experimental_readProcessIdentity,
  experimental_resolveClaudePluginRoots,
  experimental_resolveVendorPluginRoots,
  runVcsProcess as experimental_runVcsProcess,
  sanitizeInheritedChildProcessEnv as experimental_sanitizeInheritedChildProcessEnv,
  spawnPortableOutputProcess as experimental_spawnPortableOutputProcess
};
