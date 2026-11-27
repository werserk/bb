import type { RunOnMentionHost } from "./mentions";
import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "@bb/client-core";
import { Icon } from "@bb/shared-ui/icon";
import type { JsonValue } from "@get-bb/plugin-sdk";
import type { ComposerSubmitExtras } from "@get-bb/plugin-sdk/internal/composer-handle";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  encodeProviderValue,
  parseEnvironmentValue,
} from "@/components/pickers/environment-picker-value";
import { useHosts } from "@/hooks/queries/host-queries";
import { usePluginFrontendsSettled } from "@/lib/plugin-frontend-boot-state";
import { ComposerRunRowItems } from "./ComposerRunRowItems";
import {
  buildGroups,
  chipView,
  sameInputs,
  type RunOnGroupView,
  type RunOnHost,
  type RunOnRowView,
} from "./model";
import { useRunOnChoices } from "./probes";
import { useAcceptedRunOnProviders } from "./registrations";
import { useRunOnPreference } from "./run-on-preference";
import type { RunOnPickerModel } from "./RunOnGroups";
import { mergePluginSubmissions, useRunRowSubmission } from "./submission";

export interface RunOnComposerArgs {
  projectId: string;
  projectless: boolean;

  agentProviderId: string | null;

  selectionValue: string;
  providerHostId: string | null;

  providerInputs: JsonValue | null;
  primaryHostId: string | null;
  changeEnvironment: (value: string, hostId: string | null) => void;

  seedProviderInputs: (
    value: string,
    hostId: string,
    inputs: JsonValue,
  ) => void;
}

export interface RunOnComposer {
  picker: RunOnPickerModel | undefined;

  blocker: string | null;

  rowItems: ReactNode;

  mentionHostId: RunOnMentionHost;

  submit: (
    extras: ComposerSubmitExtras,
    send: (extras: ComposerSubmitExtras) => Promise<void>,
  ) => Promise<void>;
}

const NO_HOSTS: readonly RunOnHost[] = [];

export function providerInputsScopeKey(
  projectId: string,
  selectionValue: string,
  hostId: string | null,
): string {
  return `${projectId}\0${selectionValue}\0${hostId ?? ""}`;
}

function RunOnBranch({ branch }: { branch: string }) {
  return (
    <span
      data-promptbox-hide-branch-compact=""
      className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground"
      title={`Workspace branch ${branch}`}
    >
      <Icon name="GitBranch" className="size-3.5 shrink-0" />
      <span className="truncate">{branch}</span>
    </span>
  );
}

function findSelectedRow(
  group: RunOnGroupView | undefined,
  hostId: string | null,
  inputs: JsonValue | null,
): RunOnRowView | null {
  return (
    group?.rows.find(
      (row) =>
        row.choice.agentHostId === hostId &&
        sameInputs(row.choice.inputs, inputs),
    ) ?? null
  );
}

export function useRunOnComposer({
  projectId,
  projectless,
  agentProviderId,
  selectionValue,
  providerHostId,
  providerInputs,
  primaryHostId,
  changeEnvironment,
  seedProviderInputs,
}: RunOnComposerArgs): RunOnComposer {
  const acceptedOrLoading = useAcceptedRunOnProviders();
  const accepted = useMemo(
    () => (projectless ? [] : (acceptedOrLoading ?? [])),
    [acceptedOrLoading, projectless],
  );
  const { probes, choicesByProvider } = useRunOnChoices(
    accepted,
    projectless ? null : projectId,
  );
  const hosts = useHosts().data ?? NO_HOSTS;
  const settled = usePluginFrontendsSettled();
  const [preference, setPreference] = useRunOnPreference(projectId);
  const submission = useRunRowSubmission(
    `${projectId}\0${agentProviderId ?? ""}`,
  );

  const parsed = parseEnvironmentValue(selectionValue);
  const selectedProviderId =
    parsed?.type === "provider" ? parsed.environmentProviderId : null;
  const groups = useMemo(
    () => buildGroups(accepted, choicesByProvider, hosts),
    [accepted, choicesByProvider, hosts],
  );
  const selectedGroup = groups.find(
    (group) => group.providerId === selectedProviderId,
  );
  const selectedRow = findSelectedRow(
    selectedGroup,
    providerHostId,
    providerInputs,
  );

  const selectRow = useCallback(
    (row: RunOnRowView) => {
      const value = encodeProviderValue(row.providerId);
      changeEnvironment(value, row.choice.agentHostId);
      seedProviderInputs(value, row.choice.agentHostId, row.choice.inputs);
      setPreference({ providerId: row.providerId, choiceId: row.choice.id });
    },
    [changeEnvironment, seedProviderInputs, setPreference],
  );
  const fallBackToLocal = useCallback(() => {
    changeEnvironment(
      encodeProviderValue(PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID),
      primaryHostId,
    );
  }, [changeEnvironment, primaryHostId]);

  const restoredProjectId = useRef<string | null>(null);
  const preferredGroup = groups.find(
    (group) => group.providerId === preference?.providerId,
  );
  useEffect(() => {
    if (restoredProjectId.current === projectId || projectless) return;
    if (preference === null) {
      restoredProjectId.current = projectId;
      return;
    }
    if (!settled || acceptedOrLoading === null) return;
    if (preferredGroup === undefined) {
      if (selectedProviderId === preference.providerId) fallBackToLocal();
      setPreference(null);
      restoredProjectId.current = projectId;
      return;
    }
    if (preferredGroup.status === "loading") return;
    if (selectedProviderId === preference.providerId && selectedRow === null) {
      const remembered = preferredGroup.rows.find(
        (row) => row.choice.id === preference.choiceId,
      );
      if (remembered !== undefined) {
        selectRow(remembered);
      } else if (preferredGroup.status === "ready") {
        fallBackToLocal();
        setPreference(null);
      }
    }
    restoredProjectId.current = projectId;
  }, [
    acceptedOrLoading,
    fallBackToLocal,
    preference,
    preferredGroup,
    projectId,
    projectless,
    selectRow,
    selectedProviderId,
    selectedRow,
    setPreference,
    settled,
  ]);

  const selectedAccepted =
    selectedGroup !== undefined && providerHostId !== null;
  const chip = selectedAccepted
    ? chipView(hosts, providerHostId, selectedRow?.choice.workspace ?? null)
    : null;
  const blocker = !selectedAccepted
    ? null
    : selectedRow !== null
      ? selectedRow.unavailableReason
      : chip?.agentOffline
        ? `Worker ${chip.agentName} is offline`
        : null;
  const detail = selectedRow?.choice.workspace.detail;
  const picker = useMemo((): RunOnPickerModel | undefined => {
    if (groups.length === 0) return undefined;
    return {
      groups,
      registeredProviderIds: new Set(groups.map((group) => group.providerId)),
      selectedValue: selectedRow?.value ?? null,
      chip,
      footer:
        selectedRow !== null && detail
          ? `Workspace ${selectedRow.workspaceName} · ${detail}`
          : null,
      onSelect: selectRow,
    };
  }, [chip, detail, groups, selectRow, selectedRow]);

  const { current: rowItemSubmission, clear: clearSubmission } = submission;
  const submit = useCallback(
    async (
      extras: ComposerSubmitExtras,
      send: (extras: ComposerSubmitExtras) => Promise<void>,
    ) => {
      const merged = mergePluginSubmissions(
        rowItemSubmission,
        extras.pluginSubmission,
      );
      if (!merged.ok) throw new Error(merged.message);
      const { pluginSubmission: _ignored, ...rest } = extras;
      await send(
        merged.value === undefined
          ? rest
          : { ...rest, pluginSubmission: merged.value },
      );
      clearSubmission();
    },
    [clearSubmission, rowItemSubmission],
  );

  const branch = selectedRow?.choice.workspace.branch;
  const setSubmissionFor = submission.setFor;
  const rowItems = useMemo(
    () =>
      projectless ? null : (
        <>
          {probes}
          <ComposerRunRowItems
            scope={{
              kind: "new-thread",
              projectId,
              providerId: agentProviderId,
            }}
            submission={rowItemSubmission}
            setSubmissionFor={setSubmissionFor}
          />
          {branch ? <RunOnBranch branch={branch} /> : null}
        </>
      ),
    [
      agentProviderId,
      branch,
      probes,
      projectId,
      projectless,
      rowItemSubmission,
      setSubmissionFor,
    ],
  );

  return {
    picker,
    blocker,
    rowItems,
    mentionHostId:
      selectedRow === null ? undefined : selectedRow.choice.workspace.hostId,
    submit,
  };
}
