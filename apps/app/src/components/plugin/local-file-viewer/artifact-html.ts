import { artifactPreviewCsp } from "@bb/domain/artifact-preview";

const escapeAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;");
const FRAGMENT_LINKS = `document.addEventListener("click",function(e){var l=e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");});if(!l)return;var r=l.getAttribute("href");e.preventDefault();if(r.charAt(0)==="#")location.hash=r;},true);`;

export function artifactHtmlDocument(
  content: string,
  absoluteUrl: string,
  absoluteLeaseBase: string,
): string {
  const url = new URL(absoluteUrl);
  const base = new URL(absoluteLeaseBase);
  const csp = artifactPreviewCsp(base.href);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.hash ||
    url.search
  )
    throw new Error("Artifact document outside lease");
  const inner = `<base href="${escapeAttribute(url.href)}"><script>${FRAGMENT_LINKS}</script>${content}`;
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}iframe{display:block}</style><iframe title="Artifact document" sandbox="allow-scripts" srcdoc="${escapeAttribute(inner)}"></iframe>`;
}

export function decodeArtifactHtml(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  if (contentType?.toLowerCase() !== "text/html; charset=utf-8")
    throw new Error("Unexpected artifact HTML charset");
  const encoding =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? "utf-16le"
      : bytes[0] === 0xfe && bytes[1] === 0xff
        ? "utf-16be"
        : "utf-8";
  return new TextDecoder(encoding).decode(bytes);
}
