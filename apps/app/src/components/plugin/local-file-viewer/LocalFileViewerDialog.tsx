import type { RefObject } from "react";
import { Button } from "@bb/shared-ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@bb/shared-ui/dialog";
import { Icon } from "@bb/shared-ui/icon";
import {
  ThreadStorageFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import {
  buildEnvironmentFileContentUrl,
  buildThreadStorageRawContentUrl,
} from "@/lib/file-content-urls";
import { isPdfPath, PdfViewerFrame } from "./PdfViewerFrame";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import type { EmbeddedLocalFileTarget } from "@/lib/embedded-local-file-target";

export type LocalFileViewerTarget = Extract<
  EmbeddedLocalFileTarget,
  { kind: "thread-storage" | "workspace" }
>;

interface LocalFileViewerDialogProps {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  target: LocalFileViewerTarget | null;
}

const WORKING_TREE_SOURCE = { kind: "working-tree" } as const;

function getFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function getDownloadUrl(target: LocalFileViewerTarget): string {
  return target.kind === "thread-storage"
    ? buildThreadStorageRawContentUrl(target.threadId, target.relativePath)
    : buildEnvironmentFileContentUrl(
        target.environmentId,
        WORKING_TREE_SOURCE,
        target.relativePath,
      );
}

function LocalFileViewerBody({ target }: { target: LocalFileViewerTarget }) {
  if (isPdfPath(target.relativePath)) {
    return (
      <PdfViewerFrame
        title={getFileName(target.relativePath)}
        url={getDownloadUrl(target)}
      />
    );
  }
  if (target.kind === "thread-storage") {
    return (
      <ThreadStorageFilePreviewTabContent
        activePath={target.relativePath}
        copyPath={target.path}
        headerMode="none"
        isPanelOpen
        lineRange={target.lineRange}
        threadId={target.threadId}
      />
    );
  }
  return (
    <WorkspaceFilePreviewTabContent
      activePath={target.relativePath}
      copyPath={target.path}
      environmentId={target.environmentId}
      headerMode="none"
      isPanelOpen
      lineRange={target.lineRange}
      source={WORKING_TREE_SOURCE}
    />
  );
}

export function LocalFileViewerDialog({
  onClose,
  returnFocusRef,
  target,
}: LocalFileViewerDialogProps) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        hideCloseButton
        onAfterCloseAutoFocus={() => returnFocusRef.current?.focus()}
        className="h-[88dvh] max-w-[min(72rem,92vw)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0"
        compactContentClassName="h-[88dvh]"
      >
        {target === null ? null : (
          <>
            <div className="flex min-w-0 items-center gap-2 border-b px-3 py-2">
              <div className="min-w-0 flex-1">
                <DialogTitle className="truncate text-sm font-medium">
                  {getFileName(target.relativePath)}
                </DialogTitle>
                <DialogDescription className="truncate font-mono text-xs text-muted-foreground">
                  {target.path}
                </DialogDescription>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  void copyToClipboardWithToast(target.path, {
                    successMessage: "Path copied",
                  });
                }}
              >
                Copy path
              </Button>
              <Button asChild variant="outline" size="sm">
                <a
                  href={getDownloadUrl(target)}
                  download={getFileName(target.relativePath)}
                >
                  Download
                </a>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close file viewer"
                onClick={onClose}
              >
                <Icon name="X" aria-hidden />
              </Button>
            </div>
            <div className="min-h-0 overflow-auto">
              <LocalFileViewerBody target={target} />
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
