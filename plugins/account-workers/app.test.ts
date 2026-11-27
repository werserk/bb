import { describe, expect, it, vi } from "vitest";

vi.mock("@get-bb/plugin-sdk/app", () => ({ definePluginApp: (setup: unknown) => setup, experimental_useRpcQuery: () => ({}) }));

const { inputsState } = await import("./app.js");

const choice = (workspaceHostId: string, root: string, disabledReason: string | null = null, agentHostId = "w") => ({
  agentHostId,
  agentHostName: "worker",
  workspaceHostId,
  workspaceHostName: workspaceHostId,
  root,
  disabledReason,
});

const base = { projectId: "p1", agentHostId: "w", error: null, value: null };

describe("workspace inputs control", () => {
  it("picks the first usable workspace of this agent and submits it", () => {
    const state = inputsState({ ...base, choices: [choice("a", "/r", "Workspace machine a is offline"), choice("b", "/r"), choice("c", "/r", null, "other")] });
    expect(state.options.map((c) => c.workspaceHostId)).toEqual(["a", "b"]);
    expect(state.change).toEqual({ status: "ready", value: { workspaceHostId: "b", root: "/r" } });
  });

  it("keeps a chosen workspace and blocks with its reason when it goes offline", () => {
    const value = { workspaceHostId: "a", root: "/r" };
    expect(inputsState({ ...base, value, choices: [choice("a", "/r")] }).change).toEqual({ status: "ready", value });
    expect(inputsState({ ...base, value, choices: [choice("a", "/r", "Worker w is disconnected"), choice("b", "/r")] }).change)
      .toEqual({ status: "blocked", reason: "Worker w is disconnected" });
  });

  it("a value no choice has asks to choose instead of submitting it", () => {
    const state = inputsState({ ...base, value: { workspaceHostId: "gone", root: "/r" }, choices: [choice("a", "/r")] });
    expect(state.selected).toBeNull();
    expect(state.change).toEqual({ status: "blocked", reason: "Choose a workspace" });
  });

  it("blocks without a project, a new machine, loading, a load error or no workspace", () => {
    expect(inputsState({ ...base, projectId: null, choices: [] }).change.status).toBe("blocked");
    expect(inputsState({ ...base, agentHostId: null, choices: [] }).change.status).toBe("blocked");
    expect(inputsState({ ...base, choices: null }).change).toEqual({ status: "blocked", reason: "Loading workspaces" });
    expect(inputsState({ ...base, choices: null, error: "boom" }).change).toEqual({ status: "blocked", reason: "Workspaces did not load: boom" });
    expect(inputsState({ ...base, choices: [choice("c", "/r", null, "other")] }).change)
      .toEqual({ status: "blocked", reason: "No other machine holds this project's source" });
  });
});
