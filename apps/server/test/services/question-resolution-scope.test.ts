import { afterEach, describe, expect, it } from "vitest";
import { createThread, threads } from "@bb/db";
import { eq } from "drizzle-orm";
import { withTestHarness } from "../helpers/test-app.js";
import { seedThreadFixture, seedTurnStarted } from "../helpers/seed.js";
import {
  registerQuestionResolutionScope,
  withQuestionResolutionActor,
} from "../../src/services/threads/question-resolution-scope.js";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

describe("question authority at acceptance", () => {
  it("refuses descendants without a managed policy and refuses cross-project targets", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "live",
        providerThreadId: "p",
      });
      const invocation = {
        threadId: thread.id,
        turnId: "live",
        providerThreadId: "p",
      };
      const child = createThread(h.db, h.hub, {
        projectId: thread.projectId,
        providerId: "codex",
        environmentId: thread.environmentId,
        parentThreadId: thread.id,
      });
      let writes = 0;
      await expect(
        withQuestionResolutionActor(h.db, child.id, invocation, () => writes++),
      ).rejects.toThrow(/only self/);
      const foreign = seedThreadFixture(h).thread;
      await expect(
        withQuestionResolutionActor(
          h.db,
          foreign.id,
          invocation,
          () => writes++,
        ),
      ).rejects.toThrow(/another project/);
      expect(writes).toBe(0);
    });
  });

  it.each(["revoked", "unloaded", "caller-moved"])(
    "refuses a %s policy before the commit callback",
    async (mode) => {
      await withTestHarness(async (h) => {
        const { thread } = seedThreadFixture(h, {
          thread: { status: "active" },
        });
        seedTurnStarted(h.deps, {
          threadId: thread.id,
          turnId: "live",
          providerThreadId: "p",
        });
        const target = createThread(h.db, h.hub, {
          projectId: thread.projectId,
          providerId: "codex",
          environmentId: thread.environmentId,
          parentThreadId: thread.id,
        });
        const foreign = seedThreadFixture(h).project;
        dispose = registerQuestionResolutionScope(
          "wprojects",
          async (_context, accept) => {
            await Promise.resolve();
            if (mode === "unloaded") dispose!();
            if (mode === "caller-moved")
              h.db
                .update(threads)
                .set({ projectId: foreign.id })
                .where(eq(threads.id, thread.id))
                .run();
            accept({
              relationship: "ancestor",
              role: "coordinator",
              isCurrent: () => mode !== "revoked",
            });
          },
        );
        let writes = 0;
        await expect(
          withQuestionResolutionActor(
            h.db,
            target.id,
            { threadId: thread.id, turnId: "live", providerThreadId: "p" },
            () => writes++,
          ),
        ).rejects.toThrow(/current|changed/);
        expect(writes).toBe(0);
      });
    },
  );
});
