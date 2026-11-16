// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { emptyTaskState } from "./task-state.js";
import { rpcContract } from "./contracts.js";

installTestPluginRuntime();
const { useComposer } = await import("@get-bb/plugin-sdk/app");
const { default: plugin } = await import("../app.js");
const app = await loadPluginApp(plugin);
const Controller = app.composerCustomizations[0]!.banners![0]!.component;
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("mounted Prompt Suggestion lifecycle", () => {
  it("does not request suggestions while disabled", () => {
    const slot = renderSlot(
      { component: Controller },
      {},
      {
        settings: { enabled: false },
        composer: {
          scope: { kind: "thread", threadId: "thread" },
          experimental_suggestionContext: {
            eligible: true,
            completedTurnId: "turn",
            contextRevision: "r",
          },
        },
      },
    );
    expect(slot.rpcCalls).toEqual([]);
    slot.unmount();
  });

  it("keeps foreground interest while typing and never inserts a late server candidate", async () => {
    let composer: PluginComposerApi | null = null;
    let ready = false;
    const state = () => ({
      phase: ready ? "ready" : "pending",
      jobId: "232df470-1f92-4dc5-b924-19a1fc2c7d38",
      turnId: "turn",
      result: ready
        ? {
            kind: "suggestion",
            text: "Late suggestion",
            state: emptyTaskState(),
          }
        : null,
      queueMs: 0,
      preparationMs: 0,
      modelMs: 0,
      validationMs: 0,
      serverMs: null,
      usage: null,
      actualModel: null,
      actualServiceTier: null,
      finishReason: null,
      outputTokenLimit: null,
    });
    function Probe() {
      composer = useComposer();
      return <Controller />;
    }
    const slot = renderSlot(
      { component: Probe },
      {},
      {
        settings: { enabled: true },
        experimental_rpcContract: rpcContract,
        rpc: { track: state, state, detach: () => true, observe: () => true },
        composer: {
          scope: { kind: "thread", threadId: "thread" },
          experimental_suggestionContext: {
            eligible: true,
            completedTurnId: "turn",
            contextRevision: "r",
          },
        },
      },
    );
    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "track")).toBe(true),
    );
    await slot.behavior.setComposerText("My own message");
    expect(slot.rpcCalls.some((call) => call.method === "detach")).toBe(false);
    ready = true;
    await slot.behavior.experimental_invalidateRpc(["companion:thread"]);
    expect(
      composer!.experimental_suggestions.getSnapshot().candidate,
    ).toBeNull();
    expect(slot.composer.text).toBe("My own message");
    expect(slot.composer.submits).toEqual([]);
    slot.unmount();
  });
});

describe("model selection", () => {
  it("shows an unavailable saved choice without silently switching", async () => {
    const component = app.settingsSections[0]!.component;
    const slot = renderSlot(
      { component },
      {},
      {
        settings: { model: "old-model" },
        experimental_rpcContract: rpcContract,
        rpc: {
          models: () => [],
          selectModel: (input) => input,
          status: () => ({
            enabled: false,
            configured: true,
            model: "old-model",
            reasoningEffort: "default",
            serviceTier: "default",
            active: 0,
            tracked: 0,
            backgroundPreparation: false,
            instructionsAvailable: true,
            instructionRevision: "revision",
          }),
        },
      },
    );
    try {
      await waitFor(() =>
        expect(screen.getByText("Selected model is unavailable")).toBeTruthy(),
      );
      expect(
        slot.rpcCalls.filter((call) => call.method === "selectModel"),
      ).toEqual([]);
    } finally {
      slot.unmount();
    }
  });
});
