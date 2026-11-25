import { join } from "node:path";
import {
  claimQueuedThreadMessageGroup,
  createConnection,
  readPlacementDispatchReceipt,
  setQueuedThreadMessageGroupBoundary,
} from "@bb/db";
import { expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import * as runtime from "../../src/services/threads/managed-execution.js";
import * as dispatch from "../../src/services/threads/queued-message-dispatch.js";
import { seedManagedGroup } from "../helpers/managed-ordinary-queue.js";
import { withTestHarness } from "../helpers/test-app.js";

it.each(["live", "claimed", "consumed"] as const)(
  "checks the foreign follower before reading history for the authorized head (%s)",
  async (stage) => {
    await withTestHarness(async (h) => {
      const consumed = stage === "consumed";
      const f = seedManagedGroup(h, {
        secondPrincipal: consumed ? "local" : "foreign",
      });
      if (consumed) {
        const first = await f.send();
        expect(first.status).toBe(409);
        expect((await first.json()).details.state).toBe("refused_unsent");
      } else if (stage === "claimed") {
        expect(
          claimQueuedThreadMessageGroup(h.db, h.hub, f.queueIds[0]!, {
            kind: "explicit-send",
          })?.map((row) => row.id),
        ).toEqual(f.queueIds);
      }
      const path = join(h.config.dataDir, "scope.sqlite");
      await h.db.$client.backup(path);
      const statements: string[] = [];
      const db = createConnection(path, {
        slowQueryThresholdMs: 0,
        slowQueryLogger: {
          info(fields) {
            statements.push(fields.sql);
          },
        },
      });
      try {
        if (consumed) {
          // Admission prevents mixed-authority receipts. Shadow only this connection's
          // ownership projection to exercise a consumed group with a foreign sibling.
          db.$client.exec(
            "CREATE TEMP TABLE fixture_foreign_member(op TEXT PRIMARY KEY)",
          );
          db.$client
            .prepare("INSERT INTO fixture_foreign_member VALUES (?)")
            .run(f.members[1]!.id);
          db.$client.exec(`CREATE TEMP VIEW placement_action_identity AS
            SELECT i.op, i.native_protocol, i.submission_uuid,
              CASE WHEN f.op IS NULL THEN i.authority ELSE json_set(i.authority,'$.principal','foreign') END AS authority
            FROM main.placement_action_identity i LEFT JOIN fixture_foreign_member f ON f.op=i.op`);
        }
        const { app } = createApp({ ...h.deps, db });
        const handoff = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
        const wake = vi.spyOn(dispatch, "requestQueuedMessageDispatch");
        const notify = vi.spyOn(h.hub, "notifyThread");
        try {
          const changes = () =>
            db.$client.prepare("SELECT total_changes()").pluck().get();
          const before = changes();
          const missing = await f.send(app, "qsub_" + crypto.randomUUID());
          const missingBody = await missing.json();
          expect(missing.status).toBe(404);
          for (const id of f.queueIds) {
            statements.length = 0;
            const denied = await f.send(app, id);
            expect(denied.status).toBe(missing.status);
            expect(await denied.json()).toEqual(missingBody);
            expect(
              statements.some((s) => s.includes('"placement_action_identity"')),
            ).toBe(true);
            const forbiddenReads = statements.filter(
              (s) =>
                /(?:from|join) "(?:placement_effect|placement_step)"/i.test(
                  s,
                ) ||
                /"(?:prepared_request|queue_digest|queue_ordinal|ordinal|attempt|rejection_reason|native_protocol|submission_uuid)"/.test(
                  s,
                ) ||
                (s.includes('from "queued_thread_messages"') &&
                  s.includes('"content"')) ||
                (s.includes('from "events"') && s.includes('"data"')),
            );
            expect(forbiddenReads).toEqual([]);
          }
          expect(changes()).toBe(before);
          expect(handoff).not.toHaveBeenCalled();
          expect(wake).not.toHaveBeenCalled();
          expect(notify).not.toHaveBeenCalled();
        } finally {
          notify.mockRestore();
          wake.mockRestore();
          handoff.mockRestore();
        }
      } finally {
        db.$client.close();
      }
    });
  },
);

it("loads the authorized group only after both member checks and commits its ordered receipt", async () => {
  await withTestHarness(async (h) => {
    const f = seedManagedGroup(h);
    const path = join(h.config.dataDir, "authorized.sqlite");
    await h.db.$client.backup(path);
    const statements: string[] = [];
    const db = createConnection(path, {
      slowQueryThresholdMs: 0,
      slowQueryLogger: {
        info({ sql }) {
          statements.push(sql);
        },
      },
    });
    const handoff = vi.spyOn(runtime, "dispatchManagedOrdinaryTurn");
    try {
      const { app, placement } = createApp({ ...h.deps, db });
      const expectUnavailable = async () => {
        const changes = () =>
          db.$client.prepare("SELECT total_changes()").pluck().get();
        const before = changes();
        const blocked = await f.send(app);
        expect(blocked.status).toBe(409);
        expect((await blocked.json()).code).toBe(
          "placement_dispatch_unavailable",
        );
        expect(changes()).toBe(before);
        expect(handoff).not.toHaveBeenCalled();
      };
      await expectUnavailable();
      const owner = f.registerReopenedOwner(placement);
      await expectUnavailable();
      await owner.observeWorkers();
      statements.length = 0;
      const response = await f.send(app);
      const body = await response.json();
      const firstPayload = statements.findIndex(
        (s) =>
          s.includes('from "queued_thread_messages"') &&
          s.includes('"content"'),
      );
      expect(firstPayload).toBeGreaterThan(0);
      expect(
        statements
          .slice(0, firstPayload)
          .filter(
            (s) =>
              s.includes('from "placement_action_identity"') &&
              s.includes(
                'json_extract("placement_action_identity"."authority"',
              ),
          ),
      ).toHaveLength(f.queueIds.length);
      expect(response.status).toBe(409);
      expect(body.details).toMatchObject({
        state: "refused_unsent",
        sourceQueuedMessageIds: f.queueIds,
      });
      const key = {
        threadId: f.threadId,
        requestId: body.details.requested.requestId,
      };
      expect(
        readPlacementDispatchReceipt(db, key)?.members.map((m) => m.queueId),
      ).toEqual(f.queueIds);
      expect(handoff.mock.calls.map((call) => call[1])).toEqual([key]);
    } finally {
      handoff.mockRestore();
      db.$client.close();
    }
  });
});

it("keeps the same ordered group from authorization through claim while another connection tries to split it", async () => {
  await withTestHarness(async (h) => {
    const f = seedManagedGroup(h);
    const path = join(h.config.dataDir, "claim-lock.sqlite");
    await h.db.$client.backup(path);
    const db = createConnection(path);
    const rival = createConnection(path);
    const phases: string[] = [];
    try {
      rival.$client.pragma("busy_timeout = 0");
      const claimed = claimQueuedThreadMessageGroup(db, h.hub, f.queueIds[0]!, {
        kind: "explicit-send",
        authorizeMembers(_tx, members) {
          phases.push("authorize");
          expect(members).toEqual(
            f.members.map((m, i) => ({
              id: f.queueIds[i],
              threadId: f.threadId,
              placementOperationId: m.id,
            })),
          );
          expect(() =>
            setQueuedThreadMessageGroupBoundary({
              db: rival,
              notifier: h.hub,
              threadId: f.threadId,
              groupBoundaryQueuedMessageId: f.queueIds[0]!,
              expectedGroupedPrefixQueuedMessageIds: [f.queueIds[0]!],
            }),
          ).toThrow(/locked|busy/i);
        },
        assertGroupAllowed(_tx, rows) {
          phases.push("hydrate");
          expect(rows.map((row) => row.id)).toEqual(f.queueIds);
          expect(rows.every((row) => row.content.length > 0)).toBe(true);
        },
      });
      expect(phases).toEqual(["authorize", "hydrate"]);
      expect(claimed?.map((row) => row.id)).toEqual(f.queueIds);
      expect(new Set(claimed?.map((row) => row.claimToken)).size).toBe(1);
    } finally {
      rival.$client.close();
      db.$client.close();
    }
  });
});
