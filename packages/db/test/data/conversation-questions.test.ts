import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  PERSONAL_PROJECT_ID,
  conversationQuestionPublicationSchema,
} from "@bb/domain";
import { createMigratedConnection } from "../../src/testing.js";
import { createConnection } from "../../src/connection.js";
import { noopNotifier } from "../../src/notifier.js";
import {
  claimQueuedThreadMessageGroup,
  deleteClaimedQueuedThreadMessageBatchInTransaction,
  updateQueuedThreadMessage,
  createQueuedThreadMessageInTransaction,
  getQueuedThreadMessage,
} from "../../src/data/queued-thread-messages.js";
import { parseStoredQueuedMessagePayload } from "../../src/data/queued-message-payload.js";
import { createThread } from "../../src/data/threads.js";
import { interruptPendingInteractionsForThreadIds } from "../../src/data/pending-interactions.js";
import {
  createConversationQuestion,
  getConversationQuestion,
  listConversationQuestions,
  setConversationQuestionTerminal,
  withdrawConversationQuestion,
} from "../../src/data/conversation-questions.js";

const publication = conversationQuestionPublicationSchema.parse({
  body: "Listen first",
  questions: [
    {
      id: "voice",
      prompt: "Which voice?",
      shortLabel: "Voice",
      multiSelect: false,
      options: [{ value: "a", label: "A" }],
      allowFreeText: true,
    },
  ],
  materials: [],
});

it("retains multiple ordinary questions after native interruption and reopening the database", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-question-db-"));
  const file = join(root, "questions.sqlite");
  const db = createMigratedConnection();
  try {
    const thread = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      status: "idle",
    });
    const first = createConversationQuestion(db, {
      threadId: thread.id,
      sourceTurnId: "turn-1",
      sourceCallId: "call-1",
      publication: JSON.stringify(publication),
      materialManifest: "[]",
    });
    const second = createConversationQuestion(db, {
      threadId: thread.id,
      sourceTurnId: "turn-2",
      sourceCallId: "call-2",
      publication: JSON.stringify(publication),
      materialManifest: "[]",
    });
    expect(first?.id).not.toBe(second?.id);
    interruptPendingInteractionsForThreadIds(db, {
      threadIds: [thread.id],
      statusReason: "thread-stopped",
    });
    expect(
      listConversationQuestions(db, {
        threadId: thread.id,
        statuses: ["open"],
      }),
    ).toHaveLength(2);
    await db.$client.backup(file);
    const reopened = createConnection(file);
    try {
      expect(
        getConversationQuestion(reopened, {
          threadId: thread.id,
          questionId: first!.id,
        }),
      ).toMatchObject({
        revision: 1,
        status: "open",
        publication: JSON.stringify(publication),
        sourceTurnId: "turn-1",
      });
      expect(
        getConversationQuestion(reopened, {
          threadId: "another-thread",
          questionId: first!.id,
        }),
      ).toBeNull();
    } finally {
      reopened.$client.close();
    }
  } finally {
    db.$client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("fences terminal state by thread, revision and open status, retaining source identity", () => {
  const db = createMigratedConnection();
  try {
    const thread = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      status: "idle",
    });
    const input = {
      threadId: thread.id,
      sourceTurnId: "turn-1",
      sourceCallId: "call-1",
      publication: JSON.stringify(publication),
      materialManifest: "[]",
    };
    const row = createConversationQuestion(db, input)!;
    expect(createConversationQuestion(db, input)).toBeNull();
    expect(
      setConversationQuestionTerminal(db, {
        threadId: thread.id,
        questionId: row.id,
        revision: 2,
        status: "dismissed",
        response: null,
        queuedMessageId: null,
      }),
    ).toBeNull();
    expect(
      setConversationQuestionTerminal(db, {
        threadId: thread.id,
        questionId: row.id,
        revision: 1,
        status: "dismissed",
        response: null,
        queuedMessageId: null,
      })?.status,
    ).toBe("dismissed");
    expect(
      setConversationQuestionTerminal(db, {
        threadId: thread.id,
        questionId: row.id,
        revision: 1,
        status: "answered",
        response: "{}",
        queuedMessageId: "queue-late",
      }),
    ).toBeNull();
    expect(
      getConversationQuestion(db, { threadId: thread.id, questionId: row.id })
        ?.response,
    ).toBeNull();
  } finally {
    db.$client.close();
  }
});

it("commits the accepted answer and its question-bound outbox together or rolls both back", () => {
  const db = createMigratedConnection();
  try {
    const thread = createThread(db, noopNotifier, {
      projectId: PERSONAL_PROJECT_ID,
      providerId: "codex",
      status: "idle",
    });
    const question = createConversationQuestion(db, {
      threadId: thread.id,
      sourceTurnId: "turn-1",
      sourceCallId: "call-1",
      publication: JSON.stringify(publication),
      materialManifest: "[]",
    })!;
    const accept = (abort: boolean) =>
      db.transaction((tx) => {
        const queue = createQueuedThreadMessageInTransaction(tx, {
          threadId: thread.id,
          content: [
            {
              type: "text",
              text: "Answer to the original voice question: A",
              mentions: [],
            },
          ],
          model: "gpt-5",
          reasoningLevel: "medium",
          permissionMode: "full",
          serviceTier: "default",
          waitingOn: null,
          sendAt: null,
          payload: {
            kind: "questionResponse",
            questionId: question.id,
            revision: 1,
          },
          systemNotice: null,
        });
        const accepted = setConversationQuestionTerminal(tx, {
          threadId: thread.id,
          questionId: question.id,
          revision: 1,
          status: "answered",
          response: JSON.stringify({ voice: { selected: ["a"] } }),
          queuedMessageId: queue.id,
        });
        expect(accepted?.queuedMessageId).toBe(queue.id);
        if (abort) throw new Error("Crash before commit");
        return queue.id;
      });
    expect(() => accept(true)).toThrow("Crash before commit");
    expect(
      getConversationQuestion(db, {
        threadId: thread.id,
        questionId: question.id,
      })?.status,
    ).toBe("open");
    expect(
      db.$client
        .prepare(
          "SELECT count(*) AS count FROM queued_thread_messages WHERE thread_id = ?",
        )
        .get(thread.id),
    ).toEqual({ count: 0 });
    const queueId = accept(false);
    expect(
      parseStoredQueuedMessagePayload(getQueuedThreadMessage(db, queueId)!),
    ).toEqual({
      kind: "questionResponse",
      questionId: question.id,
      revision: 1,
    });
    expect(
      getConversationQuestion(db, {
        threadId: thread.id,
        questionId: question.id,
      }),
    ).toMatchObject({ status: "answered", queuedMessageId: queueId });
    const queued = getQueuedThreadMessage(db, queueId)!;
    expect(
      updateQueuedThreadMessage(db, noopNotifier, {
        id: queueId,
        threadId: thread.id,
        expectedUpdatedAt: queued.updatedAt,
        content: [{ type: "text", text: "Different answer", mentions: [] }],
      }).kind,
    ).toBe("immutable");
    expect(
      withdrawConversationQuestion(db, {
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
      }),
    ).toMatchObject({
      status: "withdrawn",
      response: JSON.stringify({ voice: { selected: ["a"] } }),
      queuedMessageId: queueId,
    });
    const claims = claimQueuedThreadMessageGroup(db, noopNotifier, queueId, {
      kind: "explicit-send",
    })!;
    expect(() =>
      db.transaction((tx) =>
        deleteClaimedQueuedThreadMessageBatchInTransaction(tx, {
          queuedMessages: claims,
        }),
      ),
    ).toThrow("withdrawn");
    expect(getQueuedThreadMessage(db, queueId)).not.toBeNull();
  } finally {
    db.$client.close();
  }
});
