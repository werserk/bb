import { eq } from "drizzle-orm";
import { events, archiveThread } from "@bb/db";
import { turnScope } from "@bb/domain";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedTurnStarted,
  seedEvent,
} from "../helpers/seed.js";
import { buildThreadTimelineWithProfile } from "../../src/services/threads/timeline.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("bb_update_plan", () => {
  it.each(["codex", "claude-code", "acp-custom"])(
    "records normalized planSteps for %s",
    async (providerId) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId,
          status: "active",
        });
        seedTurnStarted(harness.deps, {
          threadId: thread.id,
          turnId: "turn-plan",
        });
        const response = await harness.app.request(
          "/internal/session/tool-call",
          {
            method: "POST",
            headers: internalAuthHeaders(harness),
            body: JSON.stringify({
              sessionId: session.id,
              threadId: thread.id,
              providerThreadId: "provider-plan",
              turnId: "turn-plan",
              callId: "plan-1",
              tool: "bb_update_plan",
              arguments: {
                explanation: "Working",
                plan: [
                  { step: "Inspect", status: "completed" },
                  { step: "Build", status: "in_progress" },
                  { step: "Check", status: "pending" },
                ],
              },
            }),
          },
        );
        expect(await readJson(response)).toMatchObject({ success: true });
        const timeline = buildThreadTimelineWithProfile(harness.db, thread, {
          eventBudget: 1000,
          completedTurnDisplay: "collapse",
          includeClearedContextHistory: false,
          includeDiagnosticOperations: false,
          compactionOfferEnabled: false,
          summarizeShellCommands: true,
          includeNestedRows: true,
          maxInlineOutputChars: null,
          maxSeq: 0,
          page: { kind: "latest", segmentLimit: 20 },
        }).response;
        expect(timeline.pendingTodos?.items).toMatchObject([
          { text: "Inspect", status: "completed" },
          { text: "Build", status: "in_progress" },
          { text: "Check", status: "pending" },
        ]);
        const rows = harness.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all();
        const snapshots = rows.filter((row) => row.type === "item/completed");
        expect(snapshots).toHaveLength(1);
        expect(JSON.parse(snapshots[0]!.data)).toMatchObject({
          item: {
            type: "planSteps",
            id: "plan:turn-plan:plan-1",
            presentation: { suppress: true },
            explanation: "Working",
            steps: [
              { step: "Inspect", status: "completed" },
              { step: "Build", status: "active" },
              { step: "Check", status: "pending" },
            ],
          },
        });
      });
    },
  );

  it.each([
    {
      input: { plan: [{ step: "Bad", status: "unknown" }] },
      turnId: "turn-plan",
      crossHost: false,
    },
    {
      input: { plan: [{ step: "", status: "pending" }] },
      turnId: "turn-plan",
      crossHost: false,
    },
    { input: { plan: [] }, turnId: "stale-turn", crossHost: false },
    {
      input: { plan: [{ step: "Bad", status: "active" }] },
      turnId: "turn-plan",
      crossHost: false,
    },
    { input: { plan: [], extra: true }, turnId: "turn-plan", crossHost: false },
    {
      input: {
        plan: Array.from({ length: 101 }, () => ({
          step: "Too many",
          status: "pending",
        })),
      },
      turnId: "turn-plan",
      crossHost: false,
    },
    { input: { plan: [] }, turnId: "turn-plan", crossHost: true },
  ])(
    "rejects invalid, stale or foreign updates: %j",
    async ({ input, turnId, crossHost }) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps, {
          id: "plan-host",
        });
        const foreign = crossHost
          ? seedHostSession(harness.deps, { id: "foreign-plan-host" })
          : null;
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "active",
        });
        seedTurnStarted(harness.deps, {
          threadId: thread.id,
          turnId: "turn-plan",
        });
        const response = await harness.app.request(
          "/internal/session/tool-call",
          {
            method: "POST",
            headers: internalAuthHeaders(harness),
            body: JSON.stringify({
              sessionId: foreign?.session.id ?? session.id,
              threadId: thread.id,
              providerThreadId: "provider-plan",
              turnId,
              callId: "bad-plan",
              tool: "bb_update_plan",
              arguments: input,
            }),
          },
        );
        if (crossHost) expect(response.status).toBe(403);
        else expect(await readJson(response)).toMatchObject({ success: false });
        expect(
          harness.db
            .select()
            .from(events)
            .where(eq(events.threadId, thread.id))
            .all()
            .filter((row) => row.type === "item/completed"),
        ).toHaveLength(0);
      });
    },
  );
  it.each(["empty", "completed", "archived", "child", "missing"])(
    "handles %s turn lifecycle",
    async (kind) => {
      await withTestHarness(async (harness) => {
        const { host, session } = seedHostSession(harness.deps);
        const { project } = seedProjectWithSource(harness.deps, {
          hostId: host.id,
        });
        const environment = seedEnvironment(harness.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(harness.deps, {
          projectId: project.id,
          environmentId: environment.id,
          status: "active",
        });
        if (kind !== "missing")
          seedTurnStarted(harness.deps, {
            threadId: thread.id,
            turnId: "turn-plan",
          });
        if (kind === "child")
          seedEvent(harness.deps, {
            threadId: thread.id,
            sequence: 2,
            type: "turn/started",
            scope: turnScope("child-plan"),
            data: {
              providerThreadId: "provider-plan",
              parentTurnId: "turn-plan",
              parentToolCallId: "agent-1",
            },
          });
        if (kind === "completed")
          seedEvent(harness.deps, {
            threadId: thread.id,
            sequence: 2,
            type: "turn/completed",
            scope: turnScope("turn-plan"),
            data: { providerThreadId: "provider-plan", status: "completed" },
          });
        if (kind === "archived")
          archiveThread(harness.db, harness.deps.hub, thread.id);
        const response = await harness.app.request(
          "/internal/session/tool-call",
          {
            method: "POST",
            headers: internalAuthHeaders(harness),
            body: JSON.stringify({
              sessionId: session.id,
              threadId: thread.id,
              providerThreadId: "provider-plan",
              turnId: kind === "child" ? "child-plan" : "turn-plan",
              callId: "clear",
              tool: "bb_update_plan",
              arguments: { plan: [] },
            }),
          },
        );
        expect(await readJson(response)).toMatchObject({
          success: kind === "empty" || kind === "child",
        });
      });
    },
  );
});
