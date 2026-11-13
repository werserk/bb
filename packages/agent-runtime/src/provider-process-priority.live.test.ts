import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, expect, it, onTestFinished } from "vitest";
import { spawnManagedProcess, hostToolchain } from "@bb/process-utils";
import { prepareProviderProcessPriority } from "./provider-process-priority.js";

const script = `
const fs = require('node:fs');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});
const stat = fs.readFileSync('/proc/self/stat', 'utf8');
console.log(JSON.stringify({pid:process.pid, group:Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[2]), grandchild:grandchild.pid, argv:process.argv.slice(1), cwd:process.cwd(), value:process.env.BB_PRIORITY_FIXTURE, nice:os.getPriority(), io:execFileSync('ionice', ['-p', String(process.pid)], {encoding:'utf8'}).trim(), cgroup:fs.readFileSync('/proc/self/cgroup', 'utf8')}));
process.stdin.on('data', data => process.stdout.write(data));
process.stdin.on('end', () => {grandchild.once('exit', () => process.exit(23)); grandchild.kill();});
`;

async function running(pid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return !/^State:\s+[ZX]/m.test(status);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    throw error;
  }
}

async function fixture(fallback: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "bb-provider-priority-"));
  onTestFinished(() => rm(cwd, { recursive: true, force: true }));
  const env = {
    ...process.env,
    BB_PRIORITY_FIXTURE: "literal $HOME; spaced value",
  };
  const request = {
    command: process.execPath,
    args: ["-e", script, "--", "$HOME", "a;b", "", "space value"],
    env,
    cwd,
  };
  const launch = fallback
    ? await prepareProviderProcessPriority(request, {
        platform: "linux",
        resolve: (name) =>
          name === "systemd-run" ? null : hostToolchain.resolve(name, request),
        run: async () => {
          throw new Error("unexpected manager probe");
        },
      })
    : await prepareProviderProcessPriority(request);
  const managed = spawnManagedProcess(launch);
  onTestFinished(async () => {
    await managed.stop();
  });
  const lines = createInterface({ input: managed.child.stdout });
  onTestFinished(() => lines.close());
  const [first] = await once(lines, "line");
  const info: {
    pid: number;
    group: number;
    grandchild: number;
    argv: string[];
    cwd: string;
    value: string;
    nice: number;
    io: string;
    cgroup: string;
  } = JSON.parse(first);
  return { managed, info, lines, launch, cwd };
}

describe.runIf(process.platform === "linux")(
  "provider priority process contract",
  () => {
    it.each([false, true])(
      "preserves pipes, literal argv, cwd, env, pid/group, EOF and exit status (fallback=%s)",
      async (fallback) => {
        const { managed, info, lines, launch, cwd } = await fixture(fallback);
        expect(info.pid).toBe(managed.child.pid);
        expect(info.group).toBe(info.pid);
        expect(info.argv).toEqual(["$HOME", "a;b", "", "space value"]);
        expect(info.cwd).toBe(cwd);
        expect(info.value).toBe("literal $HOME; spaced value");
        expect(info.nice).toBe(19);
        expect(info.io).toBe("idle");
        if (launch.command.endsWith("/systemd-run")) {
          const group = info.cgroup
            .trim()
            .split("\n")
            .find((line) => line.startsWith("0::"))!
            .slice(3);
          expect(group).toContain("/app-bbchecks.slice/");
          expect(group).not.toContain("/bb.service/");
          const scope = `/sys/fs/cgroup${group}`;
          expect((await readFile(`${scope}/cpu.weight`, "utf8")).trim()).toBe(
            "1",
          );
          expect(
            (await readFile(`${scope}/../cpu.weight`, "utf8")).trim(),
          ).toBe("1");
          expect(
            (await readFile(`${scope}/cpu.max`, "utf8")).startsWith("max "),
          ).toBe(true);
          expect(
            (await readFile(`${scope}/../cpu.max`, "utf8")).startsWith("max "),
          ).toBe(true);
        }
        const echo = once(lines, "line");
        managed.child.stdin.write("stdio preserved\n");
        expect((await echo)[0]).toBe("stdio preserved");
        const closed = once(managed.child, "close");
        managed.child.stdin.end();
        expect(await closed).toEqual([23, null]);
        await expect.poll(() => running(info.grandchild)).toBe(false);
      },
    );

    it.each([false, true])(
      "cancels the bridge and its command descendants (fallback=%s)",
      async (fallback) => {
        const { managed, info } = await fixture(fallback);
        expect(await running(info.grandchild)).toBe(true);
        expect((await managed.stop()).treeTermination).toBe("confirmed");
        await expect.poll(() => running(info.pid)).toBe(false);
        await expect.poll(() => running(info.grandchild)).toBe(false);
      },
    );
  },
);
