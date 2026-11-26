import type { IconName } from "@bb/shared-ui/icon";
import type {
  ComposerContextEntry,
  ComposerContextKind,
  ComposerContextProgress,
  ComposerContextTally,
} from "./composer-context";

export type ComposerContextGroupKind = ComposerContextKind | "error" | "other";

export interface ComposerContextGroup {
  key: string;
  kind: ComposerContextGroupKind;
  label: string;
  icon: IconName;
  tone: "attention" | "error" | undefined;
  count: string | number | undefined;
  progress: ComposerContextProgress | undefined;
  tally: ComposerContextTally | undefined;
  entries: readonly ComposerContextEntry[];
}

const GROUP_RANK: Record<ComposerContextGroupKind, number> = {
  error: 0,
  "needs-you": 1,
  working: 2,
  plan: 3,
  changes: 4,
  queue: 5,
  other: 6,
};

const MERGED_LABEL: Partial<Record<ComposerContextGroupKind, string>> = {
  "needs-you": "Needs you",
  working: "Working",
};

const MERGED_ICON: Partial<Record<ComposerContextGroupKind, IconName>> = {
  "needs-you": "CircleQuestion",
  working: "Loading",
};

function groupKind(entry: ComposerContextEntry): ComposerContextGroupKind {
  if (entry.tone === "error") return "error";
  return entry.kind ?? "other";
}

function mergedCount(
  entries: readonly ComposerContextEntry[],
): string | number | undefined {
  let sum: number | undefined;
  for (const entry of entries) {
    if (typeof entry.summary === "number") sum = (sum ?? 0) + entry.summary;
  }
  if (sum !== undefined) return sum;
  return entries.find((entry) => entry.summary !== undefined)?.summary;
}

function toGroup(
  key: string,
  kind: ComposerContextGroupKind,
  entries: readonly ComposerContextEntry[],
): ComposerContextGroup {
  const ordered = [...entries].sort(
    (a, b) => Number(b.group === "attention") - Number(a.group === "attention"),
  );
  const first = ordered[0]!;
  const tone = ordered.some((entry) => entry.tone === "error")
    ? "error"
    : ordered.some((entry) => entry.tone === "attention")
      ? "attention"
      : undefined;
  return {
    key,
    kind,
    label: MERGED_LABEL[kind] ?? first.label,
    icon: MERGED_ICON[kind] ?? first.icon,
    tone,
    count: mergedCount(ordered),
    progress: ordered.find((entry) => entry.progress)?.progress,
    tally: ordered.find((entry) => entry.tally)?.tally,
    entries: ordered,
  };
}

export function groupComposerContext(
  entries: readonly ComposerContextEntry[],
): ComposerContextGroup[] {
  const buckets = new Map<string, ComposerContextEntry[]>();
  const kinds = new Map<string, ComposerContextGroupKind>();
  for (const entry of entries) {
    const kind = groupKind(entry);
    const key =
      kind === "error" || kind === "other" ? `${kind}:${entry.id}` : kind;
    kinds.set(key, kind);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  return [...buckets.entries()]
    .map(([key, members]) => toGroup(key, kinds.get(key)!, members))
    .map((group, index) => ({ group, index }))
    .sort(
      (a, b) =>
        GROUP_RANK[a.group.kind] - GROUP_RANK[b.group.kind] ||
        (a.group.kind === "other"
          ? Number(b.group.tone === "attention") -
            Number(a.group.tone === "attention")
          : 0) ||
        a.index - b.index,
    )
    .map(({ group }) => group);
}
