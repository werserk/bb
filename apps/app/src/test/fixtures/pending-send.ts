import type { QueryClient } from "@tanstack/react-query";
import { makeThreadWithRuntime } from "@bb/test-helpers/domain-fixtures";
import { threadQueryKey } from "@/hooks/queries/query-keys";
import { getPromptDraftAccessor } from "@/hooks/usePromptDraftStorage";

/**
 * Caches the thread a pending send belongs to, so a scope reset can hand
 * unacknowledged text back to its draft; returns that (cleared) draft.
 */
export function seedPendingSendThread(
  client: QueryClient,
  threadId = "thread-1",
  projectId = "project-1",
) {
  client.setQueryData(threadQueryKey(threadId), {
    ...makeThreadWithRuntime({ id: threadId, projectId }),
    queuedMessageCount: 0,
  } as never);
  const draft = getPromptDraftAccessor({ kind: "thread", projectId, threadId });
  draft.clear();
  return draft;
}
