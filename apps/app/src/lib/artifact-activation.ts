import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import { normalizeExperimentalFileOpenOptions } from "./live-file-navigation";
import { createArtifactAdmission } from "./artifact-admission";
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
  if (intent.experimental_artifact) {
    const validated = normalizeExperimentalFileOpenOptions(intent);
    if (!validated) return false;
    intent = validated;
  }
  const { target } = intent;
  const options = {
    title: (target.path.split(/[\\/]/u).at(-1) ?? target.path).slice(0, 200),
    ...(context ? { context: context.slice(0, 200) } : {}),
    params: {
      ...target,
      relativePath: target.path,
      lineRange: null,
      ...(intent.experimental_artifact
        ? {
            experimental_artifact: {
              version: 1,
              readRoot: intent.experimental_artifact.readRoot,
            },
          }
        : {}),
    },
  };
  if (intent.experimental_artifact) {
    openCoreModal(
      "core/local-file-viewer",
      options,
      createArtifactAdmission(intent),
    );
  } else {
    openCoreModal("core/local-file-viewer", options);
  }
  return true;
}
