// ../domain/src/host-path.ts
var WINDOWS_DRIVE_PATH_PATTERN = /^([A-Za-z]):(?:[\\/]+|$)/u;
var WINDOWS_UNC_PATH_PATTERN = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/u;
var WINDOWS_SEPARATOR_PATTERN = /[\\/]+/u;
function collapseSegments(rawSegments) {
  const segments = [];
  for (const segment of rawSegments) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments;
}
function splitHostPathRoot(path) {
  const drive = WINDOWS_DRIVE_PATH_PATTERN.exec(path);
  if (drive) {
    return {
      flavor: "windows",
      root: `${(drive[1] ?? "").toUpperCase()}:\\`,
      relativePath: path.slice(drive[0].length)
    };
  }
  const unc = WINDOWS_UNC_PATH_PATTERN.exec(path);
  if (unc) {
    return {
      flavor: "windows",
      root: `\\\\${unc[1] ?? ""}\\${unc[2] ?? ""}\\`,
      relativePath: path.slice(unc[0].length)
    };
  }
  if (path.startsWith("/")) {
    return { flavor: "posix", root: "/", relativePath: path.slice(1) };
  }
  return null;
}
function parseHostPath(path) {
  const split = splitHostPathRoot(path);
  if (split === null) {
    return null;
  }
  return {
    flavor: split.flavor,
    root: split.root,
    segments: collapseSegments(
      split.relativePath.split(
        split.flavor === "windows" ? WINDOWS_SEPARATOR_PATTERN : "/"
      )
    )
  };
}
function comparisonSegments(parsed) {
  return parsed.flavor === "windows" ? parsed.segments.map((segment) => segment.toLowerCase()) : parsed.segments;
}
function comparisonRoot(parsed) {
  return parsed.flavor === "windows" ? parsed.root.toLowerCase() : parsed.root;
}
function isHostPathWithin({
  rootPath,
  candidatePath
}) {
  const root = parseHostPath(rootPath);
  const candidate = parseHostPath(candidatePath);
  if (root === null || candidate === null || root.flavor !== candidate.flavor || comparisonRoot(root) !== comparisonRoot(candidate)) {
    return false;
  }
  const rootSegments = comparisonSegments(root);
  const candidateSegments = comparisonSegments(candidate);
  return rootSegments.length <= candidateSegments.length && rootSegments.every((segment, index) => segment === candidateSegments[index]);
}
function getRelativeHostPath({
  rootPath,
  candidatePath
}) {
  if (!isHostPathWithin({ rootPath, candidatePath })) {
    return null;
  }
  const rootSegments = parseHostPath(rootPath)?.segments ?? [];
  const candidateSegments = parseHostPath(candidatePath)?.segments ?? [];
  return candidateSegments.slice(rootSegments.length).join("/");
}

// ../domain/src/artifact-preview.ts
function isPathString(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 32768 || value.trim() !== value || /[\u0000-\u001f]/u.test(value))
    return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}
function isArtifactCanonicalRoot(value) {
  return isPathString(value) && (/^\/(?!\/)/u.test(value) || /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value)) && !value.split(/[\\/]/u).some((segment) => segment === "." || segment === "..");
}

// src/internal/composer-customization-validation.ts
var PLUGIN_SLOT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// src/internal/file-navigation-validation.ts
var FILE_PATH_MAX_LENGTH = 32768;
var WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
var WINDOWS_UNC_ABSOLUTE_PATH = /^\\\\/u;
var REVISION_REF = /^(?:HEAD|[0-9a-f]{4,40})$/iu;
function isJsonObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function hasExactKeys(value, keys) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}
function isNonEmptyIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= FILE_PATH_MAX_LENGTH && value.trim() === value;
}
function hasControlCharacter(value) {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== void 0 && codePoint < 32) return true;
  }
  return false;
}
function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 55296 && codeUnit <= 56319) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 56320 || nextCodeUnit > 57343) return true;
      index += 1;
    } else if (codeUnit >= 56320 && codeUnit <= 57343) {
      return true;
    }
  }
  return false;
}
function isValidPathSegment(segment) {
  return segment.length > 0 && segment !== "." && segment !== "..";
}
function isValidRevisionRef(value) {
  return typeof value === "string" && REVISION_REF.test(value);
}
function isPositiveSafeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isValidRelativeFilePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > FILE_PATH_MAX_LENGTH || value.trim() !== value || value.includes("\\") || hasControlCharacter(value) || hasUnpairedSurrogate(value)) {
    return false;
  }
  return value.split("/").every(isValidPathSegment);
}
function isValidAbsoluteHostFilePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > FILE_PATH_MAX_LENGTH || value.trim() !== value || hasControlCharacter(value) || hasUnpairedSurrogate(value)) {
    return false;
  }
  if (value.startsWith("/") && !value.startsWith("//")) {
    const segments = value.slice(1).split("/");
    return segments.length > 0 && segments.every(isValidPathSegment);
  }
  if (WINDOWS_DRIVE_ABSOLUTE_PATH.test(value)) {
    const segments = value.slice(3).split(/[\\/]/u);
    return segments.length > 0 && segments.every(isValidPathSegment);
  }
  if (WINDOWS_UNC_ABSOLUTE_PATH.test(value)) {
    const segments = value.slice(2).split(/[\\/]/u);
    return segments.length >= 3 && segments.every(isValidPathSegment);
  }
  return false;
}
function normalizeExperimentalLiveFileTarget(value) {
  if (!isJsonObject(value) || typeof value.kind !== "string") return null;
  switch (value.kind) {
    case "workspace": {
      const ref = value.experimental_ref;
      if (!hasExactKeys(
        value,
        ref === void 0 ? ["kind", "environmentId", "path"] : ["kind", "environmentId", "path", "experimental_ref"]
      ) || !isNonEmptyIdentity(value.environmentId) || !isValidRelativeFilePath(value.path)) {
        return null;
      }
      const target = {
        kind: value.kind,
        environmentId: value.environmentId,
        path: value.path
      };
      if (ref === void 0) return target;
      return isValidRevisionRef(ref) ? { ...target, experimental_ref: ref } : null;
    }
    case "host":
      if (!hasExactKeys(value, ["kind", "hostId", "path"]) || !isNonEmptyIdentity(value.hostId) || !isValidAbsoluteHostFilePath(value.path)) {
        return null;
      }
      return { kind: value.kind, hostId: value.hostId, path: value.path };
    case "thread-storage":
      if (!hasExactKeys(value, ["kind", "threadId", "path"]) || !isNonEmptyIdentity(value.threadId) || !isValidRelativeFilePath(value.path)) {
        return null;
      }
      return { kind: value.kind, threadId: value.threadId, path: value.path };
    default:
      return null;
  }
}
function normalizeExperimentalFileLocation(value) {
  if (value === null) return null;
  if (!isJsonObject(value) || typeof value.kind !== "string") return void 0;
  switch (value.kind) {
    case "line":
      if (!hasExactKeys(value, ["kind", "line", "column"]) || !isPositiveSafeInteger(value.line) || value.column !== null && !isPositiveSafeInteger(value.column)) {
        return void 0;
      }
      return {
        kind: value.kind,
        line: value.line,
        column: value.column
      };
    case "range":
      if (!hasExactKeys(value, ["kind", "startLine", "endLine"]) || !isPositiveSafeInteger(value.startLine) || !isPositiveSafeInteger(value.endLine) || value.endLine < value.startLine) {
        return void 0;
      }
      return {
        kind: value.kind,
        startLine: value.startLine,
        endLine: value.endLine
      };
    default:
      return void 0;
  }
}
function normalizeExperimentalArtifactScope(target, location, artifact) {
  if (!isJsonObject(artifact) || !hasExactKeys(artifact, ["version", "readRoot"]) || artifact.version !== 1 || typeof artifact.readRoot !== "string" || location !== null || target.kind === "workspace" && target.experimental_ref !== void 0)
    return null;
  const root = artifact.readRoot;
  if (root.length > FILE_PATH_MAX_LENGTH || hasControlCharacter(root) || hasUnpairedSurrogate(root) || root.split(/[\\/]/u).some((segment) => segment === ".." || segment === "."))
    return null;
  if (target.kind === "host") {
    if (!isValidAbsoluteHostFilePath(
      root.replace(/[\\/]+$/u, "") + (root.includes("\\") ? "\\__artifact__" : "/__artifact__")
    ))
      return null;
    const relative = getRelativeHostPath({
      rootPath: root,
      candidatePath: target.path
    });
    if (!relative || !isValidRelativeFilePath(relative)) return null;
  } else {
    if (root !== "" && !isValidRelativeFilePath(root)) return null;
    if (root !== "" && !target.path.startsWith(root + "/")) return null;
  }
  return { version: 1, readRoot: root };
}
function isLiveAbortSignal(value) {
  try {
    if (typeof value !== "object" || value === null) return false;
    const signal = value;
    return Object.prototype.toString.call(signal) === "[object AbortSignal]" && signal.aborted === false && typeof signal.addEventListener === "function" && typeof signal.removeEventListener === "function" && typeof signal.throwIfAborted === "function";
  } catch {
    return false;
  }
}
function normalizePhysicalSource(value) {
  if (!isJsonObject(value) || !hasExactKeys(value, ["hostId", "canonicalReadRoot"]) || !isNonEmptyIdentity(value.hostId) || typeof value.canonicalReadRoot !== "string")
    return null;
  const root = value.canonicalReadRoot;
  if (!isArtifactCanonicalRoot(root)) return null;
  return { hostId: value.hostId, canonicalReadRoot: root };
}
function normalizeExperimentalFileOpenOptions(value) {
  if (!isJsonObject(value) || !hasExactKeys(value, [
    "target",
    "location",
    ...Object.hasOwn(value, "experimental_artifact") ? ["experimental_artifact"] : []
  ])) {
    return null;
  }
  const target = normalizeExperimentalLiveFileTarget(value.target);
  const location = normalizeExperimentalFileLocation(value.location);
  if (target === null || location === void 0) return null;
  if (Object.hasOwn(value, "experimental_artifact")) {
    const artifact = value.experimental_artifact;
    if (!isJsonObject(artifact) || !hasExactKeys(artifact, [
      "version",
      "readRoot",
      "physicalSource",
      "revalidate",
      "lifetime"
    ]) || typeof artifact.revalidate !== "function" || !isLiveAbortSignal(artifact.lifetime))
      return null;
    const scope = normalizeExperimentalArtifactScope(target, location, {
      version: artifact.version,
      readRoot: artifact.readRoot
    });
    const physicalSource = normalizePhysicalSource(artifact.physicalSource);
    if (scope === null || physicalSource === null || target.kind === "host" && target.hostId !== physicalSource.hostId)
      return null;
    return {
      target,
      location,
      experimental_artifact: {
        ...scope,
        physicalSource,
        revalidate: artifact.revalidate,
        lifetime: artifact.lifetime
      }
    };
  }
  return { target, location };
}
function normalizeExperimentalFilePreviewOptions(value) {
  if (!isJsonObject(value)) return null;
  const { opener = null, ...rest } = value;
  if (opener !== null && (typeof opener !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(opener))) {
    return null;
  }
  const options = normalizeExperimentalFileOpenOptions(rest);
  return options === null ? null : { options, opener };
}
export {
  normalizeExperimentalArtifactScope,
  normalizeExperimentalFileLocation,
  normalizeExperimentalFileOpenOptions,
  normalizeExperimentalFilePreviewOptions,
  normalizeExperimentalLiveFileTarget
};
