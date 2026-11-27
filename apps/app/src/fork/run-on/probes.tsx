import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  ExperimentalRunOnChoices,
  ExperimentalRunOnWorkspace,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { PluginSlotMount } from "@/components/plugin/PluginSlotMount";
import type { PluginRunOnProviderSlot } from "@/lib/plugin-slots";
import type { AcceptedRunOnProvider } from "./registrations";

export const RUN_ON_PLUGIN_CRASHED = "The plugin stopped responding";

const CRASHED_CHOICES: ExperimentalRunOnChoices = {
  status: "error",
  choices: [],
  error: RUN_ON_PLUGIN_CRASHED,
};

function slotKey(slot: PluginRunOnProviderSlot): string {
  return `${slot.pluginId}:${slot.generation}:${slot.environmentProviderId}`;
}

function ReportOnMount({ report }: { report: () => void }) {
  useEffect(report, [report]);
  return null;
}

function ChoicesHookProbe({
  slot,
  projectId,
  onReport,
}: {
  slot: PluginRunOnProviderSlot;
  projectId: string;
  onReport: (providerId: string, choices: ExperimentalRunOnChoices) => void;
}) {
  "use no memo";
  const useChoices = slot.useChoices;
  const choices = useChoices({ projectId });
  useEffect(() => {
    onReport(slot.environmentProviderId, choices);
  }, [choices, onReport, slot.environmentProviderId]);
  return null;
}

export type RunOnChoicesByProvider = ReadonlyMap<
  string,
  ExperimentalRunOnChoices
>;

const NO_CHOICES: RunOnChoicesByProvider = new Map();

export function useRunOnChoices(
  accepted: readonly AcceptedRunOnProvider[],
  projectId: string | null,
): { probes: ReactNode; choicesByProvider: RunOnChoicesByProvider } {
  const [reported, setReported] = useState<{
    projectId: string | null;
    byProvider: RunOnChoicesByProvider;
  }>({ projectId, byProvider: NO_CHOICES });
  const report = useCallback(
    (providerId: string, choices: ExperimentalRunOnChoices) => {
      setReported((current) => {
        const base =
          current.projectId === projectId ? current.byProvider : NO_CHOICES;
        const previous = base.get(providerId);
        if (
          previous !== undefined &&
          JSON.stringify(previous) === JSON.stringify(choices)
        ) {
          return current.projectId === projectId
            ? current
            : { projectId, byProvider: base };
        }
        const next = new Map(base);
        next.set(providerId, choices);
        return { projectId, byProvider: next };
      });
    },
    [projectId],
  );
  const choicesByProvider =
    reported.projectId === projectId ? reported.byProvider : NO_CHOICES;
  const probes =
    projectId === null
      ? null
      : accepted.map(({ slot }) => (
          <PluginSlotMount
            key={slotKey(slot)}
            pluginId={slot.pluginId}
            slotKind="runOnProvider"
            slotId={slot.environmentProviderId}
            instanceId={`choices:${projectId}`}
            wrapRoot={false}
            crashFallback={
              <ReportOnMount
                report={() =>
                  report(slot.environmentProviderId, CRASHED_CHOICES)
                }
              />
            }
          >
            <ChoicesHookProbe
              slot={slot}
              projectId={projectId}
              onReport={report}
            />
          </PluginSlotMount>
        ));
  return { probes, choicesByProvider };
}

function WorkspaceHookProbe({
  slot,
  threadId,
  inputs,
  onReport,
}: {
  slot: PluginRunOnProviderSlot;
  threadId: string;
  inputs: JsonValue | null;
  onReport: (workspace: ExperimentalRunOnWorkspace | null) => void;
}) {
  "use no memo";
  const useThreadWorkspace = slot.useThreadWorkspace;
  const workspace = useThreadWorkspace({ threadId, inputs });
  useEffect(() => {
    onReport(workspace);
  }, [onReport, workspace]);
  return null;
}

export type RunOnThreadWorkspaceState =
  | { status: "loading" }
  | { status: "ready"; workspace: ExperimentalRunOnWorkspace | null }
  | { status: "crashed" };

export function useRunOnThreadWorkspace(
  slot: PluginRunOnProviderSlot | null,
  threadId: string,
  inputs: JsonValue | null,
): { probe: ReactNode; state: RunOnThreadWorkspaceState } {
  const key = slot === null ? "" : `${slotKey(slot)}:${threadId}`;
  const [reported, setReported] = useState<{
    key: string;
    state: RunOnThreadWorkspaceState;
  }>({ key, state: { status: "loading" } });
  const report = useCallback(
    (workspace: ExperimentalRunOnWorkspace | null) => {
      setReported((current) =>
        current.key === key &&
        current.state.status === "ready" &&
        JSON.stringify(current.state.workspace) === JSON.stringify(workspace)
          ? current
          : { key, state: { status: "ready", workspace } },
      );
    },
    [key],
  );
  const reportCrash = useCallback(() => {
    setReported({ key, state: { status: "crashed" } });
  }, [key]);
  const state: RunOnThreadWorkspaceState =
    reported.key === key ? reported.state : { status: "loading" };
  const probe =
    slot === null ? null : (
      <PluginSlotMount
        key={key}
        pluginId={slot.pluginId}
        slotKind="runOnProvider"
        slotId={slot.environmentProviderId}
        instanceId={`thread:${threadId}`}
        wrapRoot={false}
        crashFallback={<ReportOnMount report={reportCrash} />}
      >
        <WorkspaceHookProbe
          slot={slot}
          threadId={threadId}
          inputs={inputs}
          onReport={report}
        />
      </PluginSlotMount>
    );
  return { probe, state };
}
