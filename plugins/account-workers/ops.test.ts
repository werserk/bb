import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffOp,
  editOp,
  execOp,
  globOp,
  grepOp,
  guarded,
  readOp,
  resolveRoot,
  runningGroups,
  sha256,
  writeOp,
} from "./ops.js";

let base: string;
let root: string;
const never = new AbortController().signal;

beforeEach(async () => {
  base = await realpath(await mkdtemp(path.join(tmpdir(), "aw-ops-")));
  root = path.join(base, "root");
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(base, "outside"));
  await writeFile(path.join(root, "src", "a.py"), "def f():\n    return 1\n");
  await writeFile(path.join(base, "outside", "secret.py"), "SECRET = 1\n");
});
afterEach(() => rm(base, { recursive: true, force: true }));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("file operations", () => {
  it("reads numbered lines with the file's sha256", async () => {
    const result = await readOp({ root, path: "src/a.py" });
    expect(result.text).toBe("     1\tdef f():\n     2\t    return 1");
    expect(result.sha256).toBe(sha256("def f():\n    return 1\n"));
    expect(result.totalLines).toBe(2);
  });

  it("writes with an expected sha and refuses a stale one", async () => {
    const { sha256: before } = await readOp({ root, path: "src/a.py" });
    const written = await writeOp({ root, path: "src/a.py", content: "x = 2\n", expectedSha256: before });
    expect(written.created).toBe(false);
    expect(written.diff).toBe("--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,1 @@\n-def f():\n-    return 1\n+x = 2");
    await expect(
      guarded(() => writeOp({ root, path: "src/a.py", content: "y", expectedSha256: before })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("file changed") });
    expect(await readFile(path.join(root, "src/a.py"), "utf8")).toBe("x = 2\n");
  });

  it("creates parent directories for a new file inside the root", async () => {
    await expect(writeOp({ root, path: "pkg/new/b.txt", content: "b" })).resolves.toMatchObject({
      created: true,
      diff: "--- /dev/null\n+++ b/pkg/new/b.txt\n@@ -0,0 +1,1 @@\n+b",
    });
  });

  it("edits a unique match and refuses missing or ambiguous ones", async () => {
    await expect(
      editOp({ root, path: "src/a.py", oldString: "return 1", newString: "return 2", replaceAll: false }),
    ).resolves.toMatchObject({
      replacements: 1,
      diff: "--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,2 @@\n def f():\n-    return 1\n+    return 2",
    });
    await writeFile(path.join(root, "dup.txt"), "a a");
    await expect(
      guarded(() => editOp({ root, path: "dup.txt", oldString: "a", newString: "b", replaceAll: false })),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining("2 times") });
    await expect(
      guarded(() => editOp({ root, path: "dup.txt", oldString: "zzz", newString: "b", replaceAll: false })),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      editOp({ root, path: "dup.txt", oldString: "a", newString: "b", replaceAll: true }),
    ).resolves.toMatchObject({ replacements: 2 });
  });

  it("turns escapes and missing files into refusals, not throws", async () => {
    await expect(guarded(() => readOp({ root, path: "../outside/secret.py" }))).resolves.toMatchObject({ ok: false });
    await expect(guarded(() => readOp({ root, path: path.join(base, "outside/secret.py") }))).resolves.toMatchObject({ ok: false });
    await expect(guarded(() => readOp({ root, path: "nope.txt" }))).resolves.toEqual({ ok: false, error: "no such file or directory" });
    await expect(guarded(() => writeOp({ root, path: "../outside/x", content: "x" }))).resolves.toMatchObject({ ok: false });
    expect(existsSync(path.join(base, "outside/x"))).toBe(false);
  });

  it("refuses binary files", async () => {
    await writeFile(path.join(root, "bin"), Buffer.from([1, 0, 2]));
    await expect(guarded(() => readOp({ root, path: "bin" }))).resolves.toMatchObject({ ok: false, error: expect.stringContaining("binary") });
  });
});

describe("search", () => {
  it("globs inside the root and drops matches reached through an escaping symlink", async () => {
    await symlink(path.join(base, "outside"), path.join(root, "out"));
    const { files } = await globOp({ root, pattern: "**/*.py" });
    expect(files).toEqual(["src/a.py"]);
    expect((await globOp({ root, pattern: "**" })).files).not.toContain(".");
  });

  it("greps without a shell, so the pattern cannot run commands", async () => {
    const marker = path.join(base, "pwned");
    const result = await grepOp({ root, pattern: `$(touch ${marker})`, ignoreCase: false }, never);
    expect(result.output).toBe("(no matches)");
    expect(existsSync(marker)).toBe(false);
    const hit = await grepOp({ root, pattern: "return", ignoreCase: false }, never);
    expect(hit.output).toContain("src/a.py:2:");
    expect(hit.output).not.toContain("secret");
  });

  it("diffs a git workspace", async () => {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
    await writeFile(path.join(root, "src/a.py"), "def f():\n    return 2\n");
    const { output } = await diffOp({ root }, never);
    expect(output).toContain(" M src/a.py");
    expect(output).toContain("+    return 2");
  });
});

describe("exec", () => {
  it("runs in the root on this host and reports the exit code", async () => {
    const result = await execOp({ root, command: "pwd; echo err >&2; exit 3", timeoutMs: 10_000 }, never);
    expect(result.output).toContain(root);
    expect(result.output).toContain("err");
    expect(result.exitCode).toBe(3);
    expect(result.hostname).toBe(hostname());
  });

  it("kills the whole process group on abort and settles even if a grandchild holds stdout", async () => {
    const pidFile = path.join(base, "pids");
    const controller = new AbortController();
    const started = Date.now();
    const running = execOp(
      { root, command: `sleep 300 & echo $! > ${pidFile}; trap '' TERM; sleep 300`, timeoutMs: 60_000 },
      controller.signal,
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const grandchild = Number((await readFile(pidFile, "utf8")).trim());
    expect(alive(grandchild)).toBe(true);
    controller.abort();
    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(grandchild)).toBe(false);
    expect(runningGroups.size).toBe(0);
  });

  it("times out and kills the group", async () => {
    const result = await execOp({ root, command: "sleep 30", timeoutMs: 300 }, never);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
  });

  it("refuses a cwd outside the root", async () => {
    await expect(
      guarded(() => execOp({ root, command: "true", cwd: "../outside", timeoutMs: 1000 }, never)),
    ).resolves.toMatchObject({ ok: false });
  });
});

describe("resolveRoot", () => {
  it("returns the real root and the instruction files, deduplicated and capped", async () => {
    await writeFile(path.join(root, "AGENTS.md"), "x".repeat(20_000));
    await symlink("AGENTS.md", path.join(root, "CLAUDE.md"));
    const link = path.join(base, "link");
    await symlink(root, link);
    const result = await resolveRoot({ path: link });
    expect(result.root).toBe(root);
    expect(result.instructions).toEqual([{ file: "AGENTS.md", text: "x".repeat(12_000), truncated: true }]);
  });

  it("skips an instruction file that points outside the root", async () => {
    await symlink(path.join(base, "outside/secret.py"), path.join(root, "CLAUDE.md"));
    expect((await resolveRoot({ path: root })).instructions).toEqual([]);
  });
});
