import { useAtom } from "jotai";
import { atomWithStorage } from "jotai/utils";
import { atomFamily } from "jotai-family";
import { createTabScopedStorage } from "@/lib/browser-storage";
import { getProjectScopedStorageKey } from "@/lib/project-scoped-storage";

const RUN_ON_STORAGE_KEY = "bb.fork.run-on.choice";

export interface RunOnPreference {
  providerId: string;
  choiceId: string;
}

export function parseRunOnPreference(
  value: string | null,
): RunOnPreference | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RunOnPreference).providerId === "string" &&
      typeof (parsed as RunOnPreference).choiceId === "string"
    ) {
      const { providerId, choiceId } = parsed as RunOnPreference;
      return { providerId, choiceId };
    }
  } catch {}
  return null;
}

const runOnStorage = createTabScopedStorage<RunOnPreference | null>({
  parse: (value, initialValue) => parseRunOnPreference(value) ?? initialValue,
  serialize: (value) => JSON.stringify(value),
});

const runOnPreferenceAtomFamily = atomFamily((projectId: string) =>
  atomWithStorage<RunOnPreference | null>(
    getProjectScopedStorageKey(RUN_ON_STORAGE_KEY, projectId),
    null,
    runOnStorage,
    { getOnInit: true },
  ),
);

export function useRunOnPreference(
  projectId: string,
): [RunOnPreference | null, (next: RunOnPreference | null) => void] {
  return useAtom(runOnPreferenceAtomFamily(projectId));
}
