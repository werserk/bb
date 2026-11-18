import { expect, it } from "vitest";
import { listQueuedThreadMessages } from "@bb/db";
import { startTestServer } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import {
  closeConversationQuestion,
  publishConversationQuestion,
} from "../../src/services/threads/conversation-questions.js";

async function setup() {
  const server = await startTestServer();
  const { thread } = seedThreadFixture(server, {
    thread: { status: "active" },
  });
  seedThreadRuntimeState(server.deps, {
    threadId: thread.id,
    environmentId: thread.environmentId,
    providerThreadId: "p",
  });
  seedTurnStarted(server.deps, {
    threadId: thread.id,
    turnId: "native",
    providerThreadId: "p",
  });
  const ask = (callId: string) =>
    publishConversationQuestion(server.deps, {
      threadId: thread.id,
      source: { turnId: "native", providerThreadId: "p", callId },
      publication: {
        body: "Context",
        materials: [],
        questions: [
          {
            id: "choice",
            prompt: "Which?",
            required: true,
            multiSelect: false,
            allowFreeText: true,
            options: [{ value: "a", label: "A" }],
          },
        ],
      },
    });
  return { server, thread, ask };
}

it("does not deliver or wake the asker when an agent withdraws its own question", async () => {
  const { server, thread, ask } = await setup();
  try {
    const card = await ask("self");
    const before = listQueuedThreadMessages(server.db, thread.id).length;
    const result = await closeConversationQuestion(
      server.deps,
      {
        threadId: thread.id,
        questionId: card.id,
        revision: card.revision,
        action: "withdraw",
      },
      {
        operationId: "self-withdraw",
        reason: "Superseded by a fresh question",
        invocation: {
          threadId: thread.id,
          turnId: "native",
          providerThreadId: "p",
        },
      },
    );
    expect(result.status).toBe("withdrawn");
    expect(result.resolutionAttribution).toMatchObject({
      action: "withdraw",
      reason: "Superseded by a fresh question",
      actor: { kind: "agent", threadId: thread.id },
      deliveryId: null,
    });
    expect(result.resolutionDelivery).toBeNull();
    expect(listQueuedThreadMessages(server.db, thread.id)).toHaveLength(before);
    // A retry of the same operation stays quiet too.
    const retry = await closeConversationQuestion(
      server.deps,
      {
        threadId: thread.id,
        questionId: card.id,
        revision: card.revision,
        action: "withdraw",
      },
      {
        operationId: "self-withdraw",
        reason: "Superseded by a fresh question",
        invocation: {
          threadId: thread.id,
          turnId: "native",
          providerThreadId: "p",
        },
      },
    );
    expect(retry.resolutionAttribution?.id).toBe(
      result.resolutionAttribution?.id,
    );
    expect(listQueuedThreadMessages(server.db, thread.id)).toHaveLength(before);
  } finally {
    await server.close();
  }
});

it("still delivers a withdrawal made by someone other than the asking agent", async () => {
  const { server, thread, ask } = await setup();
  try {
    const card = await ask("local");
    const result = await closeConversationQuestion(server.deps, {
      threadId: thread.id,
      questionId: card.id,
      revision: card.revision,
      action: "withdraw",
    });
    expect(result.resolutionAttribution?.actor.kind).toBe("local-unverified");
    const deliveryId = result.resolutionAttribution?.deliveryId;
    expect(deliveryId).toEqual(expect.stringMatching(/^qmsg_/));
    expect(
      listQueuedThreadMessages(server.db, thread.id).map((row) => row.id),
    ).toContain(deliveryId);
  } finally {
    await server.close();
  }
});
