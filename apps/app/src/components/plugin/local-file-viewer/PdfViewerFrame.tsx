import { useEffect, useState } from "react";
import { Button } from "@bb/shared-ui/button";
import { Icon } from "@bb/shared-ui/icon";

type PdfState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "error"; message: string };

interface PdfViewerFrameProps {
  title: string;
  url: string;
}

export function isPdfPath(path: string): boolean {
  return /\.pdf$/iu.test(path);
}

async function loadPdfBlob(url: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { credentials: "same-origin", signal });
  if (!response.ok) {
    throw new Error(`PDF request failed with status ${response.status}.`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (
    contentType.split(";", 1)[0]!.trim().toLowerCase() !== "application/pdf"
  ) {
    throw new Error("The file is not a PDF document.");
  }
  return new Blob([await response.arrayBuffer()], {
    type: "application/pdf",
  });
}

export function PdfViewerFrame({ title, url }: PdfViewerFrameProps) {
  const [reloadNonce, setReloadNonce] = useState(0);
  const [state, setState] = useState<PdfState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setState({ status: "loading" });
    void loadPdfBlob(url, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ status: "ready", url: objectUrl });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
    return () => {
      controller.abort();
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [reloadNonce, url]);

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md space-y-3 text-center" role="alert">
          <p className="text-sm text-destructive">
            Failed to load PDF: {state.message}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setReloadNonce((current) => current + 1)}
          >
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (state.status === "loading") {
    return (
      <div
        className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
        role="status"
        aria-label={`Loading ${title}`}
      >
        <Icon name="Spinner" className="size-4 animate-spin" aria-hidden />
        Loading PDF…
      </div>
    );
  }
  return (
    <iframe
      src={state.url}
      title={title}
      className="block h-full w-full border-0"
    />
  );
}
