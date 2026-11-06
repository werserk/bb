import type { ExperimentalModalProps } from "@get-bb/plugin-sdk";
import { defineSplit } from "@/lib/define-split";

export const LazyLocalFileViewerModal = defineSplit<ExperimentalModalProps>({
  id: "local-file-viewer-modal",
  tier: "intent",
  load: () =>
    import("./LocalFileViewerModal").then(
      (module) => module.LocalFileViewerModal,
    ),
  loading: () => (
    <div
      className="flex h-full items-center justify-center text-sm text-muted-foreground"
      aria-busy="true"
    >
      Loading…
    </div>
  ),
});
