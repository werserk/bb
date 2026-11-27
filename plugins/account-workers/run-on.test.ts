import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (setup: unknown) => setup,
  experimental_useRpcQuery: () => ({}),
  experimental_useRpcMutation: () => ({}),
}));

const { registerRunOn, runOnChoices, runOnRegistration, runOnThreadWorkspace } = await import("./run-on.js");
const { default: setup } = await import("./app.js");

const choice = { agentHostId: "w", agentHostName: "worker", workspaceHostId: "a", workspaceHostName: "alpha", root: "/r", disabledReason: "Worker w is offline" };
const bound = { bindingId: "aw_1", agentHostId: "w", workspaceHostId: "b", workspaceHostName: "beta", root: "/s", branch: "main", issue: null };
const inputs = { workspaceHostId: "a", root: "/r" };

describe("run on a worker", () => {
  it("maps choices to picker rows and leaves offline to core", () => {
    expect(runOnChoices({ data: undefined, error: null })).toEqual({ status: "loading", choices: [] });
    expect(runOnChoices({ data: undefined, error: { message: "boom" } })).toEqual({ status: "error", choices: [], error: "boom" });
    expect(runOnChoices({ data: { choices: [choice] }, error: null })).toEqual({
      status: "ready",
      choices: [{ id: JSON.stringify(["w", "a", "/r"]), agentHostId: "w", inputs, workspace: { hostId: "a", detail: "/r" }, disabledReason: null }],
    });
  });

  it("shows the bound workspace, falls back to the chosen inputs and names a missing binding", () => {
    expect(runOnThreadWorkspace(inputs, { data: { workspace: bound }, error: null })).toEqual({ hostId: "b", detail: "/s", branch: "main", issue: null });
    expect(runOnThreadWorkspace(inputs, { data: undefined, error: null })).toEqual({ hostId: "a", detail: "/r" });
    expect(runOnThreadWorkspace(inputs, { data: { workspace: null }, error: null })).toEqual({ hostId: "a", detail: "/r", issue: "Workspace unbound" });
    expect(runOnThreadWorkspace(inputs, { data: undefined, error: { message: "boom" } })).toEqual({ hostId: "a", detail: "/r", issue: "Workspace did not load: boom" });
    expect(runOnThreadWorkspace(null, { data: { workspace: null }, error: null })).toBeNull();
  });

  it("registers only where the runtime has the Run on slot", () => {
    const register = vi.fn();
    expect(registerRunOn({})).toBe(false);
    expect(registerRunOn({ experimental_runOnProvider: register })).toBe(true);
    expect(register).toHaveBeenCalledWith(runOnRegistration);
    expect(runOnRegistration).toMatchObject({ version: 1, environmentProviderId: "account-workers-worker", title: "On a worker" });
  });

  it("the app keeps the inputs control on a runtime without the slot", () => {
    const inputsSlot = vi.fn();
    (setup as unknown as (app: unknown) => void)({ slots: { experimental_environmentProviderInputs: inputsSlot } });
    expect(inputsSlot).toHaveBeenCalledOnce();
    const runOn = vi.fn();
    (setup as unknown as (app: unknown) => void)({ slots: { experimental_environmentProviderInputs: vi.fn(), experimental_runOnProvider: runOn } });
    expect(runOn).toHaveBeenCalledWith(runOnRegistration);
  });
});
