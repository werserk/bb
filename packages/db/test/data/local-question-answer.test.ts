import { expect, it } from "vitest";
import { PERSONAL_PROJECT_ID } from "@bb/domain";
import { createMigratedConnection } from "../../src/testing.js";
import {
  appendQuestionResolutionEvent,
  classifyLocalQuestionAnswer,
  clearWithdrawnQuestionResponseReceipt,
  conversationQuestions,
  createConversationQuestion,
  createQueuedThreadMessageInTransaction,
  createThread,
  getConversationQuestion,
  getQuestionResolutionDelivery,
  getQuestionResolutionOperation,
  listQuestionResolutionHistory,
  markQuestionResolutionSubmitted,
  noopNotifier,
  questionResolutionEvents,
  restoreConversationQuestionDelivery,
  setConversationQuestionTerminal,
  withdrawConversationQuestion,
} from "../../src/index.js";
import { eq } from "drizzle-orm";

function fixture() {
  const db = createMigratedConnection();
  const thread = createThread(db, noopNotifier, {
    projectId: PERSONAL_PROJECT_ID,
    providerId: "codex",
    status: "idle",
  });
  const question = createConversationQuestion(db, {
    threadId: thread.id,
    sourceTurnId: "t",
    sourceCallId: "c",
    publication: "{}",
    materialManifest: "[]",
  })!;
  const queue = () =>
    db.transaction(tx => createQueuedThreadMessageInTransaction(tx, {
      threadId: thread.id,
      content: [{ type: "text", text: "arbitrary text", mentions: [] }],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: { kind: "thread-busy" },
      sendAt: null,
      payload: {
        kind: "questionResponse",
        questionId: question.id,
        revision: 1,
      },
      systemNotice: null,
    }));
  const row = queue();
  setConversationQuestionTerminal(db, {
    threadId: thread.id,
    questionId: question.id,
    revision: 1,
    status: "answered",
    response: "{}",
    queuedMessageId: row.id,
  });
  const attribution = {
    id: "qres_test",
    targetKind: "qst" as const,
    targetId: question.id,
    threadId: thread.id,
    revision: 1,
    operationId: "op",
    action: "answer" as const,
    actor: {
      kind: "local-unverified" as const,
      verification: "unverified-local" as const,
    },
    reason: "test",
    acceptedAt: 1,
    answers: {},
    deliveryId: row.id,
  };
  const audit = () =>
    appendQuestionResolutionEvent(db, {
      initial: true,
      request: "immutable",
      attribution,
    });
  const submitted = () => {
    db.update(conversationQuestions)
      .set({ dispatchedAt: 7 })
      .where(eq(conversationQuestions.id, question.id))
      .run();
    markQuestionResolutionSubmitted(db, row.id);
  };
  const args = {
    threadId: thread.id,
    questionId: question.id,
    revision: 1,
    previousQueuedMessageId: row.id,
  };
  return {
    db,
    thread,
    question,
    queue,
    row,
    attribution,
    audit,
    submitted,
    args,
  };
}

it("requires a singleton typed local answer receipt, never text or null sender alone", () => {
  const f = fixture();
  try {
    expect(classifyLocalQuestionAnswer(f.db, [f.row])).toBeUndefined();
    f.audit();
    expect(classifyLocalQuestionAnswer(f.db, [f.row])).toMatchObject({
      queuedMessageId: f.row.id,
    });
    for (const rows of [
      [f.row, f.row],
      [{ ...f.row, senderThreadId: f.thread.id }],
      [{ ...f.row, payloadKind: "message" }],
      [{ ...f.row, questionRevision: 2 }],
    ])
      expect(classifyLocalQuestionAnswer(f.db, rows)).toBeUndefined();
    f.db
      .update(questionResolutionEvents)
      .set({
        attribution: JSON.stringify({
          ...f.attribution,
          action: "withdraw",
          answers: null,
        }),
      })
      .run();
    expect(classifyLocalQuestionAnswer(f.db, [f.row])).toBeUndefined();
  } finally {
    f.db.$client.close();
  }
});

it("moves both persisted receipts and replay/history identity through repeated restore", () => {
  const f = fixture();
  try {
    f.audit();
    f.submitted();
    const immutable = f.db.$client
      .prepare(
        "select id, principal, operation_id, request from question_resolution_events",
      )
      .get();
    let previous = f.row.id;
    for (let i = 0; i < 3; i++) {
      const next = f.queue();
      f.db.transaction((tx) =>
        expect(
          restoreConversationQuestionDelivery(tx, {
            ...f.args,
            previousQueuedMessageId: previous,
            queuedMessageId: next.id,
          }),
        ).toBe(true),
      );
      expect(getQuestionResolutionDelivery(f.db, previous)).toBeNull();
      expect(getQuestionResolutionDelivery(f.db, next.id)).toMatchObject({
        submittedAt: null,
        attribution: { deliveryId: next.id, id: f.attribution.id },
      });
      expect(
        getQuestionResolutionOperation(f.db, "local-unverified", "op")
          ?.attribution.deliveryId,
      ).toBe(next.id);
      expect(
        listQuestionResolutionHistory(f.db, "qst", f.question.id)[0]
          ?.deliveryId,
      ).toBe(next.id);
      expect(
        f.db.$client
          .prepare(
            "select id, principal, operation_id, request from question_resolution_events",
          )
          .get(),
      ).toEqual(immutable);
      expect(
        f.db.$client
          .prepare(
            "select delivery_id, submitted_at from question_resolution_events",
          )
          .get(),
      ).toEqual({ delivery_id: next.id, submitted_at: null });
      f.db.update(conversationQuestions).set({ dispatchedAt: 8 }).run();
      markQuestionResolutionSubmitted(f.db, next.id);
      previous = next.id;
    }
  } finally {
    f.db.$client.close();
  }
});

it.each(["question", "audit"])(
  "atomically rejects %s-only cleared submission receipt",
  (side) => {
    const f = fixture();
    try {
      f.audit();
      f.submitted();
      if (side === "question")
        f.db.update(conversationQuestions).set({ dispatchedAt: null }).run();
      else
        f.db.update(questionResolutionEvents).set({ submittedAt: null }).run();
      const before = f.db.$client.serialize();
      expect(() =>
        f.db.transaction((tx) => {
          const next = f.queue();
          restoreConversationQuestionDelivery(tx, {
            ...f.args,
            queuedMessageId: next.id,
          });
        }),
      ).toThrow("receipts disagree");
      expect(f.db.$client.serialize()).toEqual(before);
    } finally {
      f.db.$client.close();
    }
  },
);

it("retires only the obsolete answer receipt and preserves distinct owed withdrawal", () => {
  const f = fixture();
  try {
    f.audit();
    f.submitted();
    withdrawConversationQuestion(f.db, { ...f.args, revision: 1 });
    const cancellation = f.queue();
    appendQuestionResolutionEvent(f.db, {
      initial: false,
      request: "withdraw",
      attribution: {
        ...f.attribution,
        id: "qres_cancel",
        operationId: "cancel",
        action: "withdraw",
        answers: null,
        deliveryId: cancellation.id,
      },
    });
    const before = getQuestionResolutionDelivery(f.db, cancellation.id);
    f.db.transaction((tx) =>
      expect(
        clearWithdrawnQuestionResponseReceipt(tx, {
          ...f.args,
          queuedMessageId: f.row.id,
        }),
      ).toBe(true),
    );
    expect(getQuestionResolutionDelivery(f.db, f.row.id)).toMatchObject({
      submittedAt: null,
      attribution: { deliveryId: f.row.id },
    });
    expect(getQuestionResolutionDelivery(f.db, cancellation.id)).toEqual(
      before,
    );
    expect(getConversationQuestion(f.db, f.args)?.dispatchedAt).toBeNull();
  } finally {
    f.db.$client.close();
  }
});
