import { describe, expect, it } from "vitest";
import { createConversationQuestion, listQueuedThreadMessages } from "@bb/db";
import { internalAuthHeaders } from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedTurnStarted,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import { readConversationQuestion } from "../../src/services/threads/conversation-questions.js";

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
        expect(
          (await call({ ...input, reason: "Changed retry" })).success,
        ).toBe(false);
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
