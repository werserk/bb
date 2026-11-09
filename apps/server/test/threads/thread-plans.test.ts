import { describe, it, expect } from "vitest";
import { turnScope } from "@bb/domain";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedEvent,
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
