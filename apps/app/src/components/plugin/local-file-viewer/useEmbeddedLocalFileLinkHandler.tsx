import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { appToast } from "@/components/ui/app-toast";
import type { ThreadTimelineLocalFileLinkHandler } from "@/components/thread/timeline";
import { useThreadStorageLocation } from "@/hooks/queries/thread-panel-queries";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import { resolveEmbeddedLocalFileTarget } from "@/lib/embedded-local-file-target";
import {
  LocalFileViewerDialog,
  type LocalFileViewerTarget,
} from "./LocalFileViewerDialog";

interface UseEmbeddedLocalFileLinkHandlerArgs {
  enabled: boolean;
  environmentId: string | null;
  threadId: string | null;
  workspaceRootPath: string | null;
}

interface EmbeddedLocalFileLinkHandler {
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
  viewer: ReactNode;
}

export function useEmbeddedLocalFileLinkHandler({
  enabled,
  environmentId,
  threadId,
  workspaceRootPath,
}: UseEmbeddedLocalFileLinkHandlerArgs): EmbeddedLocalFileLinkHandler {
  const [target, setTarget] = useState<LocalFileViewerTarget | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const storageLocationQuery = useThreadStorageLocation(threadId ?? "", {
    enabled: enabled && threadId !== null,
  });
  const threadStorageRootPath =
    storageLocationQuery.data?.storageRootPath ?? null;

  const onOpenLocalFileLink = useCallback<ThreadTimelineLocalFileLinkHandler>(
    (link) => {
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
        appToast.error("Can't open this file here", {
          description: resolved.path,
          action: {
            label: "Copy path",
            onClick: () => {
              void copyToClipboardWithToast(resolved.path, {
                successMessage: "Path copied",
              });
            },
          },
        });
        return true;
      }
      const activeElement = document.activeElement;
      returnFocusRef.current =
        activeElement instanceof HTMLElement ? activeElement : null;
      setTarget(resolved);
      return true;
    },
    [environmentId, threadId, threadStorageRootPath, workspaceRootPath],
  );

  const viewer = useMemo(
    () =>
      enabled ? (
        <LocalFileViewerDialog
          target={target}
          onClose={() => setTarget(null)}
          returnFocusRef={returnFocusRef}
        />
      ) : null,
    [enabled, target],
  );

  return {
    onOpenLocalFileLink: enabled ? onOpenLocalFileLink : undefined,
    viewer,
  };
}
