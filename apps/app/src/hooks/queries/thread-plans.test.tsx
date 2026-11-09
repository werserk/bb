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

it("observes same-ID plan and native input updates, preserves error display and recovers coverage", async () => {
  const threadId = "same-id";
  const response = (
    revision: number,
    waiting = false,
  ): ThreadPlansReadResponse => ({
    plans: {
      [threadId]: {
        threadId,
        revision,
        current: {
          sourceSeq: revision,
          updatedAt: revision,
          planId: "work",
          items: [
            {
              id: "step",
              text: waiting ? "Choose" : "Build",
              status: waiting ? "needs_input" : "in_progress",
              interactionIds: waiting ? ["native-id"] : [],
            },
          ],
        },
        previousPlans: [],
        historyTruncated: false,
        ownAttention: waiting ? "needs_input" : "none",
        attentionInteractionIds: waiting ? ["native-id"] : [],
        unboundInteractionIds: [],
      },
    },
    errors: {},
  });
  fake.read.mockResolvedValue(response(1));
  const hook = renderHook(() => useThreadPlans({ threadIds: [threadId] }));
  await waitFor(() => expect(hook.result.current.status).toBe("ready"));
  const initial = hook.result.current;
  expect(initial.plans[threadId]?.current?.items[0]?.text).toBe("Build");
  fake.read.mockResolvedValue(response(2, true));
  await act(async () =>
    fake.change!({
      type: "changed",
      entity: "thread",
      id: threadId,
      changes: ["events-appended"],
    }),
  );
  expect(hook.result.current.status).toBe("ready");
  expect(hook.result.current.plans[threadId]?.current?.items[0]).toMatchObject({
    text: "Choose",
    status: "needs_input",
    interactionIds: ["native-id"],
  });
  expect(hook.result.current.plans[threadId]?.ownAttention).toBe("needs_input");
  expect(initial.plans[threadId]?.revision).toBe(1);
  fake.read.mockResolvedValue({
    plans: {},
    errors: { [threadId]: "Read failed" },
  });
  await act(async () => hook.result.current.refresh());
  expect(hook.result.current.status).toBe("error");
  expect(hook.result.current.loadedThreadIds).toEqual([]);
  expect(hook.result.current.errors).toEqual({ [threadId]: "Read failed" });
  expect(hook.result.current.plans[threadId]?.revision).toBe(2);
  const failed = hook.result.current;
  fake.read.mockResolvedValue(response(3));
  await act(async () => fake.connected!());
  expect(hook.result.current.status).toBe("ready");
  expect(hook.result.current.loadedThreadIds).toEqual([threadId]);
  expect(hook.result.current.errors).toEqual({});
  expect(hook.result.current.plans[threadId]?.revision).toBe(3);
  expect(failed.errors).toEqual({ [threadId]: "Read failed" });
});

it("revalidates a cached thread after membership leaves and remounts without reporting stale coverage", async () => {
  const threadId = "remount";
  const response = (revision: number): ThreadPlansReadResponse => ({
    plans: {
      [threadId]: {
        threadId,
        revision,
        current: null,
        previousPlans: [],
        historyTruncated: false,
        ownAttention: "none",
        attentionInteractionIds: [],
        unboundInteractionIds: [],
      },
    },
    errors: {},
  });
  fake.read.mockResolvedValue(response(1));
  const first = renderHook(() => useThreadPlans({ threadIds: [threadId] }));
  await waitFor(() => expect(first.result.current.status).toBe("ready"));
  first.unmount();
  let complete!: (value: ThreadPlansReadResponse) => void;
  fake.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const statuses: string[] = [];
  const second = renderHook(() => {
    const result = useThreadPlans({ threadIds: [threadId] });
    statuses.push(result.status);
    return result;
  });
  expect(statuses[0]).toBe("loading");
  expect(second.result.current.status).toBe("loading");
  expect(second.result.current.loadedThreadIds).toEqual([]);
  expect(second.result.current.plans[threadId]?.revision).toBe(1);
  await act(async () => complete(response(2)));
  expect(second.result.current.status).toBe("ready");
  expect(second.result.current.plans[threadId]?.revision).toBe(2);
});
