// @vitest-environment jsdom

import type { SystemEnvironmentProvider } from "@bb/server-contract";
import { makeHost } from "@bb/test-helpers/domain-fixtures";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnvironmentSlot } from "@/components/promptbox/NewThreadPromptBox";
import { chipView } from "./model";
import type { RunOnPickerModel } from "./RunOnGroups";

const WORKER = "account-workers-worker";
const workspaceHost = makeHost({ id: "host_a", name: "machine-a" });
const agentHost = makeHost({ id: "host_b", name: "machine-b" });
const hosts = [workspaceHost, agentHost];

const workerProvider: SystemEnvironmentProvider = {
  machineProviderId: null,
  id: WORKER,
  displayName: "Worker",
  description: "Agent on a worker, files on the workspace machine.",
  icon: "ComputerCloud",
  logoUrl: null,
  pluginId: "account-workers",
  acceptsEmptyInputs: false,
  machineAvailability: {},
  availability: null,
  requires: {
    projectCheckout: false,
    gitCheckout: false,
    gitRemote: false,
    projectless: false,
  },
  inputs: { type: "object" },
};

function runOn(chosen: boolean, covered = true): RunOnPickerModel {
  return {
    groups: [],
    registeredProviderIds: new Set(covered ? [WORKER] : []),
    selectedValue: null,
    chip: chosen
      ? chipView(hosts, agentHost.id, { hostId: workspaceHost.id })
      : null,
    footer: null,
    onSelect: vi.fn(),
  };
}

function renderSlot(picker: RunOnPickerModel | undefined) {
  return render(
    <EnvironmentSlot
      projectless={false}
      environment={{
        value: `provider:${WORKER}`,
        sources: [],
        host: workspaceHost,
        isLocal: true,
        machines: {
          hosts,
          localDaemonHostId: workspaceHost.id,
          primaryHostId: workspaceHost.id,
        },
        providers: [workerProvider],
        selectedProviderHostId: agentHost.id,
        onSelectProvider: vi.fn(),
        runOn: picker,
      }}
      worktree={{ options: [], value: null, onChange: vi.fn() }}
      environmentProviderInputsSlot={<span data-testid="inputs-control" />}
    />,
  );
}

afterEach(cleanup);

describe("Run on and the provider's stock inputs control", () => {
  it("hides the stock inputs control while a Run on choice owns the row", () => {
    const { container } = renderSlot(runOn(true));
    expect(screen.queryByTestId("inputs-control")).toBeNull();
    expect(
      container.querySelector(
        "[data-run-on-chip] [data-promptbox-compact-label]",
      )?.textContent,
    ).toBe("machine-b → machine-a");
  });

  it("hides it for a covered provider before a choice is made", () => {
    renderSlot(runOn(false));
    expect(screen.queryByTestId("inputs-control")).toBeNull();
  });

  it("keeps it for a provider no Run on registration covers", () => {
    renderSlot(runOn(false, false));
    expect(screen.queryByTestId("inputs-control")).not.toBeNull();
    cleanup();
    renderSlot(undefined);
    expect(screen.queryByTestId("inputs-control")).not.toBeNull();
  });
});
