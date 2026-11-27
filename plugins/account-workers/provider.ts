import { randomBytes } from "node:crypto";
import type { JsonValue, MessageDispatchHookContext, MessageDispatchHookDecision } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Binding, BindingStore } from "./bindings.js";
import type { InstructionFile } from "./contract.js";
import { profileForProvider } from "./profiles/index.js";
import type { ProviderProfile } from "./profiles/types.js";
import type { ReleaseOutcome } from "./release.js";
import { WORKER_PROVIDER_ID } from "./provider-id.js";
import { SAME_HOST, type HostClient } from "./tools.js";

export { WORKER_PROVIDER_ID };

export const CREATE_DEADLINE_MS = 120_000;
export const RESOLVE_TIMEOUT_MS = 8_000;
export const CLEANUP_TIMEOUT_MS = 30_000;

export const workerInputsSchema = z
  .object({ workspaceHostId: z.string().min(1).max(128), root: z.string().min(1).max(4096) })
  .strict();
export type WorkerInputs = z.infer<typeof workerInputsSchema>;

export const workerResourceSchema = z.object({ bindingId: z.string().min(1) }).strict();

interface HostInfo {
  id: string;
  name: string;
  status: string;
}

interface ProjectSourceInfo {
  type: string;
  hostId: string;
  path: string;
}

interface ProviderThread {
  id: string;
  projectId: string;
  providerId: string;
}

interface Progress {
  step(text: string): void;
  log(text: string): void;
}

export interface WorkerValidateContext {
  project: { id: string };
  host: HostInfo;
  inputs: WorkerInputs;
}

export interface WorkerCreateContext extends WorkerValidateContext {
  thread: ProviderThread;
  attempt: number;
  report: Progress;
  signal: AbortSignal;
}

export interface WorkerRemoveContext {
  resource: JsonValue | null;
  report: Progress;
  signal: AbortSignal;
}

export type CreateResult =
  | { status: "created"; path: string; ownsPath: boolean; resource: { bindingId: string } }
  | { status: "failed"; message: string };

export interface ResolvedWorkspace {
  hostId: string;
  hostName: string;
  root: string;
  instructions: InstructionFile[];
  branch: string | null;
  sourcePath: string;
}

export interface WorkerProviderDeps {
  store: BindingStore;
  host: Pick<HostClient, "call">;
  listHosts(signal?: AbortSignal): Promise<HostInfo[]>;
  projectSources(projectId: string, signal?: AbortSignal): Promise<ProjectSourceInfo[]>;
  refusedMachineEnv(profile: ProviderProfile, projectId: string): Promise<string[]>;
  release(binding: Binding): Promise<ReleaseOutcome>;
  retire(binding: Binding): void;
  changed(threadId: string): void;
  log(message: string): void;
  deadlineMs?: number;
}

export class WorkspaceProblem extends Error {}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolveProjectWorkspace(
  deps: Pick<WorkerProviderDeps, "host" | "listHosts" | "projectSources">,
  projectId: string,
  workspaceHostId: string,
  agentHostId: string,
  signal?: AbortSignal,
): Promise<ResolvedWorkspace> {
  if (workspaceHostId === agentHostId) throw new WorkspaceProblem(SAME_HOST);
  const [hosts, sources] = await Promise.all([deps.listHosts(signal), deps.projectSources(projectId, signal)]);
  const target = hosts.find((h) => h.id === workspaceHostId);
  if (target === undefined) throw new WorkspaceProblem(`No machine ${workspaceHostId}`);
  if (target.status !== "connected") throw new WorkspaceProblem(`Workspace machine ${target.name} is ${target.status}`);
  const source = sources.find((s) => s.type === "local_path" && s.hostId === workspaceHostId);
  if (source === undefined) throw new WorkspaceProblem(`This project has no source on ${target.name}`);
  const result = await deps.host.call("resolveRoot", { path: source.path }, { hostId: workspaceHostId, signal });
  if (!result.ok) throw new WorkspaceProblem(`Workspace path refused: ${result.error}`);
  return { hostId: target.id, hostName: target.name, root: result.root, instructions: result.instructions, branch: result.branch, sourcePath: source.path };
}

function sameRoot(inputs: WorkerInputs, workspace: ResolvedWorkspace): boolean {
  return inputs.root === workspace.root || inputs.root === workspace.sourcePath;
}

export function workerProvider(deps: WorkerProviderDeps) {
  const deadlineMs = deps.deadlineMs ?? CREATE_DEADLINE_MS;

  async function validate(ctx: WorkerValidateContext) {
    try {
      const workspace = await resolveProjectWorkspace(
        deps,
        ctx.project.id,
        ctx.inputs.workspaceHostId,
        ctx.host.id,
        AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
      );
      if (!sameRoot(ctx.inputs, workspace)) {
        return { action: "refuse" as const, message: `Workspace root ${ctx.inputs.root} is not this project's source on ${workspace.hostName} (${workspace.root})` };
      }
      return { action: "accept" as const };
    } catch (error) {
      return { action: "refuse" as const, message: message(error) };
    }
  }

  async function cleanup(bindingId: string, profile: ProviderProfile, workerHostId: string, scratchPath: string | null) {
    try {
      const result = await deps.host.call(
        "releaseScratch",
        { bindingId, profile: profile.id, ...(scratchPath === null ? {} : { scratchPath }) },
        { hostId: workerHostId, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) },
      );
      if (!result.ok) throw new Error(result.error);
      return null;
    } catch (error) {
      deps.log(`account-workers: cleanup of ${bindingId} on ${workerHostId} failed: ${message(error)}`);
      return message(error);
    }
  }

  async function create(ctx: WorkerCreateContext): Promise<CreateResult> {
    const { thread, host: worker, report } = ctx;
    const existing = deps.store.recordByThread(thread.id);
    if (existing !== null) {
      if (existing.owner === "provider" && existing.releasedAt === null && existing.workerHostId === worker.id) {
        report.step("Reusing the workspace binding");
        return { status: "created", path: existing.scratchPath, ownsPath: false, resource: { bindingId: existing.id } };
      }
      return { status: "failed", message: `Thread ${thread.id} already has workspace binding ${existing.id}; start a new thread` };
    }
    const profile = profileForProvider(thread.providerId);
    if (profile === undefined) {
      return { status: "failed", message: `Provider ${thread.providerId} has no account-workers profile` };
    }
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(deadlineMs)]);
    const bindingId = `aw_${randomBytes(8).toString("hex")}`;
    let step = "Checking machine variables";
    let scratchPath: string | null = null;
    let prepared = false;
    try {
      report.step(step);
      const refused = await deps.refusedMachineEnv(profile, thread.projectId);
      if (refused.length > 0) {
        return { status: "failed", message: `BB machine variables ${refused.join(", ")} are set for this project; they override the scratch ${profile.id} config, so the worker's native tools would stay on. Remove them first.` };
      }
      step = "Resolving the workspace";
      report.step(step);
      const workspace = await resolveProjectWorkspace(deps, thread.projectId, ctx.inputs.workspaceHostId, worker.id, signal);
      if (!sameRoot(ctx.inputs, workspace)) {
        return { status: "failed", message: `Workspace root ${ctx.inputs.root} is no longer this project's source on ${workspace.hostName} (${workspace.root})` };
      }
      step = `Preparing the ${profile.id} scratch directory on ${worker.name}`;
      report.step(step);
      const model = deps.store.startModel(thread.id)?.model ?? null;
      prepared = true;
      const scratch = await deps.host.call(
        "prepareScratch",
        { bindingId, profile: profile.id, providerId: thread.providerId, model },
        { hostId: worker.id, signal },
      );
      if (!scratch.ok) {
        prepared = false;
        return { status: "failed", message: `Scratch directory failed: ${scratch.error}` };
      }
      scratchPath = scratch.path;
      signal.throwIfAborted();
      step = "Recording the workspace binding";
      deps.store.create({
        id: bindingId,
        threadId: thread.id,
        owner: "provider",
        workerHostId: worker.id,
        scratchPath: scratch.path,
        workspaceHostId: workspace.hostId,
        workspaceHostName: workspace.hostName,
        root: workspace.root,
        instructions: workspace.instructions,
        profile: profile.id,
        ready: true,
      });
      deps.store.forgetStart(thread.id);
      deps.changed(thread.id);
      return { status: "created", path: scratch.path, ownsPath: false, resource: { bindingId } };
    } catch (error) {
      const cause = signal.aborted && !ctx.signal.aborted ? `timed out after ${Math.round(deadlineMs / 1000)} s` : message(error);
      const cleanupError = prepared ? await cleanup(bindingId, profile, worker.id, scratchPath) : null;
      return {
        status: "failed",
        message: `account-workers: ${step} ${cause}` + (cleanupError === null ? "" : `; cleanup of ${bindingId} on ${worker.name} also failed: ${cleanupError}`),
      };
    }
  }

  async function remove(ctx: WorkerRemoveContext) {
    const parsed = workerResourceSchema.safeParse(ctx.resource);
    if (!parsed.success) return { status: "removed" as const };
    const record = deps.store.byId(parsed.data.bindingId);
    if (record === null || record.cleanedAt !== null) return { status: "removed" as const };
    if (record.releasedAt === null) deps.retire(record);
    else deps.store.dueNow(record.id);
    ctx.report.step("Releasing the worker scratch directory");
    const outcome = await deps.release(record);
    if (record.threadId !== null) deps.changed(record.threadId);
    switch (outcome.kind) {
      case "cleaned":
        return { status: "removed" as const };
      case "failed":
        return { status: "failed" as const, message: outcome.error };
      case "live":
        return { status: "failed" as const, message: `Thread ${record.threadId} is still running` };
      case "not-due":
        return { status: "failed" as const, message: `Release of ${record.id} is not due yet` };
    }
  }

  async function availability(ctx: { project: { id: string }; host: HostInfo }) {
    if (ctx.host.status !== "connected") return { status: "unavailable" as const, message: `${ctx.host.name} is ${ctx.host.status}` };
    const sources = await deps.projectSources(ctx.project.id);
    if (!sources.some((s) => s.type === "local_path" && s.hostId !== ctx.host.id)) {
      return { status: "unavailable" as const, message: "No other machine holds this project's source" };
    }
    return { status: "available" as const };
  }

  return {
    id: WORKER_PROVIDER_ID,
    displayName: "On a worker",
    description: "Run the agent on this machine against the project's files on another machine",
    icon: "ComputerCloud",
    inputs: workerInputsSchema,
    availability,
    validate,
    create,
    remove,
  };
}

export function noteProviderStart(
  store: BindingStore,
  context: Pick<MessageDispatchHookContext, "thread" | "environmentIntent" | "requestedExecution" | "attempt">,
): MessageDispatchHookDecision | null {
  const intent = context.environmentIntent;
  if (intent?.kind !== "provider" || intent.environmentProviderId !== WORKER_PROVIDER_ID) return null;
  if (context.thread.status !== "pending" || context.attempt !== "start-turn") return null;
  const { providerId, model } = context.requestedExecution;
  const profile = profileForProvider(providerId);
  if (profile === undefined) {
    return { action: "reject", message: `account-workers: provider ${providerId} has no worker profile` };
  }
  store.recordStart(context.thread.id, model);
  return null;
}
