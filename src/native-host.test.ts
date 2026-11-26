import { expect, it } from "vitest";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeLockProbe } from "./native-host.js";
const execute = promisify(execFile);
it("recognizes live kernel holder, rejects stale receipt and retains the same lock inode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "native-lock-"));
  const child = spawn(
    "/usr/bin/python3",
    [
      "worker/native-launcher.py",
      dir,
      "/usr/bin/python3",
      "-u",
      "-c",
      "import sys; print('ready'); sys.stdin.read()",
    ],
    {
      env: { PATH: "/usr/bin", BB_THREAD_ID: "native-owned" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const exit = new Promise((resolve) => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("error", reject);
      child.once("exit", () =>
        reject(new Error("fixture exited before ready")),
      );
    });
    const probe = async () =>
      JSON.parse(
        (
          await execute("/usr/bin/python3", [
            "-c",
            nativeLockProbe,
            path.join(dir, "native.lock"),
          ])
        ).stdout,
      );
    expect(await probe()).toEqual({ lock: "held", threadId: "native-owned" });
    const receipt = JSON.parse(
      await readFile(path.join(dir, "native-holder.json"), "utf8"),
    );
    await writeFile(
      path.join(dir, "native-holder.json"),
      JSON.stringify({ ...receipt, start: "stale" }),
    );
    expect(await probe()).toEqual({ lock: "held", threadId: null });
    const contender = await execute("/usr/bin/python3", [
      "worker/native-launcher.py",
      dir,
      "/usr/bin/true",
    ]).then(
      () => 0,
      (error: { code: number }) => error.code,
    );
    expect(contender).toBe(75);
    child.stdin.end();
    await exit;
    expect(await probe()).toEqual({ lock: "free", threadId: null });
  } finally {
    child.kill();
    await exit;
    await rm(dir, { recursive: true, force: true });
  }
});
