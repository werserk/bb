import { useState } from "react";
import type { ThreadTimelineModelFallback } from "@bb/domain";
import { ComposerContextRow } from "../context/ComposerContextRow";
import { PromptStackCard } from "@/components/promptbox/banner/PromptStackCard";
import { rawStringLocalStorage } from "@/lib/browser-storage";

interface ThreadModelFallbackCardProps {
  fallback: ThreadTimelineModelFallback;
  threadId: string;
}

function dismissalStorageKey(threadId: string): string {
  return `bb.thread.model-fallback-dismissed.${threadId}`;
}

function modelLabel(model: string): string {
  const parts = model
    .replace(/^(?:anthropic[-/])?claude-/i, "")
    .split("-")
    .filter(Boolean);
  const versionStart = parts.findIndex((part) => /^\d+$/.test(part));
  const nameParts = versionStart === -1 ? parts : parts.slice(0, versionStart);
  const versionParts = versionStart === -1 ? [] : parts.slice(versionStart);
  const name = nameParts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  const [major, minor, ...qualifiers] = versionParts;
  const version = major
    ? [minor ? `${major}.${minor}` : major, ...qualifiers].join(" ")
    : "";
  return [name, version].filter(Boolean).join(" ") || model;
}

export function ThreadModelFallbackCard({
  fallback,
  threadId,
}: ThreadModelFallbackCardProps) {
  const occurrence = String(fallback.sourceSeq);
  const storageKey = dismissalStorageKey(threadId);
  const [dismissedOccurrence, setDismissedOccurrence] = useState(() =>
    rawStringLocalStorage.getItem(storageKey, ""),
  );

  if (dismissedOccurrence === occurrence) {
    return null;
  }

  return (
    <PromptStackCard
      ariaLabel="Model fallback"
      context={{
        label: "Model fallback",
        icon: "AlertCircle",
        group: "attention",
        tone: "attention",
      }}
      className="overflow-hidden"
    >
      <div role="status" aria-live="polite">
        <ComposerContextRow
          icon="AlertTriangle"
          tone="attention"
          title="Model fallback"
          subline={
            <>
              Switched from {modelLabel(fallback.originalModel)} to{" "}
              {modelLabel(fallback.fallbackModel)}
            </>
          }
          action={
            <button
              type="button"
              aria-label="Dismiss model fallback"
              onClick={() => {
                rawStringLocalStorage.setItem(storageKey, occurrence);
                setDismissedOccurrence(occurrence);
              }}
            >
              Dismiss
            </button>
          }
        />
      </div>
    </PromptStackCard>
  );
}
