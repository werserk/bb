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
import type { LocalFileViewerTarget } from "@/lib/local-file-viewer-target";
import { PdfViewerFrame, isPdfPath } from "./PdfViewerFrame";

export async function readScopedArtifact(
  target: LocalFileViewerTarget,
  signal: AbortSignal,
) {
  const root = target.experimental_artifact!.readRoot;
  const lease = await sdk.files.createPreview(
    target.kind === "host"
      ? { hostId: target.hostId, rootPath: root, policy: "artifact-v1", signal }
      : {
          target:
            target.kind === "workspace"
              ? { kind: "workspace", environmentId: target.environmentId, root }
              : { kind: "thread-storage", threadId: target.threadId, root },
          policy: "artifact-v1",
          signal,
        },
  );
  if (lease.policy !== "artifact-v1")
    throw new Error("Restricted artifact preview unavailable");
  const relative =
    root === ""
      ? target.relativePath
      : target.relativePath
          .replace(/\\/gu, "/")
          .slice(root.replace(/\\/gu, "/").replace(/\/+$/u, "").length + 1);
  if (
    !relative ||
    relative.split("/").some((segment) => segment === ".." || segment === ".")
  )
    throw new Error("Artifact outside its read root");
  const url = `${lease.baseUrl}/${relative.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetchWithAppSurface(url, { signal });
  if (!response.ok)
    throw new Error(`Artifact unavailable (${response.status})`);
  const text = /\.(md|markdown|html?)$/iu.test(target.path)
    ? await response.text()
    : null;
  if (text === null) await response.body?.cancel();
  return { url, text, lease };
}

export function ScopedArtifactBody({
  target,
}: {
  target: LocalFileViewerTarget;
}) {
  const query = useQuery({
    queryKey: ["artifact-v1", target],
    queryFn: ({ signal }) => readScopedArtifact(target, signal),
    retry: false,
    staleTime: 0,
  });
  const data = query.data;
  const download = data ? (
    <Button asChild size="sm" variant="outline">
      <a href={data.url} download={target.path.split(/[\\/]/u).at(-1)}>
        Download
      </a>
    </Button>
  ) : null;
  if (data && isPdfPath(target.path))
    return (
      <>
        {download}
        <PdfViewerFrame title={target.path} url={data.url} />
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
        : /\.html?$/iu.test(target.path)
          ? {
              kind: "html",
              file,
              iframe: {
                sandbox: "allow-scripts",
                title: target.path,
                url: data.url,
              },
              lineRange: null,
            }
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
      {download}
      <FilePreview
        state={state}
        path={target.path}
        headerMode="none"
        onRefresh={() => void query.refetch()}
        markdownLinkRouting={{
          ...routing,
          fallbackUrlTransform: (value, key) => key === "href" && /^https?:\/\//iu.test(value) ? value : "",
          localFile: {
            absoluteLinks: { kind: "contained", rootPath: root },
            relativeLinks: routing?.localImage?.relativePaths,
            onOpenLink: (link) => {
              const relative = link.path.slice(root.length + 1);
              const readRoot = target.experimental_artifact!.readRoot;
              const path = readRoot
                ? `${readRoot.replace(/[\\/]+$/u, "")}/${relative}`
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
              return openArtifactPopup({
                target: next,
                location: null,
                experimental_artifact: target.experimental_artifact,
              });
            },
          },
        }}
      />
    </>
  );
}
