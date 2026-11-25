import { join } from "node:path";
import {
  createConnection,
  deleteThreadEventSuffixInTransaction,
  getLatestThreadSequence,
  listEvents,
  readPlacementDispatchReceipt,
} from "@bb/db";
import { flattenPromptInputGroups, threadScope } from "@bb/domain";
import { it, expect, vi } from "vitest";
import { createApp } from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";
import { appendThreadEventInTransaction } from "../../src/services/threads/thread-events.js";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness } from "../helpers/test-app.js";

it.each(["missing", "replacement request", "replacement rejection"] as const)(
  "preserves scoped replay across a native history edit: %s",
  async (edit) => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h);
      const handoff = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
      try {
        const response = await f.send();
        const original = await response.json();
        expect(response.status).toBe(409);
        expect(original.details.state).toBe("refused_unsent");
        const key = {
          threadId: f.threadId,
          requestId: original.details.requested.requestId,
        };
        const receipt = readPlacementDispatchReceipt(h.db, key)!;
        const history = listEvents(h.db, { threadId: f.threadId });
        const requested = history.find((e) => e.id === receipt.eventId)!;
        const rejected = history.find(
          (e) =>
            e.type === "client/turn/rejected" &&
            JSON.parse(e.data).requestId === key.requestId,
        )!;
        expect(JSON.parse(rejected.data).reason).toBe(
          "managed_execution_unsupported",
        );
        const hasRejectionIdentity = "rejectionEventId" in receipt;
        if (hasRejectionIdentity)
          expect(receipt.rejectionEventId).toBe(rejected.id);
        const originalCode = hasRejectionIdentity
          ? "managed_execution_unsupported"
          : "placement_dispatch_recorded";
        const onlyRejection = edit === "replacement rejection";
        h.db.transaction((tx) => {
          deleteThreadEventSuffixInTransaction(tx, {
            threadId: f.threadId,
            cutoffSequence: onlyRejection
              ? rejected.sequence
              : requested.sequence,
            oldMaxSequence: getLatestThreadSequence(tx, {
              threadId: f.threadId,
            }),
          });
          if (edit === "missing") return;
          if (!onlyRejection) {
            const data = JSON.parse(requested.data);
            const groups = [
              textInput("replacement one"),
              textInput("replacement two"),
            ];
            expect(
              appendThreadEventInTransaction(tx, {
                threadId: f.threadId,
                scope: threadScope(),
                type: "client/turn/requested",
                data: {
                  ...data,
                  input: flattenPromptInputGroups(groups),
                  inputGroups: groups,
                },
              }),
            ).toBe(requested.sequence);
          }
          expect(
            appendThreadEventInTransaction(tx, {
              threadId: f.threadId,
              scope: threadScope(),
              type: "client/turn/rejected",
              data: {
                requestId: key.requestId,
                reason: "managed_admission_unavailable",
                message: "Replacement",
              },
            }),
          ).toBe(rejected.sequence);
        });
        const path = join(h.config.dataDir, "rewritten.sqlite");
        await h.db.$client.backup(path);
        const db = createConnection(path);
        try {
          const stored = readPlacementDispatchReceipt(db, key)!;
          expect(stored.eventId).toBe(receipt.eventId);
          expect(stored.liveEventId).toBe(
            onlyRejection ? receipt.eventId : null,
          );
          const app = createApp({ ...h.deps, db }).app;
          const changes = () =>
            db.$client.prepare("SELECT total_changes()").pluck().get();
          const before = changes();
          for (const id of f.queueIds) {
            const denied = await f.send(app, id, "another");
            expect(denied.status).toBe(404);
            expect(await denied.json()).toEqual({
              code: "invalid_request",
              message: "Queued message not found",
            });
            const replay = await f.send(app, id);
            const body = await replay.json();
            expect(replay.status).toBe(409);
            if (onlyRejection) {
              // A replacement rejection cannot supply the original action's reason.
              expect(body.code).toBe(originalCode);
              expect(body.details.state).toBe("refused_unsent");
            } else expect(body.code).toBe("placement_dispatch_unavailable");
          }
          expect(changes()).toEqual(before);
          expect(handoff).toHaveBeenCalledTimes(1);
        } finally {
          db.$client.close();
        }
      } finally {
        handoff.mockRestore();
      }
    });
  },
);
