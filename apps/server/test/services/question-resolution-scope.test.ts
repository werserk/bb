import { afterEach, describe, expect, it } from "vitest";
import { createThread, threads, getLatestThreadSequence } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import { eq } from "drizzle-orm";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedTurnStarted,
  seedEvent,
} from "../helpers/seed.js";
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
  it.each(["completed", "interrupted", "aborted"] as const)(
    "refuses a caller %s while its grant is prepared",
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
        const controller = new AbortController();
        dispose = registerQuestionResolutionScope(
          "wprojects",
          async (_context, accept) => {
            await Promise.resolve();
          const sequence = getLatestThreadSequence(h.db, {threadId:thread.id}) + 1;
            if (mode === "completed")
              seedEvent(h.deps, {
                threadId: thread.id,
                sequence,
                providerThreadId: "p",
                type: "turn/completed",
                scope: turnScope("live"),
                data: { providerThreadId: "p", status: "completed" },
              });
            if (mode === "interrupted")
              seedEvent(h.deps, {
                threadId: thread.id,
                sequence,
                type: "system/thread/interrupted",
                scope: threadScope(),
                data: { reason: "manual-stop" },
              });
            if (mode === "aborted") controller.abort();
            accept({ relationship: "self", role: null, isCurrent: () => true });
          },
        );
        let writes = 0;
        await expect(
          withQuestionResolutionActor(
            h.db,
            thread.id,
            {
              threadId: thread.id,
              turnId: "live",
              providerThreadId: "p",
              signal: controller.signal,
            },
            () => writes++,
          ),
        ).rejects.toThrow(/live|interrupted/);
        expect(writes).toBe(0);
      });
    },
  );
  it.each(["valid", "sibling", "reparented"])(
    "checks the actual host parent path for %s grants",
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
          parentThreadId: mode === "sibling" ? null : thread.id,
        });
        const hostChain = [thread, target].map((row) => ({
          id: row.id,
          projectId: row.projectId,
          parentThreadId: row.parentThreadId,
          archived: false,
        }));
        dispose = registerQuestionResolutionScope(
          "wprojects",
          async (_context, accept) => {
            if (mode === "reparented")
              h.db
                .update(threads)
                .set({ parentThreadId: null })
                .where(eq(threads.id, target.id))
                .run();
            accept({
              relationship: "ancestor",
              role: "coordinator",
              hostChain,
              isCurrent: () => true,
            });
          },
        );
        const commit = () =>
          withQuestionResolutionActor(
            h.db,
            target.id,
            { threadId: thread.id, turnId: "live", providerThreadId: "p" },
            (actor) => actor,
          );
        if (mode === "valid")
          expect(await commit()).toMatchObject({
            kind: "agent",
            role: "coordinator",
            threadId: thread.id,
          });
        else await expect(commit()).rejects.toThrow(/descendant|ancestry/);
      });
    },
  );
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
              hostChain: [thread, target].map((row) => ({
                id: row.id,
                projectId: row.projectId,
                parentThreadId: row.parentThreadId,
                archived: row.archivedAt !== null,
              })),
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
