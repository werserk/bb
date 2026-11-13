import { openArtifactPopup } from "@/lib/artifact-activation";
import { useCallback } from "react";
import {
  getEnvironmentFilePreviewSourceAtRef,
  type HostFileTabState,
  type ThreadStorageFileTabState,
  type WorkspaceFileTabState,
} from "@bb/client-core";
import type { AppFilePreviewIntent } from "@/lib/app-navigation-host";
import {
  normalizeExperimentalFileOpenOptions,
  toFilePreviewLineRange,
} from "@/lib/live-file-navigation";
import type { FileOpenerOverride } from "@/lib/plugin-slot-resolvers";
import type { OpenSecondaryPanelTabRequest } from "./useThreadFileTabs";

export interface PanelFileScope {
  threadId: string | null;
  environmentId: string | null;
  hostId: string | null;
}

interface PanelFileOpenOptions {
  viewer?: FileOpenerOverride;
}

interface UsePanelFilesArgs {
  available: boolean;
  openTab: (
    request: OpenSecondaryPanelTabRequest,
    options?: PanelFileOpenOptions,
  ) => unknown;
  reveal: () => void;
  scope: PanelFileScope | null;
}

export interface PanelFiles {
  openFilePreview: (intent: AppFilePreviewIntent) => boolean;
  openHostFile: (
    file: HostFileTabState,
    options?: PanelFileOpenOptions,
  ) => void;
  openStorageFile: (
    file: ThreadStorageFileTabState,
    options?: PanelFileOpenOptions,
  ) => void;
  openWorkspaceFile: (
    file: WorkspaceFileTabState,
    options?: PanelFileOpenOptions,
  ) => void;
}

function livePreviewRequest(
  intent: AppFilePreviewIntent,
  scope: PanelFileScope | null,
): OpenSecondaryPanelTabRequest | null {
  const normalized = normalizeExperimentalFileOpenOptions(intent);
  if (normalized === null) return null;
  const { target } = normalized;
  const lineRange = toFilePreviewLineRange(normalized.location);
  switch (target.kind) {
    case "workspace":
      if (scope !== null && target.environmentId !== scope.environmentId) {
        return null;
      }
      return {
        kind: "workspace-file-preview",
        environmentId: target.environmentId,
        tab: {
          lineRange,
          path: target.path,
          source: getEnvironmentFilePreviewSourceAtRef(target.experimental_ref),
          statusLabel: null,
        },
      };
    case "host":
      if (scope === null || scope.threadId === null) {
        if (scope?.hostId != null && target.hostId !== scope.hostId) {
          return null;
        }
        return {
          kind: "host-file-preview",
          hostId: target.hostId,
          tab: { lineRange, path: target.path },
        };
      }
      if (scope.environmentId === null || target.hostId !== scope.hostId) {
        return null;
      }
      return {
        kind: "host-file-preview",
        tab: { lineRange, path: target.path },
      };
    case "thread-storage":
      if (scope !== null && target.threadId !== scope.threadId) return null;
      return {
        kind: "thread-storage-file-preview",
        threadId: target.threadId,
        tab: { lineRange, path: target.path },
      };
  }
}

export function usePanelFiles({
  available,
  openTab,
  reveal,
  scope,
}: UsePanelFilesArgs): PanelFiles {
  const openWorkspaceFile = useCallback(
    (file: WorkspaceFileTabState, options?: PanelFileOpenOptions) => {
      if (
        !options?.viewer &&
        scope?.environmentId &&
        openArtifactPopup({
          target: {
            kind: "workspace",
            environmentId: scope.environmentId,
            path: file.path,
            ...(file.source.kind === "working-tree"
              ? {}
              : { experimental_ref: "HEAD" }),
          },
          location: file.lineRange
            ? {
                kind: "range",
                startLine: file.lineRange.startLineNumber,
                endLine: file.lineRange.endLineNumber,
              }
            : null,
        })
      )
        return;
      openTab({ kind: "workspace-file-preview", tab: file }, options);
    },
    [openTab, scope],
  );
  const openStorageFile = useCallback(
    (file: ThreadStorageFileTabState, options?: PanelFileOpenOptions) => {
      if (
        !options?.viewer &&
        scope?.threadId &&
        openArtifactPopup({
          target: {
            kind: "thread-storage",
            threadId: scope.threadId,
            path: file.path,
          },
          location: file.lineRange
            ? {
                kind: "range",
                startLine: file.lineRange.startLineNumber,
                endLine: file.lineRange.endLineNumber,
              }
            : null,
        })
      )
        return;
      openTab({ kind: "thread-storage-file-preview", tab: file }, options);
    },
    [openTab, scope],
  );
  const openHostFile = useCallback(
    (file: HostFileTabState, options?: PanelFileOpenOptions) => {
      if (
        !options?.viewer &&
        scope?.hostId &&
        openArtifactPopup({
          target: { kind: "host", hostId: scope.hostId, path: file.path },
          location: file.lineRange
            ? {
                kind: "range",
                startLine: file.lineRange.startLineNumber,
                endLine: file.lineRange.endLineNumber,
              }
            : null,
        })
      )
        return;
      openTab({ kind: "host-file-preview", tab: file }, options);
    },
    [openTab, scope],
  );
  const openFilePreview = useCallback(
    (intent: AppFilePreviewIntent) => {
      if (intent.experimental_artifact) {
        const normalized = normalizeExperimentalFileOpenOptions(intent);
        return normalized !== null && openArtifactPopup(normalized);
      }
      if (!available) return false;
      const request = livePreviewRequest(intent, scope);
      if (request === null) return false;
      const tab = openTab(
        request,
        intent.viewer === undefined ? undefined : { viewer: intent.viewer },
      );
      if (tab === null) return false;
      reveal();
      return true;
    },
    [available, openTab, reveal, scope],
  );
  return { openFilePreview, openHostFile, openStorageFile, openWorkspaceFile };
}
