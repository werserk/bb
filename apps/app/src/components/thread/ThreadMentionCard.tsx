import { createContext, useCallback, useContext } from "react";
import type { ThreadListEntry } from "@bb/domain";
import { isRunningThreadRuntimeDisplayStatus } from "@bb/client-core";
import { RouteAnchor } from "@/components/ui/app-route-anchor.js";
import { useSidebarNavigationThreadSelection } from "@/hooks/queries/sidebar-navigation-query";
import { useThread } from "@/hooks/queries/thread-queries";
import { getThreadDisplayTitle } from "@/lib/thread-title";
import { cn } from "@bb/shared-ui/lib/utils";
import { useThreadRoutePath } from "@/components/thread/ThreadTitleMentions";

export type ThreadCardStatus =
  | "running"
  | "idle"
  | "waiting"
  | "error"
  | "archived";

export const THREAD_CARD_STATUS_LABELS: Record<ThreadCardStatus, string> = {
  running: "Running",
  idle: "Idle",
  waiting: "Waiting on you",
  error: "Error",
  archived: "Archived",
};

const THREAD_CARD_STATUS_DOT_CLASS_NAMES: Record<ThreadCardStatus, string> = {
  running: "bg-timeline-accent animate-pulse",
  idle: "bg-muted-foreground/60",
  waiting: "bg-attention",
  error: "bg-destructive",
  archived: "border border-muted-foreground/60",
};

interface ThreadCardStatusSource {
  archivedAt: number | null;
  hasPendingInteraction?: boolean;
  runtime: Pick<ThreadListEntry["runtime"], "displayStatus">;
}

export function threadCardStatus(
  thread: ThreadCardStatusSource,
): ThreadCardStatus {
  if (thread.archivedAt !== null) return "archived";
  if (thread.hasPendingInteraction === true) return "waiting";
  if (thread.runtime.displayStatus === "error") return "error";
  if (isRunningThreadRuntimeDisplayStatus(thread.runtime.displayStatus)) {
    return "running";
  }
  return "idle";
}

export const ThreadMentionCardsContext = createContext(false);

export function useThreadMentionCards(): boolean {
  return useContext(ThreadMentionCardsContext);
}

interface ThreadMentionCardProps {
  fallbackLabel: string;
  fallbackProjectId: string | undefined;
  threadId: string;
}

type ThreadCardEntry = ThreadCardStatusSource &
  Pick<ThreadListEntry, "id" | "projectId" | "title" | "titleFallback">;

function useThreadCardEntry(threadId: string): ThreadCardEntry | null {
  const selectEntry = useCallback(
    (threads: ThreadListEntry[]) =>
      threads.find((thread) => thread.id === threadId) ?? null,
    [threadId],
  );
  const sidebarEntry = useSidebarNavigationThreadSelection(selectEntry).data;
  const detail = useThread(threadId, { enabled: sidebarEntry == null });
  return sidebarEntry ?? detail.data ?? null;
}

export function ThreadMentionCard({
  fallbackLabel,
  fallbackProjectId,
  threadId,
}: ThreadMentionCardProps) {
  const threadRoutePath = useThreadRoutePath();
  const entry = useThreadCardEntry(threadId);
  const status = entry === null ? null : threadCardStatus(entry);
  const title = entry === null ? fallbackLabel : getThreadDisplayTitle(entry);
  return (
    <RouteAnchor
      className={cn(
        "my-1 flex w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-raised/50 px-3 py-1.5 text-sm font-normal no-underline hover:bg-state-hover hover:no-underline",
      )}
      data-thread-card-status={status ?? "unknown"}
      href={threadRoutePath(
        threadId,
        entry?.projectId ?? fallbackProjectId,
        null,
      )}
    >
      {status === null ? null : (
        <span
          aria-hidden
          className={cn(
            "size-2 shrink-0 rounded-full",
            THREAD_CARD_STATUS_DOT_CLASS_NAMES[status],
          )}
        />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {status === null ? null : (
        <span className="shrink-0 text-xs text-muted-foreground">
          {THREAD_CARD_STATUS_LABELS[status]}
        </span>
      )}
    </RouteAnchor>
  );
}
