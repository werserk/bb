import { flattenPromptInputGroups } from "@bb/domain";
import { textInput } from "../helpers/prompt-input.js";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  beginPlacementReclaim,
  finishPlacementReclaim,
  recordPlacementRuntimeState,
  readPlacementWorker,
  readPlacementAdmittedExecution,
  type DbConnection,
  readPlacementOperationRecord,
  preparePlacementExecutionCommand,
  claimPlacementExecutionCommand,
  settlePlacementExecutionCommand,
  createConnection,
  claimQueuedThreadMessageGroup,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  releaseStaleQueuedMessageClaims,
  deleteQueuedThreadMessage,
  getQueuedThreadMessage,
  getThread,
  listEvents,
  listStoredTurnRejectedRowsByClientRequestIds,
  queuedThreadMessages,
  placementWorkers,
  readPlacementDispatchReceipt,
  readPlacementQueueAttempts,
  setQueuedThreadMessageGroupBoundary,
  reservePlacementWorker,
} from "@bb/db";
import {
  seedManagedGroup,
  ownerPluginId,
  purpose,
} from "../helpers/managed-ordinary-queue.js";
import { createDeferredPromise } from "@bb/test-helpers";
import * as threadCommands from "../../src/services/threads/thread-commands.js";
import { withQuestionResolutionInvocation } from "../../src/services/threads/question-resolution-context.js";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server.js";
import * as managedRuntime from "../../src/services/threads/managed-execution.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("ordinary placement Send now", () => {
  it("retains a grouped native request across unsupported handoff and HTTP replay after reopen", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h);
      const handoff = vi.spyOn(managedRuntime, "dispatchManagedOrdinaryTurn");
      const prior = listEvents(h.db, { threadId: f.threadId }).length;
      try {
        const response = await f.send();
        const first = await response.json();
        expect(response.status, JSON.stringify(first)).toBe(409);
        expect(first).toMatchObject({
          code: "managed_execution_unsupported",
          details: {
            state: "refused_unsent",
            sourceQueuedMessageIds: f.queueIds,
            submissionIds: f.members.map((m) => m.clientSubmissionId),
            requested: {
              requestId: expect.stringMatching(/^creq_/),
              sequence: expect.any(Number),
            },
          },
        });
        const key = {
          threadId: f.threadId,
          requestId: first.details.requested.requestId,
        };
        expect(handoff).toHaveBeenCalledTimes(1);
        expect(handoff.mock.calls[0]?.[1]).toEqual(key);
        const receipt = readPlacementDispatchReceipt(h.db, key);
        const rejected = listStoredTurnRejectedRowsByClientRequestIds(h.db, {
          threadId: key.threadId,
          clientRequestIds: [key.requestId],
          afterSequence: first.details.requested.sequence,
        });
        expect(rejected.map((row) => JSON.parse(row.data).reason)).toEqual([
          managedRuntime.MANAGED_EXECUTION_UNSUPPORTED,
        ]);
        expect(Object.keys(first.details).sort()).toEqual([
          "requested",
          "sourceQueuedMessageIds",
          "state",
          "submissionIds",
        ]);
        expect(receipt).toMatchObject({
          state: "refused_unsent",
          executionOwnerOperationId: f.resident.id,
          fence: f.fence,
          members: f.members.map((m, i) =>
            expect.objectContaining({
              op: m.id,
              ordinal: i,
              queueId: f.queueIds[i],
            }),
          ),
        });
        expect(
          listEvents(h.db, { threadId: f.threadId }).find(
            (row) => row.sequence === first.details.requested.sequence,
          )?.type,
        ).toBe("client/turn/requested");
        for (const id of f.queueIds)
          expect(getQueuedThreadMessage(h.db, id)).toBeNull();
        const path = join(h.config.dataDir, "reopen.sqlite");
        await h.db.$client.backup(path);
        const restored = createConnection(path);
        try {
          const { app } = createApp({ ...h.deps, db: restored });
          for (const scope of [null, "another"]) {
            const denied = await f.send(app, f.queueIds[1], scope);
            expect(denied.status).toBe(404);
            expect(await denied.json()).toEqual({
              code: "invalid_request",
              message: "Queued message not found",
            });
          }
          for (const id of f.queueIds) {
            const repeated = await f.send(app, id);
            expect(repeated.status).toBe(409);
            expect(await repeated.json()).toEqual(first);
            expect(readPlacementDispatchReceipt(restored, key)).toEqual(
              receipt,
            );
          }
          const additions = listEvents(restored, { threadId: f.threadId })
            .slice(prior)
            .map((e) => e.type);
          expect(
            additions.filter((kind) => kind === "client/turn/requested"),
          ).toHaveLength(1);
          expect(
            additions.filter((kind) => kind === "client/turn/rejected"),
          ).toHaveLength(1);
        } finally {
          restored.$client.close();
        }
        expect(handoff).toHaveBeenCalledTimes(1);
        expect(
          listQueuedThreadCommands(h, "turn.submit", f.threadId),
        ).toHaveLength(0);
        expect(
          listQueuedThreadCommands(h, "thread.start", f.threadId),
        ).toHaveLength(0);
      } finally {
        handoff.mockRestore();
      }
    });
  });
  it.each(["flat", "grouped"] as const)(
    "retains the prepared %s boundaries for identical native flat bytes",
    async (shape) => {
      await withTestHarness(async (h) => {
        const f = seedManagedGroup(h, { firstInputShape: shape });
        const inner = [textInput("left"), textInput("right")];
        const flat = flattenPromptInputGroups(inner);
        expect(
          JSON.parse(getQueuedThreadMessage(h.db, f.queueIds[0]!)!.content),
        ).toEqual(flat);
        const response = await f.send();
        const body = await response.json();
        expect(body.code, JSON.stringify(body)).toBe(
          "managed_execution_unsupported",
        );
        const requested = listEvents(h.db, { threadId: f.threadId }).find(
          (event) => event.sequence === body.details.requested.sequence,
        );
        const groups = [
          ...(shape === "grouped" ? inner : [flat]),
          f.members[1]!.input,
        ];
        expect(JSON.parse(requested!.data)).toMatchObject({
          input: flattenPromptInputGroups(groups),
          inputGroups: groups,
          clientSubmissions: f.members.map((m, i) => ({
            id: m.clientSubmissionId,
            inputGroupIndex: i === 0 ? 0 : groups.length - 1,
          })),
        });
      });
    },
  );
  it("refuses a changed separator of the same length before claiming any row", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h, { firstInputShape: "grouped" });
      const flat = flattenPromptInputGroups([
        textInput("left"),
        textInput("right"),
      ]);
      flat[1] = textInput("  ")[0]!;
      h.db
        .update(queuedThreadMessages)
        .set({ content: JSON.stringify(flat) })
        .where(eq(queuedThreadMessages.id, f.queueIds[0]!))
        .run();
      h.db.run(
        sql.raw(
          "CREATE TRIGGER no_claim BEFORE UPDATE OF claim_token ON queued_thread_messages WHEN new.claim_token IS NOT NULL BEGIN SELECT RAISE(ABORT,'unexpected claim'); END",
        ),
      );
      const before = listEvents(h.db, { threadId: f.threadId });
      const response = await f.send();
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(
        "placement_dispatch_unavailable",
      );
      for (const id of f.queueIds) {
        expect(getQueuedThreadMessage(h.db, id)?.claimToken).toBeNull();
        expect(readPlacementQueueAttempts(h.db, id)[0]?.request).toBeNull();
      }
      expect(listEvents(h.db, { threadId: f.threadId })).toEqual(before);
      expect(
        listQueuedThreadCommands(h, "turn.submit", f.threadId),
      ).toHaveLength(0);
    });
  });
  it.each([
    "absent",
    "wrong-principal",
    "mixed-members",
    "known-plugin",
    "known-agent",
    "expired-agent",
    "invalid-caller",
    "spoof",
  ] as const)(
    "does not change the group or disclose a receipt for %s",
    async (fault) => {
      await withTestHarness(async (h) => {
        const f = seedManagedGroup(h, {
          secondPrincipal: fault === "mixed-members" ? "another" : "local",
        });
        const readBefore = () =>
          f.queueIds.map((id) => getQueuedThreadMessage(h.db, id));
        const before = readBefore();
        const eventsBefore = listEvents(h.db, { threadId: f.threadId });
        const scope =
          fault === "wrong-principal"
            ? "another"
            : fault === "absent" || fault === "spoof"
              ? null
              : "local";
        const headers: Record<string, string> =
          fault === "spoof"
            ? { "x-bb-placement-principal": "local" }
            : fault === "invalid-caller"
              ? { "x-bb-plugin-caller": "invalid-fixture" }
              : {};
        const caller =
          fault === "known-plugin"
            ? vi.spyOn(h.pluginService, "resolveRpcCaller").mockReturnValue({
                ok: true,
                caller: { kind: "plugin", pluginId: "test" },
              })
            : null;
        try {
          // A follower Send now would normally split the group before dispatch.
          const send = async () => f.send(h.app, f.queueIds[1], scope, headers);
          const response =
            fault === "known-agent" || fault === "expired-agent"
              ? await withQuestionResolutionInvocation(
                  {
                    threadId: "agent",
                    turnId: "turn",
                    providerThreadId: "session",
                  },
                  fault === "expired-agent"
                    ? AbortSignal.abort()
                    : new AbortController().signal,
                  send,
                )
              : await send();
          const missing = await f.send(
            h.app,
            "qsub_" + crypto.randomUUID(),
            scope,
            headers,
          );
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual(await missing.json());
          expect(readBefore()).toEqual(before);
          expect(listEvents(h.db, { threadId: f.threadId })).toEqual(
            eventsBefore,
          );
          expect(
            listQueuedThreadCommands(h, "turn.submit", f.threadId),
          ).toHaveLength(0);
        } finally {
          caller?.mockRestore();
        }
      });
    },
  );
  it.each(["sql-failure", "owner-changed", "scope-changed"] as const)(
    "keeps A–B–C grouped through %s and consumes only B after reopening",
    async (fault) => {
      await withTestHarness(async (h) => {
        const f = seedManagedGroup(h, { third: true });
        const [a, b, c] = f.queueIds as [string, string, string];
        const before = listEvents(h.db, { threadId: f.threadId });
        const originalScope = h.deps.resolvePlacementSendScope!;
        if (fault === "sql-failure") {
          h.db.run(
            sql.raw(
              "CREATE TRIGGER follower_fault BEFORE DELETE ON queued_thread_messages BEGIN SELECT RAISE(ABORT,'fixture consumption failure'); END",
            ),
          );
        } else if (fault === "owner-changed") {
          h.db.run(
            sql.raw(
              "CREATE TRIGGER follower_fault AFTER INSERT ON events WHEN new.type='client/turn/requested' BEGIN UPDATE placement_worker SET owner_operation_id=(SELECT placement_operation_id FROM queued_thread_messages WHERE state='claimed' LIMIT 1); END",
            ),
          );
        } else {
          let reads = 0;
          h.deps.resolvePlacementSendScope = (req) =>
            ++reads === 1 ? originalScope(req) : null;
        }
        const response = await f.send(h.app, b);
        expect(response.status).toBe(
          fault === "sql-failure" ? 500 : fault === "owner-changed" ? 409 : 404,
        );
        expect(listEvents(h.db, { threadId: f.threadId })).toEqual(before);
        const path = join(h.config.dataDir, "follower-reopen.sqlite");
        await h.db.$client.backup(path);
        const db = createConnection(path);
        try {
          expect(
            [a, b, c].map(
              (id) => getQueuedThreadMessage(db, id)?.groupWithNext,
            ),
          ).toEqual([true, true, false]);
          for (const id of [a, b, c]) {
            expect(getQueuedThreadMessage(db, id)?.claimToken).toBeNull();
            expect(readPlacementQueueAttempts(db, id)).toMatchObject([
              { request: null },
            ]);
          }
          expect(
            listQueuedThreadCommands(h, "turn.submit", f.threadId),
          ).toHaveLength(0);
          if (fault !== "scope-changed")
            db.run(sql.raw("DROP TRIGGER follower_fault"));
          const { app } = createApp({
            ...h.deps,
            db,
            resolvePlacementSendScope: originalScope,
          });
          const resent = await f.send(app, b);
          const body = await resent.json();
          expect(resent.status, JSON.stringify(body)).toBe(409);
          expect(body).toMatchObject({
            code: "managed_execution_unsupported",
            details: { sourceQueuedMessageIds: [b], state: "refused_unsent" },
          });
          expect(getQueuedThreadMessage(db, b)).toBeNull();
          expect(
            [a, c].map((id) => getQueuedThreadMessage(db, id)?.groupWithNext),
          ).toEqual([false, false]);
          expect(readPlacementQueueAttempts(db, a)[0]?.request).toBeNull();
          expect(readPlacementQueueAttempts(db, c)[0]?.request).toBeNull();
        } finally {
          db.$client.close();
        }
      });
    },
  );
  it("releases a crashed follower claim intact and fences its token after reopen", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h, { third: true });
      const [a, b, c] = f.queueIds as [string, string, string];
      const held = claimQueuedThreadMessageGroup(h.db, h.hub, b, {
        kind: "explicit-send",
      })!;
      expect(held.map((row) => row.id)).toEqual([b]);
      const path = join(h.config.dataDir, "recover-claim.sqlite");
      await h.db.$client.backup(path);
      const db = createConnection(path);
      try {
        expect(
          releaseStaleQueuedMessageClaims(db, h.hub, {
            claimedBefore: held[0]!.claimedAt + 1,
            protectedClaimTokens: [],
          }),
        ).toBe(1);
        expect(
          [a, b, c].map((id) => getQueuedThreadMessage(db, id)?.groupWithNext),
        ).toEqual([true, true, false]);
        const next = claimQueuedThreadMessageGroup(db, h.hub, b, {
          kind: "explicit-send",
        })!;
        expect(next[0]!.claimToken).not.toBe(held[0]!.claimToken);
        expect(
          db.transaction((tx) =>
            deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
              queuedMessages: held,
            }),
          ),
        ).toBe(false);
        expect(getQueuedThreadMessage(db, b)?.claimToken).toBe(
          next[0]!.claimToken,
        );
        expect(readPlacementQueueAttempts(db, b)[0]?.request).toBeNull();
      } finally {
        db.$client.close();
      }
    });
  });
  it("orders a follower claim against edits and another Send now on a second connection", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h, { third: true });
      const [a, b, c] = f.queueIds as [string, string, string];
      const path = join(h.config.dataDir, "race.sqlite");
      await h.db.$client.backup(path);
      const writer = createConnection(path);
      const competitor = createConnection(path);
      try {
        const first = createApp({ ...h.deps, db: writer }).app;
        const second = createApp({ ...h.deps, db: competitor }).app;
        const paused = createDeferredPromise<void>();
        const resume = createDeferredPromise<void>();
        const build = threadCommands.buildExecutionOptions;
        const spy = vi
          .spyOn(threadCommands, "buildExecutionOptions")
          .mockImplementationOnce(async (...args) => {
            paused.resolve();
            await resume.promise;
            return build(...args);
          });
        const flight = f.send(first, b);
        try {
          await paused.promise;
          expect(getQueuedThreadMessage(competitor, b)?.state).toBe("claimed");
          expect((await f.send(second, a)).status).toBe(409);
          expect(
            setQueuedThreadMessageGroupBoundary({
              db: competitor,
              notifier: h.hub,
              threadId: f.threadId,
              groupBoundaryQueuedMessageId: a,
              expectedGroupedPrefixQueuedMessageIds: [a],
            }).kind,
          ).toBe("claimed");
          // A concurrent removal of C changes the B-to-C edge. B's failing send must preserve the edit.
          expect(deleteQueuedThreadMessage(competitor, h.hub, c)).toBe(true);
        } finally {
          resume.resolve();
          spy.mockRestore();
        }
        const failed = await flight;
        expect(failed.status).toBe(409);
        expect(getQueuedThreadMessage(writer, b)?.claimToken).toBeNull();
        expect(
          [a, b].map((id) => getQueuedThreadMessage(writer, id)?.groupWithNext),
        ).toEqual([true, false]);
        expect(getQueuedThreadMessage(writer, c)).toBeNull();
        expect(readPlacementQueueAttempts(writer, b)).toMatchObject([
          { request: null },
        ]);
        expect(
          listQueuedThreadCommands(h, "turn.submit", f.threadId),
        ).toHaveLength(0);
      } finally {
        competitor.$client.close();
        writer.$client.close();
      }
    });
  });
  it.each(["compatible", "incompatible"] as const)(
    "orders a group around an older %s independent operation",
    async (intervening) => {
      await withTestHarness(async (h) => {
        const f = seedManagedGroup(h, { intervening });
        const [head, follower] = f.queueIds;
        const first = await f.send();
        expect(first.status).toBe(409);
        const expected =
          intervening === "compatible" ? [head] : [head, follower];
        expect(await first.json()).toMatchObject({
          code: "managed_execution_unsupported",
          details: {
            sourceQueuedMessageIds: expected,
            state: "refused_unsent",
          },
        });
        const middle = await f.sendMiddle();
        expect(middle.response.status).toBe(409);
        expect(await middle.response.json()).toMatchObject({
          code: "managed_execution_unsupported",
          details: { sourceQueuedMessageIds: [middle.qid] },
        });
        if (intervening === "compatible") {
          expect(
            readPlacementQueueAttempts(h.db, follower!)[0]?.request,
          ).toBeNull();
          const last = await f.send(h.app, follower);
          expect(await last.json()).toMatchObject({
            code: "managed_execution_unsupported",
            details: { sourceQueuedMessageIds: [follower] },
          });
        }
      });
    },
  );
  it("preserves the edge between both members of a released suffix", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h, { intervening: "compatible", third: true });
      const [head, second, third] = f.queueIds;
      expect(await (await f.send()).json()).toMatchObject({
        code: "managed_execution_unsupported",
        details: { sourceQueuedMessageIds: [head] },
      });
      expect(getQueuedThreadMessage(h.db, second!)?.groupWithNext).toBe(true);
      expect((await f.sendMiddle()).response.status).toBe(409);
      expect(await (await f.send(h.app, second)).json()).toMatchObject({
        code: "managed_execution_unsupported",
        details: { sourceQueuedMessageIds: [second, third] },
      });
    });
  });
  it("recovers the released suffix after reopen and refuses a competing same-fence transfer", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h, { intervening: "compatible" });
      const [head, tail] = f.queueIds as [string, string];
      const gate = createDeferredPromise<void>();
      const resume = createDeferredPromise<void>();
      const build = threadCommands.buildExecutionOptions;
      const prep = vi
        .spyOn(threadCommands, "buildExecutionOptions")
        .mockImplementation(async (...args) => {
          if (
            getQueuedThreadMessage(h.db, head)?.state === "claimed" &&
            !getQueuedThreadMessage(h.db, tail)?.claimToken
          ) {
            gate.resolve();
            await resume.promise;
          }
          return build(...args);
        });
      const sending = f.send();
      const path = join(h.config.dataDir, "retained-head.sqlite");
      try {
        await gate.promise;
        await h.db.$client.backup(path);
        expect((await f.send(h.app, tail)).status).toBe(409);
        h.db
          .update(placementWorkers)
          .set({ ownerOperationId: f.members[1]!.id })
          .where(eq(placementWorkers.workerId, f.workerId))
          .run();
      } finally {
        resume.resolve();
        prep.mockRestore();
      }
      const denied = await sending;
      expect(denied.status).toBe(409);
      expect(await denied.json()).toMatchObject({
        code: "placement_dispatch_unavailable",
      });
      expect(readPlacementQueueAttempts(h.db, head)[0]?.request).toBeNull();
      const reopened = createConnection(path);
      try {
        const held = getQueuedThreadMessage(reopened, head)!;
        expect(held.claimToken).toBeTruthy();
        expect(getQueuedThreadMessage(reopened, tail)?.claimToken).toBeNull();
        expect(
          releaseStaleQueuedMessageClaims(reopened, h.hub, {
            claimedBefore: held.claimedAt! + 1,
            protectedClaimTokens: [],
          }),
        ).toBe(1);
        const app = createApp({ ...h.deps, db: reopened }).app;
        const replay = await f.send(app, head);
        expect(await replay.json()).toMatchObject({
          code: "managed_execution_unsupported",
          details: { sourceQueuedMessageIds: [head] },
        });
        expect(
          readPlacementQueueAttempts(reopened, tail)[0]?.request,
        ).toBeNull();
      } finally {
        reopened.$client.close();
      }
    });
  });

  it("requires a fresh reservation for the old follower qsub after single-worker reclaim", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h, {
        intervening: "compatible",
        singleWorker: true,
      });
      const [head, tail] = f.queueIds as [string, string];
      const provider = vi.fn();
      // A simulated Agent confirms the correlated effects. This test never issues a daemon RPC.
      const runtime = vi
        .spyOn(managedRuntime, "dispatchManagedOrdinaryTurn")
        .mockImplementation(async (deps, key) => {
          const admitted = readPlacementAdmittedExecution(deps.db, {
            ...key,
            purpose,
          });
          if (!admitted) throw new Error("Missing current fixture admission");
          const id = crypto.randomUUID();
          const command = {
            ...key,
            purpose,
            executionOwnerOperationId: admitted.executionOwnerOperationId,
            fence: admitted.fence,
            nativeExecutionId: id,
            commandId: id,
            agentHostId: f.agentHostId,
            agentSessionId: f.agentSessionId,
          };
          expect(preparePlacementExecutionCommand(deps.db, command).kind).toBe(
            "prepared",
          );
          expect(
            claimPlacementExecutionCommand(deps.db, {
              ...command,
              currentAgentSessionId: f.agentSessionId,
            }).kind,
          ).toBe("won");
          provider(
            admitted.members.map((m) => m.op),
            command.fence,
          );
          expect(
            deps.db.transaction((tx) =>
              settlePlacementExecutionCommand(tx, {
                ...command,
                outcome: "succeeded",
              }),
            ),
          ).toBe(true);
        });
      const candidate = (db: DbConnection, operationId: string) => ({
        operationId,
        expectedRevision: readPlacementOperationRecord(db, operationId)!
          .revision,
        ownerRevision: 1,
        workerId: f.workerId,
        workerRevision: 1,
        routeEvidenceRevision: 1,
        purpose,
      });
      function releaseTo(
        db: DbConnection,
        sourceId: string,
        threadId: string,
        fence: number,
        targetId: string,
        revision: number,
      ) {
        const worker = readPlacementWorker(db, ownerPluginId, f.workerId)!;
        const held = {
          ...worker.nativeCustody!,
          status: "held" as const,
          revision,
          holder: {
            threadId,
            fence,
            processStart: "fixture-start-" + fence,
            bootId: "fixture-boot",
          },
        };
        expect(
          recordPlacementRuntimeState(db, {
            ownerPluginId,
            workerId: f.workerId,
            operationId: sourceId,
            fence,
            custody: held,
            activity: "idle",
            backgroundWork: false,
            pendingInteraction: false,
          }),
        ).toMatchObject({ state: "resident" });
        expect(
          beginPlacementReclaim(db, {
            ...candidate(db, targetId),
            expectedSourceOperationId: sourceId,
            expectedSourceFence: fence,
          }).kind,
        ).toBe("reclaiming");
        expect(
          finishPlacementReclaim(db, {
            ownerPluginId,
            workerId: f.workerId,
            operationId: targetId,
            fence,
            closedSourceOperationId: sourceId,
            processClosed: true,
            observation: {
              ...held,
              status: "free",
              holder: null,
              revision: revision + 1,
            },
          }).kind,
        ).toBe("released");
      }
      try {
        const one = await f.send();
        const body = await one.json();
        expect(body).toMatchObject({
          delivery: "sent",
          sourceQueuedMessageIds: [head],
        });
        const other = f.middle!;
        releaseTo(h.db, f.resident.id, f.threadId, 1, other.id, 2);
        const second = f.attach(other, f.workerId);
        expect(second.fence).toBe(2);
        const qid = f.queueMember(other, second.threadId, second.fence);
        expect(
          await (await f.send(h.app, qid, "local", {}, second.threadId)).json(),
        ).toMatchObject({ delivery: "sent", sourceQueuedMessageIds: [qid] });
        const path = join(h.config.dataDir, "single-worker.sqlite");
        await h.db.$client.backup(path);
        const restored = createConnection(path);
        try {
          const app = createApp({ ...h.deps, db: restored }).app;
          const stale = await f.send(app, tail);
          expect(stale.status).toBe(409);
          expect(await stale.json()).toMatchObject({
            code: "placement_dispatch_unavailable",
          });
          expect(
            readPlacementQueueAttempts(restored, tail)[0]?.request,
          ).toBeNull();
          const last = f.members[1]!;
          releaseTo(restored, other.id, second.threadId, 2, last.id, 4);
          expect(
            reservePlacementWorker(restored, candidate(restored, last.id)),
          ).toMatchObject({ kind: "reserved", fence: 3 });
          const three = await f.send(app, tail);
          const receipt = await three.json();
          expect(receipt).toMatchObject({
            delivery: "sent",
            sourceQueuedMessageIds: [tail],
          });
          expect(
            readPlacementDispatchReceipt(restored, {
              threadId: f.threadId,
              requestId: receipt.requested.requestId,
            }),
          ).toMatchObject({
            executionOwnerOperationId: last.id,
            fence: 3,
            state: "succeeded",
            members: [expect.objectContaining({ queueId: tail, attempt: 0 })],
          });
          expect(provider.mock.calls).toEqual([
            [[f.resident.id], 1],
            [[other.id], 2],
            [[last.id], 3],
          ]);
        } finally {
          restored.$client.close();
        }
      } finally {
        runtime.mockRestore();
      }
    });
  });

  it.each([0, 1])(
    "keeps possibly_sent after reopen with %i external fixture calls",
    async (count) => {
      await withTestHarness(async (h) => {
        const f = seedManagedGroup(h);
        const provider = vi.fn();
        const runtime = vi
          .spyOn(managedRuntime, "dispatchManagedOrdinaryTurn")
          .mockImplementationOnce(async (deps, key) => {
            const admitted = readPlacementAdmittedExecution(deps.db, {
              ...key,
              purpose,
            })!;
            const id = crypto.randomUUID();
            const command = {
              ...key,
              purpose,
              executionOwnerOperationId: admitted.executionOwnerOperationId,
              fence: admitted.fence,
              nativeExecutionId: id,
              commandId: id,
              agentHostId: f.agentHostId,
              agentSessionId: f.agentSessionId,
            };
            expect(
              preparePlacementExecutionCommand(deps.db, command).kind,
            ).toBe("prepared");
            expect(
              claimPlacementExecutionCommand(deps.db, {
                ...command,
                currentAgentSessionId: f.agentSessionId,
              }).kind,
            ).toBe("won");
            if (count) provider(command.commandId);
            throw new Error("Fixture connection lost");
          });
        try {
          expect((await f.send()).status).toBe(500);
          const path = join(h.config.dataDir, "ambiguous.sqlite");
          await h.db.$client.backup(path);
          const restored = createConnection(path);
          try {
            const app = createApp({ ...h.deps, db: restored }).app;
            const replay = await f.send(app, f.queueIds[1]);
            expect(replay.status).toBe(409);
            expect(await replay.json()).toMatchObject({
              code: "placement_dispatch_recorded",
              details: {
                state: "possibly_sent",
                sourceQueuedMessageIds: f.queueIds,
              },
            });
            expect(runtime).toHaveBeenCalledTimes(1);
            expect(provider).toHaveBeenCalledTimes(count);
          } finally {
            restored.$client.close();
          }
        } finally {
          runtime.mockRestore();
        }
      });
    },
  );
  it("rolls back the refusal when recording its native rejection fails", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h);
      h.db.run(
        sql.raw(`CREATE TRIGGER abort_rejection BEFORE INSERT ON events WHEN new.type='client/turn/rejected'
        BEGIN SELECT RAISE(ABORT,'injected rejection recording failure'); END`),
      );
      const handoff = vi.spyOn(managedRuntime, "dispatchManagedOrdinaryTurn");
      try {
        const initial = await f.send();
        expect(initial.status).toBe(500);
        expect((await initial.json()).code).toBe("internal_error");
        const replay = await f.send();
        expect(replay.status).toBe(409);
        expect(await replay.json()).toMatchObject({
          code: "placement_dispatch_recorded",
          details: { state: "prepared", sourceQueuedMessageIds: f.queueIds },
        });
        expect(handoff).toHaveBeenCalledTimes(1);
        expect(
          listEvents(h.db, { threadId: f.threadId }).filter(
            (event) => event.type === "client/turn/rejected",
          ),
        ).toHaveLength(0);
        expect(
          listQueuedThreadCommands(h, "turn.submit", f.threadId),
        ).toHaveLength(0);
      } finally {
        handoff.mockRestore();
      }
    });
  });
  it("rejects missing trusted purpose and preserves both queue entries", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h);
      delete h.deps.placementWorkspacePurpose;
      const response = await f.send();
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe(
        "placement_dispatch_unavailable",
      );
      for (const id of f.queueIds)
        expect(readPlacementQueueAttempts(h.db, id)).toMatchObject([
          { request: null },
        ]);
    });
  });
  it("allows only one concurrent Send now call to hand off a committed group", async () => {
    await withTestHarness(async (h) => {
      const f = seedManagedGroup(h);
      const handoff = vi.spyOn(managedRuntime, "dispatchManagedOrdinaryTurn");
      try {
        const responses = await Promise.all([f.send(), f.send()]);
        expect(responses.map((r) => r.status)).toEqual([409, 409]);
        expect(handoff).toHaveBeenCalledTimes(1);
        const ids = f.queueIds.map(
          (id) => readPlacementQueueAttempts(h.db, id)[0]?.request,
        );
        expect(ids[0]).toMatch(/^creq_/);
        expect(ids[1]).toBe(ids[0]);
      } finally {
        handoff.mockRestore();
      }
    });
  });
  it.each(["wrong-fence", "same-fence-transfer", "sql-error"] as const)(
    "rolls back event, receipt and queue on %s",
    async (fault) => {
      await withTestHarness(async (h) => {
        const f = seedManagedGroup(h);
        if (fault === "wrong-fence") {
          h.db
            .update(queuedThreadMessages)
            .set({ placementFence: f.fence + 1 })
            .where(eq(queuedThreadMessages.id, f.queueIds[1]!))
            .run();
        } else if (fault === "same-fence-transfer") {
          h.db.run(
            sql.raw(`CREATE TRIGGER transfer_owner AFTER INSERT ON events WHEN new.type='client/turn/requested'
          BEGIN UPDATE placement_worker SET owner_operation_id=(SELECT placement_operation_id FROM queued_thread_messages WHERE state='claimed' ORDER BY sort_key LIMIT 1); END`),
          );
        } else {
          h.db.run(
            sql.raw(`CREATE TRIGGER injected_delete BEFORE DELETE ON queued_thread_messages WHEN old.placement_operation_id IS NOT NULL
          BEGIN SELECT RAISE(ABORT,'injected queue consumption failure'); END`),
          );
        }
        const before = listEvents(h.db, { threadId: f.threadId }).length;
        const response = await f.send();
        const body = await response.json();
        expect(response.status, JSON.stringify(body)).toBe(
          fault === "sql-error" ? 500 : 409,
        );
        expect(body.code).toBe(
          fault === "sql-error"
            ? "internal_error"
            : "placement_dispatch_unavailable",
        );
        expect(listEvents(h.db, { threadId: f.threadId })).toHaveLength(before);
        for (const id of f.queueIds) {
          expect(getQueuedThreadMessage(h.db, id)?.claimToken).toBeNull();
          expect(readPlacementQueueAttempts(h.db, id)).toMatchObject([
            { request: null },
          ]);
        }
        expect(getThread(h.db, f.threadId)?.status).toBe("idle");
        expect(
          listQueuedThreadCommands(h, "turn.submit", f.threadId),
        ).toHaveLength(0);
      });
    },
  );
});
