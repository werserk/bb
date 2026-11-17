// @vitest-environment jsdom
import { useEffect } from "react";
import type { PluginComposerApi } from "@get-bb/plugin-sdk/app";
import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { helperRequestSchema, type HelperResponse } from "./helper.js";
import { rpcContract } from "./contracts.js";
installTestPluginRuntime();
const { PromptHelperAction, PromptHelperPanel } =
  await import("./prompt-helper.js");
const { useComposer } = await import("@get-bb/plugin-sdk/app");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const revision = "a".repeat(64);
const response = {
  kind: "helper" as const,
  text: "A clearer request",
  advice: "Consider checking the scope.",
  contextRevision: revision,
};
function Both() {
  return (
    <>
      <PromptHelperAction />
      <PromptHelperPanel />
    </>
  );
}
function mount(helper: () => Promise<HelperResponse> = async () => response) {
  return renderSlot(
    { component: Both },
    {},
    {
      settings: { enabled: false },
      experimental_rpcContract: rpcContract,
      rpc: { helperContext: () => ({ revision }), helper, cancel: () => true },
      composer: {
        scope: { kind: "thread", threadId: "thread" },
        text: "My request",
        experimental_suggestionContext: {
          eligible: true,
          completedTurnId: "turn",
          contextRevision: "r",
        },
      },
    },
  );
}
describe("manual helper preview", () => {
  it("separates advice and changes the draft only after explicit application while auto is disabled", async () => {
    const slot = mount();
    fireEvent.click(screen.getByRole("button", { name: "Prompt helper" }));
    await screen.findByText(response.text);
    expect(slot.composer.text).toBe("My request");
    expect(screen.getByText(response.advice)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    await waitFor(() => expect(slot.composer.text).toBe(response.text));
    expect(slot.composer.submits).toHaveLength(0);
  });
  it("keeps a preview applicable through telemetry-only ghost context changes", async () => {
    const observed: { composer: PluginComposerApi | null } = { composer: null };
    function Probe() {
      const composer = useComposer();
      useEffect(() => {
        observed.composer = composer;
      }, [composer]);
      return <Both />;
    }
    const slot = renderSlot(
      { component: Probe },
      {},
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          helperContext: () => ({ revision }),
          helper: () => response,
          cancel: () => true,
        },
        composer: {
          scope: { kind: "thread", threadId: "thread" },
          text: "My request",
          experimental_suggestionContext: {
            eligible: true,
            completedTurnId: "turn",
            contextRevision: "before-telemetry",
          },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Prompt helper" }));
    await screen.findByText(response.text);
    const composer = observed.composer;
    if (!composer) throw new Error("Composer did not mount");
    const controller = composer.experimental_suggestions;
    const current = controller.getSnapshot();
    if (!current.snapshot) throw new Error("Composer snapshot is unavailable");
    const updated = {
      ...current,
      snapshot: {
        ...current.snapshot,
        contextRevision: "after-tool-event-and-reconnect",
        draftRevision: current.snapshot.draftRevision + 1,
      },
    };
    vi.spyOn(controller, "getSnapshot").mockReturnValue(updated);
    act(() => controller.experimental_suspend()());
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Replace draft" })
        .disabled,
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    await waitFor(() => expect(slot.composer.text).toBe(response.text));
    expect(slot.composer.submits).toEqual([]);
  });
  it("keeps an edited draft when a late result arrives", async () => {
    let finish: ((value: typeof response) => void) | undefined;
    const slot = mount(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Prompt helper" }));
    await waitFor(() => expect(finish).toBeDefined());
    await slot.behavior.setComposerText("Edited meanwhile");
    finish!(response);
    await screen.findByText(response.text);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Replace draft" })
        .disabled,
    ).toBe(true);
    expect(slot.composer.text).toBe("Edited meanwhile");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(slot.composer.text).toBe("Edited meanwhile");
  });
  it("isolates two mounted composers for the same thread and cancels on disposal", async () => {
    const first = mount();
    const second = mount();
    const buttons = screen.getAllByRole("button", { name: "Prompt helper" });
    fireEvent.click(buttons[0]!);
    await screen.findByText(response.text);
    expect(buttons[1]!.getAttribute("aria-expanded")).toBe("false");
    expect(second.rpcCalls).toHaveLength(0);
    first.unmount();
    await waitFor(() =>
      expect(first.rpcCalls.some((call) => call.method === "cancel")).toBe(
        true,
      ),
    );
    expect(
      screen.queryByRole("region", { name: "Prompt helper preview" }),
    ).toBeNull();
    second.unmount();
  });
  it("rechecks context immediately before apply and preserves attachments and mention identity", async () => {
    let currentRevision = revision;
    const attachment = {
      type: "localFile" as const,
      path: "/tmp/reference.txt",
      name: "reference.txt",
    };
    const slot = renderSlot(
      { component: Both },
      {},
      {
        experimental_rpcContract: rpcContract,
        rpc: {
          helperContext: () => ({ revision: currentRevision }),
          helper: (input) => ({
            ...response,
            text: `Please ${helperRequestSchema.parse(input).draft}`,
          }),
          cancel: () => true,
        },
        composer: {
          scope: { kind: "thread", threadId: "thread" },
          text: "@task",
          mentions: [
            {
              kind: "thread",
              from: 0,
              to: 5,
              label: "task",
              threadId: "mentioned",
            },
          ],
          attachments: [attachment],
          experimental_suggestionContext: {
            eligible: true,
            completedTurnId: "turn",
            contextRevision: "r",
          },
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Prompt helper" }));
    await screen.findByText("Please @task");
    fireEvent.focus(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.getByText("Please @task")).toBeTruthy();
    currentRevision = "b".repeat(64);
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    await screen.findByText(
      "The conversation changed. Try again with the latest context.",
    );
    expect(slot.composer.text).toBe("@task");
    currentRevision = revision;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Please @task");
    fireEvent.click(screen.getByRole("button", { name: "Replace draft" }));
    await waitFor(() => expect(slot.composer.text).toBe("Please @task"));
    expect(slot.composer.draft.attachments).toEqual([attachment]);
    expect(slot.composer.draft.mentions).toEqual([
      { kind: "thread", from: 7, to: 12, label: "task", threadId: "mentioned" },
    ]);
    expect(slot.composer.submits).toEqual([]);
  });
  it("leaves failure and empty results unapplied with explicit retry only", async () => {
    let calls = 0;
    const slot = mount(async () => {
      calls++;
      return calls === 1
        ? { kind: "unavailable", reason: "model_not_configured" }
        : { kind: "none", contextRevision: revision };
    });
    fireEvent.click(screen.getByRole("button", { name: "Prompt helper" }));
    await screen.findByRole("alert");
    expect(calls).toBe(1);
    expect(slot.composer.text).toBe("My request");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText(
      "No useful next step is supported by the current conversation.",
    );
    expect(calls).toBe(2);
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Replace draft" })
        .disabled,
    ).toBe(true);
  });
});
