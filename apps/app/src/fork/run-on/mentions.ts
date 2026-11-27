import type { PromptMentionSource } from "@/hooks/usePromptMentions";

export type RunOnMentionHost = string | null | undefined;

export function runOnMentionOverride(
  host: RunOnMentionHost,
): Partial<PromptMentionSource> {
  if (host === undefined) return {};
  if (host === null) {
    return { projectId: undefined, environmentId: null, hostId: null };
  }
  return { environmentId: null, hostId: host };
}
