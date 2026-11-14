import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createQueuedThreadMessageInTransaction, getThreadSendIntake, projectAttachmentThreads,
  projects, recordProjectAttachment, reserveThreadSendIntake, readThreadSendIntakePage, deleteThread, deleteProject, updateHost,
} from "@bb/db";
import { createDeferredPromise } from "@bb/test-helpers";
import type { SendMessageRequest } from "@bb/server-contract";
import { createThreadSendIntakeService, readIntakeEnvelope } from "../../../src/services/threads/thread-send-intake.js";
import { commitSendIntake } from "../../../src/services/threads/send-intake-authority.js";
import { withTestHarness, type TestAppHarness } from "../../helpers/test-app.js";
import { seedHostSession, seedProjectWithSource, seedThread } from "../../helpers/seed.js";
import { textInput } from "../../helpers/prompt-input.js";
import * as attachments from "../../../src/services/projects/attachments.js";

afterEach(() => vi.restoreAllMocks());
function seed(h: TestAppHarness) {
  const { host } = seedHostSession(h.deps);
  const { project } = seedProjectWithSource(h.deps, { hostId: host.id });
  const thread = seedThread(h.deps, { projectId: project.id, status: "idle" });
  return { host, project, thread };
}
const payload = (): SendMessageRequest => ({ input: textInput("preserve me"), mode: "auto", clientSubmissionId: randomUUID() });

describe("raw send intake custody", () => {
  it("commits text custody before any asynchronous attachment/provider preparation and replays canonical UUID/hash", async () => {
    await withTestHarness(async h => {
      const { thread } = seed(h);
      const resolve = vi.spyOn(attachments, "resolvePromptAttachmentReferences");
      const held = createDeferredPromise<void>();
      const entered = createDeferredPromise<void>();
      const service = createThreadSendIntakeService(h.deps, async (_payload, _thread, auth) => {
        entered.resolve(); await held.promise;
        h.db.transaction(tx => commitSendIntake(tx, auth, { kind: "queue", id: auth.claim.id }));
        return { ok: true, delivery: "sent" };
      });
      try {
        const request = payload();
        const row = await service.admit(request, thread);
        expect(row).toMatchObject({ state: "pending", originalEnvelope: expect.stringContaining("preserve me"), admissionReceipt: expect.any(String) });
        expect(resolve).not.toHaveBeenCalled();
        expect((await service.admit({ mode: "auto", clientSubmissionId: request.clientSubmissionId!.toUpperCase(), input: request.input }, thread)).id).toBe(row.id);
        await expect(service.admit({ ...request, mode: "queue-if-active" }, thread)).rejects.toMatchObject({ status: 409 });
        await entered.promise;
        held.resolve();
        await service.wait(row.id);
        const settled = getThreadSendIntake(h.db, row.id)!;
        expect(settled.currentEnvelope).toBeNull();
        await expect(service.mutate(thread.id, { id: row.id, revision: settled.revision,
          action: { kind: "edit", input: textInput("late edit") } })).rejects.toMatchObject({ status: 409 });
        expect(getThreadSendIntake(h.db, row.id)?.nativeHandoff).toBe(settled.nativeHandoff);
        expect((await service.admit(request, thread)).admissionReceipt).toBe(row.admissionReceipt);
        expect(readThreadSendIntakePage(h.db, thread.id, 0)).toHaveLength(1);
      } finally { held.resolve(); service.stop(); }
    });
  });

  it("refuses a retained service reference stopped before startup readiness without changing acknowledged custody", async () => {
    await withTestHarness(async h => {
      const { thread } = seed(h);
      const execute = vi.fn(async () => ({ ok: true, delivery: "sent" } as const));
      const service = createThreadSendIntakeService(h.deps, execute, () => false);
      try {
        const row = await service.admit(payload(), thread);
        expect(row).toMatchObject({ state: "pending", claimEpoch: 0 });
        service.stop();
        const retained = getThreadSendIntake(h.db, row.id);
        await expect(service.mutate(thread.id, { id: row.id, revision: row.revision,
          action: { kind: "cancel" } })).rejects.toMatchObject({ status: 503 });
        await expect(service.admit(payload(), thread)).rejects.toMatchObject({ status: 503 });
        expect(getThreadSendIntake(h.db, row.id)).toEqual(retained);
        expect(execute).not.toHaveBeenCalled();
      } finally { service.stop(); }
    });
  });

  it("settles deleted-thread legacy waiters only after the real cascade commits, even before readiness", async () => {
    await withTestHarness(async h => {
      const { thread } = seed(h);
      const execute = vi.fn(async () => ({ ok: true, delivery: "sent" } as const));
      const service = createThreadSendIntakeService(h.deps, execute, () => false);
      try {
        const head = await service.admit(payload(), thread);
        const following = await service.admit(payload(), thread);
        let settled = false;
        const result = Promise.allSettled([service.wait(head.id), service.wait(following.id)]).then(outcomes => {
          settled = true; return outcomes;
        });
        expect(() => h.db.transaction(tx => {
          expect(deleteThread(tx, h.deps.hub, thread.id)).toBe(true);
          throw new Error("rollback thread deletion");
        })).toThrow("rollback thread deletion");
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(getThreadSendIntake(h.db, head.id)?.state).toBe("pending");
        expect(getThreadSendIntake(h.db, following.id)?.state).toBe("pending");
        h.db.transaction(tx => {
          expect(deleteThread(tx, h.deps.hub, thread.id)).toBe(true);
          expect(settled).toBe(false);
        });
        const deleted = { status: "rejected", reason: expect.objectContaining({ status: 503,
          body: expect.objectContaining({ code: "intake_not_deliverable" }) }) };
        expect(await result).toEqual([deleted, deleted]);
        expect(getThreadSendIntake(h.db, head.id)).toBeNull();
        expect(getThreadSendIntake(h.db, following.id)).toBeNull();
        expect(execute).not.toHaveBeenCalled();
      } finally { service.stop(); }
    });
  });

  it.each(["project", "host"] as const)("settles vanished-row waiters after a committed %s notification without retiring surviving threads", async signal => {
    await withTestHarness(async h => {
      const { host, project, thread } = seed(h);
      const other = seed(h);
      const execute = vi.fn(async () => ({ ok: true, delivery: "sent" } as const));
      const service = createThreadSendIntakeService(h.deps, execute, () => false);
      try {
        const row = await service.admit(payload(), thread);
        const survivor = await service.admit(payload(), other.thread);
        let outcome: PromiseSettledResult<unknown> | undefined;
        let surviving = true;
        const result = Promise.allSettled([service.wait(row.id)]).then(([value]) => { outcome = value; });
        const live = Promise.allSettled([service.wait(survivor.id)]).then(() => { surviving = false; });
        const remove = () => {
          if (signal === "project") expect(deleteProject(h.db, h.deps.hub, project.id)).toBe(true);
          else {
            h.db.delete(projects).where(eq(projects.id, project.id)).run();
            updateHost(h.db, h.deps.hub, host.id, { destroyedAt: Date.now() });
          }
        };
        expect(() => h.db.transaction(() => {
          remove();
          throw new Error("rollback cascade");
        })).toThrow("rollback cascade");
        await Promise.resolve();
        expect(outcome).toBeUndefined();
        expect(getThreadSendIntake(h.db, row.id)?.state).toBe("pending");
        h.db.transaction(() => {
          remove();
          expect(outcome).toBeUndefined();
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(outcome).toMatchObject({ status: "rejected", reason: { status: 503,
          body: { code: "intake_not_deliverable" } } });
        expect(surviving).toBe(true);
        expect(getThreadSendIntake(h.db, row.id)).toBeNull();
        expect(getThreadSendIntake(h.db, survivor.id)?.state).toBe("pending");
        expect(execute).not.toHaveBeenCalled();
        await result;
        service.stop();
        await live;
      } finally { service.stop(); }
    });
  });

  it("does not accept a supplied identity already in the native queue", async () => {
    await withTestHarness(async h => {
      const { thread } = seed(h); const request = payload();
      h.db.transaction(tx => createQueuedThreadMessageInTransaction(tx, {
        threadId: thread.id, clientSubmissionId: request.clientSubmissionId, content: request.input,
        model: "test", reasoningLevel: "medium", permissionMode: "full", serviceTier: "default",
        waitingOn: null, sendAt: null, payload: { kind: "inline" }, systemNotice: null,
      }));
      const service = createThreadSendIntakeService(h.deps, async () => ({ ok: true, delivery: "sent" }));
      try {
        await expect(service.admit(request, thread)).rejects.toMatchObject({ status: 409, body: { code: "submission_already_admitted" } });
        expect(readThreadSendIntakePage(h.db, thread.id, 0)).toHaveLength(0);
      } finally { service.stop(); }
    });
  });

  it("pins ready same-project assets in the same actual transaction as the receipt", async () => {
    await withTestHarness(async h => {
      const { thread, project } = seed(h);
      recordProjectAttachment(h.db, { projectId: project.id, storedPath: "owned.bin", originalName: "owned.bin", mimeType: null, sizeBytes: 4, createdAt: 1, readyAt: 2 });
      const held = createDeferredPromise<void>();
      const service = createThreadSendIntakeService(h.deps, async () => { await held.promise; return { ok: true, delivery: "sent" }; });
      try {
        const request: SendMessageRequest = { ...payload(), input: [{ type: "localFile", path: "owned.bin", sourceProjectId: project.id }] };
        expect(() => h.db.transaction(() => {
          void service.admit(request, thread);
          throw new Error("outer rollback");
        })).toThrow("outer rollback");
        expect(readThreadSendIntakePage(h.db, thread.id, 0)).toHaveLength(0);
        expect(h.db.select().from(projectAttachmentThreads).all()).toHaveLength(0);
        const row = await service.admit(request, thread);
        expect(row.admissionReceipt).not.toBeNull();
        expect(h.db.select().from(projectAttachmentThreads).all()).toHaveLength(1);
        expect(readIntakeEnvelope(row).input).toEqual([{ type: "localFile", path: "owned.bin" }]);
      } finally { service.stop(); held.resolve(); }
    });
  });

  it("copies into a stable private target before ack and survives source-project deletion", async () => {
    await withTestHarness(async h => {
      const { host, project, thread } = seed(h);
      const { project: source } = seedProjectWithSource(h.deps, { hostId: host.id, path: "/source" });
      const sourceDir = join(h.config.dataDir, "attachments", source.id);
      await mkdir(sourceDir, { recursive: true }); await writeFile(join(sourceDir, "asset.bin"), "source bytes");
      recordProjectAttachment(h.db, { projectId: source.id, storedPath: "asset.bin", originalName: "asset.bin", mimeType: null, sizeBytes: 12, createdAt: 1, readyAt: 2 });
      const held = createDeferredPromise<void>();
      const service = createThreadSendIntakeService(h.deps, async () => { await held.promise; return { ok: true, delivery: "sent" }; });
      try {
        const request: SendMessageRequest = { ...payload(), input: [{ type: "localFile", path: "asset.bin", sourceProjectId: source.id }] };
        const row = await service.admit(request, thread);
        const item = readIntakeEnvelope(row).input[0]!;
        if (item.type !== "localFile") throw new Error("Expected attachment");
        expect(item.path).toContain(`intake-${row.id}/${source.id}/asset.bin`);
        h.db.delete(projects).where(eq(projects.id, source.id)).run(); await rm(sourceDir, { recursive: true });
        expect(await readFile(join(h.config.dataDir, "attachments", project.id, item.path), "utf8")).toBe("source bytes");
        expect(row.admissionReceipt).not.toBeNull();
        expect(h.db.select().from(projectAttachmentThreads).all()).toHaveLength(1);
      } finally { service.stop(); held.resolve(); }
    });
  });

  it("recovers an unacknowledged staging copy from its stable ready target without rereading the source", async () => {
    await withTestHarness(async h => {
      const { thread, project } = seed(h); const request = payload();
      request.input = [{ type: "localFile", path: "asset.bin", sourceProjectId: "deleted-source" }];
      const id = `qsub_${request.clientSubmissionId}`;
      const path = `intake-${id}/deleted-source/asset.bin`;
      const target = join(h.config.dataDir, "attachments", project.id, path);
      await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, "copied before crash");
      recordProjectAttachment(h.db, { projectId: project.id, storedPath: path, originalName: "asset.bin", mimeType: null, sizeBytes: 19, createdAt: 1, readyAt: 2 });
      reserveThreadSendIntake(h.db, { id, threadId: thread.id, clientSubmissionId: request.clientSubmissionId!, envelope: JSON.stringify(request), fingerprint: "retained-original", now: Date.now() });
      const entered = createDeferredPromise<void>(); const held = createDeferredPromise<void>();
      const service = createThreadSendIntakeService(h.deps, async () => { entered.resolve(); await held.promise; return { ok: true, delivery: "sent" }; });
      try {
        service.recover(); await entered.promise;
        expect(getThreadSendIntake(h.db, id)?.admissionReceipt).not.toBeNull();
        expect(readIntakeEnvelope(getThreadSendIntake(h.db, id)!).input).toEqual([{ type: "localFile", path }]);
      } finally { service.stop(); held.resolve(); }
    });
  });
});
