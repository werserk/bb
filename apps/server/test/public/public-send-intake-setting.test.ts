import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getExperiments, listQueuedThreadMessages, listStoredEventRows } from "@bb/db";
import * as commands from "../../src/services/threads/thread-commands.js";
import { seedThreadFixture } from "../helpers/seed.js";
import { textInput } from "../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const execution = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" } as const;
afterEach(() => { vi.restoreAllMocks(); });

function intakeRowCount(h: TestAppHarness): number {
  return h.db.$client.prepare<[], { n: number }>("SELECT count(*) AS n FROM thread_send_intakes").get()!.n;
}

function send(h: TestAppHarness, threadId: string, body: Record<string, unknown>) {
  return h.app.request(`/api/v1/threads/${threadId}/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

describe("sendIntake setting", () => {
  it("defaults off", async () => {
    await withTestHarness(async h => {
      expect(getExperiments(h.db).sendIntake).toBe(false);
    });
  });

  it("off: legacy send stores no intake row and the intake routes answer 404", async () => {
    await withTestHarness(async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "idle" } });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      const id = randomUUID();
      const response = await send(h, thread.id, { input: textInput("legacy"), mode: "auto", clientSubmissionId: id });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, delivery: "sent", submissionIds: [id] });
      expect(intakeRowCount(h)).toBe(0);
      expect(listStoredEventRows(h.db, { threadId: thread.id, types: ["client/turn/requested"], order: "asc", limit: 10 })).toHaveLength(1);
      const replay = await send(h, thread.id, { input: textInput("legacy"), mode: "auto", clientSubmissionId: id });
      expect(replay.status).toBe(409);
      const admission = await h.app.request(`/api/v1/threads/${thread.id}/send-admission`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ admissionVersion: 1, input: textInput("x"), mode: "auto", clientSubmissionId: randomUUID() }),
      });
      expect(admission.status).toBe(404);
      expect(await admission.json()).toMatchObject({ code: "intake_disabled" });
      expect((await h.app.request(`/api/v1/threads/${thread.id}/send-intakes?afterOrder=0`)).status).toBe(404);
      expect(intakeRowCount(h)).toBe(0);
    });
  });

  it("off: a queued legacy send keeps the legacy queue receipt without an intake row", async () => {
    await withTestHarness(async h => {
      const { thread, session } = seedThreadFixture(h, { thread: { status: "idle" } });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      h.hub.unregisterDaemon(session.id);
      const id = randomUUID();
      const response = await send(h, thread.id, { input: textInput("held"), mode: "auto", clientSubmissionId: id });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ delivery: "queued", queuedMessage: { id: `qsub_${id}` } });
      expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
      expect(intakeRowCount(h)).toBe(0);
    });
  });

  it("on: the same send is stored as an intake row and handed off", async () => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "idle" } });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      const id = randomUUID();
      const response = await send(h, thread.id, { input: textInput("custody"), mode: "auto", clientSubmissionId: id });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, delivery: "sent", submissionIds: [id] });
      expect(intakeRowCount(h)).toBe(1);
      expect(h.db.$client.prepare<[], { state: string }>("SELECT state FROM thread_send_intakes").get()?.state).toBe("transferred");
    });
  });
});
