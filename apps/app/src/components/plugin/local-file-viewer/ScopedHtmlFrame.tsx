import { useMemo } from "react";
import { artifactHtmlDocument } from "./artifact-html";

export function ScopedHtmlFrame({
  content,
  url,
  baseUrl,
  title,
}: {
  content: string;
  url: string;
  baseUrl: string;
  title: string;
}) {
  const srcDoc = useMemo(
    () =>
      artifactHtmlDocument(
        content,
        new URL(url, window.location.origin).href,
        new URL(baseUrl.replace(/\/+$/u, "") + "/", window.location.origin)
          .href,
      ),
    [content, url, baseUrl],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="text-muted-foreground text-sm">
        Links to other documents are blocked in this preview.
      </p>
      <iframe
        title={title}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        className="min-h-0 w-full flex-1 border-0"
      />
    </div>
  );
}
