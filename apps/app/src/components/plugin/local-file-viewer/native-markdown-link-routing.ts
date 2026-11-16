import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import type { MarkdownLinkRouting } from "@/components/ui/markdown-link-routing.js";
import { openArtifactPopup } from "@/lib/artifact-activation";
import { showUnavailable } from "./useEmbeddedLocalFileLinkHandler";

const ARTIFACT_PATH = /\.(?:html?|md|markdown|pdf|png|jpe?g|gif|webp|svg)$/iu;
const NON_LOCAL_HREF = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\?)/iu;
const WINDOWS_DRIVE_HREF = /^[a-z]:[\\/]/iu;
const LINE_FRAGMENT = /#L\d/u;

interface NativeMarkdownLinkRoutingArgs {
  context?: string;
  toTarget: (
    absolutePath: string,
    rootPath: string,
  ) => ExperimentalFileOpenOptions["target"];
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
  toTarget,
}: NativeMarkdownLinkRoutingArgs): (
  routing: MarkdownLinkRouting,
) => MarkdownLinkRouting {
  return (routing) => {
    const localFile = routing.localFile;
    return {
      ...routing,
      ...(localFile === undefined
        ? {}
        : {
            localFile: {
              ...localFile,
              onOpenLink: (link) =>
                (link.ordinaryActivation === true &&
                  link.openTargetId === null &&
                  link.lineRange === null &&
                  localFile.relativeLinks !== undefined &&
                  openArtifactPopup(
                    {
                      target: toTarget(
                        link.path,
                        localFile.relativeLinks.rootPath,
                      ),
                      location: null,
                    },
                    context,
                  )) ||
                localFile.onOpenLink(link),
            },
          }),
      onOpenLink: (link) => {
        if (routing.onOpenLink?.(link)) return true;
        if (
          link.ordinaryActivation !== true ||
          !isUnresolvedLocalArtifactHref(link.href)
        )
          return false;
        showUnavailable(link.href);
        return true;
      },
    };
  };
}
