import { createNodeBbSdk } from "@bb/sdk/node";
import { expect, it } from "vitest";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedThreadFixture,
  seedTurnStarted,
  seedThreadRuntimeState,
} from "../helpers/seed.js";

it.each(["http", "sdk"])(
  "publishes, reads and closes ordinary questions through %s without native pending input",
  async (surface) => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "turn-question",
        providerThreadId: "provider-question",
      });
      const sdk = createNodeBbSdk({
        baseUrl: "http://localhost",
        fetch: async (input, init) => h.app.request(new Request(input, init)),
      });
      const publication = {
        body: "Choose later",
        questions: [
          {
            id: "voice",
            prompt: "Which voice?",
            multiSelect: false,
            allowFreeText: true,
            required: true,
            options: [{ value: "a", label: "A" }],
          },
        ],
        materials: [],
      };
      const source = {
        turnId: "turn-question",
        providerThreadId: "provider-question",
        callId: "publish-question",
      };
      const request = async (suffix: string, body?: unknown) => {
        const response = await h.app.request(
          `/api/v1/threads/${thread.id}/questions${suffix}`,
          {
            method: body === undefined ? "GET" : "POST",
            ...(body === undefined
              ? {}
              : {
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(body),
                }),
          },
        );
        expect(response.status).toBe(200);
        return await response.json();
      };
      const question =
        surface === "sdk"
          ? await sdk.threads.questions.publish({
              threadId: thread.id,
              source,
              publication,
            })
          : await request("", { source, publication });
      expect(question).toMatchObject({
        status: "open",
        revision: 1,
        publication,
      });
      const listed =
        surface === "sdk"
          ? await sdk.threads.questions.list({ threadId: thread.id })
          : await request("");
      expect(listed).toEqual([question]);
      const read =
        surface === "sdk"
          ? await sdk.threads.questions.get({
              threadId: thread.id,
              questionId: question.id,
            })
          : await request(`/${question.id}`);
      expect(read).toEqual(question);
      const closed =
        surface === "sdk"
          ? await sdk.threads.questions.dismiss({
              threadId: thread.id,
              questionId: question.id,
              revision: 1,
            })
          : await request(`/${question.id}/dismiss`, { revision: 1 });
      expect(closed).toMatchObject({
        id: question.id,
        status: "dismissed",
        queuedMessageId: null,
      });
      expect(
        h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
      ).toEqual([]);
    });
  },
);

it.each(["http", "sdk"])(
  "retains exact response receipts and rejects conflicting, stale and withdrawn answers through %s",
  async (surface) => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, { thread: { status: "active" } });
      seedThreadRuntimeState(h.deps, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: "provider-answer",
        permissionMode: "accept-edits",
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "turn-answer",
        providerThreadId: "provider-answer",
      });
      const sdk = createNodeBbSdk({
        baseUrl: "http://localhost",
        fetch: async (input, init) => h.app.request(new Request(input, init)),
      });
      const publication = {
        body: "Original audio context",
        materials: [],
        questions: [
          {
            id: "voice",
            prompt: "Which voice?",
            multiSelect: false,
            required: true,
            allowFreeText: true,
            options: [
              { value: "a", label: "A" },
              { value: "b", label: "B" },
            ],
          },
        ],
      };
      const question = await sdk.threads.questions.publish({
        threadId: thread.id,
        source: {
          turnId: "turn-answer",
          providerThreadId: "provider-answer",
          callId: "answer-publication",
        },
        publication,
      });
      const answer = { revision: 1, answers: { voice: { selected: ["a"] } } };
      const send = async (payload: typeof answer) => {
        if (surface === "sdk")
          return sdk.threads.questions.answer({
            threadId: thread.id,
            questionId: question.id,
            ...payload,
          });
        const res = await h.app.request(
          `/api/v1/threads/${thread.id}/questions/${question.id}/answer`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) throw { status: res.status };
        return await res.json();
      };
      await expect(send({ ...answer, revision: 2 })).rejects.toMatchObject({
        status: 409,
      });
      const accepted = await send(answer);
      expect(accepted).toMatchObject({
        id: question.id,
        status: "answered",
        publication,
        response: answer.answers,
        queuedMessageId: expect.any(String),
      });
      expect(await send(answer)).toEqual(accepted);
      await expect(
        send({ ...answer, answers: { voice: { selected: ["b"] } } }),
      ).rejects.toMatchObject({ status: 409 });
      const withdrawn = await sdk.threads.questions.withdraw({
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
      });
      expect(withdrawn).toMatchObject({
        status: "withdrawn",
        response: answer.answers,
        queuedMessageId: accepted.queuedMessageId,
      });
      await expect(send(answer)).rejects.toMatchObject({ status: 409 });
      expect(
        h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
      ).toEqual([]);
    });
  },
);

it("rejects invalid publication source and cross-thread question reads", async () => {
  await withTestHarness(async (h) => {
    const { thread } = seedThreadFixture(h);
    const other = seedThreadFixture(h).thread;
    const sdk = createNodeBbSdk({
      baseUrl: "http://localhost",
      fetch: async (input, init) => h.app.request(new Request(input, init)),
    });
    const publication = {
      body: "Context",
      materials: [],
      questions: [
        {
          id: "one",
          prompt: "Choose",
          multiSelect: false,
          allowFreeText: true,
          required: true,
        },
      ],
    };
    const source = {
      turnId: "missing",
      providerThreadId: "provider",
      callId: "call",
    };
    await expect(
      sdk.threads.questions.publish({
        threadId: thread.id,
        source,
        publication,
      }),
    ).rejects.toMatchObject({ status: 409 });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      turnId: source.turnId,
      providerThreadId: source.providerThreadId,
    });
    const question = await sdk.threads.questions.publish({
      threadId: thread.id,
      source,
      publication,
    });
    await expect(
      sdk.threads.questions.get({
        threadId: other.id,
        questionId: question.id,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      sdk.threads.questions.get({
        threadId: thread.id,
        questionId: "not-a-question-id",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
