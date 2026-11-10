import { z } from "zod";
import { createPendingInteraction } from "@bb/db";
import {
  createUserQuestionPayload,
  createCommandApprovalPayload,
} from "../helpers/pending-interactions.js";
import { describe, expect, it } from "vitest";
import { turnScope } from "@bb/domain";
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
import { withTestHarness } from "../helpers/test-app.js";
import {
  setPreCompletionPolicy,
  clearPreCompletionPolicies,
} from "../../src/services/threads/pre-completion.js";

describe.each(["claude-code", "codex"])(
  "pre-completion provider %s",
  (testProvider) => {
    async function fixture(
      run: (f: {
        call: (overrides?: Record<string, unknown>) => Promise<unknown>;
        stop: () => void;
        question: (approval?: boolean, corrupt?: boolean) => void;
        threadId: string;
      }) => Promise<void>,
      providerId = testProvider,
    ) {
      await withTestHarness(async (h) => {
        const { host, session } = seedHostSession(h.deps);
        const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
        const environment = seedEnvironment(h.deps, {
          hostId: host.id,
          projectId: project.id,
        });
        const thread = seedThread(h.deps, {
          projectId: project.id,
          environmentId: environment.id,
          providerId,
          status: "active",
        });
        seedTurnStarted(h.deps, {
          threadId: thread.id,
          turnId: "bb-turn",
          providerThreadId: "provider-thread",
        });
        const call = async (overrides: Record<string, unknown> = {}) =>
          readJson(
            await h.app.request("/internal/session/tool-call", {
              method: "POST",
              headers: internalAuthHeaders(h),
              body: JSON.stringify({
                sessionId: session.id,
                threadId: thread.id,
                providerThreadId: "provider-thread",
                turnId: "bb-turn",
                turnOrigin: "provider",
                callId: "stop-check",
                tool: "bb_internal_pre_completion",
                arguments: { finalText: "Need your choice", truncated: false },
                ...overrides,
              }),
            }),
          );
        try {
          await run({
            call,
            threadId: thread.id,
            question: (approval = false, corrupt = false) => {
              createPendingInteraction(h.db, {
                threadId: thread.id,
                providerId,
                providerThreadId: "provider-thread",
                providerRequestId: `question-${approval}`,
                turnId: "bb-turn",
                payload: corrupt
                  ? "{invalid-json"
                  : JSON.stringify(
                      approval
                        ? createCommandApprovalPayload()
                        : createUserQuestionPayload(),
                    ),
              });
            },
            stop: () => {
              seedEvent(h.deps, {
                threadId: thread.id,
                sequence: 5,
                type: "turn/completed",
                scope: turnScope("bb-turn"),
                data: {
                  providerThreadId: "provider-thread",
                  status: "interrupted",
                },
              });
            },
          });
        } finally {
          clearPreCompletionPolicies("test");
        }
      });
    }

    function result(value: unknown) {
      const response = z
        .object({
          success: z.literal(true),
          contentItems: z.array(z.object({ text: z.string() })).min(1),
        })
        .parse(value);
      return JSON.parse(response.contentItems[0]!.text);
    }

    describe("native pre-completion builtin", () => {
      it("opts in only registered threads and reserves one correction across policy reload", async () =>
        fixture(async (f) => {
          expect(result(await f.call())).toMatchObject({
            action: "allow",
            reason: "disabled",
          });
          const seen: unknown[] = [];
          const handler = async (ctx: unknown) => {
            seen.push(ctx);
            return {
              action: "continue" as const,
              instruction: "Ask the native question now.",
            };
          };
          setPreCompletionPolicy("test", f.threadId, handler);
          expect(result(await f.call())).toMatchObject({ action: "continue" });
          clearPreCompletionPolicies("test");
          setPreCompletionPolicy("test", f.threadId, handler);
          expect(result(await f.call())).toMatchObject({
            action: "allow",
            reason: "already_corrected",
          });
          expect(seen).toHaveLength(1);
          expect(seen[0]).toMatchObject({
            threadId: f.threadId,
            turnId: "bb-turn",
            pendingUserQuestionIds: [],
            correctionAttempt: 0,
          });
        }));
      it("does not trust arrival identity or an invented turn", async () =>
        fixture(async (f) => {
          setPreCompletionPolicy("test", f.threadId, async () => ({
            action: "continue",
            instruction: "Ask now",
          }));
          expect(result(await f.call({ turnOrigin: "arrival" }))).toMatchObject(
            {
              action: "allow",
              gap: "missing_identity",
            },
          );
          expect(
            result(await f.call({ turnId: "raw-provider-turn" })),
          ).toMatchObject({ action: "allow", gap: "missing_identity" });
        }));
      it("fails open on policy errors and validates correction text", async () =>
        fixture(async (f) => {
          setPreCompletionPolicy("test", f.threadId, async () => {
            throw new Error("private failure");
          });
          expect(result(await f.call())).toMatchObject({
            action: "allow",
            gap: "policy_failed",
          });
          setPreCompletionPolicy("test", f.threadId, async () => ({
            action: "continue",
            instruction: "x".repeat(1001),
          }));
          expect(result(await f.call())).toMatchObject({
            action: "allow",
            gap: "policy_failed",
          });
        }));
      it("does not correct a stopped turn, including Stop while policy awaits", async () =>
        fixture(async (f) => {
          setPreCompletionPolicy("test", f.threadId, async () => {
            f.stop();
            return { action: "continue", instruction: "Ask now" };
          });
          expect(result(await f.call())).toMatchObject({
            action: "allow",
            reason: "ended",
          });
        }));
    });

    it("rechecks native questions after policy; an approval alone is not a user question", async () =>
      fixture(async (f) => {
        f.question(true);
        setPreCompletionPolicy("test", f.threadId, async () => {
          f.question();
          return { action: "continue", instruction: "Ask now" };
        });
        expect(result(await f.call())).toMatchObject({
          action: "allow",
          reason: "pending_question",
        });
        expect(result(await f.call())).toMatchObject({
          action: "allow",
          reason: "pending_question",
        });
      }));
    it("reserves at most one correction under duplicate concurrent callbacks", async () =>
      fixture(async (f) => {
        setPreCompletionPolicy("test", f.threadId, async () => ({
          action: "continue",
          instruction: "Ask now",
        }));
        const values = (await Promise.all([f.call(), f.call()])).map(result);
        expect(values.filter((v) => v.action === "continue")).toHaveLength(1);
        expect(
          values.filter((v) => v.reason === "already_corrected"),
        ).toHaveLength(1);
      }));
    it("times out and permits completion without consuming the once guard", async () =>
      fixture(async (f) => {
        setPreCompletionPolicy("test", f.threadId, () => new Promise(() => {}));
        expect(result(await f.call())).toMatchObject({
          action: "allow",
          gap: "policy_timeout",
        });
        setPreCompletionPolicy("test", f.threadId, () => ({
          action: "continue",
          instruction: "Ask now",
        }));
        expect(result(await f.call())).toMatchObject({ action: "continue" });
      }));

    it("retains corrupt native questions as coverage gaps rather than absence", async () =>
      fixture(async (f) => {
        f.question(false, true);
        setPreCompletionPolicy("test", f.threadId, () => ({
          action: "continue",
          instruction: "Ask now",
        }));
        expect(result(await f.call())).toMatchObject({
          action: "allow",
          gap: "pending_questions_unavailable",
        });
      }));
    it("admits Codex through the same policy and durable once guard", async () =>
      fixture(async (f) => {
        setPreCompletionPolicy("test", f.threadId, (ctx) => {
          expect(ctx).toMatchObject({
            providerId: "codex",
            turnId: "bb-turn",
            turnOrigin: "provider",
          });
          return { action: "continue", instruction: "Ask natively" };
        });
        expect(result(await f.call())).toMatchObject({
          action: "continue",
          instruction: "Ask natively",
        });
        expect(result(await f.call())).toMatchObject({ action: "allow" });
      }, "codex"));
  },
);
