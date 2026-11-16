// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createComposerSuggestionController } from "@get-bb/plugin-sdk/internal/composer-handle";
import { ConnectedSuggestionController } from "../app.js";
import { emptyTaskState } from "./task-state.js";
import { createCoordinator } from "./coordinator.js";
import { sourceMessage } from "./context-input.js";
import type { JobView } from "./coordinator.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  refetch: vi.fn(),
  values: { enabled: true },
  data: null as JobView | null,
}));
const rpc = { call: mocks.call };
vi.mock("@get-bb/plugin-sdk/app", () => ({
  definePluginApp: (value: unknown) => value,
  useRpc: () => rpc,
  useSettings: () => ({ values: mocks.values }),
  useComposer: vi.fn(),
  experimental_useRpcQuery: () => ({
    data: mocks.data,
    error: null,
    refetch: mocks.refetch,
  }),
}));
beforeEach(() => {
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  mocks.call.mockReset();
  mocks.refetch.mockReset();
  mocks.values = { enabled: true };
});
const input = {
  composerKey: "a",
  threadId: "thread",
  completedTurnId: "turn",
  contextRevision: "one",
  eligible: true,
};
const job = (
  phase: JobView["phase"],
  result: JobView["result"] = null,
): JobView => ({
  phase,
  result,
  jobId: "232df470-1f92-4dc5-b924-19a1fc2c7d38",
  turnId: "turn",
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
async function mount() {
  mocks.call.mockResolvedValue(true);
  mocks.refetch.mockResolvedValue(undefined);
  const store = createComposerSuggestionController(vi.fn());
  store.update(input);
  const view = render(
    <ConnectedSuggestionController controller={store.controller} />,
  );
  await waitFor(() => expect(mocks.refetch).toHaveBeenCalled());
  await act(async () => {});
  return {
    store,
    view,
    refresh: () =>
      view.rerender(
        <ConnectedSuggestionController controller={store.controller} />,
      ),
  };
}

it.each(["none", "failed", "timeout"])(
  "finishes %s without another generation",
  async (outcome) => {
    mocks.data = job("pending");
    const { store, view, refresh } = await mount();
    expect(store.controller.getSnapshot().request?.phase).toBe("pending");
    const snapshot = store.controller.getSnapshot().snapshot;
    mocks.data =
      outcome === "none"
        ? job("none", { kind: "none" })
        : job("error", {
            kind: "unavailable",
            reason: outcome === "failed" ? "generation_failed" : "timeout",
          });
    refresh();
    expect(store.controller.getSnapshot().request?.phase ?? "idle").toBe(
      outcome === "none" ? "idle" : "error",
    );
    expect(store.controller.getSnapshot().snapshot).toBe(snapshot);
    expect(
      mocks.call.mock.calls.filter(([method]) => method === "track"),
    ).toHaveLength(1);
    expect(
      mocks.call.mock.calls.some(
        ([method]) => method === "suggest" || method === "cancel",
      ),
    ).toBe(false);
    view.unmount();
    expect(store.controller.getSnapshot().request).toBeNull();
  },
);

it("typing dismisses pending state and ignores the same job after the draft clears", async () => {
  mocks.data = job("pending");
  const { store, refresh } = await mount();
  act(() => store.draftChanged());
  mocks.data = job("ready", {
    kind: "suggestion",
    text: "Stale",

  });
  refresh();
  expect(store.controller.getSnapshot().candidate).toBeNull();
  expect(mocks.call.mock.calls.some(([method]) => method === "detach")).toBe(
    false,
  );
});

it("reattaches a ready server job after unmount without cancel", async () => {
  mocks.data = job("pending");
  const first = await mount();
  first.view.unmount();
  mocks.data = job("ready", {
    kind: "suggestion",
    text: "Continue",

  });
  const second = await mount();
  expect(second.store.controller.getSnapshot().candidate?.text).toBe(
    "Continue",
  );
  expect(mocks.call.mock.calls.some(([method]) => method === "cancel")).toBe(
    false,
  );
});

it("rejects a ready job from a different turn", async () => {
  mocks.data = {
    ...job("ready", {
      kind: "suggestion",
      text: "Stale",

    }),
    turnId: "old",
  };
  const { store } = await mount();
  expect(store.controller.getSnapshot().candidate).toBeNull();
});

it("reattaches the same ready job after blur and focus without browser inference", async () => {
  mocks.data = job("ready", {
    kind: "suggestion",
    text: "Continue",

  });
  const { store } = await mount();
  expect(store.controller.getSnapshot().candidate).not.toBeNull();
  act(() => window.dispatchEvent(new Event("blur")));
  expect(store.controller.getSnapshot().candidate).toBeNull();
  await act(async () => window.dispatchEvent(new Event("focus")));
  expect(
    mocks.call.mock.calls.filter(([method]) => method === "track"),
  ).toHaveLength(2);
  expect(store.controller.getSnapshot().candidate?.text).toBe("Continue");
  expect(
    mocks.call.mock.calls.some(
      ([method]) => method === "suggest" || method === "cancel",
    ),
  ).toBe(false);
});

it("tracks an active thread without displaying generation progress", async () => {
  mocks.data = job("prepared");
  const { store } = await mount();
  act(() => store.update({ ...input, eligible: false }));
  expect(
    mocks.call.mock.calls.filter(([method]) => method === "track"),
  ).toHaveLength(1);
  expect(store.controller.getSnapshot().request).toBeNull();
  expect(store.controller.getSnapshot().candidate).toBeNull();
});

it("disabling the configuration clears the candidate without cancelling a server job", async () => {
  mocks.data = job("ready", {
    kind: "suggestion",
    text: "Continue",

  });
  const { store, refresh } = await mount();
  expect(store.controller.getSnapshot().candidate).not.toBeNull();
  mocks.values = { enabled: false };
  refresh();
  expect(store.controller.getSnapshot().candidate).toBeNull();
  expect(mocks.call.mock.calls.some(([method]) => method === "cancel")).toBe(
    false,
  );
});

it("reattaches pending progress against the current eligible snapshot", async () => {
  mocks.data = job("pending");
  const { store, refresh } = await mount();
  act(() => store.update({ ...input, eligible: false }));
  expect(store.controller.getSnapshot().request).toBeNull();
  act(() => store.update(input));
  expect(store.controller.getSnapshot().request?.snapshot).toBe(
    store.controller.getSnapshot().snapshot,
  );
  mocks.data = job("ready", {
    kind: "suggestion",
    text: "Continue",

  });
  refresh();
  expect(store.controller.getSnapshot().candidate?.text).toBe("Continue");
});

it.each(["dismiss", "accept"] as const)(
  "never reoffers a job after explicit %s",
  async (action) => {
    mocks.data = job("ready", {
      kind: "suggestion",
      text: "Continue",

    });
    const { store } = await mount();
    const candidate = store.controller.getSnapshot().candidate!;
    act(() => {
      if (action === "dismiss") store.controller.dismiss();
      else store.controller.accept(candidate.requestId);
    });
    act(() => window.dispatchEvent(new Event("blur")));
    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(store.controller.getSnapshot().candidate).toBeNull();
  },
);

it("keeps a typed draft dismissal terminal when eligibility changes first", async () => {
  mocks.data = job("pending");
  const { store, refresh } = await mount();
  act(() => store.update({ ...input, eligible: false }));
  act(() => store.draftChanged());
  act(() => store.update(input));
  mocks.data = job("ready", {
    kind: "suggestion",
    text: "Stale",

  });
  refresh();
  expect(store.controller.getSnapshot().candidate).toBeNull();
});

it("keeps foreground interest after typing and registers a newly completed turn", async () => {
  mocks.data = job("pending");
  const { store } = await mount();
  act(() => store.draftChanged());
  expect(
    mocks.call.mock.calls.filter(([method]) => method === "detach"),
  ).toHaveLength(0);
  act(() =>
    store.update({
      ...input,
      completedTurnId: "next",
      contextRevision: "next",
    }),
  );
  await waitFor(() =>
    expect(
      mocks.call.mock.calls.filter(([method]) => method === "track"),
    ).toHaveLength(2),
  );
  const tracks = mocks.call.mock.calls.filter(([method]) => method === "track");
  expect(tracks[0]![1].clientId).toBe(tracks[1]![1].clientId);
  expect(
    mocks.call.mock.calls.filter(([method]) => method === "detach"),
  ).toHaveLength(0);
});

it("uses separate registration IDs so a late old track cannot detach its successor", async () => {
  mocks.data = job("prepared");
  let release!: () => void;
  mocks.call.mockImplementation((method: string) =>
    method === "track" && !release
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(true),
  );
  mocks.refetch.mockResolvedValue(undefined);
  const store = createComposerSuggestionController(vi.fn());
  store.update(input);
  render(<ConnectedSuggestionController controller={store.controller} />);
  act(() => window.dispatchEvent(new Event("blur")));
  await act(async () => window.dispatchEvent(new Event("focus")));
  await act(async () => release());
  const tracks = mocks.call.mock.calls.filter(([method]) => method === "track");
  expect(tracks).toHaveLength(2);
  expect(tracks[0]![1].clientId).not.toBe(tracks[1]![1].clientId);
  expect(
    mocks.call.mock.calls
      .filter(([method]) => method === "detach")
      .every(([, value]) => value.clientId === tracks[0]![1].clientId),
  ).toBe(true);
});

it("keeps a server-admitted next-turn job alive during foreground renewal", async () => {
  let turnId = "turn";
  let release!: () => void;
  const generate = vi.fn(async () => {
    if (turnId === "next")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return { kind: "none" as const };
  });
  const coordinator = createCoordinator({
    configuration: () => ({
      enabled: true,
      backgroundPreparation: false,
      maxRequestsPerHour: 60,
      timeoutMs: 5000,
      outputTokenLimit: 0,
    }),
    prepare: async () => ({
      context: {
        projectId: "p",
        turnId,
        revision: turnId,
        eligible: true,
        boundary: null,
        text: "{}",
        messages: [sourceMessage("u", "user", "Fix it", 1)],
        contextComplete: true,
      },
      instructionRevision: "bible",
      instructions: "BIBLE",
      memoryInstructions: "BIBLE memory",
      memoryInstructionRevision: "memory",
      configKey: "config",
    }),
    generate,
    generateMemory: async () => emptyTaskState(),
    changed: vi.fn(),
  });
  mocks.data = job("prepared");
  mocks.call.mockImplementation(
    (method: string, value: { threadId: string; clientId: string }) => {
      if (method === "track")
        return coordinator.track(value.threadId, value.clientId);
      if (method === "detach")
        return Promise.resolve(
          coordinator.detach(value.threadId, value.clientId),
        );
      return Promise.resolve(true);
    },
  );
  mocks.refetch.mockResolvedValue(undefined);
  const store = createComposerSuggestionController(vi.fn());
  store.update(input);
  const view = render(
    <ConnectedSuggestionController controller={store.controller} />,
  );
  try {
    await waitFor(async () =>
      expect((await coordinator.state("thread")).phase).toBe("none"),
    );
    turnId = "next";
    await coordinator.wake("thread");
    await waitFor(() => expect(release).toBeTypeOf("function"));
    act(() =>
      store.update({
        ...input,
        completedTurnId: "next",
        contextRevision: "next",
      }),
    );
    expect((await coordinator.state("thread")).phase).toBe("pending");
    release();
    await waitFor(async () =>
      expect((await coordinator.state("thread")).phase).toBe("none"),
    );
    expect(coordinator.diagnostics().cancelled).toBe(0);
    expect(generate).toHaveBeenCalledTimes(2);
  } finally {
    view.unmount();
    coordinator.dispose();
  }
});
