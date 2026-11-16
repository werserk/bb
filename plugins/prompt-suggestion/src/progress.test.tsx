// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createComposerSuggestionController } from "@get-bb/plugin-sdk/internal/composer-handle";
import { ConnectedSuggestionController } from "../app.js";

const mocks = vi.hoisted(() => ({ call: vi.fn(), values: { enabled: true } }));
const rpc = { call: mocks.call };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (value: unknown) => value,
  useRpc: () => rpc,
  useSettings: () => ({ values: mocks.values }),
  useComposer: vi.fn(),
}));
afterEach(() => {
  cleanup();
  mocks.call.mockReset();
});

it.each(["none", "failed", "timeout"])(
  "finishes %s without restarting inference",
  async (outcome) => {
    let finish: (value: unknown) => void = () => {};
    mocks.call.mockImplementation((method: string) =>
      method === "suggest"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(true),
    );
    const store = createComposerSuggestionController(vi.fn());
    store.update({
      composerKey: "a",
      threadId: "thread",
      completedTurnId: "turn",
      contextRevision: "one",
      eligible: true,
    });
    const snapshot = store.controller.getSnapshot().snapshot;
    const view = render(
      <ConnectedSuggestionController controller={store.controller} />,
    );
    expect(store.controller.getSnapshot().request?.phase).toBe("pending");
    await act(async () =>
      finish(
        outcome === "none"
          ? { kind: "none" }
          : {
              kind: "unavailable",
              reason: outcome === "failed" ? "generation_failed" : "timeout",
            },
      ),
    );
    expect(store.controller.getSnapshot().request?.phase ?? "idle").toBe(
      outcome === "none" ? "idle" : "error",
    );
    expect(store.controller.getSnapshot().snapshot).toBe(snapshot);
    expect(
      mocks.call.mock.calls.filter(([method]) => method === "suggest"),
    ).toHaveLength(1);
    view.unmount();
    expect(store.controller.getSnapshot().request).toBeNull();
  },
);

it("drops pending progress on typing and ignores a late answer", async () => {
  let finish: (value: unknown) => void = () => {};
  mocks.call.mockImplementation((method: string) =>
    method === "suggest"
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(true),
  );
  const store = createComposerSuggestionController(vi.fn());
  const input = {
    composerKey: "a",
    threadId: "thread",
    completedTurnId: "turn",
    contextRevision: "one",
    eligible: true,
  };
  store.update(input);
  render(<ConnectedSuggestionController controller={store.controller} />);
  act(() => store.update({ ...input, eligible: false }));
  await act(async () => finish({ kind: "suggestion", text: "Stale" }));
  expect(store.controller.getSnapshot().request).toBeNull();
  expect(store.controller.getSnapshot().candidate).toBeNull();
});
