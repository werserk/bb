import { joinHostPath } from "@bb/domain";
import { decodeArtifactHtml } from "./artifact-html";
import { ScopedHtmlFrame } from "./ScopedHtmlFrame";
import { useState } from "react";
import { useCoreModalToken } from "@/lib/core-modal-context";
import {
  withArtifactAdmission,
  getArtifactAdmissionIntent,
  requireArtifactRelativePath,
} from "@/lib/artifact-admission";
import { Button } from "@bb/shared-ui/button";
import { useQuery } from "@tanstack/react-query";
import {
  FilePreview,
  type FilePreviewState,
} from "@/components/secondary-panel/FilePreview";
import { buildMarkdownFileImageRouting } from "@/components/ui/markdown-file-image-routing";
import { sdk } from "@/lib/sdk";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { openArtifactPopup } from "@/lib/artifact-activation";
import {
  toArtifactFileTarget,
  type LocalFileViewerTarget,
} from "@/lib/local-file-viewer-target";
import { PdfViewerFrame, isPdfPath } from "./PdfViewerFrame";

export async function readScopedArtifact(
  target: LocalFileViewerTarget,
  signal: AbortSignal,
  token: string,
) {
  return withArtifactAdmission(
    token,
    target,
    signal,
    async (signal, assertActive) => {
      const root = target.experimental_artifact!.readRoot;
      const expectedSource = getArtifactAdmissionIntent(
        token,
        target,
      )!.physicalSource;
      const lease = await sdk.files.createPreview(
        target.kind === "host"
          ? {
              hostId: target.hostId,
              rootPath: root,
              policy: "artifact-v1",
              expectedSource,
              signal,
            }
          : {
              target:
                target.kind === "workspace"
                  ? {
                      kind: "workspace",
                      environmentId: target.environmentId,
                      root,
                    }
                  : { kind: "thread-storage", threadId: target.threadId, root },
              policy: "artifact-v1",
              expectedSource,
              signal,
            },
      );
      assertActive();
      if (
        lease.policy !== "artifact-v1" ||
        lease.expectedSource?.hostId !== expectedSource.hostId ||
        lease.expectedSource?.canonicalReadRoot !==
          expectedSource.canonicalReadRoot
      )
        throw new Error("Restricted artifact preview unavailable");
      const relative = requireArtifactRelativePath(
        toArtifactFileTarget(target),
        root,
      );
      const url = `${lease.baseUrl}/${relative.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetchWithAppSurface(url, {
        signal,
        redirect: "error",
      });
      assertActive();
      if (!response.ok)
        throw new Error(`Artifact unavailable (${response.status})`);
      let text: string | null = null;
      if (/\.(md|markdown|html?)$/iu.test(target.path)) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        assertActive();
        if (bytes.byteLength > 1_000_000)
          throw new Error("Artifact is too large");
        text = /\.html?$/iu.test(target.path)
          ? decodeArtifactHtml(bytes, response.headers.get("content-type"))
          : new TextDecoder().decode(bytes);
      }
      if (text === null) await response.body?.cancel();
      return { url, text, lease };
    },
  );
}

export function ScopedArtifactBody({
  target,
}: {
  target: LocalFileViewerTarget;
}) {
  const token = useCoreModalToken() ?? "";
  const [attempt, setAttempt] = useState(0);
  const refresh = () => setAttempt((value) => value + 1);
  const query = useQuery({
    queryKey: ["artifact-v1", token, attempt, target],
    queryFn: ({ signal }) => readScopedArtifact(target, signal, token),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const data = query.data;
  const download = data ? (
    <Button asChild size="sm" variant="outline">
      <a href={data.url} download={target.path.split(/[\\/]/u).at(-1)}>
        Download
      </a>
    </Button>
  ) : null;
  const actions = (
    <div className="flex items-center gap-2">
      {download}
      <Button
        size="sm"
        variant="outline"
        onClick={refresh}
        disabled={query.isFetching}
      >
        {query.error ? "Retry" : "Refresh file"}
      </Button>
    </div>
  );
  if (data && isPdfPath(target.path))
    return (
      <>
        {actions}
        <PdfViewerFrame title={target.path} url={data.url} onRetry={refresh} />
      </>
    );
  if (data && /\.html?$/iu.test(target.path))
    return (
      <>
        {actions}
        <ScopedHtmlFrame
          content={data.text!}
          url={data.url}
          baseUrl={data.lease.baseUrl}
          title={target.path}
        />
      </>
    );
  const file = {
    name: target.path,
    contents: data?.text ?? "",
    cacheKey: `artifact-v1:${data?.lease.baseUrl}`,
  };
  const state: FilePreviewState = query.error
    ? { kind: "error", message: query.error.message }
    : !data
      ? { kind: "loading" }
      : data.text === null
        ? { kind: "image", url: data.url }
        : {
            kind: "ready",
            file,
            lineRange: null,
            textPreviewKind: "markdown",
          };
  const root = "/__bb_markdown_file_root__";
  const leaseRelative = data
    ? decodeURIComponent(data.url.slice(data.lease.baseUrl.length + 1))
    : "";
  const routing = buildMarkdownFileImageRouting({
    path: leaseRelative,
    rootPath: null,
    threadId: null,
    resolveRelativeSrc: (relative) =>
      `${data?.lease.baseUrl}/${relative.split("/").map(encodeURIComponent).join("/")}`,
  });
  if (routing?.localImage)
    routing.localImage.absolutePaths = { kind: "contained", rootPath: root };
  return (
    <>
      {actions}
      <FilePreview
        state={state}
        path={target.path}
        headerMode="none"
        onRefresh={refresh}
        markdownLinkRouting={{
          ...routing,
          fallbackUrlTransform: (value, key) =>
            key === "href" && /^https?:\/\//iu.test(value) ? value : "",
          localFile: {
            absoluteLinks: { kind: "contained", rootPath: root },
            relativeLinks: routing?.localImage?.relativePaths,
            onOpenLink: (link) => {
              const relative = link.path.slice(root.length + 1);
              const readRoot = target.experimental_artifact!.readRoot;
              const path =
                target.kind === "host"
                  ? joinHostPath({
                      rootPath: readRoot,
                      relativePath: relative,
                    })!
                  : readRoot
                    ? `${readRoot}/${relative}`
                    : relative;
              const next =
                target.kind === "host"
                  ? { kind: "host" as const, hostId: target.hostId, path }
                  : target.kind === "workspace"
                    ? {
                        kind: "workspace" as const,
                        environmentId: target.environmentId,
                        path,
                      }
                    : {
                        kind: "thread-storage" as const,
                        threadId: target.threadId,
                        path,
                      };
              const admission = getArtifactAdmissionIntent(token, target);
              if (!admission) return true;
              openArtifactPopup({
                target: next,
                location: null,
                experimental_artifact: admission,
              });
              return true;
            },
          },
        }}
      />
    </>
  );
}
