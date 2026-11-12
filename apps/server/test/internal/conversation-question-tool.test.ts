import { describe, expect, it } from "vitest";
import { events, getConversationQuestion } from "@bb/db";
import { eq } from "drizzle-orm";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { seedThreadFixture, seedTurnStarted } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

describe("bb_ask_question", () => {
  it.each(["codex", "claude-code"])(
    "publishes and returns immediately for %s without a provider waiter",
    async (providerId) => {
      await withTestHarness(async (h) => {
        const { thread, session } = seedThreadFixture(h, {
          thread: { providerId, status: "active" },
        });
        seedTurnStarted(h.deps, {
          threadId: thread.id,
          turnId: "question-turn",
          providerThreadId: "p",
        });
        const request = {
          sessionId: session.id,
          threadId: thread.id,
          providerThreadId: "p",
          turnId: "question-turn",
          callId: "ask-1",
          tool: "bb_ask_question",
          arguments: {
            body: "Materials are ready",
            questions: [
              {
                question: "Which sample?",
                header: "Voice",
                multiSelect: false,
                options: [
                  { label: "A", description: "First" },
                  { label: "B", description: "Second" },
                ],
              },
            ],
          },
        };
        const call = async () =>
          readJson(
            await h.app.request("/internal/session/tool-call", {
              method: "POST",
              headers: internalAuthHeaders(h),
              body: JSON.stringify(request),
            }),
          );
        const result = await call();
        expect(result).toMatchObject({ success: true });
        if (
          !result ||
          typeof result !== "object" ||
          !("contentItems" in result) ||
          !Array.isArray(result.contentItems)
        )
          throw new Error("Missing result");
        const receipt = JSON.parse(result.contentItems[0].text);
        expect(
          getConversationQuestion(h.db, {
            threadId: thread.id,
            questionId: receipt.questionId,
          }),
        ).toMatchObject({ status: "open" });
        expect(
          h.deps.pendingInteractions.listPendingThreadInteractions(thread.id),
        ).toHaveLength(0);
        expect(await call()).toEqual(result);
        const rows = h.db
          .select()
          .from(events)
          .where(eq(events.threadId, thread.id))
          .all();
        expect(
          rows.filter((row) => row.data.includes(`::question`)),
        ).toHaveLength(1);
      });
    },
  );
});
