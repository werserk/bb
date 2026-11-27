import type { RunOnMentionHost } from "./mentions";
import {
  formatWorkspaceCheckoutDisplay,
  type WorkspaceCheckoutDisplay,
} from "@bb/shared-ui/lib/workspace-checkout-display";
import { useMemo, type ReactNode } from "react";
import { useEnvironment } from "@/hooks/queries/environment-queries";
import { useHosts } from "@/hooks/queries/host-queries";
import { isProjectlessProjectId } from "@/lib/route-paths";
import { ComposerRunRowItems } from "./ComposerRunRowItems";
import { chipView, findHost, type RunOnHost } from "./model";
import { useRunOnThreadWorkspace } from "./probes";
import { useAcceptedRunOnProviders } from "./registrations";
import { RunOnThreadPopover, type RunOnThreadView } from "./RunOnThreadPopover";

export interface RunOnOpenThread {
  probe: ReactNode;

  chip: ReactNode;

  rowItems: ReactNode;

  checkout: WorkspaceCheckoutDisplay | undefined;

  mentionHostId: RunOnMentionHost;
}

const NO_HOSTS: readonly RunOnHost[] = [];

export function useRunOnOpenThread({
  threadId,
  projectId,
  environmentId,
}: {
  threadId: string;
  projectId: string;
  environmentId: string | null;
}): RunOnOpenThread {
  const projectless = isProjectlessProjectId(projectId);
  const accepted = useAcceptedRunOnProviders();
  const environment = useEnvironment(environmentId, {
    enabled: !projectless && accepted !== null && accepted.length > 0,
  }).data;
  const entry =
    environment?.environmentProviderId == null
      ? undefined
      : accepted?.find(
          ({ slot }) =>
            slot.environmentProviderId === environment.environmentProviderId,
        );
  const slot = entry?.slot ?? null;
  const { probe, state } = useRunOnThreadWorkspace(
    slot,
    threadId,
    environment?.environmentProviderSelection?.inputs ?? null,
  );
  const hosts = useHosts().data ?? NO_HOSTS;

  const agentHostId = environment?.hostId ?? null;
  const workspace = state.status === "ready" ? state.workspace : null;
  const view = useMemo((): RunOnThreadView | null => {
    if (slot === null || agentHostId === null || state.status === "crashed") {
      return null;
    }
    const base = chipView(hosts, agentHostId, workspace);
    const agentHost = findHost(hosts, agentHostId);
    return {
      threadId,
      pluginId: slot.pluginId,
      environmentProviderId: slot.environmentProviderId,
      chip:
        state.status === "loading"
          ? { ...base, workspaceName: "…" }
          : workspace === null
            ? { ...base, workspaceName: "unknown", warning: true }
            : base,
      agentHostId,
      agentLastSeenAt:
        agentHost?.status === "connected"
          ? null
          : (agentHost?.lastSeenAt ?? null),
      workspaceHostId: workspace?.hostId ?? null,
      detail: workspace?.detail ?? null,
      issue: workspace?.issue ?? null,
      ThreadActions: slot.ThreadActions ?? null,
    };
  }, [agentHostId, hosts, slot, state.status, threadId, workspace]);

  const branch = view === null ? null : (workspace?.branch ?? null);
  const checkout = useMemo(
    () =>
      branch
        ? formatWorkspaceCheckoutDisplay({
            checkout: { kind: "branch", branchName: branch, headSha: null },
          })
        : undefined,
    [branch],
  );
  const chip = useMemo(
    () => (view === null ? null : <RunOnThreadPopover view={view} />),
    [view],
  );
  const rowItems = useMemo(
    () =>
      projectless ? null : (
        <ComposerRunRowItems scope={{ kind: "thread", threadId, projectId }} />
      ),
    [projectId, projectless, threadId],
  );
  return {
    probe,
    chip,
    rowItems,
    checkout,
    mentionHostId:
      view === null || workspace === null ? undefined : workspace.hostId,
  };
}
