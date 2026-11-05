import type { FilePreviewLineRange } from "@bb/client-core";
import {
  getHostPathDirname,
  getRelativeHostPath,
  isRawThreadId,
} from "@bb/domain";
import { normalizeAbsoluteFilePath } from "@bb/shared-ui/lib/absolute-file-path";
import type { ThreadTimelineLocalFileLink } from "@/components/thread/timeline";
import { resolveThreadLocalFileLink } from "./thread-local-file-links";

const THREAD_STORAGE_PARENT_PATTERN = /(?:^|[\\/])thread-storage$/;

interface ResolveEmbeddedLocalFileTargetArgs {
  environmentId: string | null;
  link: ThreadTimelineLocalFileLink;
  threadId: string;
  threadStorageRootPath: string | null;
  workspaceRootPath: string | null;
}

interface EmbeddedThreadStorageFileTarget {
  kind: "thread-storage";
  lineRange: FilePreviewLineRange | null;
  path: string;
  relativePath: string;
  threadId: string;
}

interface EmbeddedWorkspaceFileTarget {
  environmentId: string;
  kind: "workspace";
  lineRange: FilePreviewLineRange | null;
  path: string;
  relativePath: string;
}

interface EmbeddedUnavailableFileTarget {
  kind: "unavailable";
  path: string;
}

interface EmbeddedAppRouteTarget {
  kind: "app-route";
}

export type EmbeddedLocalFileTarget =
  | EmbeddedAppRouteTarget
  | EmbeddedThreadStorageFileTarget
  | EmbeddedUnavailableFileTarget
  | EmbeddedWorkspaceFileTarget;

interface ResolveSiblingThreadStorageTargetArgs {
  linkPath: string;
  lineRange: FilePreviewLineRange | null;
  threadStorageRootPath: string | null;
}

function resolveSiblingThreadStorageTarget({
  linkPath,
  lineRange,
  threadStorageRootPath,
}: ResolveSiblingThreadStorageTargetArgs): EmbeddedThreadStorageFileTarget | null {
  if (threadStorageRootPath === null) {
    return null;
  }
  const storageParentPath = getHostPathDirname(threadStorageRootPath);
  if (
    storageParentPath === null ||
    !THREAD_STORAGE_PARENT_PATTERN.test(storageParentPath)
  ) {
    return null;
  }
  const relativeToParent = getRelativeHostPath({
    rootPath: storageParentPath,
    candidatePath: linkPath,
  });
  if (relativeToParent === null) {
    return null;
  }
  const [threadId, ...fileSegments] = relativeToParent.split("/");
  if (
    !threadId ||
    !isRawThreadId(threadId) ||
    fileSegments.length === 0
  ) {
    return null;
  }
  return {
    kind: "thread-storage",
    lineRange,
    path: linkPath,
    relativePath: fileSegments.join("/"),
    threadId,
  };
}

export function resolveEmbeddedLocalFileTarget({
  environmentId,
  link,
  threadId,
  threadStorageRootPath,
  workspaceRootPath,
}: ResolveEmbeddedLocalFileTargetArgs): EmbeddedLocalFileTarget {
  const resolution = resolveThreadLocalFileLink({
    fileOpenTargetIds: [],
    hostFileLinksAvailable: false,
    link: { ...link, openTargetId: null },
    threadStorageRootPath,
    workspaceRootPath: environmentId === null ? null : workspaceRootPath,
  });

  switch (resolution.kind) {
    case "app-route":
      return { kind: "app-route" };
    case "open-workspace-path":
      return environmentId === null
        ? { kind: "unavailable", path: resolution.request.path }
        : {
            environmentId,
            kind: "workspace",
            lineRange: resolution.request.lineRange,
            path: resolution.request.path,
            relativePath: resolution.request.relativePath,
          };
    case "open-thread-storage-path":
      return {
        kind: "thread-storage",
        lineRange: resolution.request.lineRange,
        path: resolution.request.path,
        relativePath: resolution.request.relativePath,
        threadId,
      };
    case "open-in-target":
    case "open-host-path":
    case "error": {
      const linkPath = normalizeAbsoluteFilePath({ path: link.path });
      return (
        (linkPath === null
          ? null
          : resolveSiblingThreadStorageTarget({
              lineRange: link.lineRange,
              linkPath,
              threadStorageRootPath,
            })) ?? { kind: "unavailable", path: link.path }
      );
    }
  }
}
