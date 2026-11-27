import { useEffect, useRef } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery as useRpcQuery,
  type JsonValue,
  type PluginEnvironmentProviderInputsChange,
  type PluginEnvironmentProviderInputsProps,
} from "@get-bb/plugin-sdk/app";
import { accountWorkersAppContract, type WorkerChoice } from "./app-contract.js";
import { WORKER_PROVIDER_ID } from "./provider-id.js";

interface WorkerInputsValue {
  workspaceHostId: string;
  root: string;
}

export function readInputs(value: JsonValue | null): WorkerInputsValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { workspaceHostId, root } = value;
  return typeof workspaceHostId === "string" && typeof root === "string" ? { workspaceHostId, root } : null;
}

const matches = (choice: WorkerChoice, inputs: WorkerInputsValue | null) =>
  inputs !== null && choice.workspaceHostId === inputs.workspaceHostId && choice.root === inputs.root;

export function inputsState(args: {
  projectId: string | null;
  agentHostId: string | null;
  choices: WorkerChoice[] | null;
  error: string | null;
  value: JsonValue | null;
}): { options: WorkerChoice[]; selected: WorkerChoice | null; change: PluginEnvironmentProviderInputsChange } {
  const blocked = (reason: string, options: WorkerChoice[] = []) => ({ options, selected: null, change: { status: "blocked" as const, reason } });
  if (args.projectId === null) return blocked("Choose a project to run on a worker");
  if (args.agentHostId === null) return blocked("A worker runs on an existing machine");
  if (args.error !== null) return blocked(`Workspaces did not load: ${args.error}`);
  if (args.choices === null) return blocked("Loading workspaces");
  const options = args.choices.filter((c) => c.agentHostId === args.agentHostId);
  if (options.length === 0) return blocked("No other machine holds this project's source");
  const current = readInputs(args.value);
  const selected = options.find((c) => matches(c, current)) ?? (current === null ? (options.find((c) => c.disabledReason === null) ?? null) : null);
  if (selected === null) return blocked("Choose a workspace", options);
  if (selected.disabledReason !== null) return { options, selected, change: { status: "blocked", reason: selected.disabledReason } };
  return { options, selected, change: { status: "ready", value: { workspaceHostId: selected.workspaceHostId, root: selected.root } } };
}

const optionValue = (choice: WorkerChoice) => JSON.stringify([choice.workspaceHostId, choice.root]);

function WorkspaceInputs({ projectId, target, value, onChange }: PluginEnvironmentProviderInputsProps) {
  const query = useRpcQuery({
    contract: accountWorkersAppContract,
    method: "choices",
    input: { projectId: projectId ?? "" },
    enabled: projectId !== null,
  });
  const state = inputsState({
    projectId,
    agentHostId: target.kind === "existing-host" ? target.hostId : null,
    choices: query.data?.choices ?? null,
    error: query.error?.message ?? null,
    value,
  });
  const change = JSON.stringify(state.change);
  const report = useRef(onChange);
  useEffect(() => {
    report.current = onChange;
  });
  useEffect(() => {
    report.current(JSON.parse(change) as PluginEnvironmentProviderInputsChange);
  }, [change]);
  if (state.options.length === 0) {
    return <span className="text-xs text-muted-foreground">{state.change.status === "blocked" ? state.change.reason : null}</span>;
  }
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted-foreground">Workspace</span>
      <select
        className="rounded border border-border bg-transparent px-1 py-0.5"
        value={state.selected === null ? "" : optionValue(state.selected)}
        onChange={(event) => {
          const picked = state.options.find((c) => optionValue(c) === event.target.value);
          if (picked !== undefined) onChange({ status: "ready", value: { workspaceHostId: picked.workspaceHostId, root: picked.root } });
        }}
      >
        {state.selected === null ? <option value="">Choose a workspace</option> : null}
        {state.options.map((c) => (
          <option key={optionValue(c)} value={optionValue(c)} disabled={c.disabledReason !== null}>
            {`${c.workspaceHostName}: ${c.root}${c.disabledReason === null ? "" : ` (${c.disabledReason})`}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_environmentProviderInputs({
    environmentProviderId: WORKER_PROVIDER_ID,
    component: WorkspaceInputs,
  });
});
