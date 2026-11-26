import { randomBytes } from "node:crypto";
import {
  cliCommand,
  defineCli,
  PluginCliError,
  type BbPluginApi,
  type PluginAgentConfiguration,
  type PluginAgentConfigurationContext,
} from "@get-bb/plugin-sdk";
import { BindingStore, canonicalPath, type Binding } from "./bindings.js";
import { accountWorkersHostContract, type InstructionFile } from "./contract.js";
import {
  execCallTimeout,
  execTimeout,
  formatExec,
  runTool,
  TOOL_NAMES,
  toolDescriptions,
  toolParameters,
  SAME_HOST,
  transportFailure,
  type HostClient,
} from "./tools.js";

export function bridgeToolName(name: string): string {
  return `mcp__bb-bridge__${name}`;
}

function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const marker = "`".repeat(longest + 1);
  return `${marker}markdown\n${text}\n${marker}`;
}

export function workspaceInstructions(binding: Binding): string {
  const lines = [
    "## Workspace on another machine (account-workers)",
    `This thread runs on a worker machine. Its workspace is on the machine \`${binding.workspaceHostName}\`, root \`${binding.root}\`.`,
    "Local file and shell tools are disabled in this thread: they would act on the worker, not the workspace.",
    "Use the workspace_* tools for all file and command work. Paths are relative to the workspace root; absolute paths inside the root also work. workspace_exec runs `bash -c` in the root on the workspace machine.",
    "A failed write, edit or exec whose outcome is unknown must be checked (re-read, git status) before retrying.",
  ];
  for (const file of binding.instructions) {
    lines.push(
      "",
      `### Workspace instructions from ${file.file} (read-only, quoted from the workspace${file.truncated ? ", truncated" : ""})`,
      fence(file.text),
    );
  }
  return lines.join("\n");
}

export const MOVED_INSTRUCTIONS =
  "## account-workers\nWorkspace tools are disabled: this thread no longer runs in the scratch directory it was bound to.";

export function configureThread(
  store: BindingStore,
  context: PluginAgentConfigurationContext,
): PluginAgentConfiguration {
  const none: PluginAgentConfiguration = { tools: [], skills: [] };
  let binding = store.byThread(context.thread.id);
  if (binding === null && context.environment.path !== null) {
    binding = store.claim(context.thread.id, context.host.id, context.environment.path);
  }
  if (binding === null) return none;
  const inScratch =
    context.host.id === binding.workerHostId &&
    context.environment.path !== null &&
    canonicalPath(context.environment.path) === binding.scratchPath;
  if (!inScratch) return { ...none, instructions: MOVED_INSTRUCTIONS };
  return { tools: [...TOOL_NAMES], skills: [], instructions: workspaceInstructions(binding) };
}

interface ResolvedWorkspace {
  hostId: string;
  hostName: string;
  root: string;
  instructions: InstructionFile[];
}

export default async function accountWorkersPlugin(bb: BbPluginApi): Promise<void> {
  const store = new BindingStore(bb.storage.database());
  const host: HostClient = bb.hosts.experimental_client({ contract: accountWorkersHostContract });
  const deps = { host, bindingFor: (threadId: string) => store.byThread(threadId) };

  for (const name of TOOL_NAMES) {
    bb.agents.registerTool({
      name,
      description: toolDescriptions[name],
      parameters: toolParameters[name],
      presentation: { label: { pending: `Running ${name}`, completed: `Ran ${name}` } },
      execute: (params, ctx) => runTool(deps, name, params, ctx.threadId, ctx.signal),
    });
  }

  bb.agents.configure((context) => configureThread(store, context));

  bb.events.on("thread.deleted", ({ thread }) => {
    const binding = store.byThread(thread.id);
    if (binding !== null) store.remove(binding.id);
  });

  async function resolveMachine(idOrName: string, signal?: AbortSignal) {
    const hosts = await bb.sdk.hosts.list({ signal });
    const matches = hosts.filter((h) => h.id === idOrName || h.name === idOrName);
    if (matches.length !== 1) {
      throw new PluginCliError(
        matches.length === 0 ? `No machine ${idOrName}` : `Machine name ${idOrName} is ambiguous; use its id`,
        { code: "machine_not_found" },
      );
    }
    const match = matches[0]!;
    if (match.status !== "connected") {
      throw new PluginCliError(`Machine ${match.name} is ${match.status}`, { code: "machine_offline" });
    }
    return match;
  }

  async function resolveWorkspace(
    machine: string,
    path: string,
    workerHostId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedWorkspace> {
    const target = await resolveMachine(machine, signal);
    if (target.id === workerHostId) {
      throw new PluginCliError(SAME_HOST, { code: "same_host" });
    }
    const result = await host.call("resolveRoot", { path }, { hostId: target.id, signal });
    if (!result.ok) throw new PluginCliError(`Workspace path refused: ${result.error}`, { code: "bad_workspace" });
    return { hostId: target.id, hostName: target.name, root: result.root, instructions: result.instructions };
  }

  function bindingOrFail(threadId: string): Binding {
    const binding = store.byThread(threadId);
    if (binding === null) throw new PluginCliError(`Thread ${threadId} has no workspace binding`, { code: "not_bound" });
    return binding;
  }

  const describe = (b: Binding) =>
    `${b.threadId ?? "(unclaimed)"}  ${b.workspaceHostName}:${b.root}  binding ${b.id}`;

  bb.cli.register(
    defineCli({
      name: "account-workers",
      summary: "Run a thread on a worker machine against a workspace on another machine",
      commands: {
        spawn: cliCommand({
          summary: "Start a thread on a worker machine bound to a workspace directory on another machine",
          options: {
            "workspace-machine": { type: "string", required: true, description: "Machine that holds the workspace (id or name)" },
            path: { type: "string", required: true, description: "Absolute workspace directory on that machine" },
            machine: { type: "string", required: true, description: "Worker machine the agent runs on (id or name)" },
            prompt: { type: "string", required: true, stdin: true, description: "First message; --prompt-stdin reads it from stdin" },
            project: { type: "string", description: "Project id (default: the calling thread's project)" },
            provider: { type: "string", description: "Provider id, e.g. claude-code" },
            model: { type: "string", description: "Model id" },
            title: { type: "string", description: "Thread title" },
            "send-at": { type: "integer", min: 0, max: Number.MAX_SAFE_INTEGER, description: "Schedule the first message at this epoch ms instead of now" },
            json: { type: "boolean", description: "Print JSON" },
          },
          async run(input, ctx) {
            const o = input.options as Record<string, string | number | boolean | undefined>;
            const projectId = (o.project as string | undefined) ?? ctx.projectId;
            if (projectId === undefined) throw new PluginCliError("Pass --project", { code: "missing_project" });
            const worker = await resolveMachine(o.machine as string, ctx.signal);
            const workspace = await resolveWorkspace(o["workspace-machine"] as string, o.path as string, worker.id, ctx.signal);
            const bindingId = `aw_${randomBytes(8).toString("hex")}`;
            const scratch = await host.call(
              "prepareScratch",
              { bindingId, allowedTools: TOOL_NAMES.map(bridgeToolName) },
              { hostId: worker.id, signal: ctx.signal },
            );
            if (!scratch.ok) throw new PluginCliError(`Scratch directory failed: ${scratch.error}`);
            store.create({
              id: bindingId,
              workerHostId: worker.id,
              scratchPath: scratch.path,
              workspaceHostId: workspace.hostId,
              workspaceHostName: workspace.hostName,
              root: workspace.root,
              instructions: workspace.instructions,
            });
            let threadId: string;
            try {
              const thread = await bb.sdk.threads.spawn({
                projectId,
                prompt: o.prompt as string,
                ...(o.provider ? { providerId: o.provider as string } : {}),
                ...(o.model ? { model: o.model as string } : {}),
                title: (o.title as string | undefined) ?? `Workspace ${workspace.hostName}:${workspace.root}`,
                ...(o["send-at"] !== undefined ? { sendAt: o["send-at"] as number } : {}),
                environment: {
                  type: "host",
                  hostId: worker.id,
                  workspace: { type: "unmanaged", path: scratch.path },
                },
              });
              threadId = thread.id;
            } catch (error) {
              store.remove(bindingId);
              throw error;
            }
            const binding = store.claimById(bindingId, threadId);
            if (binding?.threadId !== threadId) {
              throw new PluginCliError(`Binding ${bindingId} was claimed by ${binding?.threadId}, not ${threadId}`);
            }
            return {
              exitCode: 0,
              stdout: o.json
                ? JSON.stringify({ threadId, bindingId, workerHostId: worker.id, scratchPath: scratch.path, workspaceHostId: workspace.hostId, root: workspace.root })
                : `Thread ${threadId} on ${worker.name}, workspace ${workspace.hostName}:${workspace.root}\nscratch ${scratch.path}`,
            };
          },
        }),
        rebind: cliCommand({
          summary: "Point a bound thread at another workspace (the next tool call goes there; instructions refresh at the next session)",
          options: {
            thread: { type: "string", required: true, description: "Thread id" },
            "workspace-machine": { type: "string", required: true, description: "Machine id or name" },
            path: { type: "string", required: true, description: "Absolute workspace directory" },
          },
          async run(input, ctx) {
            const o = input.options as Record<string, string>;
            const current = bindingOrFail(o.thread!);
            const w = await resolveWorkspace(o["workspace-machine"]!, o.path!, current.workerHostId, ctx.signal);
            const binding = store.rebind(o.thread!, {
              workspaceHostId: w.hostId,
              workspaceHostName: w.hostName,
              root: w.root,
              instructions: w.instructions,
            });
            return { exitCode: 0, stdout: describe(binding!) };
          },
        }),
        unbind: cliCommand({
          summary: "Remove a thread's workspace binding (its workspace tools then refuse)",
          options: { thread: { type: "string", required: true, description: "Thread id" } },
          run(input) {
            const binding = bindingOrFail(input.options.thread as string);
            store.remove(binding.id);
            return { exitCode: 0, stdout: `Unbound ${binding.threadId}` };
          },
        }),
        list: cliCommand({
          summary: "List workspace bindings",
          options: { json: { type: "boolean", description: "Print JSON" } },
          run(input) {
            const all = store.list();
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify(all.map(({ instructions, ...rest }) => ({ ...rest, instructionFiles: instructions.map((f) => f.file) }))) };
            }
            return { exitCode: 0, stdout: all.length === 0 ? "No bindings" : all.map(describe).join("\n") };
          },
        }),
        exec: cliCommand({
          summary: "Debug: run a command in a thread's workspace through the same path as workspace_exec",
          options: {
            thread: { type: "string", required: true, description: "Thread id" },
            "timeout-ms": { type: "integer", min: 1, max: 600_000, description: "Default 120000, max 600000" },
          },
          passthrough: true,
          async run(input, ctx) {
            const binding = bindingOrFail(input.options.thread as string);
            if (binding.workspaceHostId === binding.workerHostId) return { exitCode: 1, stderr: `refused: ${SAME_HOST}` };
            const command = input.passthrough.join(" ");
            if (command.length === 0) throw new PluginCliError("Pass the command after --");
            const timeoutMs = execTimeout(input.options["timeout-ms"] as number | undefined);
            const signal = ctx.signal ?? new AbortController().signal;
            try {
              const result = await host.call(
                "exec",
                { root: binding.root, command, timeoutMs },
                { hostId: binding.workspaceHostId, signal, timeoutMs: execCallTimeout(timeoutMs) },
              );
              if (!result.ok) return { exitCode: 1, stderr: `refused: ${result.error}` };
              return { exitCode: 0, stdout: formatExec(result) };
            } catch (error) {
              return { exitCode: 1, stderr: transportFailure("exec", error, signal.aborted) };
            }
          },
        }),
      },
    }),
  );
}
