import type {
  ExperimentalHostClient,
  PluginAgentToolResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Binding } from "./bindings.js";
import type { accountWorkersHostContract } from "./contract.js";

export type HostClient = ExperimentalHostClient<typeof accountWorkersHostContract>;
type Contract = typeof accountWorkersHostContract;
type Method = keyof Contract & string;

export const EXEC_DEFAULT_TIMEOUT_MS = 120_000;
export const EXEC_MAX_TIMEOUT_MS = 600_000;
const CALL_TIMEOUT_MS = 60_000;
const EXEC_CALL_MARGIN_MS = 15_000;
const MUTATING = new Set<Method>(["write", "edit", "exec"]);

function refused(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function ok(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }] };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function transportFailure(method: Method, error: unknown, aborted: boolean): string {
  const cause = aborted ? "the call was stopped" : `the workspace host call failed (${errorText(error)})`;
  if (!MUTATING.has(method)) return `Workspace ${method}: ${cause}. Nothing was changed by this call.`;
  const running =
    method === "exec"
      ? " The command may still be running on the workspace until its exec timeout."
      : "";
  return `Workspace ${method}: ${cause}. Outcome unknown: the workspace may or may not have applied it.${running} Re-read the affected files before retrying.`;
}

function definedOnly<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const NO_BINDING =
  "No workspace is bound to this thread. Start the thread with `bb account-workers spawn`, or bind it with `bb account-workers rebind`.";

export const SAME_HOST =
  "The workspace machine is the worker machine. account-workers keeps the worker and the workspace on different machines; bind a workspace on another machine.";

export interface ToolDeps {
  host: HostClient;
  bindingFor(threadId: string): Binding | null;
}

export async function callWorkspace<M extends Method>(
  deps: ToolDeps,
  threadId: string,
  method: M,
  input: Omit<z.input<Contract[M]["input"]>, "root">,
  signal: AbortSignal,
  format: (result: Extract<z.output<Contract[M]["output"]>, { ok: true }>, binding: Binding) => string,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<PluginAgentToolResult> {
  const binding = deps.bindingFor(threadId);
  if (binding === null) return refused(NO_BINDING);
  if (binding.workspaceHostId === binding.workerHostId) return refused(SAME_HOST);
  let result: z.output<Contract[M]["output"]>;
  try {
    result = (await deps.host.call(
      method,
      definedOnly({ ...input, root: binding.root }) as z.input<Contract[M]["input"]>,
      { hostId: binding.workspaceHostId, signal, timeoutMs },
    )) as z.output<Contract[M]["output"]>;
  } catch (error) {
    return refused(transportFailure(method, error, signal.aborted));
  }
  if (!result.ok) return refused(`Workspace ${method} refused: ${result.error}`);
  return ok(
    format(result as Extract<z.output<Contract[M]["output"]>, { ok: true }>, binding),
  );
}

type ExecOk = Extract<z.output<Contract["exec"]["output"]>, { ok: true }>;

export function formatExec(result: ExecOk): string {
  const status = result.cancelled
    ? "cancelled (process group killed)"
    : result.timedOut
      ? "timed out (process group killed)"
      : result.signal !== null
        ? `signal ${result.signal}`
        : `exit ${result.exitCode}`;
  const body = result.output.length > 0 ? result.output.replace(/\n$/, "") : "(no output)";
  return `${body}\n[host ${result.hostname}] ${status} in ${result.durationMs} ms${result.truncated ? " (output truncated)" : ""}`;
}

export function execTimeout(requested: number | undefined): number {
  return Math.min(requested ?? EXEC_DEFAULT_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS);
}

export function execCallTimeout(timeoutMs: number): number {
  return timeoutMs + EXEC_CALL_MARGIN_MS;
}

const relPath = z.string().min(1).describe("Path relative to the workspace root (an absolute path inside the root also works)");

export const toolParameters = {
  workspace_read: z.object({
    path: relPath,
    offset: z.number().int().min(1).optional().describe("First line to read, 1-based"),
    limit: z.number().int().min(1).optional().describe("Number of lines (default 2000)"),
  }),
  workspace_write: z.object({
    path: relPath,
    content: z.string().describe("Full new file content"),
    expected_sha256: z.string().optional().describe("Refuse unless the current file has this sha256 (from workspace_read)"),
  }),
  workspace_edit: z.object({
    path: relPath,
    old_string: z.string().min(1).describe("Exact text to replace; must be unique unless replace_all"),
    new_string: z.string(),
    replace_all: z.boolean().optional(),
    expected_sha256: z.string().optional(),
  }),
  workspace_glob: z.object({
    pattern: z.string().min(1).describe("Glob such as **/*.py"),
    path: relPath.optional(),
  }),
  workspace_grep: z.object({
    pattern: z.string().min(1).describe("Regular expression (ripgrep syntax)"),
    path: relPath.optional(),
    glob: z.string().optional().describe("Only files matching this glob"),
    ignore_case: z.boolean().optional(),
  }),
  workspace_exec: z.object({
    command: z.string().min(1).describe("Shell command, run with bash -c"),
    cwd: relPath.optional().describe("Working directory relative to the root"),
    timeout_ms: z.number().int().min(1).optional().describe("Default 120000, max 600000"),
  }),
  workspace_diff: z.object({}),
} as const;

export type ToolName = keyof typeof toolParameters;
export const TOOL_NAMES = Object.keys(toolParameters) as ToolName[];

export const toolDescriptions: Record<ToolName, string> = {
  workspace_read: "Read a text file in the bound workspace (on the workspace machine). Returns numbered lines and the file's sha256.",
  workspace_write: "Create or overwrite a file in the bound workspace.",
  workspace_edit: "Replace an exact string in a workspace file.",
  workspace_glob: "List workspace files matching a glob (skips .git and node_modules).",
  workspace_grep: "Search workspace file contents with ripgrep (or grep).",
  workspace_exec: "Run a shell command in the workspace on the workspace machine. Stop kills its process group.",
  workspace_diff: "Show git status and git diff HEAD of the workspace.",
};

type Params<N extends ToolName> = z.output<(typeof toolParameters)[N]>;

export function runTool<N extends ToolName>(
  deps: ToolDeps,
  name: N,
  params: Params<N>,
  threadId: string,
  signal: AbortSignal,
): Promise<PluginAgentToolResult> {
  const p = params as Record<string, unknown>;
  switch (name) {
    case "workspace_read":
      return callWorkspace(
        deps, threadId, "read",
        { path: p.path as string, offset: p.offset as number | undefined, limit: p.limit as number | undefined },
        signal,
        (r) => `${r.text || "(empty file)"}\n[sha256 ${r.sha256}, ${r.totalLines} lines${r.truncated ? ", truncated: use offset/limit" : ""}]`,
      );
    case "workspace_write":
      return callWorkspace(
        deps, threadId, "write",
        { path: p.path as string, content: p.content as string, expectedSha256: p.expected_sha256 as string | undefined },
        signal,
        (r) => `${r.created ? "Created" : "Wrote"} ${p.path as string} (${r.bytes} bytes, sha256 ${r.sha256})\n${r.diff}`,
      );
    case "workspace_edit":
      return callWorkspace(
        deps, threadId, "edit",
        {
          path: p.path as string,
          oldString: p.old_string as string,
          newString: p.new_string as string,
          replaceAll: (p.replace_all as boolean | undefined) ?? false,
          expectedSha256: p.expected_sha256 as string | undefined,
        },
        signal,
        (r) => `Edited ${p.path as string}: ${r.replacements} replacement(s), sha256 ${r.sha256}\n${r.diff}`,
      );
    case "workspace_glob":
      return callWorkspace(
        deps, threadId, "glob",
        { pattern: p.pattern as string, path: p.path as string | undefined },
        signal,
        (r) => (r.files.length === 0 ? "(no matches)" : r.files.join("\n") + (r.truncated ? "\n…(truncated)" : "")),
      );
    case "workspace_grep":
      return callWorkspace(
        deps, threadId, "grep",
        {
          pattern: p.pattern as string,
          path: p.path as string | undefined,
          glob: p.glob as string | undefined,
          ignoreCase: (p.ignore_case as boolean | undefined) ?? false,
        },
        signal,
        (r) => r.output,
      );
    case "workspace_exec": {
      const timeoutMs = execTimeout(p.timeout_ms as number | undefined);
      return callWorkspace(
        deps, threadId, "exec",
        { command: p.command as string, cwd: p.cwd as string | undefined, timeoutMs },
        signal,
        formatExec,
        execCallTimeout(timeoutMs),
      );
    }
    case "workspace_diff":
      return callWorkspace(deps, threadId, "diff", {}, signal, (r) => r.output);
    default:
      return Promise.resolve(refused(`unknown tool ${String(name)}`));
  }
}
