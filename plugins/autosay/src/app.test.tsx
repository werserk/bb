// @vitest-environment jsdom
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  loadPluginApp,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import { rpcContract } from "./contracts.js";

installTestPluginRuntime();
const { useComposer } = await import("@get-bb/plugin-sdk/app");
const { default: plugin } = await import("../app.js");
const app = await loadPluginApp(plugin);
const Controller = app.composerCustomizations[0]!.banners![0]!.component;
afterEach(cleanup);

describe("mounted Autosay lifecycle", () => {
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

  it("cancels a pending result when typing and never inserts the late text", async () => {
    let composer: PluginComposerApi | null = null;
    let finish!: (value: { kind: "suggestion"; text: string }) => void;
    const result = new Promise<{ kind: "suggestion"; text: string }>(
      (resolve) => {
        finish = resolve;
      },
    );
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
        rpc: { suggest: () => result, cancel: () => true, observe: () => true },
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
      expect(slot.rpcCalls.some((call) => call.method === "suggest")).toBe(
        true,
      ),
    );
    await slot.behavior.setComposerText("My own message");
    await waitFor(() =>
      expect(slot.rpcCalls.some((call) => call.method === "cancel")).toBe(true),
    );
    await act(async () =>
      finish({ kind: "suggestion", text: "Late suggestion" }),
    );
    expect(
      composer!.experimental_suggestions.getSnapshot().candidate,
    ).toBeNull();
    expect(slot.composer.text).toBe("My own message");
    expect(slot.composer.submits).toEqual([]);
    slot.unmount();
  });
});
