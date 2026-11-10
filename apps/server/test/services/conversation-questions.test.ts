import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  getQueuedThreadMessage,
  listQueuedThreadMessages,
  archiveThread,
  createConnection,
  threads,
  isThreadQueueAutoSendPaused,
  queuedThreadMessages,
  clearQueuedThreadMessageWaitingOn,
  setQueuedThreadMessageFailureReason,
  listEvents,
} from "@bb/db";
import {
  conversationQuestionPublicationSchema,
  parseConversationQuestionMarker,
  turnScope,
  threadScope,
} from "@bb/domain";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { registerHostRpcResponder } from "../helpers/host-rpc.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedTurnStarted,
  seedThreadRuntimeState,
  seedEvent,
} from "../helpers/seed.js";
import {
  publishConversationQuestion,
  answerConversationQuestion,
  closeConversationQuestion,
  readConversationQuestion,
  listConversationQuestionsForThread,
} from "../../src/services/threads/conversation-questions.js";

const publication = conversationQuestionPublicationSchema.parse({
  body: "Original context",
  questions: [
    {
      id: "voice",
      prompt: "Which voice?",
      multiSelect: false,
      allowFreeText: true,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    },
  ],
});

describe("independent question custody", () => {
  it("publishes idempotently without a pending waiter and accepts one exact durable answer", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, {
        thread: { providerId: "codex", status: "active" },
      });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
        permissionMode: "accept-edits",
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const args = {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      };
      const first = await publishConversationQuestion(h.deps, args);
      expect((await publishConversationQuestion(h.deps, args)).id).toBe(
        first.id,
      );
      expect(
        h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
      ).toHaveLength(0);
      const answer = {
        threadId: thread.id,
        questionId: first.id,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      };
      const accepted = await answerConversationQuestion(h.deps, answer);
      expect(accepted.status).toBe("answered");
      expect(
        (await answerConversationQuestion(h.deps, answer)).queuedMessageId,
      ).toBe(accepted.queuedMessageId);
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
      const restoredDb = createConnection(h.db.$client.serialize());
      try {
        const restoredDeps = { ...h.deps, db: restoredDb };
        expect(
          readConversationQuestion(restoredDeps, answer).queuedMessageId,
        ).toBe(accepted.queuedMessageId);
        expect(
          (await answerConversationQuestion(restoredDeps, answer))
            .queuedMessageId,
        ).toBe(accepted.queuedMessageId);
        expect(listQueuedThreadMessages(restoredDb, thread.id)).toHaveLength(1);
      } finally {
        restoredDb.$client.close();
      }

      const queued = getQueuedThreadMessage(h.db, accepted.queuedMessageId!)!;
      expect(queued.content).toContain("Original context");
      expect(queued.content).toContain("Which voice?");
      expect(queued.permissionMode).toBe("accept-edits");
      expect(queued.payloadKind).toBe("questionResponse");
      expect(
        listConversationQuestionsForThread(h.deps, { threadId: thread.id }),
      ).toHaveLength(1);
      await expect(
        answerConversationQuestion(h.deps, {
          ...answer,
          answers: { voice: { selected: ["b"] } },
        }),
      ).rejects.toThrow("already answered");
      expect(
        readConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: first.id,
        }).response,
      ).toEqual(answer.answers);
      expect(
        parseConversationQuestionMarker(`::question{id="${first.id}"}`),
      ).toBe(first.id);
    });
  });

  it("dismisses independently and refuses stale revisions, cross-thread answers and later answers", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, {
        thread: { providerId: "codex", status: "active" },
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const question = await publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      });
      const answer = {
        threadId: thread.id,
        questionId: question.id,
        revision: 2,
        answers: { voice: { selected: ["a"] } },
      };
      await expect(answerConversationQuestion(h.deps, answer)).rejects.toThrow(
        "revision",
      );
      await expect(
        answerConversationQuestion(h.deps, { ...answer, threadId: "wrong" }),
      ).rejects.toThrow("not found");
      expect(
        closeConversationQuestion(h.deps, {
          ...answer,
          revision: 1,
          action: "dismiss",
        }).status,
      ).toBe("dismissed");
      await expect(
        answerConversationQuestion(h.deps, { ...answer, revision: 1 }),
      ).rejects.toThrow("dismissed");
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(0);
    });
  });
  it("rejects conflicting publication retries and new publications after source completion", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const args = {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      };
      const first = await publishConversationQuestion(h.deps, args);
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          publication: { ...publication, body: "changed" },
        }),
      ).rejects.toThrow(/conflicting/i);
      seedEvent(h.deps, {
        threadId: thread.id,
        sequence:
          listEvents(h.db, { threadId: thread.id }).at(-1)!.sequence + 1,
        type: "turn/completed",
        scope: turnScope("origin"),
        data: { providerThreadId: "p", status: "completed" },
      });
      expect((await publishConversationQuestion(h.deps, args)).id).toBe(
        first.id,
      );
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          source: { ...args.source, callId: "later" },
        }),
      ).rejects.toThrow(/completed/i);
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          source: { ...args.source, turnId: "missing" },
        }),
      ).rejects.toThrow(/missing/i);
    });
  });
  it("keeps questions readable after archival but rejects new answers", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const question = await publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      });
      archiveThread(h.db, h.hub, thread.id);
      expect(
        readConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: question.id,
        }).status,
      ).toBe("open");
      await expect(
        answerConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: question.id,
          revision: 1,
          answers: { voice: { selected: ["a"] } },
        }),
      ).rejects.toThrow(/archived/i);
    });
  });
  it("rolls back response acceptance if queue insertion fails", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const question = await publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      });
      h.db.run(
        sql`CREATE TRIGGER question_queue_failure BEFORE INSERT ON queued_thread_messages BEGIN SELECT RAISE(ABORT, 'queue write failed'); END`,
      );
      await expect(
        answerConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: question.id,
          revision: 1,
          answers: { voice: { selected: ["a"] } },
        }),
      ).rejects.toThrow(/queue write failed/);
      expect(
        readConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: question.id,
        }).status,
      ).toBe("open");
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(0);
    });
  });
  it("requires exact provider source and publishes nothing when materials fail", async () => {
    await withTestHarness(async (h) => {
      const { thread, host, session } = seedThreadFixture(h, {
        thread: { status: "active" },
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const args = {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "wrong", callId: "ask" },
        publication,
      };
      await expect(publishConversationQuestion(h.deps, args)).rejects.toThrow(
        /provenance/i,
      );
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          // @ts-expect-error
          source: null,
        }),
      ).rejects.toThrow(/requires exact source/i);
      registerHostRpcResponder(h, {
        hostId: host.id,
        sessionId: session.id,
        handle: () => ({
          ok: false,
          errorCode: "ENOENT",
          errorMessage: "Material is missing",
        }),
      });
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          source: { ...args.source, providerThreadId: "p" },
          publication: {
            ...publication,
            materials: [
              { path: "missing.mp3", label: "Missing", dependencies: [] },
            ],
          },
        }),
      ).rejects.toThrow(/missing/i);
      expect(
        listConversationQuestionsForThread(h.deps, { threadId: thread.id }),
      ).toHaveLength(0);
      expect(
        listEvents(h.db, { threadId: thread.id }).filter(
          (event) => event.type === "item/completed",
        ),
      ).toHaveLength(0);
    });
  });
  it("retains accepted response and queue custody when withdrawn", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const question = await publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      });
      seedEvent(h.deps, {
        threadId: thread.id,
        sequence:
          listEvents(h.db, { threadId: thread.id }).at(-1)!.sequence + 1,
        type: "turn/completed",
        scope: turnScope("origin"),
        data: { providerThreadId: "p", status: "completed" },
      });
      const answer = {
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      };
      const accepted = await answerConversationQuestion(h.deps, answer);
      const withdrawn = closeConversationQuestion(h.deps, {
        ...answer,
        action: "withdraw",
      });
      expect(withdrawn).toMatchObject({
        status: "withdrawn",
        response: answer.answers,
        queuedMessageId: accepted.queuedMessageId,
      });
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
      await expect(answerConversationQuestion(h.deps, answer)).rejects.toThrow(
        /withdrawn/,
      );
    });
  });
  it.each(["idle", "stopping"] as const)(
    "keeps accepted answers held for a %s thread after stop",
    async (status) => {
      await withTestHarness(async (h) => {
        const { thread } = seedThreadFixture(h, {
          thread: { status: "active" },
        });
        seedThreadRuntimeState(h.deps, {
          threadId: thread.id,
          environmentId: thread.environmentId,
          providerThreadId: "p",
        });
        seedTurnStarted(h.deps, {
          threadId: thread.id,
          turnId: "origin",
          providerThreadId: "p",
        });
        const question = await publishConversationQuestion(h.deps, {
          threadId: thread.id,
          source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
          publication,
        });
        seedEvent(h.deps, {
          threadId: thread.id,
          sequence:
            listEvents(h.db, { threadId: thread.id }).at(-1)!.sequence + 1,
          type: "turn/completed",
          scope: turnScope("origin"),
          data: { providerThreadId: "p", status: "completed" },
        });
        seedEvent(h.deps, {
          threadId: thread.id,
          sequence:
            listEvents(h.db, { threadId: thread.id }).at(-1)!.sequence + 1,
          type: "system/thread/interrupted",
          scope: threadScope(),
          data: { reason: "manual-stop" },
        });
        h.db
          .update(threads)
          .set({ status })
          .where(eq(threads.id, thread.id))
          .run();
        const accepted = await answerConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: question.id,
          revision: 1,
          answers: { voice: { selected: ["a"] } },
        });
        expect(
          JSON.parse(
            getQueuedThreadMessage(h.db, accepted.queuedMessageId!)!.waitingOn!,
          ),
        ).toEqual({ kind: status === "stopping" ? "stopping" : "thread-busy" });
        expect(isThreadQueueAutoSendPaused(h.db, thread.id)).toBe(true);
        await runQueuedMessageDispatch(h.deps, {
          kind: "idle-recovery",
          now: Date.now() + 120000,
        });
        expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
      });
    },
  );
  it("does not publish if the thread starts stopping while material snapshots prepare", async () => {
    await withTestHarness(async (h) => {
      const { thread, host, session } = seedThreadFixture(h, {
        thread: { status: "active" },
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const bytes = Buffer.from("x");
      registerHostRpcResponder(h, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "host.read_file_chunk") {
            h.db
              .update(threads)
              .set({ status: "stopping" })
              .where(eq(threads.id, thread.id))
              .run();
            return {
              ok: true,
              result: {
                path: command.path,
                sizeBytes: bytes.length,
                mimeType: "text/plain",
                modifiedAtMs: 1,
                revision: "0".repeat(64),
                offset: command.offset,
                content: bytes
                  .subarray(command.offset, command.offset + command.length)
                  .toString("base64"),
              },
            };
          }
          if (command.type === "host.write_file")
            return {
              ok: true,
              result: {
                outcome: "written",
                sha256: createHash("sha256").update(bytes).digest("hex"),
                sizeBytes: bytes.length,
              },
            };
          throw new Error(`Unexpected command ${command.type}`);
        },
      });
      await expect(
        publishConversationQuestion(h.deps, {
          threadId: thread.id,
          source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
          publication: {
            ...publication,
            materials: [
              { path: "context.txt", label: "Context", dependencies: [] },
            ],
          },
        }),
      ).rejects.toThrow(/stopping/i);
      expect(
        listConversationQuestionsForThread(h.deps, { threadId: thread.id }),
      ).toHaveLength(0);
      expect(
        listEvents(h.db, { threadId: thread.id }).filter(
          (event) => event.type === "item/completed",
        ),
      ).toHaveLength(0);
    });
  });
  it("distinguishes queued, held and removed replies without inventing a submission receipt", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const question = await publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication,
      });
      expect(question.delivery).toEqual({ kind: "none", reason: null });
      const ref = { threadId: thread.id, questionId: question.id };
      const accepted = await answerConversationQuestion(h.deps, {
        ...ref,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      });
      expect(accepted.delivery).toMatchObject({ kind: "held" });
      clearQueuedThreadMessageWaitingOn(h.db, h.hub, {
        threadId: thread.id,
        id: accepted.queuedMessageId!,
      });
      expect(readConversationQuestion(h.deps, ref).delivery).toEqual({
        kind: "queued",
        reason: null,
      });
      setQueuedThreadMessageFailureReason(h.db, h.hub, {
        threadId: thread.id,
        id: accepted.queuedMessageId!,
        failureReason: "Provider rejected dispatch",
        now: Date.now(),
        retryDelaysMs: [],
      });
      expect(readConversationQuestion(h.deps, ref).delivery).toEqual({
        kind: "held",
        reason: "Provider rejected dispatch",
      });
      h.db
        .delete(queuedThreadMessages)
        .where(eq(queuedThreadMessages.id, accepted.queuedMessageId!))
        .run();
      const removed = readConversationQuestion(h.deps, ref);
      expect(removed.delivery.kind).toBe("removed");
      expect(removed.delivery.reason).toContain("no submission receipt");
      expect(removed.dispatchedAt).toBeNull();
      expect(removed.queuedMessageId).toBe(accepted.queuedMessageId);
    });
  });
});

it("rejects a fresh publication from a source interrupted before its completion event", async () => {
  await withTestHarness(async (h) => {
    const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      turnId: "origin",
      providerThreadId: "p",
    });
    seedEvent(h.deps, {
      threadId: thread.id,
      sequence: 2,
      type: "system/thread/interrupted",
      scope: threadScope(),
      data: { reason: "manual-stop" },
    });
    h.db
      .update(threads)
      .set({ status: "idle" })
      .where(eq(threads.id, thread.id))
      .run();
    await expect(
      publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "late" },
        publication,
      }),
    ).rejects.toThrow(/interrupted/i);
    expect(
      listConversationQuestionsForThread(h.deps, { threadId: thread.id }),
    ).toHaveLength(0);
  });
});
