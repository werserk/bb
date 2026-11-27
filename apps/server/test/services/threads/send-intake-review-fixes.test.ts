import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql, and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getThreadSendIntake, listQueuedThreadMessages, projectAttachments, recordProjectAttachment, reserveThreadSendIntake,
  setExperiments, getProjectAttachment,
} from "@bb/db";
import { listEvents } from "@bb/db/testing";
import { createDeferredPromise } from "@bb/test-helpers";
import type { SendMessageRequest } from "@bb/server-contract";
import { deliverLegacyDeferredThreadMessages } from "../../../src/services/threads/legacy-deferred-messages.js";
import { startThreadSendIntakes } from "../../../src/services/threads/thread-send-request.js";
import { createThreadSendIntakeService, readIntakeEnvelope } from "../../../src/services/threads/thread-send-intake.js";
import * as commands from "../../../src/services/threads/thread-commands.js";
import { seedHostSession, seedProjectWithSource, seedThread, seedThreadFixture } from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";

const execution = { model: "test-model", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default", source: "client/turn/requested" } as const;
afterEach(() => vi.restoreAllMocks());

describe("M1: legacy-deferred startup sweep with the intake on", () => {
  it("delivers a held send before the intake worker is ready instead of waiting on it", async () => {
    await withTestHarness({ sendIntake: true, startSendIntakes: false }, async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "idle" } });
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      h.db.run(sql`CREATE TABLE IF NOT EXISTS deferred_thread_messages_legacy (id text PRIMARY KEY, thread_id text NOT NULL, kind text NOT NULL, payload text NOT NULL, created_at integer NOT NULL)`);
      h.db.run(sql`INSERT INTO deferred_thread_messages_legacy (id, thread_id, kind, payload, created_at) VALUES ('dfr_1', ${thread.id}, 'send',
        ${JSON.stringify({ kind: "send", request: { input: textInput("held before restart"), mode: "defer-legacy" } })}, ${Date.now()})`);
      const delivered = deliverLegacyDeferredThreadMessages(h.deps);
      const outcome = await Promise.race([delivered.then(() => "done"), new Promise(resolve => setTimeout(() => resolve("deadlock"), 5000))]);
      expect(outcome).toBe("done");
      expect(listEvents(h.db, { threadId: thread.id }).filter(row => row.type === "client/turn/requested")).toHaveLength(1);
      expect(h.db.$client.prepare("SELECT count(*) AS n FROM thread_send_intakes").get()).toEqual({ n: 0 });
    });
  }, 20_000);
});

function seedCopy(h: TestAppHarness) {
  const { host } = seedHostSession(h.deps);
  const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
  const { project: source } = seedProjectWithSource(h.deps, { hostId: host.id, path: "/source" });
  const thread = seedThread(h.deps, { projectId: project.id, status: "idle" });
  return { project, source, thread };
}

describe("M2: an unfinished cross-project copy is reclaimed after restart", () => {
  it.each(["unclaimed", "claimed"] as const)("delivers a send whose %s pending attachment row was orphaned", async state => {
    await withTestHarness({ sendIntake: true }, async h => {
      const { project, source, thread } = seedCopy(h);
      const sourceDir = join(h.config.dataDir, "attachments", source.id);
      await mkdir(sourceDir, { recursive: true }); await writeFile(join(sourceDir, "asset.bin"), "source bytes");
      recordProjectAttachment(h.db, { projectId: source.id, storedPath: "asset.bin", originalName: "asset.bin", mimeType: null, sizeBytes: 12, createdAt: 1, readyAt: 2 });
      const request: SendMessageRequest = { input: [{ type: "localFile", path: "asset.bin", sourceProjectId: source.id }], mode: "auto", clientSubmissionId: randomUUID() };
      const id = `qsub_${request.clientSubmissionId}`;
      const path = `intake-${id}/${source.id}/asset.bin`;
      recordProjectAttachment(h.db, { projectId: project.id, storedPath: path, originalName: "asset.bin", mimeType: null, sizeBytes: 12, createdAt: 1, readyAt: null });
      if (state === "claimed")
        h.db.update(projectAttachments).set({ deletionClaimedAt: Date.now() }).where(and(eq(projectAttachments.projectId, project.id), eq(projectAttachments.storedPath, path))).run();
      reserveThreadSendIntake(h.db, { id, threadId: thread.id, clientSubmissionId: request.clientSubmissionId!, envelope: JSON.stringify(request), fingerprint: "orphan", now: Date.now() });
      const entered = createDeferredPromise<void>(); const held = createDeferredPromise<void>();
      const service = createThreadSendIntakeService(h.deps, async () => { entered.resolve(); await held.promise; return { ok: true, delivery: "sent", messageSequence: null }; });
      try {
        service.recover(); await entered.promise;
        const row = getThreadSendIntake(h.db, id)!;
        expect(row.state).not.toBe("rejected");
        const item = readIntakeEnvelope(row).input[0]!;
        if (item.type !== "localFile") throw new Error("Expected attachment");
        expect(item.path).toBe(path);
        expect(await readFile(join(h.config.dataDir, "attachments", project.id, path), "utf8")).toBe("source bytes");
        const attachment = getProjectAttachment(h.db, project.id, path)!;
        expect(attachment.readyAt).not.toBeNull(); expect(attachment.deletionClaimedAt).toBeNull();
      } finally { service.stop(); held.resolve(); }
    });
  });
});

describe("M3: turning the setting off after rows were stored", () => {
  function send(h: TestAppHarness, threadId: string, text: string) {
    return h.app.request(`/api/v1/threads/${threadId}/send`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: textInput(text), mode: "auto", clientSubmissionId: randomUUID() }) });
  }
  const rows = (h: TestAppHarness) => h.db.$client.prepare<[], { state: string }>("SELECT state FROM thread_send_intakes ORDER BY intake_order").all().map(r => r.state);

  it("keeps the lane for a thread with open rows, uses legacy elsewhere, and keeps the read route open", async () => {
    await withTestHarness({ sendIntake: true, startSendIntakes: false }, async h => {
      const { thread } = seedThreadFixture(h, { thread: { status: "idle" } });
      const other = { thread: seedThread(h.deps, { projectId: thread.projectId, environmentId: thread.environmentId, status: "idle" }) };
      vi.spyOn(commands, "buildExecutionOptions").mockResolvedValue(execution);
      const head = randomUUID();
      reserveThreadSendIntake(h.db, { id: `qsub_${head}`, threadId: thread.id, clientSubmissionId: head,
        envelope: JSON.stringify({ input: textInput("on-period head"), mode: "auto", clientSubmissionId: head }), fingerprint: "head", now: Date.now() });
      h.db.$client.prepare("UPDATE thread_send_intakes SET state='pending'").run();
      setExperiments(h.db, { sendIntake: false });
      const read = await h.app.request(`/api/v1/threads/${thread.id}/send-intakes?afterOrder=0`);
      expect(read.status).toBe(200);
      expect(await read.json()).toMatchObject({ rows: [expect.objectContaining({ clientSubmissionId: head, state: "pending" })] });
      const legacyElsewhere = await send(h, other.thread.id, "other thread");
      expect(legacyElsewhere.status).toBe(200);
      expect(rows(h)).toEqual(["pending"]);
      const behind = send(h, thread.id, "behind the head");
      await vi.waitFor(() => expect(rows(h)).toEqual(["pending", "pending"]));
      startThreadSendIntakes(h.deps);
      const response = await behind;
      expect(response.status).toBe(200);
      expect(rows(h)).toEqual(["transferred", "transferred"]);
      const events = listEvents(h.db, { threadId: thread.id }).filter(row => row.type === "client/turn/requested");
      expect(JSON.stringify(JSON.parse(events[0]!.data).input)).toContain("on-period head");
      const queued = listQueuedThreadMessages(h.db, thread.id).map(row => JSON.stringify(row.content));
      const second = events[1] ? JSON.stringify(JSON.parse(events[1].data).input) : queued[0];
      expect(second).toContain("behind the head");
      const after = await send(h, thread.id, "lane drained");
      expect(after.status).toBe(200);
      expect(rows(h)).toEqual(["transferred", "transferred"]);
    });
  }, 30_000);
});
