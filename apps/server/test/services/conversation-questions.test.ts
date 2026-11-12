import { createNodeBbSdk } from "@bb/sdk/node";
import { internalAuthHeaders } from "../helpers/commands.js";
import { createConversationQuestion } from "@bb/db";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
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
import { readThreadPlan } from "../../src/services/threads/thread-plans.js";
import { listThreadsWithPendingInteractionState } from "@bb/db";
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
      expect(accepted.resolutionAttribution).toMatchObject({
        action: "answer",
        actor: {
          kind: "local-unverified",
          verification: "unverified-local",
        },
        reason: "Answered in question card",
        answers: answer.answers,
        deliveryId: accepted.queuedMessageId,
      });
      expect(accepted.resolutionHistory).toHaveLength(1);
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
      expect(queued.content).toContain(
        "Answered locally · identity unverified",
      );
      expect(queued.content).not.toContain("Owner answers");
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
        (
          await closeConversationQuestion(h.deps, {
            ...answer,
            revision: 1,
            action: "dismiss",
          })
        ).status,
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
      const withdrawn = await closeConversationQuestion(h.deps, {
        ...answer,
        action: "withdraw",
      });
      expect(withdrawn).toMatchObject({
        status: "withdrawn",
        response: answer.answers,
        queuedMessageId: accepted.queuedMessageId,
      });
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(2);
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
      expect(accepted.delivery).toEqual({
        kind: "queued",
        reason: "will be sent after this turn",
      });
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

it("projects persistent-question attention across publish, multiple questions, answer and Cancel without blocking the agent", async () => {
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
      turnId: "attention-origin",
      providerThreadId: "p",
    });
    const notify = vi.spyOn(h.deps.hub, "notifyThread");
    const make = (callId: string) =>
      publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "attention-origin", providerThreadId: "p", callId },
        publication,
      });
    const first = await make("one"),
      second = await make("two");
    const read = () => readThreadPlan(h.deps, thread);
    expect(read()).toMatchObject({
      ownAttention: "needs_input",
      attentionInteractionIds: [],
      unboundInteractionIds: [],
    });
    expect(
      listThreadsWithPendingInteractionState(h.db, {
        threadIds: [thread.id],
      })[0],
    ).toMatchObject({
      hasOpenQuestion: true,
      hasPendingInteraction: false,
      status: "active",
    });
    expect(
      notify.mock.calls
        .filter(
          ([id, changes]) =>
            id === thread.id && changes.includes("interactions-changed"),
        )
        .at(-1)?.[2],
    ).toMatchObject({ projectId: thread.projectId });
    await answerConversationQuestion(h.deps, {
      threadId: thread.id,
      questionId: first.id,
      revision: 1,
      answers: { voice: { selected: ["a"] } },
    });
    expect(read().ownAttention).toBe("needs_input");
    expect(
      notify.mock.calls
        .filter(
          ([id, changes]) =>
            id === thread.id && changes.includes("interactions-changed"),
        )
        .at(-1)?.[2],
    ).toMatchObject({ projectId: thread.projectId });
    await closeConversationQuestion(h.deps, {
      threadId: thread.id,
      questionId: second.id,
      revision: 1,
      action: "dismiss",
    });
    expect(read().ownAttention).toBe("none");
    expect(
      notify.mock.calls
        .filter(
          ([id, changes]) =>
            id === thread.id && changes.includes("interactions-changed"),
        )
        .at(-1)?.[2],
    ).toMatchObject({ projectId: thread.projectId });
    expect(
      h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
    ).toHaveLength(0);
    const third = await make("three");
    await closeConversationQuestion(h.deps, {
      threadId: thread.id,
      questionId: third.id,
      revision: 1,
      action: "withdraw",
    });
    expect(read().ownAttention).toBe("none");
    const fourth = await make("four");
    h.db
      .update(threads)
      .set({ archivedAt: Date.now() })
      .where(eq(threads.id, thread.id))
      .run();
    expect(
      readThreadPlan(h.deps, { ...thread, archivedAt: Date.now() })
        .ownAttention,
    ).toBe("none");
    expect(fourth.status).toBe("open");
  });
});

describe("publication budget at authoritative entrypoints", () => {
  it.each(["service", "http", "sdk", "normalized-tool", "legacy-tool"])(
    "rejects through %s before all publication side effects",
    async (surface) => {
      await withTestHarness(async (h) => {
        const { thread, host, session } = seedThreadFixture(h, {
          thread: { status: "active" },
        });
        seedTurnStarted(h.deps, {
          threadId: thread.id,
          turnId: "origin",
          providerThreadId: "p",
        });
        const source = {
          turnId: "origin",
          providerThreadId: "p",
          callId: "big",
        };
        const oversized = {
          ...publication,
          body: "x".repeat(65537),
          materials: [{ path: "report.md", label: "Report", dependencies: [] }],
        };
        const rpc = registerHostRpcResponder(h, {
          hostId: host.id,
          sessionId: session.id,
          handle: () => {
            throw new Error("Unexpected material snapshot");
          },
        });
        const notify = vi.spyOn(h.deps.hub, "notifyThread");
        const before = listEvents(h.db, { threadId: thread.id });
        if (surface === "service") {
          await expect(
            publishConversationQuestion(h.deps, {
              threadId: thread.id,
              source,
              publication: oversized,
            }),
          ).rejects.toThrow(
            "65537/400 code points. Shorten the question and put the full report in materials.",
          );
        } else if (surface === "http") {
          const response = await h.app.request(
            `/api/v1/threads/${thread.id}/questions`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source, publication: oversized }),
            },
          );
          expect(response.status).toBe(400);
          expect(await response.text()).toContain("65537/400");
        } else if (surface === "sdk") {
          const sdk = createNodeBbSdk({
            baseUrl: "http://localhost",
            fetch: async (input, init) =>
              h.app.request(new Request(input, init)),
          });
          await expect(
            sdk.threads.questions.publish({
              threadId: thread.id,
              source,
              publication: oversized,
            }),
          ).rejects.toThrow(/65537\/400/);
        } else {
          const input =
            surface === "legacy-tool"
              ? {
                  ...oversized,
                  questions: [{ question: "Proceed?", header: "Choice" }],
                }
              : oversized;
          const response = await h.app.request("/internal/session/tool-call", {
            method: "POST",
            headers: internalAuthHeaders(h),
            body: JSON.stringify({
              sessionId: session.id,
              threadId: thread.id,
              ...source,
              tool: "bb_ask_question",
              arguments: input,
            }),
          });
          expect(await response.json()).toMatchObject({
            success: false,
            contentItems: [
              {
                type: "inputText",
                text: "Question was not published: Question card body: 65537/400 code points. Shorten the question and put the full report in materials.",
              },
            ],
          });
        }
        expect(rpc.requests).toHaveLength(0);
        expect(notify).not.toHaveBeenCalled();
        expect(listEvents(h.db, { threadId: thread.id })).toEqual(before);
        expect(
          listConversationQuestionsForThread(h.deps, { threadId: thread.id }),
        ).toEqual([]);
        expect(listQueuedThreadMessages(h.db, thread.id)).toEqual([]);
      });
    },
  );
  it("retains read/list/answer custody for a stored oversized card", async () => {
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
      const old = { ...publication, body: "я".repeat(10000) };
      const row = createConversationQuestion(h.db, {
        threadId: thread.id,
        sourceTurnId: "origin",
        sourceCallId: "old",
        publication: JSON.stringify(old),
        materialManifest: JSON.stringify({
          hostId: null,
          storageRootPath: null,
          materials: [],
          files: [],
        }),
      });
      expect(row).not.toBeNull();
      const ref = { threadId: thread.id, questionId: row!.id };
      expect(readConversationQuestion(h.deps, ref).publication.body).toBe(
        old.body,
      );
      expect(
        listConversationQuestionsForThread(h.deps, { threadId: thread.id })[0]!
          .publication.body,
      ).toBe(old.body);
      const answered = await answerConversationQuestion(h.deps, {
        ...ref,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      });
      expect(answered.status).toBe("answered");
      expect(answered.publication.body).toBe(old.body);
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
    });
  });
  it("accepts the same huge report as material beside a short question and preserves replay", async () => {
    await withTestHarness(async (h) => {
      const { thread, host, session } = seedThreadFixture(h, {
        thread: { status: "active" },
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "origin",
        providerThreadId: "p",
      });
      const report = "я".repeat(65537);
      const bytes = Buffer.from(report);
      const rpc = registerHostRpcResponder(h, {
        hostId: host.id,
        sessionId: session.id,
        handle: ({ command }) => {
          if (command.type === "host.read_file_chunk")
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
          if (command.type === "host.write_file")
            return {
              ok: true,
              result: {
                outcome: "written",
                sha256: createHash("sha256").update(bytes).digest("hex"),
                sizeBytes: bytes.length,
              },
            };
          throw new Error(`Unexpected ${command.type}`);
        },
      });
      const args = {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "report" },
        publication: {
          ...publication,
          materials: [
            { path: "report.txt", label: "Full report", dependencies: [] },
          ],
        },
      };
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          publication: { ...args.publication, body: report },
        }),
      ).rejects.toThrow("65537/400");
      expect(rpc.requests).toHaveLength(0);
      const question = await publishConversationQuestion(h.deps, args);
      expect(question.status).toBe("open");
      expect(question.materialManifest.files[0]!.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(question.materialManifest.files[0]!.sizeBytes).toBe(bytes.length);
      const requests = rpc.requests.length;
      const events = listEvents(h.db, { threadId: thread.id });
      expect((await publishConversationQuestion(h.deps, args)).id).toBe(
        question.id,
      );
      await expect(
        publishConversationQuestion(h.deps, {
          ...args,
          publication: { ...args.publication, body: "Different" },
        }),
      ).rejects.toThrow(/conflicting/i);
      expect(rpc.requests).toHaveLength(requests);
      expect(listEvents(h.db, { threadId: thread.id })).toEqual(events);
    });
  });
});
