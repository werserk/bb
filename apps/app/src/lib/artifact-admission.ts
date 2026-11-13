import type { ExperimentalFileOpenOptions } from "@get-bb/plugin-sdk";
import type { CoreModalLifetime } from "./modal-host";
import {
  toArtifactFileTarget,
  type LocalFileViewerTarget,
} from "./local-file-viewer-target";

export const ARTIFACT_ADMISSION_TIMEOUT_MS = 10_000;
type Intent = NonNullable<ExperimentalFileOpenOptions["experimental_artifact"]>;
type Record = {
  intent: Intent;
  candidate: string;
  controller: AbortController;
  attempt: AbortController | null;
};
const records = new Map<string, Record>();

function candidateKey(
  target: ExperimentalFileOpenOptions["target"],
  root: string,
) {
  return JSON.stringify([target, root]);
}

export function createArtifactAdmission(
  options: ExperimentalFileOpenOptions,
): CoreModalLifetime {
  const intent = options.experimental_artifact!;
  const controller = new AbortController();
  const record: Record = {
    intent,
    candidate: candidateKey(options.target, intent.readRoot),
    controller,
    attempt: null,
  };
  let token: string | null = null;
  const dispose = () => {
    intent.lifetime.removeEventListener("abort", dispose);
    if (token !== null) records.delete(token);
    controller.abort();
  };
  intent.lifetime.addEventListener("abort", dispose, { once: true });
  if (intent.lifetime.aborted) dispose();
  return {
    signal: controller.signal,
    bind(next) {
      token = next;
      records.set(next, record);
    },
    dispose,
  };
}

export function hasLiveArtifactAdmission(token: string): boolean {
  const record = records.get(token);
  return record !== undefined && !record.controller.signal.aborted;
}

export function getArtifactAdmissionIntent(
  token: string,
  target: LocalFileViewerTarget,
): Intent | null {
  const record = records.get(token);
  return record &&
    !record.controller.signal.aborted &&
    target.experimental_artifact &&
    record.candidate ===
      candidateKey(
        toArtifactFileTarget(target),
        target.experimental_artifact.readRoot,
      )
    ? record.intent
    : null;
}

export async function withArtifactAdmission<T>(
  token: string,
  target: LocalFileViewerTarget,
  signal: AbortSignal,
  read: (signal: AbortSignal, assertActive: () => void) => Promise<T>,
): Promise<T> {
  const intent = getArtifactAdmissionIntent(token, target);
  const record = records.get(token);
  if (!intent || !record)
    throw new Error("Artifact admission is no longer available");
  record.attempt?.abort();
  const controller = new AbortController();
  record.attempt = controller;
  const abort = () =>
    controller.abort(new Error("Artifact admission cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  record.controller.signal.addEventListener("abort", abort, { once: true });
  const assertActive = () => {
    if (
      signal.aborted ||
      record.controller.signal.aborted ||
      record.attempt !== controller ||
      records.get(token) !== record
    )
      abort();
    controller.signal.throwIfAborted();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelAdmission: (() => void) | undefined;
  try {
    assertActive();
    await new Promise<void>((resolve, reject) => {
      cancelAdmission = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", cancelAdmission, {
        once: true,
      });
      timer = setTimeout(
        () => controller.abort(new Error("Artifact admission timed out")),
        ARTIFACT_ADMISSION_TIMEOUT_MS,
      );
      Promise.resolve()
        .then(() => {
          assertActive();
          return intent.revalidate({
            target: toArtifactFileTarget(target),
            readRoot: intent.readRoot,
            signal: controller.signal,
          });
        })
        .then((result) => {
          assertActive();
          if (result !== true) throw new Error("Artifact admission refused");
          resolve();
        })
        .catch(reject);
    });
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", cancelAdmission!);
    assertActive();
    const result = await read(controller.signal, assertActive);
    assertActive();
    return result;
  } finally {
    clearTimeout(timer);
    if (cancelAdmission)
      controller.signal.removeEventListener("abort", cancelAdmission);
    signal.removeEventListener("abort", abort);
    record.controller.signal.removeEventListener("abort", abort);
    if (record.attempt === controller) record.attempt = null;
    controller.abort();
  }
}
