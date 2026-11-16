import { openArtifactPopup } from "@/lib/artifact-activation";
import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { appToast } from "@/components/ui/app-toast";
import type { ThreadTimelineLocalFileLinkHandler } from "@/components/thread/timeline";
import { getThreadEntity } from "@/hooks/cache-owners/thread-entity-store";
import { useThreadStorageLocation } from "@/hooks/queries/thread-panel-queries";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { resolveEmbeddedLocalFileTarget } from "@/lib/embedded-local-file-target";
import { resolveHomeThread } from "@/lib/local-file-viewer-target";
import { openCoreModal } from "@/lib/modal-host";

export function showUnavailable(path: string): void {
  appToast.error("Can't open this file here", {
    description: path,
    action: {
      label: "Copy path",
      onClick: () => {
        void copyToClipboardWithToast(path, {
          successMessage: "Path copied",
        });
      },
    },
  });
}

interface UseEmbeddedLocalFileLinkHandlerArgs {
  enabled: boolean;
  artifactsOnly?: boolean;
  environmentId: string | null;
  threadId: string | null;
  workspaceRootPath: string | null;
}

interface EmbeddedLocalFileLinkHandler {
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
}

export function useEmbeddedLocalFileLinkHandler({
  enabled,
  artifactsOnly = false,
  environmentId,
  threadId,
  workspaceRootPath,
}: UseEmbeddedLocalFileLinkHandlerArgs): EmbeddedLocalFileLinkHandler {
  const queryClient = useQueryClient();
  const storageLocationQuery = useThreadStorageLocation(threadId ?? "", {
    enabled: enabled && threadId !== null,
  });
  const threadStorageRootPath =
    storageLocationQuery.data?.storageRootPath ?? null;

  const onOpenLocalFileLink = useCallback<ThreadTimelineLocalFileLinkHandler>(
    (link) => {
      if (artifactsOnly && link.openTargetId !== null) return false;
      const resolved = resolveEmbeddedLocalFileTarget({
        environmentId,
        link,
        threadId: threadId ?? "",
        threadStorageRootPath,
        workspaceRootPath,
      });
      if (resolved.kind === "app-route") {
        return false;
      }
      if (resolved.kind === "unavailable") {
        if (artifactsOnly) return false;
        showUnavailable(resolved.path);
        return true;
      }
      const target =
        resolved.kind === "workspace"
          ? {
              kind: "workspace" as const,
              environmentId: resolved.environmentId,
              path: resolved.relativePath,
            }
          : {
              kind: "thread-storage" as const,
              threadId: resolved.threadId,
              path: resolved.relativePath,
            };
      const homeThreadId = resolveHomeThread(resolved);
      const title =
        homeThreadId === null
          ? null
          : getThreadEntity(queryClient, homeThreadId)?.thread.title;
      if (
        link.ordinaryActivation === true &&
        link.openTargetId === null &&
        resolved.lineRange === null &&
        openArtifactPopup({ target, location: null }, title ?? undefined)
      )
        return true;
      if (artifactsOnly) return false;
      try {
        openCoreModal("core/local-file-viewer", {
          title: (
            resolved.relativePath.split(/[\\/]/).at(-1) ?? resolved.relativePath
          ).slice(0, 200),
          ...(title ? { context: title.slice(0, 200) } : {}),
          params: {
            ...resolved,
            lineRange:
              resolved.lineRange === null ? null : { ...resolved.lineRange },
          },
        });
      } catch {
        showUnavailable(resolved.path);
      }
      return true;
    },
    [
      artifactsOnly,
      environmentId,
      queryClient,
      threadId,
      threadStorageRootPath,
      workspaceRootPath,
    ],
  );

  return {
    onOpenLocalFileLink: enabled ? onOpenLocalFileLink : undefined,
  };
}
