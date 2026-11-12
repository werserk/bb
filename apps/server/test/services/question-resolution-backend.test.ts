import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import { startTestServer } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  publishConversationQuestion,
  closeConversationQuestion,
} from "../../src/services/threads/conversation-questions.js";
import { archiveThread, unarchiveThread, deleteThread } from "@bb/db";
import { withQuestionResolutionActor } from "../../src/services/threads/question-resolution-scope.js";

it("declares observation/resolution v1 to a real backend plugin and preserves native invocation identity", async () => {
  const server = await startTestServer();
  const root = await mkdtemp(join(tmpdir(), "bb-question-backend-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-question-probe",
        version: "0.1.0",
        bb: {
          name: "Question probe",
          description: "Test",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(root, "server.ts"),
      `export default function plugin(bb) {
      bb.agents.registerTool({ name: "question_probe", description: "Resolve through backend SDK", parameters: { type: "object" }, execute: async input => JSON.stringify(await bb.experimental_questionResolution.resolve(input)) });
    }`,
    );
    const { thread, session } = seedThreadFixture(server, {
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
    server.pluginService.bindSdk({ baseUrl: server.baseUrl });
    expect((await server.pluginService.installPath(root)).status).toBe(
      "running",
    );
    const api = server.pluginService.getApi("question-probe")!;
    const capability = api.experimental_questionResolution;
    if (!capability) throw new Error("Question resolution unavailable");
    expect(capability.version).toBe(1);
    const connected = createDeferredPromise<void>();
    const stopConnection = api.sdk.subscribe({
      event: "realtime:connection",
      callback: (event) => {
        if (event.state === "connected") connected.resolve();
      },
    });
    const observed: string[] = [];
    const lifecycle: string[] = [];
    const ready = createDeferredPromise<void>();
    const stop = api.sdk.subscribe({
      event: "thread:changed",
      threadId: thread.id,
      experimental_onReady: () => ready.resolve(),
      callback: (event) => {
        if (event.changes.includes("interactions-changed"))
          observed.push(event.id ?? thread.id);
        lifecycle.push(...event.changes);
      },
    });
    api.onDispose(stop);
    api.onDispose(stopConnection);
    await connected.promise;
    await ready.promise;
    const question = await publishConversationQuestion(server.deps, {
      threadId: thread.id,
      source: { turnId: "native", providerThreadId: "p", callId: "ask" },
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
    await vi.waitFor(() => expect(observed).toHaveLength(1));
    expect(
      (
        await api.sdk.threads.questions.open({ threadId: thread.id })
      ).questions.map((row) => row.id),
    ).toEqual([question.id]);
    expect(
      (
        await api.sdk.threads.questions.get({
          threadId: thread.id,
          questionId: question.id,
        })
      ).publication.questions[0]?.prompt,
    ).toBe("Which?");
    const input = {
      threadId: thread.id,
      questionId: question.id,
      revision: 1,
      operationId: "native-sdk-answer",
      action: "answer",
      reason: "The agreed scope settles this",
      answers: { choice: { selected: ["a"] } },
    };
    const response = await server.app.request("/internal/session/tool-call", {
      method: "POST",
      headers: internalAuthHeaders(server),
      body: JSON.stringify({
        sessionId: session.id,
        threadId: thread.id,
        turnId: "native",
        providerThreadId: "p",
        callId: "resolve",
        tool: "question_probe",
        arguments: input,
      }),
    });
    const result = await response.json();
    expect(result.success, JSON.stringify(result)).toBe(true);
    const receipt = JSON.parse(result.contentItems[0].text);
    expect(receipt.resolution.actor).toMatchObject({
      kind: "agent",
      verification: "runtime",
      threadId: thread.id,
    });
    await vi.waitFor(() => expect(observed).toHaveLength(2));
    expect(
      (await api.sdk.threads.questions.open({ threadId: thread.id })).total,
    ).toBe(0);
    expect(
      (
        await api.sdk.threads.questions.get({
          threadId: thread.id,
          questionId: question.id,
        })
      ).status,
    ).toBe("answered");
    for (const action of ["dismiss", "withdraw"] as const) {
      const before = observed.length;
      const card = await publishConversationQuestion(server.deps, {
        threadId: thread.id,
        source: { turnId: "native", providerThreadId: "p", callId: action },
        publication: question.publication,
      });
      await vi.waitFor(() => expect(observed).toHaveLength(before + 1));
      await closeConversationQuestion(server.deps, {
        threadId: thread.id,
        questionId: card.id,
        revision: card.revision,
        action,
      });
      await vi.waitFor(() => expect(observed).toHaveLength(before + 2));
      expect(
        (
          await api.sdk.threads.questions.get({
            threadId: thread.id,
            questionId: card.id,
          })
        ).status,
      ).toBe(action === "dismiss" ? "dismissed" : "withdrawn");
    }
    const surviving = await publishConversationQuestion(server.deps, {
      threadId: thread.id,
      source: { turnId: "native", providerThreadId: "p", callId: "surviving" },
      publication: question.publication,
    });
    await vi.waitFor(() => expect(observed).toHaveLength(7));
    archiveThread(server.db, server.hub, thread.id);
    await vi.waitFor(() =>
      expect(
        lifecycle.filter((reason) => reason === "archived-changed"),
      ).toHaveLength(1),
    );
    expect(
      (await api.sdk.threads.questions.open({ threadId: thread.id })).total,
    ).toBe(0);
    unarchiveThread(server.db, server.hub, thread.id);
    await vi.waitFor(() =>
      expect(
        lifecycle.filter((reason) => reason === "archived-changed"),
      ).toHaveLength(2),
    );
    expect(
      (
        await api.sdk.threads.questions.open({ threadId: thread.id })
      ).questions.map((row) => row.id),
    ).toEqual([surviving.id]);
    stop();
    stopConnection();
    server.hub.notifyThread(thread.id, ["interactions-changed"]);
    expect(observed).toHaveLength(7);
    const local = await capability.resolve({
      ...input,
      operationId: "local-withdraw",
      action: "withdraw",
      answers: undefined,
    });
    expect(local.resolution.actor).toEqual({
      kind: "local-unverified",
      verification: "unverified-local",
    });
    expect(observed).toHaveLength(7);
    const deletion: string[] = [];
    const deletionReady = createDeferredPromise<void>();
    const stopDeletion = api.sdk.subscribe({
      event: "thread:changed",
      threadId: thread.id,
      experimental_onReady: () => deletionReady.resolve(),
      callback: (event) => deletion.push(...event.changes),
    });
    await deletionReady.promise;
    deleteThread(server.db, server.hub, thread.id);
    await vi.waitFor(() => expect(deletion).toContain("thread-deleted"));
    await expect(
      api.sdk.threads.questions.open({ threadId: thread.id }),
    ).rejects.toThrow();
    stopDeletion();
  } finally {
    await server.pluginService.stop();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("stages scope policy until activation and releases it on reload, failed load and stop", async () => {
  const server = await startTestServer();
  const root = await mkdtemp(join(tmpdir(), "bb-question-policy-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "bb-plugin-question-policy",
        version: "0.1.0",
        bb: {
          name: "Question policy",
          description: "Test",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    const source = (
      role: string,
      fail = false,
    ) => `export default function plugin(bb) {
      bb.experimental_questionResolutionScope.register((_context, accept) => accept({ relationship: "self", role: ${JSON.stringify(role)}, isCurrent: () => true }));
      ${fail ? 'throw new Error("candidate failed");' : ""}
    }`;
    const { thread } = seedThreadFixture(server, {
      thread: { status: "active" },
    });
    seedTurnStarted(server.deps, {
      threadId: thread.id,
      turnId: "live",
      providerThreadId: "p",
    });
    const actor = () =>
      withQuestionResolutionActor(
        server.db,
        thread.id,
        { threadId: thread.id, turnId: "live", providerThreadId: "p" },
        (value) => value,
      );
    await writeFile(join(root, "server.ts"), source("failed", true));
    expect((await server.pluginService.installPath(root)).status).toBe("error");
    expect(await actor()).toMatchObject({ role: null });
    await writeFile(join(root, "server.ts"), source("first"));
    await server.pluginService.reload("question-policy");
    expect(await actor()).toMatchObject({ role: "first" });
    await writeFile(
      join(root, "server.ts"),
      source("failed replacement", true),
    );
    await server.pluginService.reload("question-policy");
    expect(await actor()).toMatchObject({ role: "first" });
    await writeFile(join(root, "server.ts"), source("replacement"));
    await server.pluginService.reload("question-policy");
    expect(await actor()).toMatchObject({ role: "replacement" });
    await server.pluginService.stop();
    expect(await actor()).toMatchObject({ role: null });
  } finally {
    await server.pluginService.stop();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
