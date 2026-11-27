// @vitest-environment jsdom

import { PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID } from "@bb/client-core";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { ComposerSubmitExtras } from "@get-bb/plugin-sdk/internal/composer-handle";
import type {
  ExperimentalRunOnChoices,
  ExperimentalRunOnWorkspace,
  JsonValue,
} from "@get-bb/plugin-sdk";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeProviderValue } from "@/components/pickers/environment-picker-value";
import { useComposerTypeahead } from "@/components/thread/composer/useComposerTypeahead";
import type { PluginRunOnProviderSlot } from "@/lib/plugin-slots";
import type { RunOnHost } from "./model";
import type { RunOnThreadWorkspaceState } from "./probes";
import type { AcceptedRunOnProvider } from "./registrations";
import { useRunRowSubmission } from "./submission";
import { useRunOnComposer, type RunOnComposer } from "./useRunOnComposer";
import { useRunOnOpenThread } from "./useRunOnOpenThread";

const WORKER = "account-workers-worker";
const CHOICE_INPUTS = { workspaceHostId: "h-a", root: "repo" };

const stubs = vi.hoisted(() => ({
  accepted: null as readonly unknown[] | null,
  choices: new Map<string, unknown>(),
  hosts: [] as unknown[],
  environment: undefined as unknown,
  workspace: { status: "loading" } as unknown,
  rowItemProps: null as {
    setSubmissionFor?: (pluginId: string, data: JsonValue | null) => boolean;
  } | null,
}));

vi.mock("./registrations", () => ({
  useAcceptedRunOnProviders: () => stubs.accepted,
}));
vi.mock("./probes", () => ({
  RUN_ON_PLUGIN_CRASHED: "The plugin stopped responding",
  useRunOnChoices: () => ({ probes: null, choicesByProvider: stubs.choices }),
  useRunOnThreadWorkspace: (slot: unknown) => ({
    probe: null,
    state: slot === null ? { status: "loading" } : stubs.workspace,
  }),
}));
vi.mock("./ComposerRunRowItems", () => ({
  ComposerRunRowItems: (props: typeof stubs.rowItemProps) => {
    stubs.rowItemProps = props;
    return null;
  },
}));
vi.mock("@/hooks/queries/host-queries", () => ({
  useHosts: () => ({ data: stubs.hosts }),
}));
vi.mock("@/hooks/queries/environment-queries", () => ({
  useEnvironment: () => ({ data: stubs.environment }),
}));
vi.mock("@/lib/plugin-frontend-boot-state", () => ({
  usePluginFrontendsSettled: () => true,
}));
vi.mock("@/hooks/usePromptMentions", () => ({
  usePromptMentionTriggers: () => [],
}));

function host(id: string, name: string, connected = true): RunOnHost {
  return {
    id,
    name,
    status: connected ? "connected" : "disconnected",
    lastSeenAt: 1_000,
  } as RunOnHost;
}

function accepted(
  slotOverrides: Partial<PluginRunOnProviderSlot> = {},
): AcceptedRunOnProvider {
  return {
    slot: {
      pluginId: "account-workers",
      generation: 1,
      version: 1,
      environmentProviderId: WORKER,
      title: "On a worker",
      useChoices: () => ({ status: "ready", choices: [] }),
      useThreadWorkspace: () => null,
      ...slotOverrides,
    },
    provider: {
      id: WORKER,
      pluginId: "account-workers",
      machineAvailability: {},
    } as unknown as SystemEnvironmentProvider,
  };
}

function readyChoices(): ExperimentalRunOnChoices {
  return {
    status: "ready",
    choices: [
      {
        id: "b-a",
        agentHostId: "h-b",
        inputs: CHOICE_INPUTS,
        workspace: {
          hostId: "h-a",
          detail: "/srv/repo",
          branch: "main",
        },
      },
    ],
  };
}

const LOCAL_VALUE = encodeProviderValue(
  PROJECT_CHECKOUT_ENVIRONMENT_PROVIDER_ID,
);

function useComposerHarness(projectId: string, initial?: Selection) {
  const [selection, setSelection] = useState<Selection>(
    initial ?? { value: LOCAL_VALUE, hostId: "h-a", inputs: null },
  );
  const changeEnvironment = vi.fn((value: string, hostId: string | null) =>
    setSelection((current) => ({ ...current, value, hostId })),
  );
  const seedProviderInputs = vi.fn(
    (_value: string, _hostId: string, inputs: JsonValue) =>
      setSelection((current) => ({ ...current, inputs })),
  );
  const runOn = useRunOnComposer({
    projectId,
    projectless: false,
    agentProviderId: "codex",
    selectionValue: selection.value,
    providerHostId: selection.hostId,
    providerInputs: selection.inputs,
    primaryHostId: "h-a",
    changeEnvironment,
    seedProviderInputs,
  });
  return { runOn, selection, changeEnvironment };
}

interface Selection {
  value: string;
  hostId: string | null;
  inputs: JsonValue | null;
}

let projectSeq = 0;
function nextProject(): string {
  projectSeq += 1;
  return `p-${projectSeq}`;
}

function selectFirstRow(runOn: RunOnComposer): void {
  const row = runOn.picker?.groups[0]?.rows[0];
  if (row === undefined) throw new Error("no row");
  runOn.picker?.onSelect(row);
}

beforeEach(() => {
  stubs.accepted = [accepted()];
  stubs.choices = new Map([[WORKER, readyChoices()]]);
  stubs.hosts = [host("h-a", "machine-a"), host("h-b", "machine-b")];
  stubs.environment = undefined;
  stubs.workspace = { status: "loading" };
});
afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
});

describe("useRunOnComposer", () => {
  it("keeps the row item data through a failed create and clears it after success", async () => {
    const projectId = nextProject();
    const { result } = renderHook(() => useComposerHarness(projectId));
    render(<>{result.current.runOn.rowItems}</>);
    act(() => {
      expect(
        stubs.rowItemProps?.setSubmissionFor?.("account-pool", {
          accountId: "a1",
        }),
      ).toBe(true);
    });
    const send = vi
      .fn<(extras: ComposerSubmitExtras) => Promise<void>>()
      .mockRejectedValueOnce(new Error("create failed"))
      .mockResolvedValue(undefined);

    await act(async () => {
      await expect(result.current.runOn.submit({}, send)).rejects.toThrow(
        "create failed",
      );
    });
    await act(async () => {
      await result.current.runOn.submit({}, send);
    });
    await act(async () => {
      await result.current.runOn.submit({}, send);
    });

    const held = { pluginId: "account-pool", data: { accountId: "a1" } };
    expect(send.mock.calls.map(([extras]) => extras.pluginSubmission)).toEqual([
      held,
      held,
      undefined,
    ]);
  });

  it("drops a scope's row item data when the scope changes", () => {
    const { result, rerender } = renderHook(
      ({ scope }) => useRunRowSubmission(scope),
      { initialProps: { scope: "p\0codex" } },
    );
    act(() => {
      result.current.setFor("account-pool", { a: 1 });
    });
    expect(result.current.current?.data).toEqual({ a: 1 });
    rerender({ scope: "p\0claude-code" });
    expect(result.current.current).toBeNull();
    rerender({ scope: "p\0codex" });
    expect(result.current.current).toBeNull();
  });

  it("selects the stock provider on the agent host and seeds its inputs", () => {
    const projectId = nextProject();
    const { result } = renderHook(() => useComposerHarness(projectId));
    expect(result.current.runOn.picker?.registeredProviderIds.has(WORKER)).toBe(
      true,
    );
    expect(result.current.runOn.picker?.chip).toBeNull();
    act(() => selectFirstRow(result.current.runOn));
    expect(result.current.selection).toEqual({
      value: encodeProviderValue(WORKER),
      hostId: "h-b",
      inputs: CHOICE_INPUTS,
    });
    const { runOn } = result.current;
    expect(runOn.picker?.selectedValue).toBe(`runon:${WORKER}:b-a`);
    expect(runOn.picker?.chip).toMatchObject({
      agentName: "machine-b",
      workspaceName: "machine-a",
      warning: false,
    });
    expect(runOn.picker?.footer).toBe("Workspace machine-a · /srv/repo");
    expect(runOn.blocker).toBeNull();
    expect(runOn.mentionHostId).toBe("h-a");
  });

  it("keeps the stock mention host and no chip for a Local selection", () => {
    const projectId = nextProject();
    const { result } = renderHook(() => useComposerHarness(projectId));
    expect(result.current.runOn.mentionHostId).toBeUndefined();
    expect(result.current.runOn.blocker).toBeNull();
  });

  it("shows 'Choose a workspace' when the inputs match no choice", () => {
    const projectId = nextProject();
    const { result } = renderHook(() =>
      useComposerHarness(projectId, {
        value: encodeProviderValue(WORKER),
        hostId: "h-b",
        inputs: { workspaceHostId: "h-other", root: "x" },
      }),
    );
    expect(result.current.runOn.picker?.chip?.workspaceName).toBeNull();
    expect(result.current.runOn.mentionHostId).toBeUndefined();
  });

  it("disables an offline worker's row and blocks Send when it is selected", () => {
    stubs.hosts = [host("h-a", "machine-a"), host("h-b", "machine-b", false)];
    const projectId = nextProject();
    const { result } = renderHook(() =>
      useComposerHarness(projectId, {
        value: encodeProviderValue(WORKER),
        hostId: "h-b",
        inputs: CHOICE_INPUTS,
      }),
    );
    const row = result.current.runOn.picker?.groups[0]?.rows[0];
    expect(row?.unavailableReason).toBe("Worker machine-b is offline");
    expect(row?.lastSeenAt).toBe(1_000);
    expect(result.current.runOn.blocker).toBe("Worker machine-b is offline");
    expect(result.current.runOn.picker?.chip).toMatchObject({
      agentOffline: true,
      warning: true,
    });
  });

  it("blocks Send when the workspace host is offline", () => {
    stubs.hosts = [host("h-a", "machine-a", false), host("h-b", "machine-b")];
    const projectId = nextProject();
    const { result } = renderHook(() =>
      useComposerHarness(projectId, {
        value: encodeProviderValue(WORKER),
        hostId: "h-b",
        inputs: CHOICE_INPUTS,
      }),
    );
    expect(result.current.runOn.blocker).toBe("Workspace machine-a is offline");
  });

  it("restores the remembered choice for the project", () => {
    const projectId = nextProject();
    const first = renderHook(() => useComposerHarness(projectId));
    act(() => selectFirstRow(first.result.current.runOn));
    first.unmount();

    const { result } = renderHook(() =>
      useComposerHarness(projectId, {
        value: encodeProviderValue(WORKER),
        hostId: "h-b",
        inputs: null,
      }),
    );
    expect(result.current.selection.inputs).toEqual(CHOICE_INPUTS);
    expect(result.current.runOn.picker?.selectedValue).toBe(
      `runon:${WORKER}:b-a`,
    );
  });

  it("falls back to Local on the primary host when the plugin is gone", () => {
    const projectId = nextProject();
    const first = renderHook(() => useComposerHarness(projectId));
    act(() => selectFirstRow(first.result.current.runOn));
    first.unmount();
    stubs.accepted = [];
    const { result } = renderHook(() =>
      useComposerHarness(projectId, {
        value: encodeProviderValue(WORKER),
        hostId: "h-b",
        inputs: CHOICE_INPUTS,
      }),
    );
    expect(result.current.changeEnvironment).toHaveBeenCalledWith(
      LOCAL_VALUE,
      "h-a",
    );
    expect(result.current.selection.value).toBe(LOCAL_VALUE);
    expect(result.current.runOn.picker).toBeUndefined();
  });

  it("falls back to Local when the remembered choice is no longer listed", () => {
    const projectId = nextProject();
    const first = renderHook(() => useComposerHarness(projectId));
    act(() => selectFirstRow(first.result.current.runOn));
    first.unmount();
    stubs.choices = new Map([[WORKER, { status: "ready", choices: [] }]]);
    const { result } = renderHook(() =>
      useComposerHarness(projectId, {
        value: encodeProviderValue(WORKER),
        hostId: "h-b",
        inputs: null,
      }),
    );
    expect(result.current.selection).toMatchObject({
      value: LOCAL_VALUE,
      hostId: "h-a",
    });
  });

  it("waits while the provider list loads", () => {
    stubs.accepted = null;
    const projectId = nextProject();
    const { result } = renderHook(() => useComposerHarness(projectId));
    expect(result.current.runOn.picker).toBeUndefined();
    expect(result.current.changeEnvironment).not.toHaveBeenCalled();
  });
});

function workerEnvironment(providerId: string | null = WORKER) {
  return {
    id: "env-1",
    hostId: "h-b",
    environmentProviderId: providerId,
    environmentProviderSelection:
      providerId === null
        ? null
        : {
            machine: { type: "existing", hostId: "h-b" },
            inputs: CHOICE_INPUTS,
          },
  };
}

function openThread() {
  return renderHook(() =>
    useRunOnOpenThread({
      threadId: "t-1",
      projectId: "p-open",
      environmentId: "env-1",
    }),
  );
}

describe("useRunOnOpenThread", () => {
  const workspace: ExperimentalRunOnWorkspace = {
    hostId: "h-a",
    detail: "/srv/repo",
    branch: "feature-x",
  };

  it("shows the Run on chip, the worker's branch and the workspace mention host", () => {
    stubs.environment = workerEnvironment();
    stubs.workspace = {
      status: "ready",
      workspace,
    } satisfies RunOnThreadWorkspaceState;
    const { result } = openThread();
    expect(result.current.checkout?.label).toBe("feature-x");
    expect(result.current.mentionHostId).toBe("h-a");
    const view = render(<MemoryRouter>{result.current.chip}</MemoryRouter>);
    expect(
      view.getByRole("button", { name: "Run on: machine-b on machine-a" }),
    ).toBeTruthy();
    const trigger = view.getByRole("button");
    expect(trigger.hasAttribute("data-promptbox-shrinkable-control")).toBe(
      true,
    );
    expect(
      trigger.querySelector("[data-promptbox-compact-label]")?.textContent,
    ).toBe("machine-b");
    expect(
      trigger.querySelector("[data-promptbox-full-label]")?.textContent,
    ).toContain("machine-a");
  });

  it("turns host-bound mentions off when the workspace host is unknown", () => {
    stubs.environment = workerEnvironment();
    stubs.workspace = {
      status: "ready",
      workspace: { ...workspace, hostId: null, label: "elsewhere" },
    };
    expect(openThread().result.current.mentionHostId).toBeNull();
  });

  it("keeps today's row for a stock thread", () => {
    stubs.environment = workerEnvironment(null);
    const { result } = openThread();
    expect(result.current.chip).toBeNull();
    expect(result.current.checkout).toBeUndefined();
    expect(result.current.mentionHostId).toBeUndefined();
  });

  it("keeps today's row for a provider without a registration", () => {
    stubs.environment = workerEnvironment("someone-elses-provider");
    stubs.workspace = { status: "ready", workspace };
    const { result } = openThread();
    expect(result.current.chip).toBeNull();
    expect(result.current.mentionHostId).toBeUndefined();
  });

  it("keeps today's row when the plugin's hook crashed", () => {
    stubs.environment = workerEnvironment();
    stubs.workspace = { status: "crashed" };
    const { result } = openThread();
    expect(result.current.chip).toBeNull();
  });

  it("marks the chip amber when the agent host is offline", () => {
    stubs.environment = workerEnvironment();
    stubs.hosts = [host("h-a", "machine-a"), host("h-b", "machine-b", false)];
    stubs.workspace = { status: "ready", workspace };
    const { result } = openThread();
    const view = render(<MemoryRouter>{result.current.chip}</MemoryRouter>);
    const chip = view.container.querySelector("[data-run-on-chip]");
    expect(chip?.className).toContain("text-warning-text");
    expect(chip?.textContent).toContain("machine-b offline");
  });
});

describe("useComposerTypeahead mention host", () => {
  function typeahead(mentionHostId?: string | null) {
    return renderHook(() =>
      useComposerTypeahead({
        projectId: "p-1",
        providerId: "codex",
        environmentId: "env-1",
        currentThreadId: "t-1",
        selectedProviderComposerActions: undefined,
        resolveMentionLink: () => null,
        ...(mentionHostId === undefined ? {} : { mentionHostId }),
      }),
    ).result.current.typeaheadConfig;
  }

  it("reads mentions from the workspace host's project source", () => {
    const config = typeahead("h-a");
    expect(config.mention?.source).toMatchObject({
      projectId: "p-1",
      environmentId: null,
      hostId: "h-a",
    });

    expect(config.command?.source).toMatchObject({ environmentId: "env-1" });
  });

  it("reads no files when the workspace host is unknown, not the primary host's", () => {
    const config = typeahead(null);
    expect(config.mention?.source).toEqual({
      projectId: undefined,
      currentThreadId: "t-1",
      environmentId: null,
      hostId: null,
      threadStorageThreadId: "t-1",
    });
  });

  it("keeps the stock source without Run on", () => {
    const config = typeahead();
    expect(config.mention?.source).toMatchObject({ environmentId: "env-1" });
    expect(config.mention?.source).not.toHaveProperty("hostId");
  });
});
