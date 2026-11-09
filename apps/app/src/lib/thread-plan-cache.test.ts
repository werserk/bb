import { it, expect } from "vitest";
import { ThreadPlanCache } from "./thread-plan-cache";
import type { ThreadPlansReadResponse } from "@bb/domain";
it("bounds requests and keeps coverage incomplete until every member loads", async () => {
  const calls: string[][] = [];
  const pending: ((result: ThreadPlansReadResponse) => void)[] = [];
  const cache = new ThreadPlanCache((ids) => {
    calls.push([...ids]);
    return new Promise((resolve) => pending.push(resolve));
  });
  const ids = Array.from({ length: 95 }, (_, i) => `t${i}`);
  const done = cache.refresh(ids);
  expect(calls.map((c) => c.length)).toEqual([40, 40]);
  expect(cache.loaded(ids)).toEqual([]);
  const response = (ids: string[], revision = 2): ThreadPlansReadResponse => ({
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
  pending[0]!(response(calls[0]!));
  await Promise.resolve();
  await Promise.resolve();
  expect(calls.map((c) => c.length)).toEqual([40, 40, 15]);
  pending[1]!(response(calls[1]!));
  pending[2]!(response(calls[2]!));
  await done;
  expect(cache.loaded(ids)).toHaveLength(95);
  const again = cache.refresh([ids[0]!]);
  pending[3]!(response([ids[0]!], 1));
  await again;
  expect(cache.plans[ids[0]!]!.revision).toBe(2);
  expect(cache.errors[ids[0]!]).toMatch(/revision/i);
});
