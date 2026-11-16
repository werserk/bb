import { getRelativeHostPath } from "@bb/domain";
import { isArtifactCanonicalRoot } from "@bb/domain/artifact-preview";
import type {
  ExperimentalFileLocation,
  ExperimentalFileOpenOptions,
  ExperimentalLiveFileTarget,
} from "../app-contract.js";
import { PLUGIN_SLOT_ID_PATTERN } from "./composer-customization-validation.js";

const FILE_PATH_MAX_LENGTH = 32_768;
const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_UNC_ABSOLUTE_PATH = /^\\\\/u;
const REVISION_REF = /^(?:HEAD|[0-9a-f]{4,40})$/iu;

function isJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isNonEmptyIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= FILE_PATH_MAX_LENGTH &&
    value.trim() === value
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint < 0x20) return true;
  }
  return false;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isValidPathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== "..";
}

function isValidRevisionRef(value: unknown): value is string {
  return typeof value === "string" && REVISION_REF.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isValidRelativeFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > FILE_PATH_MAX_LENGTH ||
    value.trim() !== value ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    hasUnpairedSurrogate(value)
  ) {
    return false;
  }
  return value.split("/").every(isValidPathSegment);
}

function isValidAbsoluteHostFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > FILE_PATH_MAX_LENGTH ||
    value.trim() !== value ||
    hasControlCharacter(value) ||
    hasUnpairedSurrogate(value)
  ) {
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

export function normalizeExperimentalLiveFileTarget(
  value: unknown,
): ExperimentalLiveFileTarget | null {
  if (!isJsonObject(value) || typeof value.kind !== "string") return null;

  switch (value.kind) {
    case "workspace": {
      const ref = value.experimental_ref;
      if (
        !hasExactKeys(
          value,
          ref === undefined
            ? ["kind", "environmentId", "path"]
            : ["kind", "environmentId", "path", "experimental_ref"],
        ) ||
        !isNonEmptyIdentity(value.environmentId) ||
        !isValidRelativeFilePath(value.path)
      ) {
        return null;
      }
      const target = {
        kind: value.kind,
        environmentId: value.environmentId,
        path: value.path,
      };
      if (ref === undefined) return target;
      return isValidRevisionRef(ref)
        ? { ...target, experimental_ref: ref }
        : null;
    }
    case "host":
      if (
        !hasExactKeys(value, ["kind", "hostId", "path"]) ||
        !isNonEmptyIdentity(value.hostId) ||
        !isValidAbsoluteHostFilePath(value.path)
      ) {
        return null;
      }
      return { kind: value.kind, hostId: value.hostId, path: value.path };
    case "thread-storage":
      if (
        !hasExactKeys(value, ["kind", "threadId", "path"]) ||
        !isNonEmptyIdentity(value.threadId) ||
        !isValidRelativeFilePath(value.path)
      ) {
        return null;
      }
      return { kind: value.kind, threadId: value.threadId, path: value.path };
    default:
      return null;
  }
}

export function normalizeExperimentalFileLocation(
  value: unknown,
): ExperimentalFileLocation | null | undefined {
  if (value === null) return null;
  if (!isJsonObject(value) || typeof value.kind !== "string") return undefined;

  switch (value.kind) {
    case "line":
      if (
        !hasExactKeys(value, ["kind", "line", "column"]) ||
        !isPositiveSafeInteger(value.line) ||
        (value.column !== null && !isPositiveSafeInteger(value.column))
      ) {
        return undefined;
      }
      return {
        kind: value.kind,
        line: value.line,
        column: value.column,
      };
    case "range":
      if (
        !hasExactKeys(value, ["kind", "startLine", "endLine"]) ||
        !isPositiveSafeInteger(value.startLine) ||
        !isPositiveSafeInteger(value.endLine) ||
        value.endLine < value.startLine
      ) {
        return undefined;
      }
      return {
        kind: value.kind,
        startLine: value.startLine,
        endLine: value.endLine,
      };
    default:
      return undefined;
  }
}

export function normalizeExperimentalArtifactScope(
  target: ExperimentalLiveFileTarget,
  location: ExperimentalFileLocation | null,
  artifact: unknown,
): { version: 1; readRoot: string } | null {
  if (
    !isJsonObject(artifact) ||
    !hasExactKeys(artifact, ["version", "readRoot"]) ||
    artifact.version !== 1 ||
    typeof artifact.readRoot !== "string" ||
    location !== null ||
    (target.kind === "workspace" && target.experimental_ref !== undefined)
  )
    return null;
  const root = artifact.readRoot;
  if (
    root.length > FILE_PATH_MAX_LENGTH ||
    hasControlCharacter(root) ||
    hasUnpairedSurrogate(root) ||
    root.split(/[\\/]/u).some((segment) => segment === ".." || segment === ".")
  )
    return null;
  if (target.kind === "host") {
    if (
      !isValidAbsoluteHostFilePath(
        root.replace(/[\\/]+$/u, "") +
          (root.includes("\\") ? "\\__artifact__" : "/__artifact__"),
      )
    )
      return null;
    const relative = getRelativeHostPath({
      rootPath: root,
      candidatePath: target.path,
    });
    if (!relative || !isValidRelativeFilePath(relative)) return null;
  } else {
    if (root !== "" && !isValidRelativeFilePath(root)) return null;
    if (root !== "" && !target.path.startsWith(root + "/")) return null;
  }
  return { version: 1, readRoot: root };
}

function isLiveAbortSignal(value: unknown): value is AbortSignal {
  try {
    if (typeof value !== "object" || value === null) return false;
    const signal = value as AbortSignal;
    return (
      Object.prototype.toString.call(signal) === "[object AbortSignal]" &&
      signal.aborted === false &&
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function" &&
      typeof signal.throwIfAborted === "function"
    );
  } catch {
    return false;
  }
}

function normalizePhysicalSource(value: unknown) {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, ["hostId", "canonicalReadRoot"]) ||
    !isNonEmptyIdentity(value.hostId) ||
    typeof value.canonicalReadRoot !== "string"
  )
    return null;
  const root = value.canonicalReadRoot;
  if (!isArtifactCanonicalRoot(root)) return null;
  return { hostId: value.hostId, canonicalReadRoot: root };
}

export function normalizeExperimentalFileOpenOptions(
  value: unknown,
): ExperimentalFileOpenOptions | null {
  if (
    !isJsonObject(value) ||
    !hasExactKeys(value, [
      "target",
      "location",
      ...(Object.hasOwn(value, "experimental_artifact")
        ? ["experimental_artifact"]
        : []),
    ])
  ) {
    return null;
  }
  const target = normalizeExperimentalLiveFileTarget(value.target);
  const location = normalizeExperimentalFileLocation(value.location);
  if (target === null || location === undefined) return null;
  if (Object.hasOwn(value, "experimental_artifact")) {
    const artifact = value.experimental_artifact;
    if (
      !isJsonObject(artifact) ||
      !hasExactKeys(artifact, [
        "version",
        "readRoot",
        "physicalSource",
        "revalidate",
        "lifetime",
      ]) ||
      typeof artifact.revalidate !== "function" ||
      !isLiveAbortSignal(artifact.lifetime)
    )
      return null;
    const scope = normalizeExperimentalArtifactScope(target, location, {
      version: artifact.version,
      readRoot: artifact.readRoot,
    });
    const physicalSource = normalizePhysicalSource(artifact.physicalSource);
    if (
      scope === null ||
      physicalSource === null ||
      (target.kind === "host" && target.hostId !== physicalSource.hostId)
    )
      return null;
    return {
      target,
      location,
      experimental_artifact: {
        ...scope,
        physicalSource,
        revalidate: artifact.revalidate as NonNullable<
          ExperimentalFileOpenOptions["experimental_artifact"]
        >["revalidate"],
        lifetime: artifact.lifetime,
      },
    };
  }
  return { target, location };
}

export function normalizeExperimentalFilePreviewOptions(
  value: unknown,
): { options: ExperimentalFileOpenOptions; opener: string | null } | null {
  if (!isJsonObject(value)) return null;
  const { opener = null, ...rest } = value;
  if (
    opener !== null &&
    (typeof opener !== "string" || !PLUGIN_SLOT_ID_PATTERN.test(opener))
  ) {
    return null;
  }
  const options = normalizeExperimentalFileOpenOptions(rest);
  return options === null ? null : { options, opener };
}
