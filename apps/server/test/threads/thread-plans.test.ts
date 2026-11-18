import { createNodeBbSdk } from "@bb/sdk/node";
import { readThreadPlan } from "../../src/services/threads/thread-plans.js";
import { createUserQuestionPayload } from "../helpers/pending-interactions.js";
import { describe, it, expect, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  conversationQuestionPublicationSchema,
  turnScope,
  threadScope,
  toInteractionLifecycle,
} from "@bb/domain";
import {
  deleteThreadEventSuffixInTransaction,
  getLatestThreadSequence,
  listPlanHistoryEventRows,
  setQueuedThreadMessageFailureReason,
  threads,
} from "@bb/db";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import {
  closeConversationQuestion,
  publishConversationQuestion,
} from "../../src/services/threads/conversation-questions.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
  seedThread,
  seedThreadFixture,
  seedThreadRuntimeState,
  seedEvent,
  seedTurnStarted,
} from "../helpers/seed.js";

vi.mock("@bb/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@bb/db")>();
  return {
    ...actual,
    listPlanHistoryEventRows: vi.fn(actual.listPlanHistoryEventRows),
  };
});

describe("canonical thread plans", () => {
  it("reads off-page identities, deduplicates updates and stops at empty clear", async () => {
    await withTestHarness(async (h) => {
      const { host } = seedHostSession(h.deps);
      const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
      const env = seedEnvironment(h.deps, {
        hostId: host.id,
        projectId: project.id,
      });
      const thread = seedThread(h.deps, {
        projectId: project.id,
        environmentId: env.id,
        status: "idle",
      });
      const write = (sequence: number, planId: string, empty = false) =>
        seedEvent(h.deps, {
          threadId: thread.id,
          sequence,
          type: "item/completed",
          scope: turnScope("turn"),
          data: {
            providerThreadId: "provider",
            item: {
              type: "planSteps",
              id: `p${sequence}`,
              planId,
              status: "completed",
              steps: empty
                ? []
                : [
                    {
                      id: "step",
                      step: "Check",
                      status: "failed",
                      note: "refused",
                      actor: "reviewer",
                    },
                  ],
            },
          },
        });
      write(1, "earlier");
      write(2, "current");
      write(3, "current");
      const read = async () => {
        const res = await h.app.request("/api/v1/threads/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadIds: [thread.id] }),
        });
        expect(res.status).toBe(200);
        return await res.json();
      };
      expect(await read()).toMatchObject({
        errors: {},
        plans: {
          [thread.id]: {
            threadId: thread.id,
            revision: 3,
            current: {
              planId: "current",
              sourceSeq: 3,
              items: [
                {
                  id: "step",
                  status: "failed",
                  note: "refused",
                  actor: "reviewer",
                  interactionIds: [],
                },
              ],
            },
            previousPlans: [{ planId: "earlier" }],
            historyTruncated: false,
            ownAttention: "failed",
          },
        },
      });
      const sdk = createNodeBbSdk({
        baseUrl: "http://localhost",
        fetch: async (input, init) => h.app.request(new Request(input, init)),
      });
      expect(await sdk.threads.plans({ threadIds: [thread.id] })).toEqual(
        await read(),
      );
      const tooMany = await h.app.request("/api/v1/threads/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threadIds: Array(41).fill(thread.id) }),
      });
      expect(tooMany.status).toBe(400);
      write(4, "clear", true);
      expect(await read()).toMatchObject({
        plans: {
          [thread.id]: {
            current: null,
            previousPlans: [],
            ownAttention: "none",
          },
        },
      });
    });
  });
});

it("retains creation anchors beyond the 32-event window and input across context clear", async () => {
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps);
    const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
    const env = seedEnvironment(h.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "claude-code",
    });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      turnId: "turn",
      providerThreadId: "provider",
    });
    const write = (sequence: number) =>
      seedEvent(h.deps, {
        threadId: thread.id,
        sequence,
        type: "item/completed",
        scope: turnScope("turn"),
        data: {
          providerThreadId: "provider",
          item: {
            type: "planSteps",
            id: `p${sequence}`,
            planId: "stable",
            status: "completed",
            steps:
              sequence < 4
                ? [{ id: "step", step: "Build", status: "active" }]
                : [
                    { id: "step", step: "Build", status: "completed" },
                    { id: "second", step: "Verify", status: "active" },
                  ],
          },
        },
      });
    write(2);
    const created = h.deps.pendingInteractions.registerPendingInteraction({
      interaction: {
        threadId: thread.id,
        turnId: "turn",
        providerId: "claude-code",
        providerThreadId: "provider",
        providerRequestId: "question",
        payload: createUserQuestionPayload(),
      },
    });
    if (created.outcome === "rejected") throw new Error(created.reason);
    write(4);
    const second = h.deps.pendingInteractions.registerPendingInteraction({
      interaction: {
        threadId: thread.id,
        turnId: "turn",
        providerId: "claude-code",
        providerThreadId: "provider",
        providerRequestId: "second-question",
        payload: createUserQuestionPayload(),
      },
    });
    if (second.outcome === "rejected") throw new Error(second.reason);
    for (let seq = 6; seq <= 40; seq++) write(seq);
    const result = readThreadPlan(h.deps, thread);
    expect(result.current?.items[0]).toMatchObject({
      id: "step",
      status: "needs_input",
      interactionIds: [created.interaction.id],
    });
    expect(result.historyTruncated).toBe(true);
    expect(result.unboundInteractionIds).toEqual([]);
    expect(result.current?.items[1]).toMatchObject({
      id: "second",
      status: "needs_input",
      interactionIds: [second.interaction.id],
    });
    seedEvent(h.deps, {
      threadId: thread.id,
      sequence: 41,
      type: "system/interaction/lifecycle",
      scope: turnScope("turn"),
      data: { interaction: toInteractionLifecycle(created.interaction) },
    });
    const ambiguous = readThreadPlan(h.deps, thread);
    expect(ambiguous.unboundInteractionIds).toEqual([created.interaction.id]);
    expect(ambiguous.current?.items[1]?.interactionIds).toEqual([
      second.interaction.id,
    ]);
    seedEvent(h.deps, {
      threadId: thread.id,
      sequence: 42,
      type: "system/operation",
      scope: threadScope(),
      data: {
        operation: "context_clear",
        status: "completed",
        message: "cleared",
        operationId: "clear",
      },
    });
    const cleared = readThreadPlan(h.deps, thread);
    expect(cleared.current).toBeNull();
    expect(cleared.previousPlans).toEqual([]);
    expect(cleared.ownAttention).toBe("needs_input");
    expect(cleared.unboundInteractionIds).toEqual(
      expect.arrayContaining([created.interaction.id, second.interaction.id]),
    );
  });
});

it("keeps oversized-turn native input available without guessing a plan step or truncating plan history", async () => {
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps);
    const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
    const env = seedEnvironment(h.deps, {
      hostId: host.id,
      projectId: project.id,
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      environmentId: env.id,
      providerId: "claude-code",
    });
    seedTurnStarted(h.deps, {
      threadId: thread.id,
      turnId: "turn",
      providerThreadId: "provider",
    });
    seedEvent(h.deps, {
      threadId: thread.id,
      sequence: 2,
      type: "item/completed",
      scope: turnScope("turn"),
      data: {
        providerThreadId: "provider",
        item: {
          type: "planSteps",
          id: "plan",
          planId: "current",
          status: "completed",
          steps: [{ id: "step", step: "Build", status: "active" }],
        },
      },
    });
    const created = h.deps.pendingInteractions.registerPendingInteraction({
      interaction: {
        threadId: thread.id,
        turnId: "turn",
        providerId: "claude-code",
        providerThreadId: "provider",
        providerRequestId: "question",
        payload: createUserQuestionPayload(),
      },
    });
    if (created.outcome === "rejected") throw new Error(created.reason);
    const pendingBefore =
      h.deps.pendingInteractions.listPendingThreadInteractions(thread.id);
    expect(
      readThreadPlan(h.deps, thread).current?.items[0]?.interactionIds,
    ).toEqual([created.interaction.id]);
    for (let sequence = 4; sequence <= 131; sequence++)
      seedEvent(h.deps, {
        threadId: thread.id,
        sequence,
        type: "system/interaction/lifecycle",
        scope: turnScope("turn"),
        data: {
          interaction: {
            ...toInteractionLifecycle(created.interaction),
            id: `historical-${sequence}`,
          },
        },
      });
    const result = readThreadPlan(h.deps, thread);
    expect(result).toMatchObject({
      ownAttention: "needs_input",
      attentionInteractionIds: [created.interaction.id],
      unboundInteractionIds: [created.interaction.id],
      historyTruncated: false,
    });
    expect(result.current?.items[0]).toMatchObject({
      id: "step",
      status: "in_progress",
      interactionIds: [],
    });
    expect(
      h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
    ).toEqual(pendingBefore);
    expect(pendingBefore[0]?.payload).toEqual(createUserQuestionPayload());
    const sdk = createNodeBbSdk({
      baseUrl: "http://localhost",
      fetch: async (input, init) => h.app.request(new Request(input, init)),
    });
    expect(await sdk.threads.plans({ threadIds: [thread.id] })).toEqual({
      plans: { [thread.id]: result },
      errors: {},
    });
    expect(
      await sdk.threads.interactions.list({ threadId: thread.id }),
    ).toEqual(pendingBefore);
  });
});

describe("conditional plan reads", () => {
  type Harness = TestAppHarness;
  type Plans = {
    plans: Record<string, { readRevision: string } & Record<string, unknown>>;
    errors: Record<string, string>;
    unchanged?: Record<string, { revision: number; readRevision: string }>;
  };
  const historyReads = vi.mocked(listPlanHistoryEventRows);
  const post = (h: Harness, body: unknown) =>
    h.app.request("/api/v1/threads/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const plans = async (
    h: Harness,
    threadIds: string[],
    known?: Record<string, string>,
  ): Promise<Plans> => {
    const res = await post(h, known ? { threadIds, known } : { threadIds });
    expect(res.status).toBe(200);
    return (await res.json()) as Plans;
  };
  const writePlan = (
    h: Harness,
    threadId: string,
    sequence: number,
    text: string,
  ) =>
    seedEvent(h.deps, {
      threadId,
      sequence,
      type: "item/completed",
      scope: turnScope("turn"),
      data: {
        providerThreadId: "provider",
        item: {
          type: "planSteps",
          id: `p${sequence}`,
          planId: "plan",
          status: "completed",
          steps: [{ id: "step", step: text, status: "active" }],
        },
      },
    });
  const setup = (h: Harness, status: "idle" | "active" = "idle") => {
    const { thread } = seedThreadFixture(h, {
      thread: { providerId: "codex", status },
    });
    writePlan(h, thread.id, 1, "Build");
    return thread;
  };
  const tokenOf = async (h: Harness, threadId: string) => {
    const token = (await plans(h, [threadId])).plans[threadId]?.readRevision;
    if (token === undefined) throw new Error("missing readRevision");
    return token;
  };

  it("Caller without known", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const result = await plans(h, [thread.id]);
      expect(result).toEqual({
        errors: {},
        plans: {
          [thread.id]: {
            threadId: thread.id,
            revision: 1,
            current: {
              sourceSeq: 1,
              updatedAt: expect.any(Number),
              planId: "plan",
              items: [
                {
                  id: "step",
                  text: "Build",
                  status: "in_progress",
                  interactionIds: [],
                },
              ],
            },
            previousPlans: [],
            historyTruncated: false,
            questionAttention: { total: 0, firstQuestionId: null },
            ownAttention: "none",
            attentionInteractionIds: [],
            unboundInteractionIds: [],
            readRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
          },
        },
      });
      expect(result).not.toHaveProperty("unchanged");
      expect(readThreadPlan(h.deps, thread)).toEqual(result.plans[thread.id]);
    });
  });

  it("Unchanged thread", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const other = seedThread(h.deps, {
        projectId: thread.projectId,
        environmentId: thread.environmentId,
        status: "idle",
      });
      writePlan(h, other.id, 1, "Other");
      const token = await tokenOf(h, thread.id);
      historyReads.mockClear();
      const result = await plans(h, [thread.id], { [thread.id]: token });
      expect(result).toEqual({
        plans: {},
        errors: {},
        unchanged: { [thread.id]: { revision: 1, readRevision: token } },
      });
      expect(historyReads).not.toHaveBeenCalled();
      const mixed = await plans(h, [thread.id, other.id], {
        [thread.id]: token,
      });
      expect(Object.keys(mixed.plans)).toEqual([other.id]);
      expect(mixed.unchanged).toEqual({
        [thread.id]: { revision: 1, readRevision: token },
      });
      expect(historyReads).toHaveBeenCalled();
      expect(
        historyReads.mock.calls.every(([, args]) => args.threadId === other.id),
      ).toBe(true);
    });
  });

  it("Plan appended", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const token = await tokenOf(h, thread.id);
      writePlan(h, thread.id, 2, "Verify");
      const result = await plans(h, [thread.id], { [thread.id]: token });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]).toMatchObject({
        revision: 2,
        current: { sourceSeq: 2, items: [{ text: "Verify" }] },
      });
      expect(result.plans[thread.id]?.readRevision).not.toBe(token);
    });
  });

  it("Question withdrawn", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h, "active");
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
      const question = await publishConversationQuestion(h.deps, {
        threadId: thread.id,
        source: { turnId: "origin", providerThreadId: "p", callId: "ask" },
        publication: conversationQuestionPublicationSchema.parse({
          body: "Context",
          questions: [
            {
              id: "pick",
              prompt: "Which?",
              multiSelect: false,
              allowFreeText: true,
              options: [
                { value: "a", label: "A" },
                { value: "b", label: "B" },
              ],
            },
          ],
        }),
      });
      const before = (await plans(h, [thread.id])).plans[thread.id];
      expect(before).toMatchObject({
        questionAttention: { total: 1, firstQuestionId: question.id },
      });
      const sequence = getLatestThreadSequence(h.db, { threadId: thread.id });
      await closeConversationQuestion(h.deps, {
        threadId: thread.id,
        questionId: question.id,
        revision: 1,
        action: "withdraw",
      });
      expect(getLatestThreadSequence(h.db, { threadId: thread.id })).toBe(
        sequence,
      );
      const result = await plans(h, [thread.id], {
        [thread.id]: before!.readRevision,
      });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]).toMatchObject({
        revision: sequence,
        questionAttention: { total: 0, firstQuestionId: null },
      });
      expect(result.plans[thread.id]?.readRevision).not.toBe(
        before!.readRevision,
      );
    });
  });

  it("Queued send failed", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const queued = seedQueuedMessage(h.deps, {
        threadId: thread.id,
        content: [{ type: "text", text: "later", mentions: [] }],
      });
      const token = await tokenOf(h, thread.id);
      setQueuedThreadMessageFailureReason(h.db, h.hub, {
        threadId: thread.id,
        id: queued.id,
        failureReason: "Provider rejected dispatch",
        now: Date.now(),
        retryDelaysMs: [],
      });
      const result = await plans(h, [thread.id], { [thread.id]: token });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]).toMatchObject({
        revision: 1,
        ownAttention: "failed",
      });
      expect(result.plans[thread.id]?.readRevision).not.toBe(token);
    });
  });

  it("Status changed", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const token = await tokenOf(h, thread.id);
      h.db
        .update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, thread.id))
        .run();
      const result = await plans(h, [thread.id], { [thread.id]: token });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]).toMatchObject({ revision: 1 });
      expect(result.plans[thread.id]?.readRevision).not.toBe(token);
    });
  });

  it("Message edited (tail rewrite)", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      writePlan(h, thread.id, 2, "Verify");
      const token = await tokenOf(h, thread.id);
      h.db.transaction((tx) =>
        deleteThreadEventSuffixInTransaction(tx, {
          threadId: thread.id,
          cutoffSequence: 2,
          oldMaxSequence: 2,
        }),
      );
      writePlan(h, thread.id, 2, "Ship");
      const result = await plans(h, [thread.id], { [thread.id]: token });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]).toMatchObject({
        revision: 2,
        current: { sourceSeq: 2, items: [{ text: "Ship" }] },
      });
      expect(result.plans[thread.id]?.readRevision).not.toBe(token);
    });
  });

  it("Core restarted", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const token = await tokenOf(h, thread.id);
      vi.resetModules();
      const restarted =
        await import("../../src/services/threads/thread-plans.js");
      const result = restarted.readThreadPlanUnlessKnown(h.deps, thread, token);
      expect(result.unchanged).toBeUndefined();
      expect(result.plan?.readRevision).not.toBe(token);
    });
  });

  it("Attention interaction settled in memory", async () => {
    await withTestHarness(async (h) => {
      const { thread } = seedThreadFixture(h, {
        thread: { providerId: "claude-code", status: "idle" },
      });
      seedTurnStarted(h.deps, {
        threadId: thread.id,
        turnId: "turn",
        providerThreadId: "provider",
      });
      const created = h.deps.pendingInteractions.registerPendingInteraction({
        interaction: {
          threadId: thread.id,
          turnId: "turn",
          providerId: "claude-code",
          providerThreadId: "provider",
          providerRequestId: "question",
          payload: createUserQuestionPayload(),
        },
      });
      if (created.outcome === "rejected") throw new Error(created.reason);
      const before = (await plans(h, [thread.id])).plans[thread.id];
      expect(before).toMatchObject({
        attentionInteractionIds: [created.interaction.id],
      });
      vi.spyOn(
        h.deps.pendingInteractions,
        "listPendingThreadInteractions",
      ).mockReturnValue([]);
      const result = await plans(h, [thread.id], {
        [thread.id]: before!.readRevision,
      });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]).toMatchObject({
        revision: before!.revision,
        attentionInteractionIds: [],
      });
      expect(result.plans[thread.id]?.readRevision).not.toBe(
        before!.readRevision,
      );
    });
  });

  it("Unknown token", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const token = await tokenOf(h, thread.id);
      const result = await plans(h, [thread.id], {
        [thread.id]: "0".repeat(64),
      });
      expect(result.unchanged).toEqual({});
      expect(result.plans[thread.id]?.readRevision).toBe(token);
    });
  });

  it("Missing id with known", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const missing = "thr_2222222222";
      const token = await tokenOf(h, thread.id);
      const without = await plans(h, [missing]);
      expect(without.errors[missing]).toEqual(expect.any(String));
      const result = await plans(h, [missing, thread.id], {
        [missing]: token,
        [thread.id]: token,
      });
      expect(result).toEqual({
        plans: {},
        errors: without.errors,
        unchanged: { [thread.id]: { revision: 1, readRevision: token } },
      });
    });
  });

  it("refuses an oversized or malformed known with 400", async () => {
    await withTestHarness(async (h) => {
      const thread = setup(h);
      const alphabet = "23456789abcdefghijkmnpqrstuvwxyz";
      const known = Object.fromEntries(
        Array.from({ length: 41 }, (_, i) => [
          `thr_aaaaaaaa${alphabet[Math.floor(i / 32)]}${alphabet[i % 32]}`,
          "token",
        ]),
      );
      expect(Object.keys(known)).toHaveLength(41);
      for (const body of [
        { threadIds: [thread.id], known },
        { threadIds: [thread.id], known: { "not-a-thread": "token" } },
        { threadIds: [thread.id], known: { [thread.id]: "x".repeat(129) } },
        { threadIds: [thread.id], known: { [thread.id]: 1 } },
      ])
        expect((await post(h, body)).status).toBe(400);
    });
  });
});
