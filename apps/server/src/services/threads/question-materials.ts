import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  questionMaterialPathSchema,
  type ConversationQuestionPublication,
  type FrozenQuestionFile,
  type QuestionMaterialManifest,
} from "@bb/domain";
import { HOST_FILE_CHUNK_MAX_BYTES } from "@bb/host-daemon-contract";
import { ApiError } from "../../errors.js";
import { COMMAND_TIMEOUT_MS } from "../../constants.js";
import type { LoggedWorkSessionDeps } from "../../types.js";
import {
  callHostOnlineRpc,
  callHostRetryableOnlineRpc,
} from "../hosts/online-rpc.js";
import { joinHostPathSegments } from "../lib/host-path.js";
import {
  requireThreadStorageTarget,
  type ThreadStorageTarget,
} from "./thread-storage.js";

export const QUESTION_MATERIAL_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  uniqueFiles: 128,
} as const;

export type PreparedQuestionMaterials = QuestionMaterialManifest;

const previewMimeTypes: Record<string, readonly string[]> = {
  html: ["text/html"],
  htm: ["text/html"],
  md: ["text/markdown", "text/x-markdown"],
  txt: ["text/plain"],
  pdf: ["application/pdf"],
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  avif: ["image/avif"],
  svg: ["image/svg+xml"],
  mp3: ["audio/mpeg"],
  wav: ["audio/wav", "audio/x-wav", "audio/wave"],
  ogg: ["audio/ogg"],
  m4a: ["audio/mp4", "audio/x-m4a"],
  flac: ["audio/flac", "audio/x-flac"],
  mp4: ["video/mp4"],
  webm: ["video/webm"],
  mov: ["video/quicktime"],
};

function materialError(message: string): never {
  throw new ApiError(400, "invalid_question_material", message, false);
}

function validatePath(value: string): void {
  if (!questionMaterialPathSchema.safeParse(value).success)
    materialError(
      `Question material path must be a contained thread-storage relative path: ${value}`,
    );
}

async function readStableFile(
  deps: LoggedWorkSessionDeps,
  target: ThreadStorageTarget,
  originalPath: string,
  remainingBytes: number,
): Promise<{ bytes: Buffer; mimeType: string | null; revision: string }> {
  const read = (offset: number, length: number, revision: string | null) =>
    callHostRetryableOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.read_file_chunk",
        path: joinHostPathSegments(target.storagePath, originalPath),
        rootPath: target.storagePath,
        offset,
        length,
        revision,
      },
    });
  const metadata = await read(0, 0, null);
  if (metadata.sizeBytes > QUESTION_MATERIAL_LIMITS.fileBytes)
    materialError(
      `Question material '${originalPath}' exceeds 8 MiB per file (bounded host RPC payloads)`,
    );
  if (metadata.sizeBytes > remainingBytes)
    materialError(
      "Question materials exceed 64 MiB total (bounded host RPC payloads)",
    );
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < metadata.sizeBytes;) {
    const length = Math.min(
      HOST_FILE_CHUNK_MAX_BYTES,
      metadata.sizeBytes - offset,
    );
    const chunk = await read(offset, length, metadata.revision);
    const bytes = Buffer.from(chunk.content, "base64");
    if (
      chunk.revision !== metadata.revision ||
      chunk.sizeBytes !== metadata.sizeBytes ||
      chunk.offset !== offset ||
      chunk.mimeType !== metadata.mimeType ||
      bytes.length !== length
    )
      materialError(
        `Question material '${originalPath}' changed or returned an incomplete chunk`,
      );
    chunks.push(bytes);
    offset += length;
  }
  const final = await read(metadata.sizeBytes, 0, metadata.revision);
  if (
    final.revision !== metadata.revision ||
    final.sizeBytes !== metadata.sizeBytes
  )
    materialError(`Question material '${originalPath}' changed during read`);
  return {
    bytes: Buffer.concat(chunks),
    mimeType: metadata.mimeType,
    revision: metadata.revision,
  };
}

export async function prepareQuestionMaterials(
  deps: LoggedWorkSessionDeps,
  args: {
    threadId: string;
    questionId: string;
    materials: ConversationQuestionPublication["materials"];
  },
): Promise<PreparedQuestionMaterials> {
  if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(args.questionId))
    materialError(
      "Question ID must contain only letters, numbers, underscores and hyphens",
    );
  const paths = new Set<string>();
  const labels = new Map<string, string>();
  for (const material of args.materials) {
    validatePath(material.path);
    if (labels.has(material.path))
      materialError(`Duplicate question material path: ${material.path}`);
    labels.set(material.path, material.label);
    paths.add(material.path);
    for (const dependency of material.dependencies) {
      validatePath(dependency);
      paths.add(dependency);
    }
  }
  if (paths.size > QUESTION_MATERIAL_LIMITS.uniqueFiles)
    materialError(
      "Question materials exceed 128 unique files (bounded host RPC payloads)",
    );
  if (paths.size === 0)
    return { hostId: null, storageRootPath: null, materials: [], files: [] };
  const target = await requireThreadStorageTarget(deps, args.threadId);
  const prefix = `question-materials/${args.questionId}/`;
  const prepared = new Map<
    string,
    Omit<FrozenQuestionFile, "snapshotRevision"> & { bytes: Buffer }
  >();
  let totalBytes = 0;
  for (const originalPath of paths) {
    const { bytes, mimeType } = await readStableFile(
      deps,
      target,
      originalPath,
      QUESTION_MATERIAL_LIMITS.totalBytes - totalBytes,
    );
    if (labels.has(originalPath)) {
      const extension = originalPath.split(".").at(-1)?.toLowerCase() ?? "";
      if (!mimeType || !previewMimeTypes[extension]?.includes(mimeType))
        materialError(
          `Unsupported question material preview '${originalPath}' (${mimeType ?? "unknown MIME type"})`,
        );
    }
    totalBytes += bytes.length;
    prepared.set(originalPath, {
      originalPath,
      snapshotPath: `${prefix}${originalPath}`,
      label: labels.get(originalPath) ?? originalPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      mimeType,
      bytes,
    });
  }
  const files: FrozenQuestionFile[] = [];
  for (const { bytes, ...file } of prepared.values()) {
    const written = await callHostOnlineRpc(deps, {
      hostId: target.hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.write_file",
        rootPath: target.storagePath,
        path: joinHostPathSegments(target.storagePath, file.snapshotPath),
        content: bytes.toString("base64"),
        contentEncoding: "base64",
        createParents: true,
        expectedSha256: null,
      },
    });
    if (written.outcome === "conflict") {
      if (written.currentSha256 !== file.sha256)
        materialError(
          `Question material snapshot conflict for '${file.originalPath}': existing snapshot differs`,
        );
    } else if (
      written.sha256 !== file.sha256 ||
      written.sizeBytes !== file.sizeBytes
    ) {
      materialError(
        `Question material snapshot verification failed for '${file.originalPath}'`,
      );
    }
    const snapshot = await readStableFile(
      deps,
      target,
      file.snapshotPath,
      file.sizeBytes,
    );
    if (
      createHash("sha256").update(snapshot.bytes).digest("hex") !== file.sha256
    )
      materialError(
        `Question material snapshot changed for '${file.originalPath}'`,
      );
    files.push({ ...file, snapshotRevision: snapshot.revision });
  }
  return {
    hostId: target.hostId,
    storageRootPath: target.storagePath,
    files,
    materials: args.materials.map((material) => {
      const file = files.find((file) => file.originalPath === material.path);
      if (!file) throw new Error("Prepared question material is missing");
      return {
        ...file,
        dependencies: [...new Set(material.dependencies)].map(
          (dependency) => `${prefix}${dependency}`,
        ),
      };
    }),
  };
}
