import { describe, expect, it } from "vitest";
import { parseQuestionResolutionNotice } from "@bb/domain";
import { createConversationQuestion, listQueuedThreadMessages } from "@bb/db";
import { internalAuthHeaders } from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedTurnStarted,
  seedThreadRuntimeState,
  seedThread,
  seedProjectWithSource,
  seedEnvironment,
} from "../helpers/seed.js";
import {
  answerConversationQuestion,
  readConversationQuestion,
} from "../../src/services/threads/conversation-questions.js";

const publication = {
  body: "A choice for the asker",
  materials: [],
  questions: [
    {
      id: "choice",
      prompt: "Which?",
      multiSelect: false,
      allowFreeText: true,
      required: true,
      options: [{ value: "a", label: "A" }],
    },
  ],
};

describe("native question resolution", () => {
  it.each([
    ["foreign", "answer"],
    ["foreign", "withdraw"],
    ["sibling", "answer"],
    ["sibling", "withdraw"],
  ] as const)(
    "refuses %s %s before exposing revision or answer-validation details",
    async (relationship, action) => {
      await withTestHarness(async (h) => {
        const target = seedThreadFixture(h, { thread: { status: "active" } });
        seedThreadRuntimeState(h.deps, {
          threadId: target.thread.id,
          environmentId: target.environment.id,
          providerThreadId: "target-provider",
        });
        const callerProject =
          relationship === "foreign"
            ? seedProjectWithSource(h.deps, { hostId: target.host.id }).project
            : target.project;
        const callerEnvironment =
          relationship === "foreign"
            ? seedEnvironment(h.deps, {
                hostId: target.host.id,
                projectId: callerProject.id,
              })
            : target.environment;
        const caller = seedThread(h.deps, {
          projectId: callerProject.id,
          environmentId: callerEnvironment.id,
          status: "active",
        });
        const session = target.session;
        seedTurnStarted(h.deps, {
          threadId: caller.id,
          turnId: "native",
          providerThreadId: "caller-provider",
        });
        const question = createConversationQuestion(h.db, {
          threadId: target.thread.id,
          sourceTurnId: null,
          sourceCallId: null,
          publication: JSON.stringify(publication),
          materialManifest: JSON.stringify({
            hostId: null,
            storageRootPath: null,
            materials: [],
            files: [],
          }),
        })!;
        await answerConversationQuestion(h.deps, {
          threadId: target.thread.id,
          questionId: question.id,
          revision: 1,
          answers: {
            choice: { selected: [], freeText: "PRIVATE_OWNER_ANSWER" },
          },
        });
        const before = readConversationQuestion(h.deps, {
          threadId: target.thread.id,
          questionId: question.id,
        });
        for (const revision of [2, 1]) {
          for (const answers of action === "answer"
            ? [{ choice: { selected: ["a"] } }, {}]
            : [undefined]) {
            const response = await h.app.request(
              "/internal/session/tool-call",
              {
                method: "POST",
                headers: internalAuthHeaders(h),
                body: JSON.stringify({
                  sessionId: session.id,
                  threadId: caller.id,
                  turnId: "native",
                  providerThreadId: "caller-provider",
                  callId: "resolve",
                  tool: "bb_resolve_question",
                  arguments: {
                    threadId: target.thread.id,
                    questionId: question.id,
                    revision,
                    operationId: "not-authorized",
                    action,
                    reason: "Must not disclose the target",
                    ...(answers ? { answers } : {}),
                  },
                }),
              },
            );
            const result = await response.json();
            expect(result.success, JSON.stringify(result)).toBe(false);
            const error = JSON.parse(result.contentItems[0].text).error;
            expect(error.code).toBe("question_resolution_refused");
            expect(error.details).toBeUndefined();
            expect(JSON.stringify(result)).not.toContain(
              "PRIVATE_OWNER_ANSWER",
            );
            expect(JSON.stringify(result)).not.toContain(publication.body);
          }
        }
        expect(
          readConversationQuestion(h.deps, {
            threadId: target.thread.id,
            questionId: question.id,
          }),
        ).toEqual(before);
        expect(listQueuedThreadMessages(h.db, target.thread.id)).toHaveLength(
          1,
        );
      });
    },
  );

  it("discovers answerable prompts with bounded coverage and refuses stale cursors", async () => {
    await withTestHarness(async (h) => {
      const { thread, session } = seedThreadFixture(h, {
        thread: { status: "active" },
      });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "native",
        providerThreadId: "p",
      });
      for (let i = 0; i < 2; i++)
        createConversationQuestion(h.db, {
          threadId: thread.id,
          sourceTurnId: null,
          sourceCallId: null,
          publication: JSON.stringify(publication),
          materialManifest: JSON.stringify({
            hostId: null,
            storageRootPath: null,
            materials: [],
            files: [],
          }),
        });
      const list = async (cursor?: string) => {
        const response = await h.app.request("/internal/session/tool-call", {
          method: "POST",
          headers: internalAuthHeaders(h),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: thread.id,
            turnId: "native",
            providerThreadId: "p",
            callId: "list",
            tool: "bb_list_questions",
            arguments: {
              threadId: thread.id,
              limit: 1,
              ...(cursor ? { cursor } : {}),
            },
          }),
        });
        return response.json();
      };
      const first = await list();
      expect(first.success).toBe(true);
      const page = JSON.parse(first.contentItems[0].text);
      expect(page).toMatchObject({
        coverage: "page",
        total: 2,
        questions: [
          {
            kind: "qst",
            revision: 1,
            questions: [
              {
                id: "choice",
                prompt: "Which?",
                multiSelect: false,
                allowFreeText: true,
                required: true,
                options: [{ value: "a", label: "A" }],
              },
            ],
          },
        ],
      });
      const second = JSON.parse(
        (await list(page.nextCursor)).contentItems[0].text,
      );
      expect(second).toMatchObject({
        coverage: "page",
        nextCursor: null,
        readRevision: page.readRevision,
      });
      const closed = await h.app.request(
        `/api/v1/threads/${thread.id}/questions/${page.questions[0].id}/dismiss`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ revision: 1 }),
        },
      );
      expect(closed.ok).toBe(true);
      expect((await list(page.nextCursor)).success).toBe(false);
    });
  });
  it.each(["answer", "withdraw"] as const)(
    "resolves self with %s and an operation-bound retry receipt",
    async (action) => {
      await withTestHarness(async (h) => {
        const { thread, session } = seedThreadFixture(h, {
          thread: { status: "active" },
        });
        seedThreadRuntimeState(h.deps, {
          threadId: thread.id,
          environmentId: thread.environmentId,
          providerThreadId: "p",
        });
        seedTurnStarted(h.deps, {
          threadId: thread.id,
          turnId: "native",
          providerThreadId: "p",
        });
        const question = createConversationQuestion(h.db, {
          threadId: thread.id,
          sourceTurnId: null,
          sourceCallId: null,
          publication: JSON.stringify(publication),
          materialManifest: JSON.stringify({
            hostId: null,
            storageRootPath: null,
            materials: [],
            files: [],
          }),
        })!;
        const input = {
          threadId: thread.id,
          questionId: question.id,
          revision: 1,
          operationId: "answer-1",
          action,
          reason: "The accepted scope settles this choice",
          ...(action === "answer"
            ? { answers: { choice: { selected: ["a"] } } }
            : {}),
        };
        const call = async (arguments_: unknown) => {
          const response = await h.app.request("/internal/session/tool-call", {
            method: "POST",
            headers: internalAuthHeaders(h),
            body: JSON.stringify({
              sessionId: session.id,
              threadId: thread.id,
              turnId: "native",
              providerThreadId: "p",
              callId: "resolve",
              tool: "bb_resolve_question",
              arguments: arguments_,
            }),
          });
          return response.json();
        };
        const first = await call(input);
        expect(first.success).toBe(true);
        const stale = await call({ ...input, revision: 2 });
        expect(JSON.parse(stale.contentItems[0].text).error).toMatchObject({
          code: "conversation_question_conflict",
          details: { current: { id: question.id, revision: 1 } },
        });
        const accepted = readConversationQuestion(h.deps, {
          threadId: thread.id,
          questionId: question.id,
        });
        expect(accepted.resolutionAttribution).toMatchObject({
          actor: {
            kind: "agent",
            verification: "runtime",
            threadId: thread.id,
            projectId: thread.projectId,
            name: thread.title,
          },
          operationId: "answer-1",
          reason: input.reason,
        });
        expect((await call(input)).success).toBe(true);
        if (action === "answer") {
          const withdrawal = await call({
            ...input,
            action: "withdraw",
            answers: undefined,
            operationId: "withdraw-closed",
          });
          expect(withdrawal.success).toBe(false);
          expect(
            JSON.parse(withdrawal.contentItems[0].text).error.details.current
              .status,
          ).toBe("answered");
        }
        const conflict = await call({ ...input, reason: "Changed retry" });
        expect(conflict.success).toBe(false);
        expect(JSON.parse(conflict.contentItems[0].text).error).toMatchObject({
          code: "conversation_question_conflict",
          details: {
            current: {
              id: question.id,
              revision: 1,
              status: accepted.status,
              resolutionAttribution: { id: accepted.resolutionAttribution!.id },
            },
          },
        });
        expect(
          (await call({ ...input, operationId: "another-operation" })).success,
        ).toBe(false);
        expect(
          readConversationQuestion(h.deps, {
            threadId: thread.id,
            questionId: question.id,
          }).resolutionHistory,
        ).toHaveLength(1);
        const queue = listQueuedThreadMessages(h.db, thread.id);
        expect(queue).toHaveLength(1);
        expect(queue[0]!.senderThreadId).toBe(thread.id);
        expect(
          parseQuestionResolutionNotice(JSON.parse(queue[0]!.content)[0].text),
        ).toMatchObject({
          version: 1,
          resolution: { actor: { kind: "agent", threadId: thread.id } },
        });
        expect(queue[0]!.content).toContain(
          action === "answer" ? "Answered by" : "Withdrawn by",
        );
        expect(accepted.status).toBe(
          action === "answer" ? "answered" : "withdrawn",
        );
        if (action === "withdraw") expect(accepted.response).toBeNull();
        expect(queue[0]!.content).toContain(input.reason);
        expect(
          (await call({ ...input, actor: { kind: "owner" } })).success,
        ).toBe(false);
      });
    },
  );

  it("records unauthenticated local answers without trusting a claimed native thread", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      const question = createConversationQuestion(h.db, {
        threadId: thread.id,
        sourceTurnId: null,
        sourceCallId: null,
        publication: JSON.stringify(publication),
        materialManifest: JSON.stringify({
          hostId: null,
          storageRootPath: null,
          materials: [],
          files: [],
        }),
      })!;
      const response = await h.app.request(
        `/api/v1/threads/${thread.id}/questions/${question.id}/answer`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            BB_THREAD_ID: "thr_coordinator",
            "X-BB-Thread-ID": "thr_coordinator",
          },
          body: JSON.stringify({
            revision: 1,
            answers: { choice: { selected: ["a"] } },
          }),
        },
      );
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      expect(result.resolutionAttribution.actor).toEqual({
        kind: "local-unverified",
        verification: "unverified-local",
      });
      expect(
        listQueuedThreadMessages(h.db, thread.id)[0]!.senderThreadId,
      ).toBeNull();
    });
  });
});

it.each(["answer", "withdraw"] as const)(
  "resolves qst %s through the shared local endpoint without trusting actor headers",
  async (action) => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      const question = createConversationQuestion(h.db, {
        threadId: thread.id,
        sourceTurnId: null,
        sourceCallId: null,
        publication: JSON.stringify(publication),
        materialManifest: JSON.stringify({
          hostId: null,
          storageRootPath: null,
          materials: [],
          files: [],
        }),
      })!;
      const input = {
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
        operationId: "local-op",
        action,
        reason: "Settled locally",
        ...(action === "answer"
          ? { answers: { choice: { selected: ["a"] } } }
          : {}),
      };
      const invoke = (extra = {}) =>
        h.app.request(`/api/v1/threads/${thread.id}/question-resolution`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-BB-Thread-ID": "thr_coordinator",
          },
          body: JSON.stringify({ ...input, ...extra }),
        });
      for (const extra of [
        { origin: "local-input" },
        { decisionPolicy: "local-input-parity" },
        { actor: { kind: "owner" } },
      ]) {
        expect((await invoke(extra)).status).toBe(400);
        expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(0);
      }
      const first = await invoke();
      expect(first.status).toBe(200);
      const receipt = await first.json();
      expect(receipt.resolution.actor).toEqual({
        kind: "local-unverified",
        verification: "unverified-local",
      });
      const notice = parseQuestionResolutionNotice(
        JSON.parse(listQueuedThreadMessages(h.db, thread.id)[0]!.content)[0]
          .text,
      );
      expect(notice).toMatchObject({
        version: 2,
        decisionPolicy: "local-input-parity",
        resolution: { action, actor: { kind: "local-unverified" } },
      });
      const originalBytes = listQueuedThreadMessages(h.db, thread.id)[0]!
        .content;
      expect((await (await invoke()).json()).resolution).toEqual(
        receipt.resolution,
      );
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
      expect(listQueuedThreadMessages(h.db, thread.id)[0]!.content).toBe(
        originalBytes,
      );
    });
  },
);

it.each(["pending", "resolving", "resolved"] as const)(
  "leaves provider %s questions untouched for both agent actions",
  async (status) => {
    const {
      createPendingInteraction,
      pendingInteractions,
      questionResolutionEvents,
    } = await import("@bb/db");
    const { eq } = await import("drizzle-orm");
    const { createUserQuestionPayload } =
      await import("../helpers/pending-interactions.js");
    await withTestHarness(async (h) => {
      const { thread, session } = seedThreadFixture(h, {
        thread: { status: "active" },
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "native",
        providerThreadId: "p",
      });
      const interaction = createPendingInteraction(h.db, {
        threadId: thread.id,
        providerId: "codex",
        providerRequestId: "request",
        providerThreadId: "p",
        turnId: "native",
        payload: JSON.stringify(createUserQuestionPayload()),
      });
      h.db
        .update(pendingInteractions)
        .set({ status })
        .where(eq(pendingInteractions.id, interaction.id))
        .run();
      const before = h.db.select().from(pendingInteractions).all();
      for (const action of ["answer", "withdraw"] as const) {
        const response = await h.app.request("/internal/session/tool-call", {
          method: "POST",
          headers: internalAuthHeaders(h),
          body: JSON.stringify({
            sessionId: session.id,
            threadId: thread.id,
            turnId: "native",
            providerThreadId: "p",
            callId: "unsupported",
            tool: "bb_resolve_question",
            arguments: {
              threadId: thread.id,
              interactionId: interaction.id,
              revision: 1,
              operationId: `provider-${action}`,
              action,
              reason: "Settled elsewhere",
              ...(action === "answer"
                ? { answers: { choice: { selected: ["a"] } } }
                : {}),
            },
          }),
        });
        const result = await response.json();
        expect(result.success).toBe(false);
        expect(JSON.stringify(result)).toContain("unsupported");
        expect(h.db.select().from(pendingInteractions).all()).toEqual(before);
        expect(h.db.select().from(questionResolutionEvents).all()).toHaveLength(
          0,
        );
        expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(0);
      }
    });
  },
);

it("accepts one winner when a live self agent and a local answer race", async () => {
  await withTestHarness(async (h) => {
    const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
    seedThreadRuntimeState(h.deps, {
      threadId: thread.id,
      environmentId: thread.environmentId,
      providerThreadId: "race-provider",
    });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      turnId: "race",
      providerThreadId: "race-provider",
    });
    const question = createConversationQuestion(h.db, {
      threadId: thread.id,
      sourceTurnId: null,
      sourceCallId: null,
      publication: JSON.stringify(publication),
      materialManifest: JSON.stringify({
        hostId: null,
        storageRootPath: null,
        materials: [],
        files: [],
      }),
    });
    if (!question) throw new Error("Question fixture missing");
    const args = {
      threadId: thread.id,
      questionId: question.id,
      revision: 1,
      answers: { choice: { selected: ["a"] } },
    };
    const outcomes = await Promise.allSettled([
      answerConversationQuestion(h.deps, args, {
        operationId: "race-agent",
        reason: "Agent settled",
        invocation: {
          threadId: thread.id,
          turnId: "race",
          providerThreadId: "race-provider",
        },
      }),
      answerConversationQuestion(h.deps, args),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled"),
    ).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === "rejected");
    if (loser?.status !== "rejected") throw new Error("Missing race loser");
    expect(loser.reason.body).toMatchObject({
      code: "conversation_question_conflict",
      details: { current: { status: "answered" } },
    });
    const current = readConversationQuestion(h.deps, args);
    expect(current.resolutionHistory).toHaveLength(1);
    const queue = listQueuedThreadMessages(h.db, thread.id);
    expect(queue).toHaveLength(1);
    expect(current.resolutionAttribution?.deliveryId).toBe(queue[0]!.id);
  });
});

it.each(["unknown", "plugin", "local-input"] as const)(
  "keeps origin %s server-owned across replay",
  async (origin) => {
    const { resolveQuestion } =
      await import("../../src/services/threads/question-resolution.js");
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "p",
      });
      const question = createConversationQuestion(h.db, {
        threadId: thread.id,
        sourceTurnId: null,
        sourceCallId: null,
        publication: JSON.stringify(publication),
        materialManifest: JSON.stringify({
          hostId: null,
          storageRootPath: null,
          materials: [],
          files: [],
        }),
      })!;
      const input = {
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
        operationId: "stable",
        action: "answer",
        reason: "Selected",
        answers: { choice: { selected: ["a"] } },
      };
      const first = await resolveQuestion(h.deps, input, null, origin);
      const queued = listQueuedThreadMessages(h.db, thread.id)[0]!;
      expect(
        parseQuestionResolutionNotice(JSON.parse(queued.content)[0].text)
          ?.version,
      ).toBe(origin === "local-input" ? 2 : 1);
      const retry = await resolveQuestion(h.deps, input, null, "local-input");
      expect(retry.resolution).toEqual(first.resolution);
      expect(listQueuedThreadMessages(h.db, thread.id)).toEqual([queued]);
      await expect(
        resolveQuestion(
          h.deps,
          { ...input, origin: "local-input" },
          null,
          "plugin",
        ),
      ).rejects.toThrow();
    });
  },
);
