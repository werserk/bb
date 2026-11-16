import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server.js";

describe("public Autosay entry points", () => {
  it("defaults off, refuses generation and validates CLI and RPC boundaries", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "autosay" });
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

  it("validates native settings and keeps API keys out of status", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "autosay" });
    try {
      await plugin(bb);
      await harness.behavior.setSettings({
        enabled: true,
        baseUrl: "https://example.com/v1",
        model: "configured",
        apiKey: "fixture-secret",
      });
      await expect(
        harness.behavior.setSettings({ timeoutMs: -1 }),
      ).rejects.toThrow();
      await expect(
        harness.behavior.setSettings({ baseUrl: "http://example.com" }),
      ).rejects.toThrow();
      const status = await harness.behavior.runCli(["status"]);
      expect(status.exitCode).toBe(0);
      expect(status.stdout).not.toContain("fixture-secret");
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
