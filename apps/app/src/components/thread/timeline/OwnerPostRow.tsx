import type { TimelineOwnerPostRow } from "@bb/thread-view";
import { ownerPostText } from "@bb/thread-view";
import { ThreadMentionCardsContext } from "@/components/thread/ThreadMentionCard.js";
import { ConversationMessageContent } from "./ConversationMessageContent.js";
import type {
  ThreadTimelineLinkHandler,
  ThreadTimelineLocalFileLinkHandler,
} from "./types.js";

interface OwnerPostRowProps {
  onOpenLink: ThreadTimelineLinkHandler | undefined;
  onOpenLocalFileLink: ThreadTimelineLocalFileLinkHandler | undefined;
  projectId: string | undefined;
  row: TimelineOwnerPostRow;
  workspaceRootPath: string | undefined;
}

export function OwnerPostRow({
  onOpenLink,
  onOpenLocalFileLink,
  projectId,
  row,
  workspaceRootPath,
}: OwnerPostRowProps) {
  const pending = row.status === "pending";
  return (
    <div data-owner-post={pending ? "pending" : "completed"}>
      <div className="flex items-center gap-2 px-2 pb-1 text-xs text-muted-foreground">
        <span
          aria-hidden
          className="size-1.5 shrink-0 rotate-45 bg-timeline-accent"
        />
        <span>Post</span>
        <span aria-hidden>·</span>
        <span>{pending ? "Posting" : "Posted"}</span>
      </div>
      <ThreadMentionCardsContext.Provider value={true}>
        <ConversationMessageContent
          attachments={null}
          id={row.id}
          mobileActionDisplay="overflow"
          onOpenLink={onOpenLink}
          onOpenLocalFileLink={onOpenLocalFileLink}
          projectId={projectId}
          role="assistant"
          showActions={false}
          streaming={false}
          text={ownerPostText(row) ?? ""}
          threadId={row.threadId}
          timestamp={row.startedAt}
          turnId={row.turnId}
          workspaceRootPath={workspaceRootPath}
        />
      </ThreadMentionCardsContext.Provider>
    </div>
  );
}
