// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExperimentalRunOnChoices,
  ExperimentalRunOnWorkspace,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { resetAllCrashedPluginSlotsForTest } from "@/components/plugin/PluginSlotMount";
import type { PluginRunOnProviderSlot } from "@/lib/plugin-slots";
import {
  RUN_ON_PLUGIN_CRASHED,
  useRunOnChoices,
  useRunOnThreadWorkspace,
  type RunOnChoicesByProvider,
  type RunOnThreadWorkspaceState,
} from "./probes";

const WORKER = "account-workers-worker";

let release: (() => void) | null = null;

function useStatefulChoices({
  projectId,
}: {
  projectId: string;
}): ExperimentalRunOnChoices {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    release = () => setReady(true);
  }, []);
  return ready
    ? {
        status: "ready",
        choices: [
          {
            id: `${projectId}-b-a`,
            agentHostId: "h-b",
            inputs: { root: "repo" },
            workspace: { hostId: "h-a" },
          },
        ],
      }
    : { status: "loading", choices: [] };
}

function useCrashingChoices(): ExperimentalRunOnChoices {
  throw new Error("plugin bug");
}

function useWorkspace({
  inputs,
}: {
  threadId: string;
  inputs: JsonValue | null;
}): ExperimentalRunOnWorkspace | null {
  const [workspace] = useState<ExperimentalRunOnWorkspace>(() => ({
    hostId: "h-a",
    branch: String((inputs as { root?: string } | null)?.root),
  }));
  return workspace;
}

function slot(
  overrides: Partial<PluginRunOnProviderSlot> = {},
): PluginRunOnProviderSlot {
  return {
    pluginId: "account-workers",
    generation: 1,
    version: 1,
    environmentProviderId: WORKER,
    title: "Workers",
    useChoices: useStatefulChoices,
    useThreadWorkspace: useWorkspace,
    ...overrides,
  };
}

function ChoicesHarness({
  slots,
  projectId,
  onChoices,
}: {
  slots: PluginRunOnProviderSlot[];
  projectId: string | null;
  onChoices: (value: RunOnChoicesByProvider) => void;
}) {
  const { probes, choicesByProvider } = useRunOnChoices(
    slots.map((entry) => ({
      slot: entry,
      provider: {} as never,
    })),
    projectId,
  );
  onChoices(choicesByProvider);
  return <>{probes}</>;
}

describe("Run on probes", () => {
  beforeEach(() => {
    resetAllCrashedPluginSlotsForTest();
    release = null;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("reports a stateful plugin hook's choices as they change", () => {
    let latest: RunOnChoicesByProvider = new Map();
    render(
      <ChoicesHarness
        slots={[slot()]}
        projectId="p1"
        onChoices={(value) => (latest = value)}
      />,
    );
    expect(latest.get(WORKER)?.status).toBe("loading");
    act(() => release?.());
    expect(latest.get(WORKER)).toEqual({
      status: "ready",
      choices: [
        {
          id: "p1-b-a",
          agentHostId: "h-b",
          inputs: { root: "repo" },
          workspace: { hostId: "h-a" },
        },
      ],
    });
  });

  it("reports an error when the plugin hook throws, and keeps other providers", () => {
    let latest: RunOnChoicesByProvider = new Map();
    render(
      <ChoicesHarness
        slots={[
          slot({
            pluginId: "broken",
            environmentProviderId: "broken-worker",
            useChoices: useCrashingChoices,
          }),
          slot(),
        ]}
        projectId="p1"
        onChoices={(value) => (latest = value)}
      />,
    );
    expect(latest.get("broken-worker")).toEqual({
      status: "error",
      choices: [],
      error: RUN_ON_PLUGIN_CRASHED,
    });
    expect(latest.get(WORKER)?.status).toBe("loading");
  });

  it("mounts nothing without a project", () => {
    let latest: RunOnChoicesByProvider | null = null;
    const view = render(
      <ChoicesHarness
        slots={[slot()]}
        projectId={null}
        onChoices={(value) => (latest = value)}
      />,
    );
    expect(latest).toEqual(new Map());
    expect(release).toBeNull();
    view.unmount();
  });

  it("reads an open thread's workspace from the thread's inputs", () => {
    let state: RunOnThreadWorkspaceState = { status: "loading" };
    function Harness() {
      const result = useRunOnThreadWorkspace(slot(), "t1", { root: "feature" });
      useEffect(() => {
        state = result.state;
      });
      return <>{result.probe}</>;
    }
    render(<Harness />);
    expect(state).toEqual({
      status: "ready",
      workspace: { hostId: "h-a", branch: "feature" },
    });
  });
});
