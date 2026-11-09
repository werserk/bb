// @vitest-environment jsdom
import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, it, expect, vi } from "vitest";
import type { ThreadPlansReadResponse, ChangedMessage } from "@bb/domain";
const fake = vi.hoisted(() => ({
  read: vi.fn(),
  change: null as ((event: ChangedMessage) => void) | null,
  connected: null as (() => void) | null,
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
  detach: vi.fn(),
}));
vi.mock("@/lib/sdk", () => ({ sdk: { threads: { plans: fake.read } } }));
vi.mock("@/lib/ws", () => ({
  wsManager: {
    subscribe: fake.subscribe,
    unsubscribe: fake.unsubscribe,
    onChanged: (fn: (event: ChangedMessage) => void) => {
      fake.change = fn;
      return fake.detach;
    },
    onConnected: (fn: () => void) => {
      fake.connected = fn;
      return fake.detach;
    },
  },
}));
import { useThreadPlans } from "./thread-plans";
afterEach(cleanup);
it("shares native event invalidation, tracks changed graph coverage and recovers failed members", async () => {
  const response = (
    ids: string[],
    revision: number,
  ): ThreadPlansReadResponse => ({
    plans: Object.fromEntries(
      ids.map((threadId) => [
        threadId,
        {
          threadId,
          revision,
          current: null,
          previousPlans: [],
          historyTruncated: false,
          ownAttention: "none",
          attentionInteractionIds: [],
          unboundInteractionIds: [],
        },
      ]),
    ),
    errors: {},
  });
  fake.read.mockImplementation(async ({ threadIds }: { threadIds: string[] }) =>
    response(threadIds, 1),
  );
  const hook = renderHook(({ ids }) => useThreadPlans({ threadIds: ids }), {
    initialProps: { ids: ["a", "a"] },
  });
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  expect(hook.result.current.requestedThreadIds).toEqual(["a"]);
  let resolve: ((value: ThreadPlansReadResponse) => void) | undefined;
  fake.read.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  hook.rerender({ ids: ["a", "b"] });
  expect(hook.result.current.status).toBe("loading");
  await act(async () => resolve!({ plans: {}, errors: { b: "Unavailable" } }));
  expect(hook.result.current.status).toBe("error");
  expect(hook.result.current.loadedThreadIds).toEqual(["a"]);
  fake.read.mockImplementation(async ({ threadIds }: { threadIds: string[] }) =>
    response(threadIds, 2),
  );
  await act(async () => hook.result.current.refresh(["b"]));
  expect(hook.result.current.status).toBe("ready");
  await act(async () =>
    fake.change!({
      type: "changed",
      entity: "thread",
      id: "a",
      changes: ["events-appended"],
    }),
  );
  expect(hook.result.current.plans.a!.revision).toBe(2);
  expect(fake.subscribe).toHaveBeenCalledWith({
    kind: "thread-detail",
    threadId: "b",
  });
  hook.unmount();
  expect(fake.detach).toHaveBeenCalled();
});
