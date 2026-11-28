import "../../../.ladle/composer-plugin";
import type { ProjectSource } from "@bb/domain";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { ExperimentalRunOnChoices } from "@get-bb/plugin-sdk";
import { Icon } from "@bb/shared-ui/icon";
import { FollowUpPromptBox } from "@/components/promptbox/FollowUpPromptBox";
import { NewThreadPromptBoxUI } from "@/components/promptbox/NewThreadPromptBox";
import { ThreadEnvironmentSummary } from "@/components/promptbox/ThreadEnvironmentSummary";
import { PageShell } from "@/components/ui/page-shell.js";
import type { PluginRunOnProviderSlot } from "@/lib/plugin-slots";
import { useComposerDraftFixture } from "@/test/fixtures/composer-draft";
import {
  makeAttachmentsConfig,
  makeExecutionControlsProps,
  makeHost,
  makeTypeaheadConfig,
  PROJECT_IDS,
  STORY_ENVIRONMENT_PROVIDERS,
  STORY_PROJECTS,
  STORY_WORKTREE_OPTIONS,
} from "../../../.ladle/story-fixtures";
import { buildGroups, chipView } from "./model";
import type { RunOnPickerModel } from "./RunOnGroups";
import { RunOnThreadPopover } from "./RunOnThreadPopover";

export default {
  title: "fork/Run on composer",
};

const WORKER = "account-workers-worker";
const noop = () => {};

const hostA = makeHost({
  id: "host_a",
  name: "workspace-host-with-a-very-long-name-17",
});
const hostB = makeHost({
  id: "host_b",
  name: "worker-with-a-very-long-machine-name-0042",
});
const hosts = [hostA, hostB];

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
  pluginId: "account-workers",
  icon: "ComputerCloud",
  inputs: { type: "object" },
  acceptsEmptyInputs: false,
} as SystemEnvironmentProvider;

const slot = {
  pluginId: "account-workers",
  generation: 1,
  version: 1,
  environmentProviderId: WORKER,
  title: "On a worker",
  description: "agent there, files elsewhere",
  useChoices: () => ({ status: "ready", choices: [] }),
  useThreadWorkspace: () => null,
} satisfies PluginRunOnProviderSlot;

const choices: ExperimentalRunOnChoices = {
  status: "ready",
  choices: [
    {
      id: "b-a",
      agentHostId: hostB.id,
      inputs: {},
      workspace: { hostId: hostA.id, detail: "/srv/repo" },
    },
  ],
};

function pickerModel(): RunOnPickerModel {
  const groups = buildGroups(
    [{ slot, provider: workerProvider }],
    new Map([[WORKER, choices]]),
    hosts,
  );
  return {
    groups,
    registeredProviderIds: new Set([WORKER]),
    selectedValue: groups[0]?.rows[0]?.value ?? null,
    chip: chipView(hosts, hostB.id, { hostId: hostA.id }),
    footer: `Workspace ${hostA.name} · /srv/repo`,
    onSelect: noop,
  };
}

const permission = {
  value: "auto" as const,
  options: [{ value: "auto" as const, label: "Approve for me" }],
  onChange: noop,
  supported: true,
};

function AccountChip() {
  return (
    <span
      data-story-account-chip=""
      className="flex shrink-0 items-center gap-1 px-1 text-xs text-muted-foreground"
    >
      <Icon name="Layers" className="size-3.5" />
      <span>Claude A</span>
    </span>
  );
}

function WorkspaceInputsControl() {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Workspace</span>
      <select className="rounded border border-border bg-transparent px-1 py-0.5">
        <option>{`${hostA.name}: /srv/repo/with/a/long/absolute/path`}</option>
      </select>
    </label>
  );
}

function NewThreadComposerScene({ width }: { width: string }) {
  const draft = useComposerDraftFixture("");
  return (
    <div className="mx-auto w-full" style={{ maxWidth: width }}>
      <NewThreadPromptBoxUI
        mentionMenuPlacement="bottom"
        id="run-on-new-thread-long-names"
        draft={draft}
        onSubmit={noop}
        isSubmitting={false}
        disabled={false}
        history={{ entries: [], onSelectEntry: noop }}
        typeahead={makeTypeaheadConfig()}
        attachments={makeAttachmentsConfig()}
        modeConfig={{
          environment: {
            value: `provider:${WORKER}`,
            sources,
            host: hostA,
            isLocal: true,
            providers: [...STORY_ENVIRONMENT_PROVIDERS, workerProvider],
            selectedProviderHostId: hostB.id,
            onSelectProvider: noop,
            machines: {
              hosts,
              localDaemonHostId: hostA.id,
              primaryHostId: hostA.id,
            },
            runOn: pickerModel(),
            runRowItems: <AccountChip />,
          },
          environmentProviderInputsSlot: <WorkspaceInputsControl />,
          worktree: {
            options: STORY_WORKTREE_OPTIONS,
            value: null,
            onChange: noop,
          },
          permission,
        }}
        project={{
          projects: STORY_PROJECTS,
          value: PROJECT_IDS.bb,
          onChange: noop,
        }}
        execution={makeExecutionControlsProps()}
      />
    </div>
  );
}

export function NewThreadLongNames() {
  return <NewThreadComposerScene width="760px" />;
}

export function NewThreadNarrowColumn() {
  return <NewThreadComposerScene width="528px" />;
}

export function OpenThreadLongNames() {
  const draft = useComposerDraftFixture("");
  const chip = (
    <RunOnThreadPopover
      view={{
        threadId: "thr_demo",
        pluginId: "account-workers",
        environmentProviderId: WORKER,
        chip: chipView(hosts, hostB.id, { hostId: hostA.id }),
        agentHostId: hostB.id,
        agentLastSeenAt: null,
        workspaceHostId: hostA.id,
        detail: "/srv/repo",
        issue: null,
        ThreadActions: null,
      }}
    />
  );
  return (
    <div className="w-full min-w-0 bg-background">
      <PageShell
        shellClassName="!mx-0 !mt-0 !h-auto !min-h-0 !flex-none md:!mx-0 md:!mt-0"
        scrollAreaClassName="hidden"
        footerClassName="chat-prompt-box"
        footer={
          <FollowUpPromptBox
            attachments={makeAttachmentsConfig()}
            stack={null}
            composer={{
              history: { entries: [], onSelectEntry: noop },
              isFollowUpSubmitting: false,
              draft,
              onModifierSubmit: noop,
              onSubmit: noop,
              compactPromptPlaceholder: "Reply",
              promptPlaceholder: "Reply",
              canModifierSubmit: false,
              steerActiveThreadOnEnter: false,
              submitMode: { kind: "ready" },
              threadRuntimeDisplayStatus: "idle",
            }}
            environmentSummary={
              <ThreadEnvironmentSummary
                projectName="Demo"
                environmentLabel="Worker"
                environmentOverride={chip}
                rowItems={<AccountChip />}
                onCreateNewThreadInEnvironment={noop}
              />
            }
            compactEnvironmentSummary={
              <>
                {chip}
                <AccountChip />
              </>
            }
            contextWindowUsage={null}
            execution={makeExecutionControlsProps()}
            permission={permission}
            typeahead={makeTypeaheadConfig()}
            collapseResetKey="thr_demo"
          />
        }
      >
        <span aria-hidden="true" />
      </PageShell>
    </div>
  );
}
