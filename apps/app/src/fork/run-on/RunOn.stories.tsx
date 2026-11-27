import type { ProjectSource } from "@bb/domain";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { ExperimentalRunOnChoices } from "@get-bb/plugin-sdk";
import type { ReactNode } from "react";
import { EnvironmentPickerUI } from "@/components/pickers/EnvironmentPicker";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import type { PluginRunOnProviderSlot } from "@/lib/plugin-slots";
import { Icon } from "@bb/shared-ui/icon";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";
import {
  makeHost,
  STORY_ENVIRONMENT_PROVIDERS,
} from "../../../.ladle/story-fixtures";
import { buildGroups, chipView, type RunOnHost } from "./model";
import type { RunOnPickerModel } from "./RunOnGroups";
import { RunOnThreadPopover, type RunOnThreadView } from "./RunOnThreadPopover";

export default {
  title: "fork/Run on",
};

const WORKER = "account-workers-worker";
const LAST_SEEN = Date.now() - 2 * 60 * 60 * 1000;

const hostA = makeHost({ id: "host_a", name: "machine-a" });
const hostB = makeHost({ id: "host_b", name: "machine-b" });
const hostBOffline = makeHost({
  id: "host_b",
  name: "machine-b",
  status: "disconnected",
  lastSeenAt: LAST_SEEN,
});
const hostAOffline = makeHost({
  id: "host_a",
  name: "machine-a",
  status: "disconnected",
  lastSeenAt: LAST_SEEN,
});

const sources: readonly ProjectSource[] = [
  {
    id: "src_a",
    projectId: "proj_demo",
    type: "local_path",
    hostId: hostA.id,
    path: "/srv/repo",
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

const workerProvider = {
  ...STORY_ENVIRONMENT_PROVIDERS[0],
  id: WORKER,
  displayName: "Worker",
  description: "Agent on a worker, files on a workspace host.",
  pluginId: "account-workers",
  icon: "ComputerCloud",
  acceptsEmptyInputs: false,
} as SystemEnvironmentProvider;

const providers: readonly SystemEnvironmentProvider[] = [
  ...STORY_ENVIRONMENT_PROVIDERS,
  workerProvider,
];

const slot = {
  pluginId: "account-workers",
  generation: 1,
  version: 1,
  environmentProviderId: WORKER,
  title: "On a worker",
  description: "agent there, files on machine-a",
  useChoices: () => ({ status: "ready", choices: [] }),
  useThreadWorkspace: () => null,
} satisfies PluginRunOnProviderSlot;

const choices: ExperimentalRunOnChoices = {
  status: "ready",
  choices: [
    {
      id: "b-a",
      agentHostId: hostB.id,
      inputs: { workspaceHostId: hostA.id, root: "/srv/repo" },
      workspace: { hostId: hostA.id, detail: "/srv/repo", branch: "main" },
    },
  ],
};

const noop = () => {};

function pickerModel(
  hosts: readonly RunOnHost[],
  selected: boolean,
): RunOnPickerModel {
  const groups = buildGroups(
    [{ slot, provider: workerProvider }],
    new Map([[WORKER, choices]]),
    hosts,
  );
  const row = groups[0]?.rows[0];
  return {
    groups,
    registeredProviderIds: new Set([WORKER]),
    selectedValue: selected ? (row?.value ?? null) : null,
    chip: selected
      ? chipView(hosts, hostB.id, choices.choices[0]?.workspace ?? null)
      : null,
    footer: selected ? "Workspace machine-a · /srv/repo" : null,
    onSelect: noop,
  };
}

function Picker({
  hosts,
  selected,
}: {
  hosts: readonly (typeof hostA)[];
  selected: boolean;
}) {
  return (
    <EnvironmentPickerUI
      value={selected ? `provider:${WORKER}` : "provider:project-checkout"}
      sources={sources}
      host={hostA}
      isLocal
      providers={providers}
      selectedProviderHostId={selected ? hostB.id : hostA.id}
      onSelectProvider={noop}
      machines={{ hosts, localDaemonHostId: hostA.id, primaryHostId: hostA.id }}
      runOn={pickerModel(hosts, selected)}
      defaultOpen
      modal={false}
      muted
    />
  );
}

export function NewThreadMenu() {
  return (
    <StoryCard labelWidth="minmax(0,140px)">
      <StoryRow
        label="worker selected"
        hint="menu open; chip machine-b → machine-a"
      >
        <Picker hosts={[hostA, hostB]} selected />
      </StoryRow>
    </StoryCard>
  );
}

export function NewThreadOffline() {
  return (
    <StoryCard labelWidth="minmax(0,140px)">
      <StoryRow label="worker offline" hint="row disabled, chip amber">
        <Picker hosts={[hostA, hostBOffline]} selected />
      </StoryRow>
    </StoryCard>
  );
}

function threadView(hosts: readonly RunOnHost[]): RunOnThreadView {
  const agent = hosts.find((host) => host.id === hostB.id);
  return {
    threadId: "thr_demo",
    pluginId: "account-workers",
    environmentProviderId: WORKER,
    chip: chipView(hosts, hostB.id, { hostId: hostA.id }),
    agentHostId: hostB.id,
    agentLastSeenAt:
      agent?.status === "connected" ? null : (agent?.lastSeenAt ?? null),
    workspaceHostId: hostA.id,
    detail: "/srv/repo",
    issue: null,
    ThreadActions: () => (
      <button
        type="button"
        className="rounded-md border border-border px-2 py-1 text-xs"
      >
        Change workspace…
      </button>
    ),
  };
}

function AccountChip() {
  return (
    <span className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground">
      <Icon name="Layers" className="size-3.5" />
      <span data-promptbox-full-label="">Claude A</span>
    </span>
  );
}

function ThreadRow({ hosts }: { hosts: readonly RunOnHost[] }): ReactNode {
  return (
    <ThreadEnvironmentSummary
      projectName="Demo"
      environmentLabel="Worker"
      environmentOverride={<RunOnThreadPopover view={threadView(hosts)} />}
      rowItems={<AccountChip />}
      environmentCheckout={{
        copyErrorMessage: null,
        copyLabel: null,
        copySuccessMessage: null,
        copyValue: null,
        label: "main",
        rowLabel: "Branch",
        title: "main",
      }}
      onCreateNewThreadInEnvironment={noop}
    />
  );
}

export function OpenThread() {
  return (
    <StoryCard labelWidth="minmax(0,140px)">
      <StoryRow label="open thread" hint="click the chip for the popover">
        <ThreadRow hosts={[hostA, hostB]} />
      </StoryRow>
      <StoryRow label="agent offline" hint="amber chip; popover note">
        <ThreadRow hosts={[hostA, hostBOffline]} />
      </StoryRow>
      <StoryRow label="workspace offline" hint="amber chip">
        <ThreadRow hosts={[hostAOffline, hostB]} />
      </StoryRow>
    </StoryCard>
  );
}
