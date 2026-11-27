import type { Host } from "@bb/domain";
import type {
  ExperimentalRunOnChoice,
  ExperimentalRunOnChoices,
  ExperimentalRunOnWorkspace,
  JsonValue,
} from "@get-bb/plugin-sdk";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { AcceptedRunOnProvider } from "./registrations";

export type RunOnHost = Pick<Host, "id" | "name" | "status" | "lastSeenAt">;

export function canonicalJson(value: JsonValue | null | undefined): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, JsonValue>)[key])}`,
    )
    .join(",")}}`;
}

export function sameInputs(
  left: JsonValue | null | undefined,
  right: JsonValue | null | undefined,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

export function runOnRowValue(providerId: string, choiceId: string): string {
  return `runon:${providerId}:${choiceId}`;
}

export function findHost(
  hosts: readonly RunOnHost[],
  hostId: string | null,
): RunOnHost | undefined {
  return hostId === null ? undefined : hosts.find((host) => host.id === hostId);
}

export function agentName(hosts: readonly RunOnHost[], hostId: string): string {
  return findHost(hosts, hostId)?.name ?? hostId;
}

export function workspaceName(
  hosts: readonly RunOnHost[],
  workspace: ExperimentalRunOnWorkspace,
): string {
  return (
    findHost(hosts, workspace.hostId)?.name ?? workspace.label ?? "workspace"
  );
}

export interface RunOnHostStates {
  agentOffline: boolean;

  workspaceOffline: boolean;
}

export function hostStates(
  hosts: readonly RunOnHost[],
  agentHostId: string,
  workspace: ExperimentalRunOnWorkspace,
): RunOnHostStates {
  const workspaceHost = findHost(hosts, workspace.hostId);
  return {
    agentOffline: findHost(hosts, agentHostId)?.status !== "connected",
    workspaceOffline:
      workspaceHost !== undefined && workspaceHost.status !== "connected",
  };
}

export interface RunOnUnavailable {
  reason: string;

  offlineHostId: string | null;
}

export function choiceUnavailable(
  choice: ExperimentalRunOnChoice,
  provider: SystemEnvironmentProvider,
  hosts: readonly RunOnHost[],
): RunOnUnavailable | null {
  const states = hostStates(hosts, choice.agentHostId, choice.workspace);
  if (states.agentOffline) {
    return {
      reason: `Worker ${agentName(hosts, choice.agentHostId)} is offline`,
      offlineHostId: choice.agentHostId,
    };
  }
  const availability = provider.machineAvailability[choice.agentHostId];
  if (availability?.status === "unavailable") {
    return { reason: availability.message, offlineHostId: null };
  }
  if (states.workspaceOffline) {
    return {
      reason: `Workspace ${workspaceName(hosts, choice.workspace)} is offline`,
      offlineHostId: choice.workspace.hostId,
    };
  }
  return choice.disabledReason
    ? { reason: choice.disabledReason, offlineHostId: null }
    : null;
}

export function choiceUnavailableReason(
  choice: ExperimentalRunOnChoice,
  provider: SystemEnvironmentProvider,
  hosts: readonly RunOnHost[],
): string | null {
  return choiceUnavailable(choice, provider, hosts)?.reason ?? null;
}

export interface RunOnRowView {
  providerId: string;
  choice: ExperimentalRunOnChoice;
  value: string;
  agentName: string;
  workspaceName: string;
  agentConnected: boolean;

  unavailableReason: string | null;

  lastSeenAt: number | null;
}

export interface RunOnGroupView {
  providerId: string;
  title: string;
  description: string | null;
  status: ExperimentalRunOnChoices["status"];
  error: string | null;
  rows: readonly RunOnRowView[];
}

export function buildGroups(
  accepted: readonly AcceptedRunOnProvider[],
  choicesByProvider: ReadonlyMap<string, ExperimentalRunOnChoices>,
  hosts: readonly RunOnHost[],
): RunOnGroupView[] {
  return accepted.map(({ slot, provider }) => {
    const reported = choicesByProvider.get(slot.environmentProviderId);
    const status = reported?.status ?? "loading";
    return {
      providerId: slot.environmentProviderId,
      title: slot.title,
      description: slot.description ?? null,
      status,
      error: status === "error" ? (reported?.error ?? "Unavailable") : null,
      rows: (reported?.choices ?? []).map((choice) => {
        const unavailable = choiceUnavailable(choice, provider, hosts);
        return {
          providerId: slot.environmentProviderId,
          choice,
          value: runOnRowValue(slot.environmentProviderId, choice.id),
          agentName: agentName(hosts, choice.agentHostId),
          workspaceName: workspaceName(hosts, choice.workspace),
          agentConnected:
            findHost(hosts, choice.agentHostId)?.status === "connected",
          unavailableReason: unavailable?.reason ?? null,
          lastSeenAt:
            findHost(hosts, unavailable?.offlineHostId ?? null)?.lastSeenAt ??
            null,
        };
      }),
    };
  });
}

export interface RunOnChipView {
  agentName: string;

  workspaceName: string | null;
  agentOffline: boolean;
  workspaceOffline: boolean;

  warning: boolean;
}

export function chipView(
  hosts: readonly RunOnHost[],
  agentHostId: string,
  workspace: ExperimentalRunOnWorkspace | null,
): RunOnChipView {
  const states =
    workspace === null
      ? {
          agentOffline: findHost(hosts, agentHostId)?.status !== "connected",
          workspaceOffline: false,
        }
      : hostStates(hosts, agentHostId, workspace);
  return {
    agentName: agentName(hosts, agentHostId),
    workspaceName: workspace === null ? null : workspaceName(hosts, workspace),
    ...states,
    warning:
      states.agentOffline ||
      states.workspaceOffline ||
      Boolean(workspace?.issue),
  };
}

export function chipText(view: RunOnChipView): {
  agent: string;
  workspace: string;
} {
  return {
    agent: view.agentOffline ? `${view.agentName} offline` : view.agentName,
    workspace:
      view.workspaceName === null
        ? "Choose a workspace"
        : view.workspaceOffline
          ? `${view.workspaceName} offline`
          : view.workspaceName,
  };
}
