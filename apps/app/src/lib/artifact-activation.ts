import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import { openCoreModal } from "./modal-host";

export function isOrdinaryArtifact(
  intent: ExperimentalFileOpenOptions,
): boolean {
  return (
    intent.location === null &&
    !(
      intent.target.kind === "workspace" &&
      intent.target.experimental_ref !== undefined
    ) &&
    /\.(html?|md|markdown|pdf|png|jpe?g|gif|webp|svg)$/iu.test(
      intent.target.path,
    )
  );
}

export function openArtifactPopup(
  intent: ExperimentalFileOpenOptions,
  context?: string,
): boolean {
  if (!isOrdinaryArtifact(intent)) return false;
  const { target } = intent;
  openCoreModal("core/local-file-viewer", {
    title: (target.path.split(/[\\/]/u).at(-1) ?? target.path).slice(0, 200),
    ...(context ? { context: context.slice(0, 200) } : {}),
    params: {
      ...target,
      relativePath: target.path,
      lineRange: null,
      ...(intent.experimental_artifact
        ? { experimental_artifact: { ...intent.experimental_artifact } }
        : {}),
    },
  });
  return true;
}
