import { useState, type ComponentType } from "react";
import {
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type JsonValue,
} from "@get-bb/plugin-sdk/app";
import { accountWorkersAppContract, type ThreadWorkspace, type WorkerChoice, type WorkspaceOption } from "./app-contract.js";
import { readInputs } from "./inputs.js";
import { WORKER_PROVIDER_ID } from "./provider-id.js";

export interface RunOnWorkspace {
  hostId: string | null;
  label?: string;
  detail?: string;
  branch?: string | null;
  issue?: string | null;
}

export interface RunOnChoice {
  id: string;
  agentHostId: string;
  inputs: JsonValue;
  workspace: RunOnWorkspace;
  disabledReason?: string | null;
}

export interface RunOnChoices {
  status: "loading" | "ready" | "error";
  choices: readonly RunOnChoice[];
  error?: string;
}

export interface RunOnProviderRegistration {
  version: 1;
  environmentProviderId: string;
  title: string;
  description?: string;
  order?: number;
  useChoices(scope: { projectId: string }): RunOnChoices;
  useThreadWorkspace(scope: { threadId: string; inputs: JsonValue | null }): RunOnWorkspace | null;
  ThreadActions?: ComponentType<{ threadId: string }>;
}

interface QueryLike<T> {
  data: T | undefined;
  error: { message: string } | null;
}

export function runOnChoices(query: QueryLike<{ choices: WorkerChoice[] }>): RunOnChoices {
  if (query.data === undefined) {
    return query.error === null ? { status: "loading", choices: [] } : { status: "error", choices: [], error: query.error.message };
  }
  return {
    status: "ready",
    choices: query.data.choices.map((c) => ({
      id: JSON.stringify([c.agentHostId, c.workspaceHostId, c.root]),
      agentHostId: c.agentHostId,
      inputs: { workspaceHostId: c.workspaceHostId, root: c.root },
      workspace: { hostId: c.workspaceHostId, detail: c.root },
      disabledReason: null,
    })),
  };
}

export function runOnThreadWorkspace(inputs: JsonValue | null, query: QueryLike<{ workspace: ThreadWorkspace | null }>): RunOnWorkspace | null {
  const bound = query.data?.workspace;
  if (bound !== undefined && bound !== null) {
    return { hostId: bound.workspaceHostId, detail: bound.root, branch: bound.branch, issue: bound.issue };
  }
  const chosen = readInputs(inputs);
  if (chosen === null) return null;
  const base = { hostId: chosen.workspaceHostId, detail: chosen.root };
  if (bound === null) return { ...base, issue: "Workspace unbound" };
  return query.error === null ? base : { ...base, issue: `Workspace did not load: ${query.error.message}` };
}

function useChoices({ projectId }: { projectId: string }): RunOnChoices {
  return runOnChoices(useRpcQuery({ contract: accountWorkersAppContract, method: "choices", input: { projectId } }));
}

function useThreadWorkspace({ threadId, inputs }: { threadId: string; inputs: JsonValue | null }): RunOnWorkspace | null {
  return runOnThreadWorkspace(inputs, useRpcQuery({ contract: accountWorkersAppContract, method: "threadWorkspace", input: { threadId } }));
}

function optionLabel(option: WorkspaceOption): string {
  return `${option.workspaceHostName}: ${option.root}${option.disabledReason === null ? "" : ` (${option.disabledReason})`}`;
}

function ChangeWorkspace({ threadId }: { threadId: string }) {
  const [open, setOpen] = useState(false);
  const options = useRpcQuery({ contract: accountWorkersAppContract, method: "workspaceOptions", input: { threadId }, enabled: open });
  const rebind = useRpcMutation({ contract: accountWorkersAppContract, method: "rebind" });
  if (!open) {
    return (
      <button type="button" className="text-left text-xs hover:underline" onClick={() => setOpen(true)}>
        Change workspace…
      </button>
    );
  }
  const list = options.data?.options ?? [];
  return (
    <div role="dialog" aria-label="Change workspace" className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">Move this thread's file and shell tools to another machine</span>
      {options.error !== null ? <span className="text-destructive">{options.error.message}</span> : null}
      {options.data === undefined && options.error === null ? <span className="text-muted-foreground">Loading workspaces</span> : null}
      {options.data !== undefined && list.length === 0 ? <span className="text-muted-foreground">No other machine holds this project's source</span> : null}
      {list.map((option) => (
        <button
          key={`${option.workspaceHostId}:${option.root}`}
          type="button"
          className="text-left hover:underline disabled:opacity-50"
          disabled={option.current || option.disabledReason !== null || rebind.isPending}
          onClick={() => void rebind.mutate({ threadId, workspaceHostId: option.workspaceHostId }).then(() => setOpen(false), () => undefined)}
        >
          {option.current ? `${optionLabel(option)} (current)` : optionLabel(option)}
        </button>
      ))}
      {rebind.error !== null ? <span className="text-destructive">{rebind.error.message}</span> : null}
      <button type="button" className="text-left text-muted-foreground hover:underline" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

export const runOnRegistration: RunOnProviderRegistration = {
  version: 1,
  environmentProviderId: WORKER_PROVIDER_ID,
  title: "On a worker",
  description: "Agent on the worker, files on another machine",
  useChoices,
  useThreadWorkspace,
  ThreadActions: ChangeWorkspace,
};

export function registerRunOn(slots: object): boolean {
  const register = (slots as { experimental_runOnProvider?: unknown }).experimental_runOnProvider;
  if (typeof register !== "function") return false;
  (register as (registration: RunOnProviderRegistration) => void).call(slots, runOnRegistration);
  return true;
}
