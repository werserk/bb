import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMigratedConnection } from "@bb/db/testing";
import type { Logger } from "@bb/logger";
import { createAiServiceRegistry } from "../../../src/services/ai/ai-service-registry.js";
import {
  createPluginService,
  type PluginService,
} from "../../../src/services/plugins/plugin-service.js";
import {
  getThreadAttentionPolicy,
  resetThreadAttentionPolicies,
} from "../../../src/services/threads/thread-attention-policy.js";
import { createNoopTelemetryService } from "../../../src/services/system/telemetry.js";
import { testLogger } from "../../helpers/test-app.js";

interface DiscardControl {
  generation: number;
  mode: "success" | "throw" | "timeout";
  events: string[];
  factoryGate: Promise<void>;
  cleanupGate: Promise<void>;
  hangCleanup: boolean;
  lateDone: boolean;
  lateErrors: string[];
  candidateDb: { open: boolean } | null;
  openIngress: boolean;
}

declare global {
  var __candidateDiscard: DiscardControl | undefined;
}

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const fixture = `
export default async function(bb: any) {
  const c = globalThis.__candidateDiscard;
  const generation = ++c.generation;
  bb.cli.register({ name: "discard", summary: "Fixture", run() { return { exitCode: 0, stdout: String(generation) }; } });
  bb.experimental_threads.setAttentionPolicy("retained-thread", generation === 1 ? { backgroundTurns: "silent" } : null);
  bb.experimental_threads.setAttentionPolicy("candidate-thread", { backgroundTurns: "silent" });
  if (generation === 1) {
    bb.onDispose(() => c.events.push("previous disposed"));
    return;
  }
  if (c.openIngress) await bb.server.internal_DO_NOT_USE_openTunnelIngress({ audience: "fixture" });
  c.candidateDb = bb.storage.database();
  bb.onDispose(() => { c.events.push("first:" + c.candidateDb.open); });
  bb.onDispose(() => { c.events.push("reject"); throw new Error("cleanup failure"); });
  bb.onDispose(async () => {
    c.events.push("last");
    if (c.hangCleanup) await c.cleanupGate;
    c.events.push("last settled");
  });
  if (c.mode === "throw") throw new Error("factory failure");
  if (c.mode === "timeout") {
    await c.factoryGate;
    const attempts = [
      () => bb.onDispose(() => c.events.push("late hook")),
      () => bb.storage.database(),
      () => bb.background.service({ name: "late", start() {} }),
      () => bb.experimental_threads.setAttentionPolicy("late-thread", { backgroundTurns: "silent" }),
    ];
    for (const attempt of attempts) {
      try { attempt(); } catch (error) { c.lateErrors.push(error.name); }
    }
    c.lateDone = true;
  }
}
`;

describe("discarded plugin candidates", () => {
  let dir: string;
  let service: PluginService;
  let db: ReturnType<typeof createMigratedConnection>;
  let c: DiscardControl;
  let factory: ReturnType<typeof gate>;
  let cleanup: ReturnType<typeof gate>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bb-candidate-discard-"));
    factory = gate();
    cleanup = gate();
    c = {
      generation: 0,
      mode: "success",
      events: [],
      factoryGate: factory.promise,
      cleanupGate: cleanup.promise,
      hangCleanup: false,
      lateDone: false,
      lateErrors: [],
      candidateDb: null,
      openIngress: false,
    };
    globalThis.__candidateDiscard = c;
    const root = join(dir, "fixture");
    await mkdir(root);
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-discard",
        version: "0.1.0",
        bb: {
          name: "Discard fixture",
          description: "Candidate cleanup",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(join(root, "server.ts"), fixture);
    db = createMigratedConnection();
    service = createPluginService({
      openTunnelIngress: async () => ({
        baseUrl: "https://fixture.invalid",
        close: async () => {
          c.events.push("ingress closing");
          await cleanup.promise;
          c.events.push("ingress closed");
        },
      }),
      aiServices: createAiServiceRegistry(),
      telemetry: createNoopTelemetryService(),
      db,
      hub: {
        getDaemonSessionIdForHost: () => null,
        notifyPluginChanged: () => {},
        onWatchedTargets: () => () => {},
        notifyPluginSignal: () => 0,
        notifySystem: () => {},
      },
      logger: testLogger as unknown as Logger,
      dataDir: join(dir, "data"),
      appVersion: "0.9.0",
      loadTimeoutMs: 50,
      serviceStopTimeoutMs: 200,
    });
    expect(await service.installPath(root)).toMatchObject({
      status: "running",
    });
  });

  afterEach(async () => {
    factory.resolve();
    cleanup.resolve();
    await service.stop();
    db.$client.close();
    resetThreadAttentionPolicies();
    globalThis.__candidateDiscard = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  async function expectPreviousRetained() {
    expect(await service.runCliCommand("discard", [], {})).toMatchObject({
      exitCode: 0,
      stdout: "1",
    });
    expect(c.events).not.toContain("previous disposed");
    expect(getThreadAttentionPolicy("retained-thread")).toEqual({
      backgroundTurns: "silent",
    });
    expect(service.list().find((p) => p.id === "discard")).toMatchObject({
      status: "running",
      statusDetail: expect.stringContaining("reload failed:"),
    });
  }

  it("runs every registered hook in reverse invocation order after factory rejection and closes its database", async () => {
    c.mode = "throw";
    await service.reload("discard");
    expect(c.events).toEqual(["last", "last settled", "reject", "first:true"]);
    expect(c.candidateDb?.open).toBe(false);
    await expectPreviousRetained();
  });

  it("invalidates before cleanup waits and rejects late factory registrations after timeout", async () => {
    c.mode = "timeout";
    c.hangCleanup = true;
    const reload = service.reload("discard");
    await expect.poll(() => c.events).toContain("last");
    factory.resolve();
    await expect.poll(() => c.lateDone).toBe(true);
    expect(c.lateErrors).toEqual(Array(4).fill("PluginContextStaleError"));
    expect(c.events).not.toContain("late hook");
    await reload;
    expect(c.candidateDb?.open).toBe(false);
    expect(getThreadAttentionPolicy("late-thread")).toBeNull();
    await expectPreviousRetained();
    cleanup.resolve();
    await expect.poll(() => c.events).toContain("last settled");
  });

  it("bounds a hung cleanup without skipping other hooks or waiting for the factory to finish", async () => {
    c.mode = "timeout";
    c.hangCleanup = true;
    await service.reload("discard");
    expect(c.lateDone).toBe(false);
    expect(c.events).toEqual(["last", "reject", "first:true"]);
    expect(c.candidateDb?.open).toBe(false);
    await expectPreviousRetained();
    factory.resolve();
    await expect.poll(() => c.lateDone).toBe(true);
    expect(c.lateErrors).toHaveLength(4);
  });

  it("awaits the same ingress close started by invalidation", async () => {
    c.mode = "throw";
    c.openIngress = true;
    let finished = false;
    const reload = service.reload("discard").then(() => {
      finished = true;
    });
    await expect.poll(() => c.events).toContain("ingress closing");
    expect(finished).toBe(false);
    expect(c.candidateDb?.open).toBe(true);
    cleanup.resolve();
    await reload;
    expect(
      c.events.filter((event) => event === "ingress closing"),
    ).toHaveLength(1);
    expect(c.events).toContain("ingress closed");
    expect(c.candidateDb?.open).toBe(false);
    await expectPreviousRetained();
  });

  it("publishes buffered candidate policies only on successful activation", async () => {
    await service.reload("discard");
    expect(c.events).toContain("previous disposed");
    expect(getThreadAttentionPolicy("retained-thread")).toBeNull();
    expect(getThreadAttentionPolicy("candidate-thread")).toEqual({
      backgroundTurns: "silent",
    });
    expect(await service.runCliCommand("discard", [], {})).toMatchObject({
      stdout: "2",
    });
  });
});
