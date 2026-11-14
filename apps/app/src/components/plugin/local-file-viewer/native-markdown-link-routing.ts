import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import { getAbsoluteDirname } from "@bb/shared-ui/lib/absolute-file-path";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { openArtifactPopup } from "@/lib/artifact-activation";
import { showUnavailable } from "./useEmbeddedLocalFileLinkHandler";

export const NATIVE_DOCUMENT_ROOT = "/__bb_markdown_file_root__";

const ARTIFACT_PATH = /\.(?:html?|md|markdown|pdf|png|jpe?g|gif|webp|svg)$/iu;
const NON_LOCAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/iu;
const WINDOWS_DRIVE_HREF = /^[a-z]:[\\/]/iu;
const LINE_FRAGMENT = /#L\d/u;

interface NativeMarkdownLinkRoutingArgs {
  context?: string;
  documentPath: string;
  rootPath: string;
  toTarget: (absolutePath: string) => ExperimentalFileOpenOptions["target"];
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isUnresolvedLocalArtifactHref(href: string): boolean {
  if (NON_LOCAL_HREF.test(href) && !WINDOWS_DRIVE_HREF.test(href)) return false;
  if (LINE_FRAGMENT.test(href)) return false;
  return ARTIFACT_PATH.test(safeDecode(href.split(/[?#]/u)[0] ?? ""));
}

export function buildNativeMarkdownLinkRouting({
  context,
  documentPath,
  rootPath,
  toTarget,
}: NativeMarkdownLinkRoutingArgs): MarkdownLinkRouting {
  return {
    localFile: {
      absoluteLinks: { kind: "contained", rootPath },
      relativeLinks: {
        baseDir: getAbsoluteDirname({ path: documentPath }),
        rootPath,
      },
      preserveAnchorHref: true,
      onOpenLink: (link) =>
        link.ordinaryActivation === true &&
        link.openTargetId === null &&
        link.lineRange === null &&
        openArtifactPopup(
          { target: toTarget(link.path), location: null },
          context,
        ),
    },
    onOpenLink: ({ href, ordinaryActivation }) => {
      if (ordinaryActivation !== true || !isUnresolvedLocalArtifactHref(href))
        return false;
      showUnavailable(href);
      return true;
    },
  };
}
