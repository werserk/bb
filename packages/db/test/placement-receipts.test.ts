import { reconcileSupersededPlacementRetries } from "../src/data/placement-retry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { it, expect, vi } from "vitest";
import {
  createStandaloneBuiltinCompactCommandInput,
  clientSubmissionQueueId,
  threadScope,
  type PlacementAuthority,
  type TurnRequestEventData,
} from "@bb/domain";
import { createConnection, migrate, type DbConnection } from "../src/index.js";
import {
  events,
  threads,
  placementEffects,
  placementOperations,
  placementRetryTargets,
  queuedThreadMessages as queue,
} from "../src/schema.js";
import {
  commitPlacementCompactDispatch,
  PlacementDispatchConflictError,
  preparePlacementExecutionCommand,
  claimPlacementExecutionCommand,
  settlePlacementExecutionCommand,
  readPlacementAdmittedExecution,
  readPlacementDispatchReceipt,
  refusePlacementBeforeHandoff,
} from "../src/data/placement-dispatch-receipts.js";
import {
  readPlacementQueueAttempts,
  readPlacementActionReceipt,
} from "../src/data/placement-action-receipts.js";
import {
  acceptPlacementOperation,
  readPlacementOperation,
  grantPlacementRetryConsent,
  schedulePlacementRetry,
  revokePlacementRetryConsent,
} from "../src/data/placement-operations.js";
import {
  preparePlacementOperation,
  recordPlacementQueueReceipt,
} from "../src/data/placement-bindings.js";
import { createQueuedThreadMessageInTransaction } from "../src/data/queued-thread-messages.js";
import { recordPlacementSteerRedelivery } from "../src/data/placement-redelivery.js";
import { appendStoredThreadEventInTransaction } from "../src/data/events.js";
import {
  setupPlacement,
  acceptPrepared,
  attachAndQueue,
  fixtureAuthority,
  workspace,
  purpose,
} from "./helpers/placement.js";
import {
  appendFixture,
  claimFixture,
  fixtureCommand,
  fixtureExecution,
  failFixture,
} from "./helpers/placement-dispatch.js";
import {
  createConversationQuestion,
  setConversationQuestionTerminal,
  restoreConversationQuestionDelivery,
  withdrawConversationQuestion,
  clearWithdrawnQuestionResponseReceipt,
  getConversationQuestion,
} from "../src/data/conversation-questions.js";
import { appendQuestionResolutionEvent } from "../src/data/question-resolution-events.js";
import { claimQueuedThreadMessageGroup } from "../src/data/queued-thread-messages.js";
import { noopNotifier } from "../src/notifier.js";

const first = "creq_2222222222",
  second = "creq_3333333333",
  third = "creq_4444444444";
const scope = {
  principalScope: "owner",
  ownerPluginId: "workers",
  providerId: "claude",
  authority: fixtureAuthority,
};
function scratch(run: (db: DbConnection, open: () => DbConnection) => void) {
  const dir = mkdtempSync(join(tmpdir(), "placement-receipt-"));
  const conns: DbConnection[] = [];
  const open = () => {
    const db = createConnection(join(dir, "scratch.db"));
    conns.push(db);
    return db;
  };
  try {
    const db = open();
    migrate(db);
    setupPlacement(db);
    run(db, open);
  } finally {
    for (const db of conns) if (db.$client.open) db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
function resident(db: DbConnection, compactFirst = false) {
  const op = acceptPrepared(db, "first", {}, { compactFirst });
  attachAndQueue(db, op.id);
  return readPlacementOperation(db, op.id)!;
}
function follower(
  db: DbConnection,
  threadId: string,
  authority: PlacementAuthority,
) {
  const a = acceptPlacementOperation(db, {
    ...scope,
    authority,
    submissionKey: "follow",
    request: {
      schemaVersion: 1,
      intent: { kind: "continuation", threadId, request: { input: "second" } },
    },
  });
  if (a.kind !== "accepted") throw new Error("no follower");
  const id = a.operation.id;
  preparePlacementOperation(db, {
    operationId: id,
    expectedRevision: 1,
    workspace,
    preparedExecution: fixtureExecution,
    preparedRequest: { input: "second" },
    attachmentReceipts: [],
  });
  const uuid = readPlacementActionReceipt(db, id)!.submissionUuid!;
  const queued = db.transaction(
    (tx) =>
      recordPlacementQueueReceipt(tx, {
        operationId: id,
        fence: 1,
        queuedMessageId: clientSubmissionQueueId(uuid),
        onCommitted: () => {},
        insertQueue: (t, i) => {
          createQueuedThreadMessageInTransaction(t, {
            placement: i,
            clientSubmissionId: uuid,
            threadId,
            ...fixtureExecution,
            content: [{ type: "text", text: "second", mentions: [] }],
            senderThreadId: authority.sender,
            origin: authority.origin,
            originPluginId: authority.plugin,
            requestedBy: authority.requestedBy,
            sendAt: null,
            waitingOn: null,
            systemNotice: null,
            payload: { kind: "inline" },
          });
        },
      }),
    { behavior: "immediate" },
  );
  if (queued.kind !== "recorded") throw new Error("no follower receipt");
  return queued.operation;
}
function group(
  db: DbConnection,
  reverse = false,
  authority: PlacementAuthority = fixtureAuthority,
) {
  const op = resident(db),
    follow = follower(db, op.threadId!, authority);
  const [a, b] = reverse ? [follow, op] : [op, follow];
  db.update(queue)
    .set({ sortKey: "A", groupWithNext: true })
    .where(eq(queue.id, a.queueReceipt!.queuedMessageId))
    .run();
  db.update(queue)
    .set({ sortKey: "B", groupWithNext: false })
    .where(eq(queue.id, b.queueReceipt!.queuedMessageId))
    .run();
  return {
    op,
    follow,
    a,
    b,
    claimed: claimFixture(db, a.queueReceipt!.queuedMessageId),
  };
}
it.each([false, true])(
  "rejects different effective escalation with either action first (%s)",
  (reverse) =>
    scratch((db) => {
      const { op, claimed } = group(db, reverse, {
        ...fixtureAuthority,
        escalation: "deny",
      });
      expect(() =>
        db.transaction((tx) => appendFixture(tx, op.id, claimed, first)),
      ).toThrow(PlacementDispatchConflictError);
      expect(db.select().from(events).all()).toHaveLength(0);
      expect(db.select().from(placementEffects).all()).toHaveLength(0);
      expect(db.select().from(queue).all()).toHaveLength(2);
    }),
);
it("writes ordered group membership with independent execution owner, rolls back append, and holds ambiguous command across reopen", () =>
  scratch((db, open) => {
    const { op, a, b, claimed } = group(db, true);
    expect(() =>
      db.transaction((tx) => {
        appendFixture(tx, op.id, claimed, first);
        throw new RangeError("abort shell");
      }),
    ).toThrow(RangeError);
    expect(db.select().from(queue).all()).toHaveLength(2);
    expect(
      readPlacementQueueAttempts(db, claimed[0]!.id)[0]?.request,
    ).toBeNull();
    const { guard, receipt } = db.transaction(
      (tx) => appendFixture(tx, op.id, claimed, first),
      { behavior: "immediate" },
    );
    expect(receipt.members.map((m) => m.op)).toEqual([a.id, b.id]);
    expect(receipt.executionOwnerOperationId).toBe(b.id);
    expect(db.select().from(queue).all()).toHaveLength(0);
    const cmd = { ...guard, ...fixtureCommand };
    expect(preparePlacementExecutionCommand(db, cmd).kind).toBe("prepared");
    expect(
      claimPlacementExecutionCommand(db, {
        ...cmd,
        currentAgentSessionId: "moved",
      }).kind,
    ).toBe("refused");
    expect(
      claimPlacementExecutionCommand(db, {
        ...cmd,
        currentAgentSessionId: cmd.agentSessionId,
      }).kind,
    ).toBe("won");
    db.$client.close();
    const reopened = open();
    expect(
      readPlacementQueueAttempts(reopened, claimed[0]!.id)[0],
    ).toMatchObject({ request: first, ordinal: 0 });
    expect(readPlacementDispatchReceipt(reopened, guard)).toMatchObject({
      state: "possibly_sent",
      nativeExecutionId: cmd.nativeExecutionId,
      agentSessionId: cmd.agentSessionId,
    });
    expect(readPlacementAdmittedExecution(reopened, guard)).toBeNull();
    expect(
      claimPlacementExecutionCommand(reopened, {
        ...cmd,
        currentAgentSessionId: cmd.agentSessionId,
      }).kind,
    ).toBe("held");
    expect(
      reopened.transaction((tx) => refusePlacementBeforeHandoff(tx, guard)),
    ).toBe(false);
    expect(
      reopened.transaction((tx) =>
        settlePlacementExecutionCommand(tx, {
          ...cmd,
          commandId: "wrong",
          outcome: "succeeded",
        }),
      ),
    ).toBe(false);
    expect(
      reopened.transaction((tx) =>
        settlePlacementExecutionCommand(tx, { ...cmd, outcome: "succeeded" }),
      ),
    ).toBe(true);
  }));
it("holds the prompt behind an independent compact request across reopen until correlated completion", () =>
  scratch((db, open) => {
    const op = resident(db, true),
      threadId = op.threadId!;
    const claimed = claimFixture(db, op.queueReceipt!.queuedMessageId);
    const guard = {
      threadId,
      requestId: first,
      executionOwnerOperationId: op.id,
      purpose,
      fence: 1,
    };
    const compact: TurnRequestEventData = {
      requestId: first,
      source: "tell",
      direction: "outbound",
      initiator: "user",
      senderThreadId: null,
      input: createStandaloneBuiltinCompactCommandInput(),
      target: { kind: "new-turn" },
      execution: fixtureExecution,
      request: { method: "turn/start", params: {} },
    };
    db.transaction((tx) => {
      const requestSequence = appendStoredThreadEventInTransaction(tx, {
        threadId,
        scope: threadScope(),
        type: "client/turn/requested",
        data: compact,
      });
      commitPlacementCompactDispatch(tx, {
        ...guard,
        requestSequence,
        operationId: op.id,
      });
    });
    const cmd = { ...guard, ...fixtureCommand };
    preparePlacementExecutionCommand(db, cmd);
    expect(
      claimPlacementExecutionCommand(db, {
        ...cmd,
        currentAgentSessionId: cmd.agentSessionId,
      }).kind,
    ).toBe("won");
    db.$client.close();
    const next = open();
    expect(() =>
      next.transaction((tx) => appendFixture(tx, op.id, claimed, second)),
    ).toThrow(/prior step incomplete/);
    expect(readPlacementActionReceipt(next, op.id)?.currentStep).toBe(0);
    expect(
      next.transaction((tx) =>
        settlePlacementExecutionCommand(tx, { ...cmd, outcome: "succeeded" }),
      ),
    ).toBe(true);
    const r = next.transaction((tx) =>
      appendFixture(tx, op.id, claimed, second),
    ).receipt;
    expect(r.members.map((m) => [m.step, m.request])).toEqual([[1, second]]);
    expect(
      readPlacementActionReceipt(next, op.id)?.steps[0]?.latest?.attempt
        .request,
    ).toBe(first);
  }));
it("links a shared native replacement to every refused steer attempt and preserves historical membership", () =>
  scratch((db, open) => {
    const { op, claimed } = group(db);
    const { guard, body } = db.transaction((tx) =>
      appendFixture(tx, op.id, claimed, first),
    );
    const cmd = { ...guard, ...fixtureCommand };
    preparePlacementExecutionCommand(db, cmd);
    claimPlacementExecutionCommand(db, {
      ...cmd,
      currentAgentSessionId: cmd.agentSessionId,
    });
    const { qid, seq } = db.transaction((tx) => {
      expect(
        settlePlacementExecutionCommand(tx, { ...cmd, outcome: "refused" }),
      ).toBe(true);
      const row = createQueuedThreadMessageInTransaction(tx, {
        threadId: guard.threadId,
        content: body.input,
        ...fixtureExecution,
        sendAt: null,
        waitingOn: null,
        systemNotice: null,
        payload: { kind: "deferredSteer", sourceRequestId: first },
      });
      const seq = appendStoredThreadEventInTransaction(tx, {
        threadId: guard.threadId,
        scope: threadScope(),
        type: "client/turn/rejected",
        data: {
          requestId: first,
          reason: "turn_not_steerable",
          message: "fixture",
          deferredToQueuedMessageId: row.id,
        },
      });
      return {
        qid: recordPlacementSteerRedelivery(tx, {
          ...guard,
          rejectionSequence: seq,
        })!,
        seq,
      };
    });
    db.$client.close();
    const next = open();
    expect(
      next.transaction((tx) =>
        recordPlacementSteerRedelivery(tx, {
          ...guard,
          rejectionSequence: seq,
        }),
      ),
    ).toBe(qid);
    const redelivery = claimFixture(next, qid);
    const receipt = next.transaction((tx) =>
      appendFixture(tx, op.id, redelivery, second, {
        deferredFromRequestId: first,
        input: body.input,
        inputGroups: body.inputGroups,
        clientSubmissions: body.clientSubmissions,
      }),
    ).receipt;
    expect(receipt.members.map((m) => [m.step, m.attempt, m.queueId])).toEqual([
      [0, 1, qid],
      [0, 1, qid],
    ]);
    expect(
      readPlacementDispatchReceipt(next, guard)?.members.map((m) => m.attempt),
    ).toEqual([0, 0]);
  }));
it.each(["failed_accepted", "refused"] as const)(
  "enforces one exact successor, due clock and grouped retry derivation for %s",
  (outcome) =>
    scratch((db, open) => {
      const { op, follow, claimed } = group(db);
      const { guard, body } = db.transaction((tx) =>
        appendFixture(tx, op.id, claimed, first),
      );
      const cmd = { ...guard, ...fixtureCommand };
      preparePlacementExecutionCommand(db, cmd);
      claimPlacementExecutionCommand(db, {
        ...cmd,
        currentAgentSessionId: cmd.agentSessionId,
      });
      db.transaction((tx) => {
        settlePlacementExecutionCommand(tx, { ...cmd, outcome });
        tx.update(threads)
          .set({ status: "error" })
          .where(eq(threads.id, guard.threadId))
          .run();
      });
      const grantArgs = {
        principalScope: "owner",
        submissionKey: "key",
        failedOperationId: op.id,
        failedRequestId: first,
        permissionProvenance: {
          identity: "local-unverified",
          authority: "local-input-parity",
          actionId: "click",
        },
      } as const;
      const grant = grantPlacementRetryConsent(db, grantArgs);
      if (grant.kind !== "granted") throw new Error("no grant");
      const next = open();
      expect(
        grantPlacementRetryConsent(next, {
          ...grantArgs,
          submissionKey: "alias",
        }),
      ).toEqual(grant);
      expect(
        grantPlacementRetryConsent(next, {
          ...grantArgs,
          submissionKey: "alias",
          failedOperationId: follow.id,
        }).kind,
      ).toBe("conflict");
      expect(
        grantPlacementRetryConsent(next, {
          ...grantArgs,
          failedRequestId: third,
        }).kind,
      ).toBe("conflict");
      expect(
        grantPlacementRetryConsent(next, {
          ...grantArgs,
          submissionKey: "other-key",
          permissionProvenance: {
            ...grantArgs.permissionProvenance,
            actionId: "another-click",
          },
        }).kind,
      ).toBe("refused");
      const r = acceptPlacementOperation(next, {
        ...scope,
        authority: { ...fixtureAuthority, initiator: "system" },
        submissionKey: "retry",
        request: {
          schemaVersion: 1,
          intent: {
            kind: "retry",
            failedOperationId: op.id,
            consentId: grant.consent.id,
          },
        },
      });
      if (r.kind !== "accepted") throw new Error("no retry");
      expect(next.select().from(queue).all()).toHaveLength(0);
      const deadline = Date.now() + 3600000;
      expect(
        schedulePlacementRetry(next, {
          operationId: r.operation.id,
          scheduler: "other",
          sendAt: deadline,
        }),
      ).toBeNull();
      const qid = schedulePlacementRetry(next, {
        operationId: r.operation.id,
        scheduler: "provider-retry",
        sendAt: deadline,
      })!;
      const pending = next.select().from(queue).where(eq(queue.id, qid)).get()!;
      expect(pending.placementFence).toBeNull();
      const env = next
        .select()
        .from(placementOperations)
        .where(eq(placementOperations.id, r.operation.id))
        .get()!.retryDerivation!;
      const patch: Partial<TurnRequestEventData> = {
        initiator: "system",
        input: JSON.parse(pending.content),
        inputGroups: env.groups as TurnRequestEventData["inputGroups"],
        clientSubmissions:
          env.membership as TurnRequestEventData["clientSubmissions"],
        retryOfRequestId: first,
        retryAttempt: 2,
      };
      expect(patch.clientSubmissions).toEqual(
        body.clientSubmissions!.map((m) => ({
          ...m,
          inputGroupIndex:
            outcome === "failed_accepted" ? 0 : m.inputGroupIndex,
        })),
      );
      if (outcome === "failed_accepted")
        expect(patch.input).toMatchObject([
          { text: "Please continue.", visibility: "agent-only" },
        ]);
      else expect(patch.inputGroups?.length).toBe(2);
      const retryClaim = claimFixture(next, qid);
      expect(() =>
        next.transaction((tx) =>
          appendFixture(tx, op.id, retryClaim, second, patch),
        ),
      ).toThrow(PlacementDispatchConflictError);
      expect(next.select().from(placementRetryTargets).get()?.state).toBe(
        "scheduled",
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
      try {
        expect(() =>
          next.transaction((tx) => {
            appendFixture(tx, op.id, retryClaim, second, patch);
            throw new Error("rollback-spend");
          }),
        ).toThrow("rollback-spend");
        expect(next.select().from(placementRetryTargets).get()?.state).toBe(
          "scheduled",
        );
        const finished = next.transaction((tx) =>
          appendFixture(tx, op.id, retryClaim, second, patch),
        );
        expect(finished.receipt.root).toBe(first);
        expect(next.select().from(placementRetryTargets).get()?.state).toBe(
          "spent",
        );
        expect(revokePlacementRetryConsent(next, grant.consent.id)).toBe(false);
      } finally {
        clock.mockRestore();
      }
    }),
);

it("rolls back an unexpected native error and persists a correlated pre-send refusal separately from uncertain delivery", () =>
  scratch((db, open) => {
    const op = resident(db),
      claimed = claimFixture(db, op.queueReceipt!.queuedMessageId);
    db.$client.exec(
      "CREATE TEMP TRIGGER fixture_abort BEFORE INSERT ON placement_effect BEGIN SELECT RAISE(ABORT,'fixture I/O failure'); END",
    );
    let error: unknown;
    try {
      db.transaction((tx) => appendFixture(tx, op.id, claimed, first));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PlacementDispatchConflictError);
    expect(String(error)).toContain("fixture I/O failure");
    expect(db.select().from(events).all()).toHaveLength(0);
    db.$client.exec("DROP TRIGGER fixture_abort");
    const { guard } = db.transaction((tx) =>
      appendFixture(tx, op.id, claimed, first),
    );
    expect(
      db.transaction((tx) => refusePlacementBeforeHandoff(tx, guard)),
    ).toBe(false);
    db.transaction((tx) => {
      appendStoredThreadEventInTransaction(tx, {
        threadId: guard.threadId,
        scope: threadScope(),
        type: "client/turn/rejected",
        data: {
          requestId: first,
          reason: "host_unavailable",
          message: "fixture refusal before handoff",
        },
      });
      expect(refusePlacementBeforeHandoff(tx, guard)).toBe(true);
    });
    db.$client.close();
    const next = open();
    expect(readPlacementDispatchReceipt(next, guard)?.state).toBe(
      "refused_unsent",
    );
    expect(
      preparePlacementExecutionCommand(next, { ...guard, ...fixtureCommand })
        .kind,
    ).toBe("refused");
    expect(next.$client.pragma("foreign_key_check")).toEqual([]);
  }));

it.each([false, true])(
  "preserves native answer identity with a restored or withdrawn question receipt (%s)",
  (withdraw) =>
    scratch((db, open) => {
      const op = resident(db),
        threadId = op.threadId!;
      const q = createConversationQuestion(db, {
        threadId,
        sourceTurnId: "turn",
        sourceCallId: "call",
        publication: "{}",
        materialManifest: "[]",
      })!;
      const protocol = {
        kind: "questionResponse" as const,
        questionId: q.id,
        revision: q.revision,
      };
      const result = acceptPlacementOperation(db, {
        ...scope,
        submissionKey: "answer",
        protocol,
        request: {
          schemaVersion: 1,
          intent: {
            kind: "continuation",
            threadId,
            request: { input: "answer" },
          },
        },
      });
      if (result.kind !== "accepted") throw new Error("no answer action");
      const id = result.operation.id;
      preparePlacementOperation(db, {
        operationId: id,
        expectedRevision: 1,
        workspace,
        preparedExecution: fixtureExecution,
        preparedRequest: { input: "answer" },
        attachmentReceipts: [],
      });
      const content = [
        { type: "text" as const, text: "fixture answer", mentions: [] },
      ];
      const native = {
        threadId,
        content,
        ...fixtureExecution,
        sendAt: null,
        waitingOn: null,
        systemNotice: null,
        payload: protocol,
      };
      const queued = db.transaction((tx) =>
        recordPlacementQueueReceipt(tx, {
          operationId: id,
          fence: 1,
          onCommitted: () => {},
          insertQueue: (t, placement) => {
            const row = createQueuedThreadMessageInTransaction(t, {
              ...native,
              placement,
            });
            setConversationQuestionTerminal(t, {
              threadId,
              questionId: q.id,
              revision: 1,
              status: "answered",
              response: "{}",
              queuedMessageId: row.id,
            });
            appendQuestionResolutionEvent(t, {
              attribution: {
                id: "qa",
                targetKind: "qst",
                targetId: q.id,
                threadId,
                revision: 1,
                operationId: "answer",
                action: "answer",
                actor: {
                  kind: "local-unverified",
                  verification: "unverified-local",
                },
                reason: "test",
                acceptedAt: 1,
                answers: {},
                deliveryId: row.id,
              },
              initial: true,
              request: "{}",
            });
            return row.id;
          },
        }),
      );
      if (queued.kind !== "recorded") throw new Error("missing question queue");
      const qid = queued.operation.queueReceipt!.queuedMessageId;
      expect(readPlacementActionReceipt(db, id)).toMatchObject({
        submissionUuid: null,
        protocol,
        steps: [{ kind: "answer" }],
      });
      const original = claimFixture(db, qid);
      const { guard } = db.transaction((tx) =>
        appendFixture(tx, op.id, original, first, {
          clientSubmissions: [],
          questionResponse: { ...protocol, queuedMessageId: qid },
        }),
      );
      const cmd = { ...guard, ...fixtureCommand };
      preparePlacementExecutionCommand(db, cmd);
      claimPlacementExecutionCommand(db, {
        ...cmd,
        currentAgentSessionId: cmd.agentSessionId,
      });
      db.$client.close();
      const next = open();
      next.transaction((tx) => {
        expect(
          settlePlacementExecutionCommand(tx, { ...cmd, outcome: "refused" }),
        ).toBe(true);
        let replacement: string | undefined;
        if (withdraw) {
          withdrawConversationQuestion(tx, {
            threadId,
            questionId: q.id,
            revision: 1,
          });
          expect(
            clearWithdrawnQuestionResponseReceipt(tx, {
              threadId,
              questionId: q.id,
              revision: 1,
              queuedMessageId: qid,
            }),
          ).toBe(true);
        } else {
          replacement = createQueuedThreadMessageInTransaction(tx, native).id;
          expect(
            restoreConversationQuestionDelivery(tx, {
              threadId,
              questionId: q.id,
              revision: 1,
              previousQueuedMessageId: qid,
              queuedMessageId: replacement,
            }),
          ).toBe(true);
        }
        const seq = appendStoredThreadEventInTransaction(tx, {
          threadId,
          scope: threadScope(),
          type: "client/turn/rejected",
          data: {
            requestId: first,
            reason: "stale_turn",
            message: "fixture",
            deferredToQueuedMessageId: replacement,
          },
        });
        expect(
          recordPlacementSteerRedelivery(tx, {
            ...guard,
            rejectionSequence: seq,
          }),
        ).toBe(replacement ?? null);
        expect(
          getConversationQuestion(tx, { threadId, questionId: q.id }),
        ).toMatchObject({
          queuedMessageId: replacement ?? qid,
          dispatchedAt: null,
        });
        expect(readPlacementQueueAttempts(tx, qid)[0]?.request).toBe(first);
      });
    }),
);

it.each(["revoke", "supersede"] as const)(
  "retires exactly the scheduled native row on %s and retains consent replay",
  (mode) =>
    scratch((db, open) => {
      const op = resident(db);
      const req = failFixture(db, op.id);
      const args = {
        principalScope: "owner",
        submissionKey: "one",
        failedOperationId: op.id,
        failedRequestId: req,
        permissionProvenance: {
          identity: "local-unverified",
          authority: "local-input-parity",
          actionId: "one",
        },
      } as const;
      const grant = grantPlacementRetryConsent(db, args);
      if (grant.kind !== "granted") throw new Error("missing grant");
      const r = acceptPlacementOperation(db, {
        ...scope,
        authority: { ...fixtureAuthority, initiator: "system" },
        submissionKey: "retry",
        request: {
          schemaVersion: 1,
          intent: {
            kind: "retry",
            failedOperationId: op.id,
            consentId: grant.consent.id,
          },
        },
      });
      if (r.kind !== "accepted") throw new Error("missing retry");
      const when = Date.now() + 1000000;
      const q = schedulePlacementRetry(db, {
        operationId: r.operation.id,
        scheduler: "provider-retry",
        sendAt: when,
      })!;
      const unrelated = db.transaction((tx) =>
        createQueuedThreadMessageInTransaction(tx, {
          threadId: op.threadId!,
          content: [{ type: "text", text: "unmanaged", mentions: [] }],
          ...fixtureExecution,
          systemNotice: null,
          waitingOn: null,
          sendAt: null,
          payload: { kind: "inline" },
        }),
      );
      const next = open();
      if (mode === "revoke")
        expect(revokePlacementRetryConsent(next, grant.consent.id)).toBe(true);
      else
        next.transaction((tx) => {
          const data = JSON.parse(
            tx
              .select()
              .from(events)
              .where(eq(events.type, "client/turn/requested"))
              .get()!.data,
          );
          appendStoredThreadEventInTransaction(tx, {
            threadId: op.threadId!,
            scope: threadScope(),
            type: "client/turn/requested",
            data: { ...data, requestId: second },
          });
          reconcileSupersededPlacementRetries(tx, op.threadId!);
        });
      expect(
        next.select().from(queue).where(eq(queue.id, q)).get(),
      ).toBeUndefined();
      expect(
        next.select().from(queue).where(eq(queue.id, unrelated.id)).get(),
      ).toEqual(unrelated);
      expect(next.select().from(placementRetryTargets).get()?.state).toBe(
        mode === "revoke" ? "revoked" : "superseded",
      );
      const replay = grantPlacementRetryConsent(next, {
        ...args,
        submissionKey: "alias",
      });
      expect(replay).toMatchObject({
        kind: "granted",
        consent: { id: grant.consent.id },
      });
    }),
);

it("checks the complete Send now scope before follower ungrouping and before reporting an existing claim", () =>
  scratch((db) => {
    const root = resident(db),
      follow = follower(db, root.threadId!, {
        ...fixtureAuthority,
        escalation: "deny",
      });
    const a = root.queueReceipt!.queuedMessageId,
      b = follow.queueReceipt!.queuedMessageId;
    db.update(queue)
      .set({ sortKey: "A", groupWithNext: true })
      .where(eq(queue.id, a))
      .run();
    db.update(queue).set({ sortKey: "B" }).where(eq(queue.id, b)).run();
    const snapshots = () =>
      db.select().from(queue).orderBy(queue.sortKey).all();
    const deny = () =>
      claimQueuedThreadMessageGroup(db, noopNotifier, b, {
        kind: "explicit-send",
        assertGroupAllowed: (tx, rows) => {
          expect(rows.map((row) => row.id)).toEqual([a, b]);
          expect(readPlacementQueueAttempts(tx, b)[0]?.op).toBe(follow.id);
          throw new Error("actor cannot send this group");
        },
      });
    const before = snapshots();
    expect(deny).toThrow("actor cannot send this group");
    expect(snapshots()).toEqual(before);
    expect(claimFixture(db, a)).toHaveLength(2);
    const claimed = snapshots();
    expect(deny).toThrow("actor cannot send this group");
    expect(snapshots()).toEqual(claimed);
  }));
