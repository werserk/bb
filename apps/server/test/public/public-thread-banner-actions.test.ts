import { getLastStoredProviderThreadId, getThread, getThreadSendIntake, listEvents, listThreadSendIntakes } from "@bb/db";
import {
  encodeClientTurnRequestIdNumber,
  threadScope,
  turnScope,
  turnRequestEventDataSchema,
  type PromptInput,
} from "@bb/domain";
import { describe, expect, it, vi } from "vitest";
import { groupHostDaemonEvents } from "@bb/host-daemon-contract";
import { internalAuthHeaders } from "../helpers/commands.js";
import {
  registerHostRpcResponder,
  EMPTY_WORKSPACE_AGENT_CONTEXT,
} from "../helpers/host-rpc.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedEvent,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
  seedTurnStarted,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

interface BannerFixture {
  environmentId: string;
  hostId: string;
  projectId: string;
  sessionId: string;
  threadId: string;
}

function clearCommandInput(): PromptInput[] {
  return [
    {
      type: "text",
      text: "/clear",
      mentions: [
        {
          start: 0,
          end: 6,
          resource: {
            kind: "command",
            trigger: "/",
            name: "clear",
            source: "command",
            origin: "builtin",
            label: "clear",
            argumentHint: null,
          },
        },
      ],
    },
  ];
}

function seedBannerFixture(
  harness: TestAppHarness,
  args: { status: "active" | "idle" },
): BannerFixture {
  const { host, session } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    environmentId: environment.id,
    projectId: project.id,
    providerId: "codex",
    status: args.status,
  });
  return {
    environmentId: environment.id,
    hostId: host.id,
    projectId: project.id,
    sessionId: session.id,
    threadId: thread.id,
  };
}

function seedActivePlan(harness: TestAppHarness, fixture: BannerFixture): void {
  const requestId = encodeClientTurnRequestIdNumber({ value: 1 });
  seedEvent(harness.deps, {
    threadId: fixture.threadId,
    environmentId: fixture.environmentId,
    sequence: 1,
    type: "client/turn/requested",
    scope: threadScope(),
    data: {
      direction: "outbound",
      requestId,
      input: [
        {
          type: "text",
          text: "/plan verify cancellation",
          mentions: [
            {
              start: 0,
              end: 5,
              resource: {
                kind: "command",
                trigger: "/",
                name: "plan",
                source: "command",
                origin: "user",
                label: "plan",
                argumentHint: null,
              },
            },
          ],
        },
      ],
      target: { kind: "new-turn" },
      execution: {
        model: "gpt-5",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      initiator: "user",
      senderThreadId: null,
      request: { method: "turn/start", params: {} },
      source: "tell",
    },
  });
  seedEvent(harness.deps, {
    threadId: fixture.threadId,
    environmentId: fixture.environmentId,
    providerThreadId: "provider-thread-1",
    sequence: 2,
    type: "turn/input/accepted",
    scope: turnScope("turn-plan-1"),
    data: {
      providerThreadId: "provider-thread-1",
      clientRequestId: requestId,
    },
  });
  seedTurnStarted(harness.deps, {
    environmentId: fixture.environmentId,
    providerThreadId: "provider-thread-1",
    sequence: 3,
    threadId: fixture.threadId,
    turnId: "turn-plan-1",
  });
}

function seedGoal(
  harness: TestAppHarness,
  fixture: BannerFixture,
  status: "active" | "paused",
): void {
  seedThreadRuntimeState(harness.deps, {
    environmentId: fixture.environmentId,
    providerThreadId: "provider-thread-1",
    sequenceStart: 1,
    threadId: fixture.threadId,
  });
  seedEvent(harness.deps, {
    threadId: fixture.threadId,
    environmentId: fixture.environmentId,
    providerThreadId: "provider-thread-1",
    sequence: 3,
    type: "thread/goal/updated",
    scope: threadScope(),
    data: {
      providerThreadId: "provider-thread-1",
      objective: "Verify authoritative Goal cancellation",
      status,
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 10,
    },
  });
}

async function readBannerActivity(
  harness: TestAppHarness,
  fixture: BannerFixture,
): Promise<{ activePlanModeCount: number }> {
  const response = await harness.app.request(
    `/api/v1/threads?projectId=${fixture.projectId}`,
  );
  expect(response.status).toBe(200);
  const threads = (await readJson(response)) as Array<{
    id: string;
    activity: { activePlanModeCount: number };
  }>;
  const thread = threads.find((entry) => entry.id === fixture.threadId);
  if (!thread) throw new Error(`Missing thread ${fixture.threadId}`);
  return thread.activity;
}

async function readTimelineGoalStatus(
  harness: TestAppHarness,
  fixture: BannerFixture,
): Promise<string | null> {
  const response = await harness.app.request(
    `/api/v1/threads/${fixture.threadId}/timeline`,
  );
  expect(response.status).toBe(200);
  const timeline = (await readJson(response)) as {
    extensionStates: Record<string, { status: string } | undefined>;
  };
  return timeline.extensionStates["provider-codex/goal"]?.status ?? null;
}

describe("public thread banner actions", () => {
  it("routes standalone built-in /clear to a same-thread context boundary", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedThreadRuntimeState(harness.deps, {
        environmentId: fixture.environmentId,
        providerThreadId: "provider-thread-1",
        threadId: fixture.threadId,
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: ({ command }) => {
          expect(command).toMatchObject({
            type: "thread.stop",
            threadId: fixture.threadId,
          });
          return { ok: true, result: { providerCheckpointId: null } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: clearCommandInput(),
          }),
        },
      );

      expect(response.status).toBe(200);
      expect(responder.requests).toHaveLength(1);
      expect(
        getLastStoredProviderThreadId(harness.db, fixture.threadId),
      ).toBeNull();
      const events = listEvents(harness.db, { threadId: fixture.threadId });
      expect(
        events.filter((event) => event.type === "client/turn/requested"),
      ).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "system/thread/interrupted"),
      ).toHaveLength(0);
      expect(
        events.find((event) => event.type === "system/operation"),
      ).toMatchObject({
        data: expect.stringContaining('"operation":"context_clear"'),
      });
    });
  });

  it("rejects /clear while a thread is active", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "active" });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "queue-if-active",
            input: clearCommandInput(),
          }),
        },
      );

      expect(response.status).toBe(409);
      expect(
        listEvents(harness.db, { threadId: fixture.threadId }),
      ).toHaveLength(0);
    });
  });

  it("rejects a send while an in-place context clear is in flight", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedThreadRuntimeState(harness.deps, {
        environmentId: fixture.environmentId,
        providerThreadId: "provider-thread-1",
        threadId: fixture.threadId,
      });
      let finishStop: () => void = () => {};
      const stopPending = new Promise<void>((resolve) => {
        finishStop = resolve;
      });
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: async ({ command }) => {
          expect(command).toMatchObject({
            type: "thread.stop",
            threadId: fixture.threadId,
          });
          await stopPending;
          return { ok: true, result: { providerCheckpointId: null } };
        },
      });

      const clearResponsePending = harness.app.request(
        `/api/v1/threads/${fixture.threadId}/context/clear`,
        { method: "POST" },
      );
      await vi.waitFor(() => {
        expect(responder.requests).toHaveLength(1);
      });

      const sendResponse = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/send`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: [{ type: "text", text: "race the clear", mentions: [] }],
          }),
        },
      );
      expect(sendResponse.status).toBe(409);
      expect(await readJson(sendResponse)).toMatchObject({
        message: "Thread context is being cleared",
      });

      finishStop();
      expect((await clearResponsePending).status).toBe(200);
      expect(
        getLastStoredProviderThreadId(harness.db, fixture.threadId),
      ).toBeNull();
    });
  });

  it.each([false, true])(
    "settles Plan cancellation with an early completion event: %s",
    async (earlyCompletion) => {
      await withTestHarness(async (harness) => {
        const fixture = seedBannerFixture(harness, { status: "active" });
        seedActivePlan(harness, fixture);
        const responder = registerHostRpcResponder(harness, {
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          handle: async ({ command }) => {
            expect(command).toMatchObject({
              type: "thread.plan.cancel",
              threadId: fixture.threadId,
              expectedTurnId: "turn-plan-1",
            });
            if (earlyCompletion) {
              const completion = await harness.app.request(
                "/internal/session/events",
                {
                  method: "POST",
                  headers: internalAuthHeaders(harness),
                  body: JSON.stringify({
                    sessionId: fixture.sessionId,
                    eventGroups: groupHostDaemonEvents([
                      {
                        threadId: fixture.threadId,
                        event: {
                          type: "turn/completed",
                          threadId: fixture.threadId,
                          providerThreadId: "provider-thread-1",
                          scope: turnScope("turn-plan-1"),
                          status: "interrupted",
                        },
                      },
                    ]),
                  }),
                },
              );
              expect(completion.status).toBe(200);
              expect(getThread(harness.db, fixture.threadId)?.status).toBe(
                "idle",
              );
            }
            return { ok: true, result: { cancelled: true } };
          },
        });

        const response = await harness.app.request(
          `/api/v1/threads/${fixture.threadId}/plan/cancel`,
          { method: "POST" },
        );

        expect(
          response.status,
          JSON.stringify(await readJson(response.clone())),
        ).toBe(200);
        expect(responder.requests).toHaveLength(1);
        expect(getThread(harness.db, fixture.threadId)?.status).toBe("idle");
        await expect(
          readBannerActivity(harness, fixture),
        ).resolves.toMatchObject({
          activePlanModeCount: 0,
        });
        await expect(
          readBannerActivity(harness, fixture),
        ).resolves.toMatchObject({
          activePlanModeCount: 0,
        });
      });
    },
  );

  it("send intake on: retains a legacy send during context clear and returns its native post-clear receipt", async () => {
    await withTestHarness({ sendIntake: true }, async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedThreadRuntimeState(harness.deps, {
        environmentId: fixture.environmentId, providerThreadId: "provider-thread-1", threadId: fixture.threadId,
      });
      const beforeRequests = listEvents(harness.db, { threadId: fixture.threadId }).filter(row => row.type === "client/turn/requested");
      let finishStop: () => void = () => {};
      const stopPending = new Promise<void>(resolve => { finishStop = resolve; });
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId, sessionId: fixture.sessionId,
        handle: async ({ command }) => {
          switch (command.type) {
            case "thread.stop":
              expect(command.threadId).toBe(fixture.threadId);
              await stopPending;
              return { ok: true, result: { providerCheckpointId: null } };
            case "host.read_workspace_agent_context": return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
            case "thread.start": return { ok: true, result: { providerThreadId: "provider-after-legacy-clear" } };
            default: throw new Error(`Unexpected command ${command.type}`);
          }
        },
      });
      const clearResponsePending = harness.app.request(`/api/v1/threads/${fixture.threadId}/context/clear`, { method: "POST" });
      let sendResponsePending: Promise<Response> | undefined;
      try {
        await vi.waitFor(() => expect(responder.requests.filter(({ command }) => command.type === "thread.stop")).toHaveLength(1));
        let sendSettled = false;
        sendResponsePending = Promise.resolve(harness.app.request(`/api/v1/threads/${fixture.threadId}/send`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "start", input: [{ type: "text", text: "race the clear", mentions: [] }] }),
        })).then(response => { sendSettled = true; return response; });
        await vi.waitFor(() => expect(listThreadSendIntakes(harness.db, fixture.threadId)).toEqual([
          expect.objectContaining({ state: "pending", sealedAt: null, claimEpoch: 1 }),
        ]));
        const retained = listThreadSendIntakes(harness.db, fixture.threadId)[0]!;
        expect(retained.currentEnvelope).not.toBeNull();
        expect(sendSettled).toBe(false);
        expect(listEvents(harness.db, { threadId: fixture.threadId }).filter(row => row.type === "client/turn/requested")).toEqual(beforeRequests);
        expect(responder.requests.filter(({ command }) => command.type === "thread.start" || command.type === "turn.submit")).toEqual([]);
        finishStop();
        expect((await clearResponsePending).status).toBe(200);
        const response = await sendResponsePending;
        expect(response.status).toBe(200);
        expect(await readJson(response)).toEqual({ ok: true, delivery: "sent" });
        await vi.waitFor(() => expect(responder.requests.filter(({ command }) => command.type === "thread.start")).toHaveLength(1));
        const events = listEvents(harness.db, { threadId: fixture.threadId });
        const requests = events.filter(row => row.type === "client/turn/requested");
        expect(requests).toHaveLength(beforeRequests.length + 1);
        const requested = requests.at(-1)!;
        const request = turnRequestEventDataSchema.parse(JSON.parse(requested.data));
        expect(request.input).toEqual([{ type: "text", text: "race the clear", mentions: [] }]);
        const cleared = events.find(row => row.type === "system/operation" && JSON.parse(row.data).operation === "context_clear")!;
        expect(requested.sequence).toBeGreaterThan(cleared.sequence);
        const completed = getThreadSendIntake(harness.db, retained.id)!;
        expect(completed.state).toBe("transferred");
        expect(JSON.parse(completed.nativeHandoff!)).toMatchObject({ id: request.requestId, sequence: requested.sequence });
        expect(getLastStoredProviderThreadId(harness.db, fixture.threadId)).toBeNull();
      } finally {
        finishStop();
        await clearResponsePending;
        await sendResponsePending;
        responder.unregister();
      }
    });
  });

  it.each([false, true])(
    "settles Plan cancellation with an early completion event: %s",
    async (earlyCompletion) => {
      await withTestHarness(async (harness) => {
        const fixture = seedBannerFixture(harness, { status: "active" });
        seedActivePlan(harness, fixture);
        const responder = registerHostRpcResponder(harness, {
          hostId: fixture.hostId,
          sessionId: fixture.sessionId,
          handle: async ({ command }) => {
            expect(command).toMatchObject({
              type: "thread.plan.cancel",
              threadId: fixture.threadId,
              expectedTurnId: "turn-plan-1",
            });
            if (earlyCompletion) {
              const completion = await harness.app.request(
                "/internal/session/events",
                {
                  method: "POST",
                  headers: internalAuthHeaders(harness),
                  body: JSON.stringify({
                    sessionId: fixture.sessionId,
                    eventGroups: groupHostDaemonEvents([
                      {
                        threadId: fixture.threadId,
                        event: {
                          type: "turn/completed",
                          threadId: fixture.threadId,
                          providerThreadId: "provider-thread-1",
                          scope: turnScope("turn-plan-1"),
                          status: "interrupted",
                        },
                      },
                    ]),
                  }),
                },
              );
              expect(completion.status).toBe(200);
              expect(getThread(harness.db, fixture.threadId)?.status).toBe(
                "idle",
              );
            }
            return { ok: true, result: { cancelled: true } };
          },
        });

        const response = await harness.app.request(
          `/api/v1/threads/${fixture.threadId}/plan/cancel`,
          { method: "POST" },
        );

        expect(
          response.status,
          JSON.stringify(await readJson(response.clone())),
        ).toBe(200);
        expect(responder.requests).toHaveLength(1);
        expect(getThread(harness.db, fixture.threadId)?.status).toBe("idle");
        await expect(
          readBannerActivity(harness, fixture),
        ).resolves.toMatchObject({
          activePlanModeCount: 0,
        });
        await expect(
          readBannerActivity(harness, fixture),
        ).resolves.toMatchObject({
          activePlanModeCount: 0,
        });
      });
    },
  );

  it("keeps Plan active when provider cancellation fails", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "active" });
      seedActivePlan(harness, fixture);
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: () => ({
          ok: false,
          errorCode: "provider_error",
          errorMessage: "Plan cancellation failed",
        }),
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/plan/cancel`,
        { method: "POST" },
      );

      expect(response.status).not.toBe(200);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
      await expect(readBannerActivity(harness, fixture)).resolves.toMatchObject(
        {
          activePlanModeCount: 1,
        },
      );
    });
  });

  it("does not finalize the thread when a stale Plan cancellation finds a newer turn", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "active" });
      seedActivePlan(harness, fixture);
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: ({ command }) => {
          expect(command).toMatchObject({
            type: "thread.plan.cancel",
            threadId: fixture.threadId,
            expectedTurnId: "turn-plan-1",
          });
          return { ok: true, result: { cancelled: false } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/plan/cancel`,
        { method: "POST" },
      );

      expect(response.status).toBe(409);
      expect(responder.requests).toHaveLength(1);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
      expect(
        listEvents(harness.db, { threadId: fixture.threadId }).some(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toBe(false);
      await expect(readBannerActivity(harness, fixture)).resolves.toMatchObject(
        { activePlanModeCount: 1 },
      );
    });
  });

  it("does not finalize a newer server turn when the daemon reports the Plan turn cancelled", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "active" });
      seedActivePlan(harness, fixture);
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: ({ command }) => {
          expect(command).toMatchObject({
            type: "thread.plan.cancel",
            expectedTurnId: "turn-plan-1",
          });
          seedTurnStarted(harness.deps, {
            environmentId: fixture.environmentId,
            providerThreadId: "provider-thread-1",
            sequence: 4,
            threadId: fixture.threadId,
            turnId: "turn-newer-2",
          });
          return { ok: true, result: { cancelled: true } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/plan/cancel`,
        { method: "POST" },
      );

      expect(response.status).toBe(409);
      expect(getThread(harness.db, fixture.threadId)?.status).toBe("active");
      expect(
        listEvents(harness.db, { threadId: fixture.threadId }).some(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toBe(false);
      await expect(readBannerActivity(harness, fixture)).resolves.toMatchObject(
        { activePlanModeCount: 1 },
      );
    });
  });

  it("accepts a stale Plan cancellation only after provider events show the Plan turn ended", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "active" });
      seedActivePlan(harness, fixture);
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: () => {
          seedEvent(harness.deps, {
            threadId: fixture.threadId,
            environmentId: fixture.environmentId,
            providerThreadId: "provider-thread-1",
            sequence: 4,
            type: "turn/completed",
            scope: turnScope("turn-plan-1"),
            data: {
              providerThreadId: "provider-thread-1",
              status: "completed",
            },
          });
          return { ok: true, result: { cancelled: false } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/plan/cancel`,
        { method: "POST" },
      );

      expect(response.status).toBe(200);
      expect(
        listEvents(harness.db, { threadId: fixture.threadId }).some(
          (event) => event.type === "system/thread/interrupted",
        ),
      ).toBe(false);
      await expect(readBannerActivity(harness, fixture)).resolves.toMatchObject(
        { activePlanModeCount: 0 },
      );
    });
  });

  it("refuses to clear a Goal on a thread that has none, whatever its provider", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/goal/clear`,
        { method: "POST" },
      );
      expect(response.status).toBe(409);
      expect(await readJson(response)).toMatchObject({
        code: "invalid_request",
        message: "No Goal to clear",
      });
    });
  });

  it("accepts a stale Goal clear result after provider events persist the clear", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedGoal(harness, fixture, "active");
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: ({ command }) => {
          if (command.type === "host.read_workspace_agent_context") {
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          }
          expect(command).toMatchObject({
            type: "thread.goal.clear",
            threadId: fixture.threadId,
          });
          seedEvent(harness.deps, {
            threadId: fixture.threadId,
            environmentId: fixture.environmentId,
            providerThreadId: "provider-thread-1",
            sequence: 4,
            type: "thread/goal/cleared",
            scope: threadScope(),
            data: { providerThreadId: "provider-thread-1" },
          });
          return { ok: true, result: { cleared: false } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/goal/clear`,
        { method: "POST" },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
      await expect(
        readTimelineGoalStatus(harness, fixture),
      ).resolves.toBeNull();
    });
  });

  it("serves the Codex plugin's latest Goal state to its app through the timeline", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedGoal(harness, fixture, "paused");

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/timeline`,
      );

      expect(response.status).toBe(200);
      const timeline = (await readJson(response)) as {
        extensionStates: Record<string, unknown>;
      };
      expect(timeline.extensionStates).toEqual({
        "provider-codex/goal": {
          objective: "Verify authoritative Goal cancellation",
          status: "paused",
          tokenBudget: null,
          tokensUsed: 100,
          timeUsedSeconds: 10,
        },
      });
    });
  });

  it("clears a paused Goal", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedGoal(harness, fixture, "paused");
      registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: ({ command }) => {
          if (command.type === "host.read_workspace_agent_context") {
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          }
          seedEvent(harness.deps, {
            threadId: fixture.threadId,
            environmentId: fixture.environmentId,
            providerThreadId: "provider-thread-1",
            sequence: 4,
            type: "thread/goal/cleared",
            scope: threadScope(),
            data: { providerThreadId: "provider-thread-1" },
          });
          return { ok: true, result: { cleared: true } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/goal/clear`,
        { method: "POST" },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(200);
    });
  });

  it("keeps Goal active when provider cancellation fails", async () => {
    await withTestHarness(async (harness) => {
      const fixture = seedBannerFixture(harness, { status: "idle" });
      seedGoal(harness, fixture, "active");
      const responder = registerHostRpcResponder(harness, {
        hostId: fixture.hostId,
        sessionId: fixture.sessionId,
        handle: ({ command }) => {
          if (command.type === "host.read_workspace_agent_context") {
            return { ok: true, result: EMPTY_WORKSPACE_AGENT_CONTEXT };
          }
          return { ok: true, result: { cleared: false } };
        },
      });

      const response = await harness.app.request(
        `/api/v1/threads/${fixture.threadId}/goal/clear`,
        { method: "POST" },
      );

      expect(
        response.status,
        JSON.stringify(await readJson(response.clone())),
      ).toBe(409);
      expect(
        responder.requests.some(
          ({ command }) => command.type === "thread.goal.clear",
        ),
      ).toBe(true);
      await expect(readTimelineGoalStatus(harness, fixture)).resolves.toBe(
        "active",
      );
    });
  });
});
