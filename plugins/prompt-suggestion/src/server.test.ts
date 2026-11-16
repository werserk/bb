import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { experimental_AI_MODEL_ID_MAX_LENGTH } from "@get-bb/plugin-sdk";
import { fixture } from "./test-fixtures.js";
import { installGenerator } from "./generator-fixture.js";
import plugin from "../server.js";
import { rpcContract } from "./contracts.js";

describe("public Prompt Suggestion entry points", () => {
  it("defaults off, refuses generation and validates CLI and RPC boundaries", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "prompt-suggestion",
    });
    try {
      await plugin(bb);
      expect(await harness.behavior.callRpc("status")).toMatchObject({
        enabled: false,
        configured: false,
        active: 0,
      });
      expect(
        await harness.behavior.runCli(["suggest", "--thread", "thread"]),
      ).toMatchObject({
        exitCode: 0,
        stdout: JSON.stringify({
          kind: "unavailable",
          reason: "not_configured",
        }),
      });
      expect((await harness.behavior.runCli(["suggest"])).exitCode).not.toBe(0);
      expect(
        (
          await harness.behavior.runCli([
            "suggest",
            "--thread",
            "thread",
            "--request",
            "invalid",
          ])
        ).exitCode,
      ).not.toBe(0);
      await expect(
        harness.behavior.callRpc("suggest", { threadId: "thread" }),
      ).rejects.toThrow();
      expect(harness.inspection.sdk.calls).toHaveLength(0);
      expect(harness.inspection.logEntries).toHaveLength(0);
      expect(harness.inspection.registrations.agentTools).toHaveLength(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("validates native settings and exposes only the selected BB model", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "prompt-suggestion",
    });
    try {
      await plugin(bb);
      await harness.behavior.setSettings({
        enabled: true,
        model: "configured",
      });
      await expect(
        harness.behavior.setSettings({ timeoutMs: -1 }),
      ).rejects.toThrow();
      await expect(
        harness.behavior.setSettings({
          model: "x".repeat(experimental_AI_MODEL_ID_MAX_LENGTH + 1),
        }),
      ).rejects.toThrow();
      const status = await harness.behavior.runCli(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toContain("apiKey");
      expect(JSON.parse(status.stdout)).toMatchObject({
        enabled: true,
        configured: true,
      });
      await harness.behavior.setSettings({ enabled: false });
      expect(await harness.behavior.callRpc("status")).toMatchObject({
        enabled: false,
      });
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});

it("shares RPC and CLI state and preserves admission after cache clearing", async () => {
  const { bb, harness } = fixture();
  let calls = 0;
  const model = await installGenerator(bb, async () => {
    calls++;
    return JSON.stringify({ kind: "none" });
  });
  try {
    await plugin(bb);
    await harness.behavior.setSettings({
      enabled: true,
      model,
      backgroundPreparation: true,
    });
    const args = {
      threadId: "thread",
      clientId: "232df470-1f92-4dc5-b924-19a1fc2c7d38",
    };
    await expect(
      harness.behavior.callRpc("track", { ...args, ignored: true }),
    ).rejects.toThrow();
    await harness.behavior.callRpc("track", args);
    await expect
      .poll(
        async () =>
          (await harness.behavior.runCli(["state", "--thread", "thread"]))
            .stdout,
      )
      .toContain('"phase":"none"');
    expect(
      await harness.behavior.callRpc("inspect", { threadId: "thread" }),
    ).toBeNull();
    await expect.poll(async () => rpcContract.diagnostics.output.parse(await harness.behavior.callRpc("diagnostics"))).toMatchObject({ memory: { errors: 1, active: 0 } });
    expect(await harness.behavior.callRpc("detach", args)).toBe(true);
    expect(
      (await harness.behavior.runCli(["clear-cache", "--thread", "thread"]))
        .exitCode,
    ).toBe(0);
    await harness.behavior.callRpc("track", args);
    expect(calls).toBe(2);
    const diagnostics = rpcContract.diagnostics.output.parse(await harness.behavior.callRpc("diagnostics"));
    expect(diagnostics).toMatchObject({
      admitted: 2,
      tracked: 1,
      memory: { completed: 0, errors: 1, cancelled: 0, active: 0, queued: 0 },
    });
    const cliDiagnostics = await harness.behavior.runCli(["diagnostics"]);
    expect(cliDiagnostics.exitCode).toBe(0);
    expect(JSON.parse(cliDiagnostics.stdout)).toEqual(diagnostics);
    expect(JSON.stringify(diagnostics)).not.toContain("Fixed locally");
    await harness.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thread", archivedAt: 1 }),
    });
    expect(
      await harness.behavior.callRpc("inspect", { threadId: "thread" }),
    ).toBeNull();
    expect(
      await harness.behavior.callRpc("state", { threadId: "thread" }),
    ).toMatchObject({ phase: "unavailable" });
  } finally {
    await harness.lifecycle.dispose();
  }
});
