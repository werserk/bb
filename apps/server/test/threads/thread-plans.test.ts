import { createNodeBbSdk } from "@bb/sdk/node";
import { readThreadPlan } from "../../src/services/threads/thread-plans.js";
import { createUserQuestionPayload } from "../helpers/pending-interactions.js";
import { describe, it, expect } from "vitest";
import { turnScope, threadScope } from "@bb/domain";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedEvent,
  seedTurnStarted,
} from "../helpers/seed.js";

describe("canonical thread plans", () => {
  it("reads off-page identities, deduplicates updates and stops at empty clear", async () => {
    await withTestHarness(async (h) => {
      const { host } = seedHostSession(h.deps);
      const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
      const env = seedEnvironment(h.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(h.deps, {
        projectId: project.id,
        environmentId: env.id,
        status: "idle",
      });
      const write = (sequence: number, planId: string, empty = false) =>
        seedEvent(h.deps, {
          threadId: thread.id,
          sequence,
          type: "item/completed",
          scope: turnScope("turn"),
          data: {
            providerThreadId: "provider",
            item: {
              type: "planSteps",
              id: `p${sequence}`,
              planId,
              status: "completed",
              steps: empty
                ? []
                : [
                    {
                      id: "step",
                      step: "Check",
                      status: "failed",
                      note: "refused",
                      actor: "reviewer",
                    },
                  ],
            },
          },
        });
      write(1, "earlier");
      write(2, "current");
      write(3, "current");
      const read = async () => {
        const res = await h.app.request("/api/v1/threads/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadIds: [thread.id] }),
        });
        expect(res.status).toBe(200);
        return await res.json();
      };
      expect(await read()).toMatchObject({
        errors: {},
        plans: {
          [thread.id]: {
            threadId: thread.id,
            revision: 3,
            current: {
              planId: "current",
              sourceSeq: 3,
              items: [
                {
                  id: "step",
                  status: "failed",
                  note: "refused",
                  actor: "reviewer",
                  interactionIds: [],
                },
              ],
            },
            previousPlans: [{ planId: "earlier" }],
            historyTruncated: false,
            ownAttention: "failed",
          },
        },
      });
      const sdk = createNodeBbSdk({
        baseUrl: "http://localhost",
        fetch: async (input, init) => h.app.request(new Request(input, init)),
      });
      expect(await sdk.threads.plans({ threadIds: [thread.id] })).toEqual(
        await read(),
      );
      const tooMany = await h.app.request("/api/v1/threads/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadIds: Array(41).fill(thread.id) }),
      });
      expect(tooMany.status).toBe(400);
      write(4, "clear", true);
      expect(await read()).toMatchObject({
        plans: {
          [thread.id]: {
            current: null,
            previousPlans: [],
            ownAttention: "none",
          },
        },
      });
    });
  });
});

it("retains creation anchors beyond the 32-event window and input across context clear", async () => {
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps);
    const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
    const env = seedEnvironment(h.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "claude-code",
    });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      turnId: "turn",
      providerThreadId: "provider",
    });
    const write = (sequence: number) =>
      seedEvent(h.deps, {
        threadId: thread.id,
        sequence,
        type: "item/completed",
        scope: turnScope("turn"),
        data: {
          providerThreadId: "provider",
          item: {
            type: "planSteps",
            id: `p${sequence}`,
            planId: "stable",
            status: "completed",
            steps: [{ id: "step", step: "Build", status: "active" }],
          },
        },
      });
    write(2);
    const created = h.deps.pendingInteractions.registerPendingInteraction({
      interaction: {
        threadId: thread.id,
        turnId: "turn",
        providerId: "claude-code",
        providerThreadId: "provider",
        providerRequestId: "question",
        payload: createUserQuestionPayload(),
      },
    });
    if (created.outcome === "rejected") throw new Error(created.reason);
    for (let seq = 4; seq <= 40; seq++) write(seq);
    const result = readThreadPlan(h.deps, thread);
    expect(result.current?.items[0]).toMatchObject({
      id: "step",
      status: "needs_input",
      interactionIds: [created.interaction.id],
    });
    expect(result.historyTruncated).toBe(true);
    expect(result.unboundInteractionIds).toEqual([]);
    seedEvent(h.deps, {
      threadId: thread.id,
      sequence: 41,
      type: "system/operation",
      scope: threadScope(),
      data: {
        operation: "context_clear",
        status: "completed",
        message: "cleared",
        operationId: "clear",
      },
    });
    const cleared = readThreadPlan(h.deps, thread);
    expect(cleared.current).toBeNull();
    expect(cleared.previousPlans).toEqual([]);
    expect(cleared.ownAttention).toBe("needs_input");
    expect(cleared.unboundInteractionIds).toEqual([created.interaction.id]);
  });
});
