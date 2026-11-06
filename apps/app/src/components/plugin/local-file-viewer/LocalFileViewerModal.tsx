import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ExperimentalModalProps } from "@get-bb/plugin-sdk";
import { Button } from "@bb/shared-ui/button";
import {
  ThreadStorageFilePreviewTabContent,
  WorkspaceFilePreviewTabContent,
} from "@/components/secondary-panel/ThreadSecondaryPanelTabContent";
import { PluginThreadChat } from "@/components/plugin/PluginThreadChat";
import type { FilePreview } from "@bb/client-core";
import { useThread } from "@/hooks/queries/thread-queries";
import { useThreadStorageFilePreview } from "@/hooks/queries/thread-panel-queries";
import {
  buildEnvironmentFileContentUrl,
  buildThreadStorageRawContentUrl,
} from "@/lib/file-content-urls";
import { copyToClipboardWithToast } from "@/lib/clipboard";
import {
  parseLocalFileViewerTarget,
  resolveHomeThread,
  type LocalFileViewerTarget,
} from "@/lib/local-file-viewer-target";
import { getThreadRoutePath } from "@/lib/route-paths";
import { isPdfPath, PdfViewerFrame } from "./PdfViewerFrame";

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
    return target.kind === "thread-storage" ? (
      <ThreadStoragePdf target={target} />
    ) : (
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

function getPreviewReloadKey(
  preview: FilePreview | undefined,
): number | undefined {
  if (preview === undefined) return undefined;
  if (preview.kind === "unsupported") return preview.sizeBytes;
  return preview.kind === "text" ? preview.content.length : undefined;
}

function ThreadStoragePdf({
  target,
}: {
  target: Extract<LocalFileViewerTarget, { kind: "thread-storage" }>;
}) {
  const preview = useThreadStorageFilePreview(
    target.threadId,
    target.relativePath,
  );
  if (preview.data === undefined && !preview.isError) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading PDF…
      </div>
    );
  }
  return (
    <PdfViewerFrame
      title={getFileName(target.relativePath)}
      url={getDownloadUrl(target)}
      reloadKey={getPreviewReloadKey(preview.data)}
    />
  );
}

function ArtifactThreadChat({ threadId }: { threadId: string }) {
  const threadQuery = useThread(threadId);
  const thread = threadQuery.data;
  const navigate = useNavigate();
  if (threadQuery.isError || thread?.archivedAt) {
    return (
      <div className="p-3 text-sm text-muted-foreground">
        Thread unavailable
      </div>
    );
  }
  return (
    <>
      <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {thread?.title ?? "Loading…"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!thread}
          onClick={() => {
            if (!thread) return;
            void navigate(
              getThreadRoutePath({ projectId: thread.projectId, threadId }),
              { replace: true },
            );
          }}
        >
          Open thread
        </Button>
      </div>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <PluginThreadChat
          threadId={threadId}
          variant="compact"
          layout="contained"
        />
      </div>
    </>
  );
}

export function LocalFileViewerModal({
  params,
  compact,
}: ExperimentalModalProps) {
  const target = parseLocalFileViewerTarget(params);
  const [tab, setTab] = useState<"artifact" | "chat">("artifact");
  if (target === null) throw new Error("Invalid local file viewer params");
  const homeThread = resolveHomeThread(target);
  const fileName = getFileName(target.relativePath);
  const typeLabel = isPdfPath(fileName)
    ? "PDF"
    : /\.html?$/iu.test(fileName)
      ? "HTML · sandboxed"
      : /\.md$/iu.test(fileName)
        ? "Markdown"
        : (fileName.split(".").at(-1)?.toUpperCase() ?? "File");
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {compact && homeThread !== null ? (
        <div
          role="tablist"
          aria-label="File and thread"
          className="flex shrink-0 border-b"
        >
          {(["artifact", "chat"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`local-file-${value}-tab`}
              aria-controls={`local-file-${value}`}
              aria-selected={tab === value}
              onClick={() => setTab(value)}
              className="flex-1 px-3 py-2 text-sm aria-selected:bg-muted"
            >
              {value === "artifact" ? "Artifact" : "Chat"}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <section
          id="local-file-artifact"
          role={compact && homeThread ? "tabpanel" : undefined}
          aria-labelledby={
            compact && homeThread ? "local-file-artifact-tab" : undefined
          }
          className="min-h-0 min-w-0 flex-[1.5] flex-col overflow-hidden"
          style={{
            display:
              compact && homeThread !== null && tab !== "artifact"
                ? "none"
                : "flex",
          }}
        >
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {fileName}
            </span>
            <span className="text-xs text-muted-foreground">{typeLabel}</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                void copyToClipboardWithToast(target.path, {
                  successMessage: "Path copied",
                })
              }
            >
              Copy path
            </Button>
            <Button asChild size="sm" variant="outline">
              <a href={getDownloadUrl(target)} download={fileName}>
                Download
              </a>
            </Button>
          </div>
          <div className="min-h-0 min-w-0 flex-1 overflow-auto">
            <LocalFileViewerBody target={target} />
          </div>
        </section>
        {homeThread !== null ? (
          <section
            id="local-file-chat"
            role={compact ? "tabpanel" : undefined}
            aria-labelledby={compact ? "local-file-chat-tab" : undefined}
            className="min-h-0 min-w-[340px] flex-1 flex-col overflow-hidden border-l"
            style={{ display: compact && tab !== "chat" ? "none" : "flex" }}
          >
            <ArtifactThreadChat threadId={homeThread} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
