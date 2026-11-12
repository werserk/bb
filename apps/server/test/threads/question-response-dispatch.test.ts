import {
  getQueuedThreadMessage,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import {
  conversationQuestionPublicationSchema,
  parseQuestionResolutionNotice,
  turnScope,
} from "@bb/domain";
import { createDeferredPromise } from "@bb/test-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerConversationQuestion,
  closeConversationQuestion,
  publishConversationQuestion,
  readConversationQuestion,
} from "../../src/services/threads/conversation-questions.js";
import { applyLoggedThreadLifecycleEvent } from "../../src/services/threads/lifecycle-outcome.js";
import { sendQueuedMessageNow } from "../../src/services/threads/queued-messages.js";
import { acceptThreadSendRequest } from "../../src/services/threads/thread-send-request.js";
import {
  registerHostRpcResponder,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
} from "../helpers/host-rpc.js";
import { listQueuedCommands } from "../helpers/commands.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEvent,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const publication = conversationQuestionPublicationSchema.parse({
  body: "Compare the original voice samples.",
  questions: [
    {
      id: "voice",
      prompt: "Which voice should speak?",
      options: [{ value: "a", label: "Voice A" }],
      allowFreeText: true,
      multiSelect: false,
    },
  ],
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function prepareQuestion(h: TestAppHarness) {
  const { thread, environment, host, session } = seedThreadFixture(h, {
    thread: { status: "active" },
  });
  const source = {
    turnId: "origin",
    providerThreadId: "provider-question",
    callId: "ask",
  };
  seedThreadRuntimeState(h.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    providerThreadId: source.providerThreadId,
    permissionMode: "accept-edits",
  });
  seedTurnStarted(h.deps, {
    threadId: thread.id,
    environmentId: environment.id,
    ...source,
  });
  const question = await publishConversationQuestion(h.deps, {
    threadId: thread.id,
    source,
    publication,
  });
  return { thread, environment, host, session, source, question };
}

function finishSource(
  h: TestAppHarness,
  fixture: Awaited<ReturnType<typeof prepareQuestion>>,
) {
  seedEvent(h.deps, {
    threadId: fixture.thread.id,
    environmentId: fixture.environment.id,
    providerThreadId: fixture.source.providerThreadId,
    sequence:
      listEvents(h.db, { threadId: fixture.thread.id }).at(-1)!.sequence + 1,
    type: "turn/completed",
    scope: turnScope(fixture.source.turnId),
    data: {
      providerThreadId: fixture.source.providerThreadId,
      status: "completed",
    },
  });
  applyLoggedThreadLifecycleEvent(h.deps, {
    threadId: fixture.thread.id,
    event: { type: "run.succeeded" },
  });
}
function requests(h: TestAppHarness, threadId: string) {
  return listEvents(h.db, { threadId }).filter(
    (event) => event.type === "client/turn/requested",
  );
}
function providerSends(h: TestAppHarness) {
  return [
    ...listQueuedCommands(h, "turn.submit"),
    ...listQueuedCommands(h, "thread.start"),
  ];
}
function assertHeld(
  h: TestAppHarness,
  fixture: Awaited<ReturnType<typeof prepareQuestion>>,
  queuedMessageId: string,
  requestsBefore: number,
) {
  const row = getQueuedThreadMessage(h.db, queuedMessageId);
  expect(row).toMatchObject({
    state: "failed_exhausted",
    payloadKind: "questionResponse",
    questionId: fixture.question.id,
    questionRevision: 1,
    claimToken: null,
  });
  expect(row?.failureReason).toContain("question withdrawn");
  expect(row?.content).toContain(publication.body);
  expect(
    listQueuedThreadMessages(h.db, fixture.thread.id).map((row) => row.id),
  ).toContain(queuedMessageId);
  const cancellation = listQueuedThreadMessages(h.db, fixture.thread.id).find(
    (row) => row.id !== queuedMessageId,
  );
  const notice = parseQuestionResolutionNotice(
    JSON.parse(cancellation!.content)[0].text,
  );
  expect(notice?.resolution).toMatchObject({
    action: "withdraw",
    answers: null,
  });
  expect(requests(h, fixture.thread.id)).toHaveLength(requestsBefore);
  expect(providerSends(h)).toHaveLength(0);
  expect(
    readConversationQuestion(h.deps, {
      threadId: fixture.thread.id,
      questionId: fixture.question.id,
    }),
  ).toMatchObject({
    status: "withdrawn",
    delivery: { kind: "held" },
    queuedMessageId,
    response: { voice: { selected: ["a"] } },
  });
}

describe("independent question response dispatch", () => {
  it("submits one attributed cancellation using its own durable queue receipt", async () => {
    await withTestHarness(async (h) => {
      vi.useFakeTimers();
      const fixture = await prepareQuestion(h);
      const ref = {
        threadId: fixture.thread.id,
        questionId: fixture.question.id,
        revision: 1,
        action: "withdraw" as const,
      };
      const call = {
        operationId: "cancel-scope",
        reason: "The accepted scope no longer needs the answer",
        invocation: {
          threadId: fixture.thread.id,
          turnId: fixture.source.turnId,
          providerThreadId: fixture.source.providerThreadId,
        },
      };
      const accepted = await closeConversationQuestion(h.deps, ref, call);
      const retry = await closeConversationQuestion(h.deps, ref, call);
      expect(retry.resolutionAttribution?.id).toBe(
        accepted.resolutionAttribution?.id,
      );
      expect(retry.resolutionAttribution?.deliveryId).toBe(
        accepted.resolutionAttribution?.deliveryId,
      );
      const deliveryId = accepted.resolutionAttribution!.deliveryId!;
      expect(accepted.response).toBeNull();
      expect(accepted.queuedMessageId).toBeNull();
      expect(accepted.resolutionDelivery?.kind).toBe("held");
      finishSource(h, fixture);
      const before = requests(h, fixture.thread.id).length;
      expect(
        (
          await sendQueuedMessageNow(h.deps, {
            threadId: fixture.thread.id,
            queuedMessageId: deliveryId,
            mode: "auto",
          })
        ).delivery,
      ).toBe("sent");
      expect(requests(h, fixture.thread.id)).toHaveLength(before + 1);
      expect(providerSends(h)).toHaveLength(1);
      expect(getQueuedThreadMessage(h.db, deliveryId)).toBeNull();
      const current = readConversationQuestion(h.deps, ref);
      expect(current).toMatchObject({
        status: "withdrawn",
        response: null,
        resolutionDelivery: { kind: "submitted" },
        resolutionAttribution: accepted.resolutionAttribution,
      });
      await expect(
        sendQueuedMessageNow(h.deps, {
          threadId: fixture.thread.id,
          queuedMessageId: deliveryId,
          mode: "auto",
        }),
      ).rejects.toThrow();
      expect(requests(h, fixture.thread.id)).toHaveLength(before + 1);
      expect(providerSends(h)).toHaveLength(1);
    });
  });
  it("retains a withdrawn accepted response as a visible exhausted row without sending", async () => {
    await withTestHarness(async (h) => {
      vi.useFakeTimers();
      const fixture = await prepareQuestion(h);
      const answer = await answerConversationQuestion(h.deps, {
        threadId: fixture.thread.id,
        questionId: fixture.question.id,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      });
      await closeConversationQuestion(h.deps, {
        threadId: fixture.thread.id,
        questionId: fixture.question.id,
        revision: 1,
        action: "withdraw",
      });
      finishSource(h, fixture);
      const before = requests(h, fixture.thread.id).length;
      const delivery = await sendQueuedMessageNow(h.deps, {
        threadId: fixture.thread.id,
        queuedMessageId: answer.queuedMessageId!,
        mode: "auto",
      });
      expect(delivery.delivery).toBe("queued");
      assertHeld(h, fixture, answer.queuedMessageId!, before);
    });
  });

  it("checks withdrawal again after asynchronous dispatch preparation", async () => {
    await withTestHarness(async (h) => {
      vi.useFakeTimers();
      const fixture = await prepareQuestion(h);
      const answer = await answerConversationQuestion(h.deps, {
        threadId: fixture.thread.id,
        questionId: fixture.question.id,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      });
      finishSource(h, fixture);
      const entered = createDeferredPromise<void>();
      const release = createDeferredPromise<void>();
      registerHostRpcResponder(h, {
        hostId: fixture.host.id,
        sessionId: fixture.session.id,
        restoreCommandCaptureAfterResponse: true,
        async handle({ command }) {
          if (command.type !== "host.read_workspace_agent_context")
            throw new Error(`Unexpected preparation command ${command.type}`);
          entered.resolve();
          await release.promise;
          return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
        },
      });
      const before = requests(h, fixture.thread.id).length;
      const pending = sendQueuedMessageNow(h.deps, {
        threadId: fixture.thread.id,
        queuedMessageId: answer.queuedMessageId!,
        mode: "auto",
      });
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error(
            "Dispatch completed before asynchronous workspace preparation",
          );
        }),
      ]);
      await closeConversationQuestion(h.deps, {
        threadId: fixture.thread.id,
        questionId: fixture.question.id,
        revision: 1,
        action: "withdraw",
      });
      release.resolve();
      expect((await pending).delivery).toBe("queued");
      assertHeld(h, fixture, answer.queuedMessageId!, before);
    });
  });

  it("dispatches an accepted answer with original context after its source turn completed", async () => {
    await withTestHarness(async (h) => {
      vi.useFakeTimers();
      const fixture = await prepareQuestion(h);
      const answer = await answerConversationQuestion(h.deps, {
        threadId: fixture.thread.id,
        questionId: fixture.question.id,
        revision: 1,
        answers: { voice: { selected: ["a"] } },
      });
      finishSource(h, fixture);
      const before = requests(h, fixture.thread.id).length;
      expect(
        (
          await sendQueuedMessageNow(h.deps, {
            threadId: fixture.thread.id,
            queuedMessageId: answer.queuedMessageId!,
            mode: "auto",
          })
        ).delivery,
      ).toBe("sent");
      expect(listQueuedThreadMessages(h.db, fixture.thread.id)).toHaveLength(0);
      expect(requests(h, fixture.thread.id)).toHaveLength(before + 1);
      const sent = requests(h, fixture.thread.id).at(-1)!.data;
      expect(sent).toContain(publication.body);
      expect(sent).toContain("Which voice should speak?");
      expect(sent).toContain("Voice A");
      expect(sent).toContain(fixture.question.id);
      expect(providerSends(h)).toHaveLength(1);
      expect(
        readConversationQuestion(h.deps, {
          threadId: fixture.thread.id,
          questionId: fixture.question.id,
        }),
      ).toMatchObject({
        status: "answered",
        delivery: { kind: "submitted" },
        dispatchedAt: expect.any(Number),
        queuedMessageId: answer.queuedMessageId,
      });
    });
  });

  it("sends an ordinary message while an unanswered question stays open", async () => {
    await withTestHarness(async (h) => {
      vi.useFakeTimers();
      const fixture = await prepareQuestion(h);
      finishSource(h, fixture);
      const before = requests(h, fixture.thread.id).length;
      await acceptThreadSendRequest(h.deps, {
        thread: getThread(h.db, fixture.thread.id)!,
        payload: {
          input: textInput("Continue the separate task."),
          mode: "auto",
        },
      });
      expect(requests(h, fixture.thread.id)).toHaveLength(before + 1);
      expect(requests(h, fixture.thread.id).at(-1)!.data).toContain(
        "Continue the separate task.",
      );
      expect(providerSends(h)).toHaveLength(1);
      expect(
        readConversationQuestion(h.deps, {
          threadId: fixture.thread.id,
          questionId: fixture.question.id,
        }),
      ).toMatchObject({
        status: "open",
        delivery: { kind: "none", reason: null },
        response: null,
        queuedMessageId: null,
      });
    });
  });
});
