import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getThreadAttentionPolicy,
  resetThreadAttentionPolicies,
} from "../../../src/services/threads/thread-attention-policy.js";
import {
  type TestAppHarness,
  withTestHarness,
} from "../../helpers/test-app.js";

async function writePlugin(
  dir: string,
  name: string,
  serverSource: string,
): Promise<string> {
  const rootDir = join(dir, name);
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name,
      version: "0.1.0",
      bb: {
        name: "Attention fixture",
        description: "Attention policy fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), serverSource);
  return rootDir;
}

async function withPluginHarness(
  run: (harness: TestAppHarness, workDir: string) => Promise<void>,
): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "bb-plugin-attention-test-"));
  try {
    await withTestHarness((harness) => run(harness, workDir));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

afterEach(() => resetThreadAttentionPolicies());

describe("bb.experimental_threads.setAttentionPolicy (server)", () => {
  it("applies a policy when set and drops it when the plugin is disabled", async () => {
    await withPluginHarness(async (harness, workDir) => {
      const rootDir = await writePlugin(
        workDir,
        "bb-plugin-attention",
        `export default function plugin(bb: any) {
          bb.experimental_threads.setAttentionPolicy("thr_a", { backgroundTurns: "silent" });
          bb.experimental_threads.setAttentionPolicy("thr_b", { backgroundTurns: "silent" });
          bb.experimental_threads.setAttentionPolicy("thr_b", null);
        }`,
      );
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("running");
      expect(getThreadAttentionPolicy("thr_a")).toEqual({
        backgroundTurns: "silent",
      });
      expect(getThreadAttentionPolicy("thr_b")).toBeNull();
      await harness.pluginService.setEnabled("attention", false);
      expect(getThreadAttentionPolicy("thr_a")).toBeNull();
    });
  });

  it("rejects an invalid policy and fails the plugin load", async () => {
    await withPluginHarness(async (harness, workDir) => {
      const rootDir = await writePlugin(
        workDir,
        "bb-plugin-bad-attention",
        `export default function plugin(bb: any) {
          bb.experimental_threads.setAttentionPolicy("thr_a", { backgroundTurns: "loud" });
        }`,
      );
      const entry = await harness.pluginService.installPath(rootDir);
      expect(entry.status).toBe("error");
      expect(entry.statusDetail).toContain("setAttentionPolicy");
      expect(getThreadAttentionPolicy("thr_a")).toBeNull();
    });
  });
});
