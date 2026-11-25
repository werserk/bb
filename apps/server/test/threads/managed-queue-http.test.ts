import { join } from "node:path";
import {
  claimQueuedThreadMessageGroup,
  createConnection,
  getQueuedThreadMessage,
  getThread,
  listEvents,
  readPlacementDispatchReceipt,
  setQueuedThreadMessageGroupBoundary,
  type DbConnection,
} from "@bb/db";
import { expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import { PendingInteractionLifecycle } from "../../src/services/interactions/pending-interactions.js";
import * as runtime from "../../src/services/threads/managed-execution.js";
import * as dispatch from "../../src/services/threads/queued-message-dispatch.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { createUserQuestionPayload } from "../helpers/pending-interactions.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedQueuedMessage,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function changes(db: DbConnection) {
  return db.$client.prepare("SELECT total_changes()").pluck().get();
}

it("reads the authorized consumed group during a later question and gates new input", async () => {
  await withTestHarness(async (h) => {
    const f = seedManagedGroup(h, { third: true, firstInputShape: "grouped" });
    const [head, second, pending] = f.queueIds as [string, string, string];
    expect(
      setQueuedThreadMessageGroupBoundary({
        db: h.db,
        notifier: h.hub,
        threadId: f.threadId,
        expectedGroupedPrefixQueuedMessageIds: [head, second],
        groupBoundaryQueuedMessageId: second,
      }).kind,
    ).toBe("updated");
    const entry = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
    try {
      const initial = await f.send();
      const original = await initial.json();
      expect(initial.status).toBe(409);
      expect(original).toMatchObject({
        details: {
          state: "refused_unsent",
          sourceQueuedMessageIds: [head, second],
        },
      });
      expect(entry).toHaveBeenCalledTimes(1);
      const key = {
        threadId: f.threadId,
        requestId: original.details.requested.requestId,
      };
      const receipt = readPlacementDispatchReceipt(h.db, key)!;
      if ("rejectionEventId" in receipt) {
        const rejection = listEvents(h.db, { threadId: f.threadId }).find(
          (event) =>
            event.type === "client/turn/rejected" &&
            JSON.parse(event.data).requestId === key.requestId,
        );
        expect(rejection).toBeDefined();
        expect(receipt.rejectionEventId).toBe(rejection!.id);
        expect(original.code).toBe("managed_execution_unsupported");
      } else {
        expect(original.code).toBe("placement_dispatch_recorded");
      }
      const path = join(h.config.dataDir, "pending-replay.sqlite");
      await h.db.$client.backup(path);
      const db = createConnection(path);
      try {
        const pendingInteractions = new PendingInteractionLifecycle({
          ...h.deps,
          db,
        });
        const app = createApp({ ...h.deps, db, pendingInteractions }).app;
        const turn = {
          threadId: f.threadId,
          turnId: "later-turn",
          providerThreadId: "guest-session-worker",
        };
        seedTurnStarted({ db, hub: h.hub }, turn);
        expect(
          pendingInteractions.registerPendingInteraction({
            interaction: {
              ...turn,
              providerId: "claude-code",
              providerRequestId: "fixture-question",
              payload: createUserQuestionPayload(),
            },
          }).outcome,
        ).toBe("created");
        const events = listEvents(db, { threadId: f.threadId });
        const wake = vi.spyOn(dispatch, "requestQueuedMessageDispatch");
        const notify = vi.spyOn(h.hub, "notifyThread");
        try {
          const before = changes(db);
          for (const id of [head, second]) {
            const replay = await f.send(app, id);
            expect(replay.status).toBe(initial.status);
            expect(await replay.json()).toEqual(original);
          }
          const deniedBody = {
            code: "invalid_request",
            message: "Queued message not found",
          };
          for (const id of [
            head,
            second,
            pending,
            "qsub_" + crypto.randomUUID(),
          ]) {
            for (const scope of [null, "wrong"]) {
              const denied = await f.send(app, id, scope);
              expect(denied.status).toBe(404);
              expect(await denied.json()).toEqual(deniedBody);
            }
          }
          const inaccessible = await f.send(
            app,
            head,
            "local",
            {},
            "thr_missing",
          );
          expect(inaccessible.status).toBe(404);
          expect((await inaccessible.json()).code).toBe("thread_not_found");
          const fresh = await f.send(app, pending);
          expect(fresh.status).toBe(409);
          expect((await fresh.json()).code).toBe("awaiting_user_interaction");
          expect(changes(db)).toEqual(before);
          expect(notify).not.toHaveBeenCalled();
          expect(getQueuedThreadMessage(db, pending)?.claimToken).toBeNull();
          const [held] = claimQueuedThreadMessageGroup(db, h.hub, pending, {
            kind: "explicit-send",
          })!;
          const afterClaim = changes(db);
          notify.mockClear();
          const denied = await f.send(app, pending, "wrong");
          expect(denied.status).toBe(404);
          expect(await denied.json()).toEqual(deniedBody);
          expect(changes(db)).toEqual(afterClaim);
          expect(getQueuedThreadMessage(db, pending)?.claimToken).toBe(
            held!.claimToken,
          );
          expect(readPlacementDispatchReceipt(db, key)).toEqual(receipt);
          expect(listEvents(db, { threadId: f.threadId })).toEqual(events);
          expect(entry).toHaveBeenCalledTimes(1);
          expect(wake).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
          expect(
            listQueuedThreadCommands(h, "turn.submit", f.threadId),
          ).toHaveLength(0);
        } finally {
          wake.mockRestore();
          notify.mockRestore();
        }
      } finally {
        db.$client.close();
      }
    } finally {
      entry.mockRestore();
    }
  });
});

it("checks a boundary target's thread before an unrelated managed claim", async () => {
  await withTestHarness(async (h) => {
    const f = seedManagedGroup(h, { third: true });
    const other = seedThread(h.deps, {
      projectId: getThread(h.db, f.threadId)!.projectId,
    });
    const foreign = seedQueuedMessage(h.deps, {
      threadId: other.id,
      content: textInput("one"),
    });
    const extra = seedQueuedMessage(h.deps, {
      threadId: other.id,
      content: textInput("two"),
    });
    const missing = "qsub_" + crypto.randomUUID();
    const patch = (threadId: string, target: string, prefix = [target]) =>
      h.app.request(
        `/api/v1/threads/${threadId}/queued-messages/group-boundary`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            groupBoundaryQueuedMessageId: target,
            expectedGroupedPrefixQueuedMessageIds: prefix,
          }),
        },
      );
    const [head, follower] = f.queueIds as [string, string, ...string[]];
    expect(
      claimQueuedThreadMessageGroup(h.db, h.hub, follower, {
        kind: "explicit-send",
      })?.map((r) => r.id),
    ).toEqual([follower]);
    const before = changes(h.db);
    for (const id of [foreign.id, missing]) {
      const missingResponse = await patch(f.threadId, id);
      expect(missingResponse.status).toBe(404);
      expect(await missingResponse.json()).toEqual({
        code: "invalid_request",
        message: "Queued message not found",
      });
    }
    for (const id of [follower, head]) {
      const blocked = await patch(f.threadId, id);
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toEqual({
        code: "invalid_request",
        message: "Queued message is already being sent",
      });
    }
    expect(changes(h.db)).toEqual(before);
    const grouped = await patch(other.id, extra.id, [foreign.id, extra.id]);
    expect(grouped.status).toBe(200);
    expect(getQueuedThreadMessage(h.db, foreign.id)?.groupWithNext).toBe(true);
    const absent = await patch(other.id, follower);
    expect(absent.status).toBe(404);
  });
});
