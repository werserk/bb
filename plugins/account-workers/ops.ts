import type { ChildProcess } from "node:child_process";
import {
  experimental_execHostFileCallback as execFile,
  experimental_spawnHostProcess as spawn,
} from "@get-bb/plugin-sdk/process";
import { createHash } from "node:crypto";
import {
  glob as fsGlob,
  mkdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import type { InstructionFile } from "./contract.js";
import { checkRoot, confine, display, WorkspaceRefusal } from "./confine.js";
import { unifiedHunk } from "./hunk.js";

export const READ_MAX_BYTES = 4 * 1024 * 1024;
export const READ_DEFAULT_LINES = 2000;
export const LINE_MAX_CHARS = 2000;
export const TEXT_MAX_CHARS = 60_000;
export const GLOB_MAX_FILES = 1000;
export const INSTRUCTION_MAX_CHARS = 12_000;
export const KILL_GRACE_MS = 2000;
const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

export type Outcome<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function guarded<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    if (error instanceof WorkspaceRefusal) return { ok: false, error: error.message };
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { ok: false, error: "no such file or directory" };
    if (code === "EISDIR") return { ok: false, error: "is a directory" };
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, error: "permission denied" };
    }
    throw error;
  }
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function clip(text: string, max = TEXT_MAX_CHARS) {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max / 4);
  const tail = max - head;
  return {
    text: `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(-tail)}`,
    truncated: true,
  };
}

async function readText(file: string): Promise<{ text: string; raw: Buffer }> {
  const info = await stat(file);
  if (info.isDirectory()) throw new WorkspaceRefusal("is a directory");
  if (info.size > READ_MAX_BYTES) {
    throw new WorkspaceRefusal(
      `file is ${info.size} bytes; over the ${READ_MAX_BYTES}-byte limit (use workspace_exec with head/sed)`,
    );
  }
  const raw = await readFile(file);
  if (raw.subarray(0, 8192).includes(0)) {
    throw new WorkspaceRefusal("binary file; use workspace_exec to inspect it");
  }
  return { text: raw.toString("utf8"), raw };
}

export async function resolveRoot(input: { path: string }) {
  if (!path.isAbsolute(input.path)) {
    throw new WorkspaceRefusal("workspace path must be absolute");
  }
  const root = await realpath(input.path);
  if (!(await stat(root)).isDirectory()) {
    throw new WorkspaceRefusal(`${input.path} is not a directory`);
  }
  const instructions: InstructionFile[] = [];
  const seen = new Set<string>();
  for (const file of INSTRUCTION_FILES) {
    try {
      const absolute = await confine(root, file);
      const real = await realpath(absolute);
      if (seen.has(real)) continue;
      seen.add(real);
      const { text } = await readText(real);
      instructions.push({
        file,
        text: text.slice(0, INSTRUCTION_MAX_CHARS),
        truncated: text.length > INSTRUCTION_MAX_CHARS,
      });
    } catch {
    }
  }
  return { root, hostname: hostname(), instructions, branch: await readBranch(root) };
}

export async function readBranch(root: string): Promise<string | null> {
  try {
    let gitDir = path.join(root, ".git");
    if ((await stat(gitDir)).isFile()) {
      const pointer = /^gitdir: (.+)$/.exec((await readFile(gitDir, "utf8")).trim());
      if (pointer === null) return null;
      gitDir = path.resolve(root, pointer[1]!);
    }
    const head = /^ref: refs\/heads\/(.+)$/.exec((await readFile(path.join(gitDir, "HEAD"), "utf8")).trim());
    return head === null ? null : head[1]!;
  } catch {
    return null;
  }
}

export async function readOp(input: {
  root: string;
  path: string;
  offset?: number;
  limit?: number;
}) {
  const root = await checkRoot(input.root);
  const file = await confine(root, input.path);
  const { text, raw } = await readText(file);
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const offset = input.offset ?? 1;
  const limit = input.limit ?? READ_DEFAULT_LINES;
  const numbered = lines
    .slice(offset - 1, offset - 1 + limit)
    .map((line, index) => {
      const cut =
        line.length > LINE_MAX_CHARS ? `${line.slice(0, LINE_MAX_CHARS)}…` : line;
      return `${String(offset + index).padStart(6)}\t${cut}`;
    })
    .join("\n");
  const clipped = clip(numbered);
  return {
    text: clipped.text,
    sha256: sha256(raw),
    totalLines: lines.length,
    truncated: clipped.truncated || offset - 1 + limit < lines.length,
  };
}

async function currentContent(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function checkExpected(expected: string | undefined, actual: string | null) {
  if (expected === undefined) return;
  if (actual === null) {
    throw new WorkspaceRefusal("expected_sha256 given but the file does not exist");
  }
  if (actual !== expected) {
    throw new WorkspaceRefusal(
      `file changed: sha256 is ${actual}, expected ${expected}; re-read it first`,
    );
  }
}

export async function writeOp(input: {
  root: string;
  path: string;
  content: string;
  expectedSha256?: string;
}) {
  const root = await checkRoot(input.root);
  const file = await confine(root, input.path);
  const previous = await currentContent(file);
  checkExpected(input.expectedSha256, previous === null ? null : sha256(previous));
  await mkdir(path.dirname(file), { recursive: true });
  const data = Buffer.from(input.content, "utf8");
  await writeFile(file, data);
  const name = path.relative(root, file);
  const diff =
    previous !== null && (previous.length > READ_MAX_BYTES || previous.subarray(0, 8192).includes(0))
      ? "(previous content was binary or over the read limit; no diff)"
      : unifiedHunk(name, previous === null ? null : previous.toString("utf8"), input.content);
  return { sha256: sha256(data), bytes: data.length, created: previous === null, diff };
}

export async function editOp(input: {
  root: string;
  path: string;
  oldString: string;
  newString: string;
  replaceAll: boolean;
  expectedSha256?: string;
}) {
  const root = await checkRoot(input.root);
  const file = await confine(root, input.path);
  const { text, raw } = await readText(file);
  checkExpected(input.expectedSha256, sha256(raw));
  const count = text.split(input.oldString).length - 1;
  if (count === 0) throw new WorkspaceRefusal("old_string not found in the file");
  if (count > 1 && !input.replaceAll) {
    throw new WorkspaceRefusal(
      `old_string matches ${count} times; add context to make it unique or pass replace_all`,
    );
  }
  const next = input.replaceAll
    ? text.split(input.oldString).join(input.newString)
    : text.replace(input.oldString, () => input.newString);
  const data = Buffer.from(next, "utf8");
  await writeFile(file, data);
  return {
    sha256: sha256(data),
    replacements: input.replaceAll ? count : 1,
    diff: unifiedHunk(path.relative(root, file), text, next),
  };
}

const SKIP_DIRS = new Set([".git", "node_modules"]);

export async function globOp(input: { root: string; pattern: string; path?: string }) {
  const root = await checkRoot(input.root);
  const base = await confine(root, input.path ?? ".");
  const files: string[] = [];
  let truncated = false;
  for await (const entry of fsGlob(input.pattern, {
    cwd: base,
    exclude: (name: string) => SKIP_DIRS.has(path.basename(name)),
  })) {
    const absolute = path.resolve(base, entry);
    if (absolute === base) continue;
    try {
      await confine(root, absolute);
    } catch {
      continue;
    }
    if (files.length >= GLOB_MAX_FILES) {
      truncated = true;
      break;
    }
    files.push(display(root, absolute));
  }
  files.sort();
  return { files, truncated };
}

interface Captured {
  stdout: string;
  code: number | null;
  missing: boolean;
}

function capture(
  file: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { cwd, signal, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) return resolve({ stdout, code: 0, missing: false });
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return resolve({ stdout: "", code: null, missing: true });
        if (typeof code === "number") {
          return resolve({ stdout: stdout || stderr, code, missing: false });
        }
        reject(error);
      },
    );
  });
}

export async function grepOp(
  input: { root: string; pattern: string; path?: string; glob?: string; ignoreCase: boolean },
  signal: AbortSignal,
) {
  const root = await checkRoot(input.root);
  const target = display(root, await confine(root, input.path ?? "."));
  const rgArgs = [
    "--line-number",
    "--no-heading",
    "--color=never",
    ...(input.ignoreCase ? ["-i"] : []),
    ...(input.glob ? ["-g", input.glob] : []),
    "-e",
    input.pattern,
    "--",
    target,
  ];
  let result = await capture("rg", rgArgs, root, signal);
  if (result.missing) {
    const grepArgs = [
      "-rn",
      "--exclude-dir=.git",
      "--exclude-dir=node_modules",
      ...(input.ignoreCase ? ["-i"] : []),
      ...(input.glob ? [`--include=${input.glob}`] : []),
      "-e",
      input.pattern,
      "--",
      target,
    ];
    result = await capture("grep", grepArgs, root, signal);
  }
  if (result.missing) throw new WorkspaceRefusal("neither rg nor grep is installed");
  if (result.code === 1) return { output: "(no matches)", truncated: false };
  if (result.code !== 0) throw new WorkspaceRefusal(result.stdout.trim() || "search failed");
  const clipped = clip(result.stdout);
  return { output: clipped.text, truncated: clipped.truncated };
}

export async function diffOp(input: { root: string }, signal: AbortSignal) {
  const root = await checkRoot(input.root);
  const status = await capture(
    "git",
    ["status", "--short", "--untracked-files=all"],
    root,
    signal,
  );
  if (status.missing) throw new WorkspaceRefusal("git is not installed");
  if (status.code !== 0) throw new WorkspaceRefusal(status.stdout.trim() || "not a git repository");
  const diff = await capture("git", ["diff", "HEAD", "--no-color"], root, signal);
  const body = diff.code === 0 ? diff.stdout : "(no HEAD commit yet)";
  const clipped = clip(
    `# git status --short\n${status.stdout || "(clean)\n"}\n# git diff HEAD\n${body || "(no changes)\n"}`,
    100_000,
  );
  return { output: clipped.text, truncated: clipped.truncated };
}

export const runningGroups = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
  }
}

export function killAllGroups(): void {
  for (const pid of runningGroups) killGroup(pid, "SIGKILL");
  runningGroups.clear();
}

export async function execOp(
  input: { root: string; command: string; cwd?: string; timeoutMs: number },
  signal: AbortSignal,
) {
  const root = await checkRoot(input.root);
  const cwd = await confine(root, input.cwd ?? ".");
  const started = Date.now();
  const child: ChildProcess = spawn("bash", ["-c", input.command], {
    cwd,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid;
  let output = "";
  const append = (chunk: Buffer) => {
    output += chunk.toString("utf8");
    if (output.length > TEXT_MAX_CHARS * 4) {
      output = output.slice(0, TEXT_MAX_CHARS) + output.slice(-TEXT_MAX_CHARS * 2);
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  if (pid !== undefined) runningGroups.add(pid);

  let timedOut = false;
  let cancelled = false;
  let killTimer: NodeJS.Timeout | undefined;
  const terminate = () => {
    if (pid === undefined || killTimer !== undefined) return;
    killGroup(pid, "SIGTERM");
    killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };
  const onAbort = () => {
    cancelled = true;
    terminate();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, input.timeoutMs);

  const exit = await new Promise<{ code: number | null; signal: string | null; spawnError?: string }>(
    (resolve) => {
      child.once("error", (error) => resolve({ code: null, signal: null, spawnError: error.message }));
      child.once("exit", (code, sig) => resolve({ code, signal: sig }));
    },
  );
  await new Promise<void>((resolve) => {
    const drain = setTimeout(resolve, 200);
    child.once("close", () => {
      clearTimeout(drain);
      resolve();
    });
  });
  clearTimeout(timer);
  signal.removeEventListener("abort", onAbort);
  child.stdout?.destroy();
  child.stderr?.destroy();
  if (pid !== undefined) {
    if (cancelled || timedOut) {
      killGroup(pid, "SIGKILL");
      if (killTimer !== undefined) clearTimeout(killTimer);
    }
    runningGroups.delete(pid);
  }
  if (exit.spawnError !== undefined) throw new WorkspaceRefusal(`could not start bash: ${exit.spawnError}`);
  const clipped = clip(output);
  return {
    output: clipped.text,
    truncated: clipped.truncated,
    exitCode: exit.code,
    signal: exit.signal,
    timedOut,
    cancelled,
    hostname: hostname(),
    durationMs: Date.now() - started,
  };
}
