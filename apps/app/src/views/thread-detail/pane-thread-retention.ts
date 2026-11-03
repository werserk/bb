import type { QueryClient } from "@tanstack/react-query";
import type {
  ThreadResponse,
  ThreadTimelineResponse,
} from "@bb/server-contract";
import {
  threadQueryKey,
  threadTimelineQueryKey,
} from "@/hooks/queries/query-keys";
import type { ThreadRoutePathArgs } from "@/lib/route-paths";

export const PANE_RETAINED_VIEW_LIMIT = 2;
export const PANE_RETAINED_ROW_LIMIT = 2000;

export interface PaneRetentionState {
  activeThreadId: string;
  slots: readonly ThreadRoutePathArgs[];
}

export type CanRetainThread = (
  threadId: string,
  options: { checkRows: boolean },
) => boolean;

export function initialPaneRetention(
  active: ThreadRoutePathArgs,
): PaneRetentionState {
  return { activeThreadId: active.threadId, slots: [active] };
}

export function reconcilePaneRetention(
  state: PaneRetentionState,
  active: ThreadRoutePathArgs,
  canRetain: CanRetainThread,
): PaneRetentionState {
  const switched = state.activeThreadId !== active.threadId;
  const kept = state.slots.filter(
    (slot) =>
      slot.threadId === active.threadId ||
      canRetain(slot.threadId, {
        checkRows: switched && slot.threadId === state.activeThreadId,
      }),
  );
  let slots = kept;
  if (!kept.some((slot) => slot.threadId === active.threadId)) {
    if (kept.length >= PANE_RETAINED_VIEW_LIMIT) {
      const victim = kept.find(
        (slot) => slot.threadId !== state.activeThreadId,
      );
      slots = kept.map((slot) => (slot === victim ? active : slot));
    } else {
      slots = [...kept, active];
    }
  }
  const unchanged =
    !switched &&
    slots.length === state.slots.length &&
    slots.every((slot, index) => slot === state.slots[index]);
  if (unchanged) {
    return state;
  }
  return { activeThreadId: active.threadId, slots };
}

export function canRetainCachedThread(
  queryClient: QueryClient,
  threadId: string,
  options: { checkRows: boolean },
): boolean {
  const thread = queryClient.getQueryData<ThreadResponse>(
    threadQueryKey(threadId),
  );
  if (thread === undefined || thread.archivedAt != null) {
    return false;
  }
  if (!options.checkRows) {
    return true;
  }
  const timeline = queryClient.getQueryData<ThreadTimelineResponse>(
    threadTimelineQueryKey(threadId),
  );
  return (timeline?.rows.length ?? 0) <= PANE_RETAINED_ROW_LIMIT;
}
