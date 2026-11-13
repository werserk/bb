import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "../../src/testing.js";
import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import { recordProjectAttachment } from "../../src/data/project-attachments.js";
import { events, projectAttachmentThreads, threads } from "../../src/schema.js";
import {
  reserveThreadSendIntake,
  finaliseThreadSendIntake,
  getThreadSendIntake,
  claimThreadSendIntake,
  sealThreadSendIntake,
  handoffThreadSendIntake,
  mutateThreadSendIntake,
  failThreadSendIntake,
  listThreadSendIntakes,
  assertThreadSendIntakeClaim,
  hasThreadSendIntakeNativeIdentity,
} from "../../src/data/thread-send-intakes.js";

const connections: ReturnType<typeof createMigratedConnection>[] = [];
afterEach(() => {
  for (const db of connections.splice(0)) db.$client.close();
});
function setup() {
  const db = createMigratedConnection();
  connections.push(db);
  const host = upsertHost(db, noopNotifier, { name: "intake-host" });
  const { project } = createProject(db, noopNotifier, {
    name: "intake-project",
    source: { type: "local_path", hostId: host.id, path: "/intake" },
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    providerId: "codex",
  });
  const reserve = (id: string, clientId: string | null = null) =>
    reserveThreadSendIntake(db, {
      id, threadId: thread.id, clientSubmissionId: clientId,
      envelope: '{"input":[{"type":"text","text":"original","mentions":[]}],"mode":"auto"}',
      fingerprint: "original-hash", now: 100,
    });
  const ready = (id: string) => db.transaction((tx) =>
    finaliseThreadSendIntake(tx, {
      id, envelope: "{}", attachmentPaths: [], admissionReceipt: "accepted", now: 100,
    }), { behavior: "immediate" });
  return { db, project, thread, reserve, ready };
}

describe("durable send intake", () => {
  it("finds a pre-intake identity beyond the old history window with canonical UUID casing", () => {
    const { db, thread } = setup();
    const id = "abcdefab-cdef-4abc-8def-abcdefabcdef";
    db.transaction(tx => {
      for (let sequence = 1; sequence <= 1002; sequence++) {
        tx.insert(events).values({ id: `native-${sequence}`, threadId: thread.id,
          type: "client/turn/requested", scopeKind: "thread", sequence, createdAt: sequence,
          data: JSON.stringify({ requestId: `creq_${sequence}`, input: [],
            ...(sequence === 1 ? { clientSubmissions: [{ id: id.toUpperCase(), inputGroupIndex: 0 }] } : {}) }),
        }).run();
      }
    });
    expect(hasThreadSendIntakeNativeIdentity(db, thread.id, id)).toBe(true);
    expect(hasThreadSendIntakeNativeIdentity(db, "another-thread", id)).toBe(false);
    expect(hasThreadSendIntakeNativeIdentity(db, thread.id, "00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("orders mixed identified and no-ID sends and keeps a staging head in the lane", () => {
    const { db, thread, reserve, ready } = setup();
    reserve("modern", "client"); reserve("legacy"); reserve("old-client");
    ready("legacy"); ready("old-client");
    expect(claimThreadSendIntake(db, { threadId: thread.id, token: "a", now: 101, leaseMs: 100 })).toBeNull();
    ready("modern");
    const claim = claimThreadSendIntake(db, { threadId: thread.id, token: "a", now: 101, leaseMs: 100 })!;
    expect(claim.id).toBe("modern");
    expect(listThreadSendIntakes(db, thread.id).map(r => [r.id, r.intakeOrder, r.clientSubmissionId])).toEqual([
      ["modern", 1, "client"], ["legacy", 2, null], ["old-client", 3, null],
    ]);
    expect(claimThreadSendIntake(db, { threadId: thread.id, token: "b", now: 102, leaseMs: 100 })).toBeNull();
  });

  it("rolls back admission and asset pins together and never acknowledges staging", () => {
    const { db, project, thread, reserve } = setup();
    reserve("asset");
    recordProjectAttachment(db, {
      projectId: project.id, storedPath: "asset.bin", originalName: "asset.bin", mimeType: null, sizeBytes: 5,
      createdAt: 1, readyAt: 2,
    });
    expect(() => db.transaction(tx => {
      finaliseThreadSendIntake(tx, { id: "asset", envelope: "ready", attachmentPaths: ["asset.bin", "missing.bin"], admissionReceipt: "accepted", now: 101 });
    }, { behavior: "immediate" })).toThrow();
    expect(getThreadSendIntake(db, "asset")).toMatchObject({ state: "staging", admissionReceipt: null });
    expect(db.select().from(projectAttachmentThreads).where(eq(projectAttachmentThreads.threadId, thread.id)).all()).toEqual([]);
    db.transaction(tx => finaliseThreadSendIntake(tx, { id: "asset", envelope: "ready", attachmentPaths: ["asset.bin"], admissionReceipt: "accepted", now: 102 }), { behavior: "immediate" });
    expect(getThreadSendIntake(db, "asset")).toMatchObject({ state: "pending", admissionReceipt: "accepted" });
    expect(db.select().from(projectAttachmentThreads).all()).toHaveLength(1);
  });

  it("retains the original replay key, hash, receipt and monotonic anchor after handoff", () => {
    const { db, thread, reserve, ready } = setup();
    reserve("qsub_client", "client"); ready("qsub_client");
    const claim = claimThreadSendIntake(db, { threadId: thread.id, token: "a", now: 101, leaseMs: 100 })!;
    db.transaction(tx => handoffThreadSendIntake(tx, claim, { kind: "queue", id: "qsub_client" }, "queued", 102));
    expect(getThreadSendIntake(db, claim.id)).toMatchObject({ state: "transferred", currentEnvelope: null, originalEnvelope: null, originalFingerprint: "original-hash", admissionReceipt: "accepted", nativeReceipt: "queued" });
    expect(reserve("different-id", "client").id).toBe(claim.id);
    expect(() => reserveThreadSendIntake(db, { id: "another", threadId: thread.id, clientSubmissionId: "client", envelope: "changed", fingerprint: "changed-hash", now: 103 })).toThrow(/conflict/i);
    expect(reserve("next").intakeOrder).toBe(2);
  });

  it("fences expired workers inside the transaction and rolls back their native effects", () => {
    const { db, thread, reserve, ready } = setup();
    reserve("first"); ready("first");
    const stale = claimThreadSendIntake(db, { threadId: thread.id, token: "old", now: 101, leaseMs: 10 })!;
    const current = claimThreadSendIntake(db, { threadId: thread.id, token: "new", now: 112, leaseMs: 100 })!;
    expect(current.claimEpoch).toBe(stale.claimEpoch + 1);
    expect(() => db.transaction(tx => {
      tx.update(threads).set({ title: "stale effect" }).where(eq(threads.id, thread.id)).run();
      assertThreadSendIntakeClaim(tx, stale, 113);
    })).toThrow(/claim/i);
    expect(db.select().from(threads).where(eq(threads.id, thread.id)).get()?.title).not.toBe("stale effect");
    expect(() => db.transaction(tx => handoffThreadSendIntake(tx, stale, { kind: "queue", id: "bad" }, null, 113))).toThrow(/claim/i);
    db.transaction(tx => handoffThreadSendIntake(tx, current, { kind: "queue", id: "good" }, null, 114));
  });

  it("edits by revision before seal, conflicts after seal and preserves failed custody", () => {
    const { db, thread, reserve, ready } = setup();
    reserve("first"); ready("first"); reserve("next"); ready("next");
    const row = getThreadSendIntake(db, "first")!;
    const edited = mutateThreadSendIntake(db, { id: row.id, revision: row.revision, action: { kind: "edit", envelope: JSON.stringify({ text: "new draft" }), attachmentPaths: [] }, now: 101 });
    expect(edited.originalFingerprint).toBe("original-hash");
    expect(() => mutateThreadSendIntake(db, { id: row.id, revision: row.revision, action: { kind: "cancel" }, now: 102 })).toThrow(/conflict/i);
    const claim = claimThreadSendIntake(db, { threadId: thread.id, token: "a", now: 103, leaseMs: 100 })!;
    db.transaction(tx => sealThreadSendIntake(tx, claim, 104));
    expect(() => mutateThreadSendIntake(db, { id: claim.id, revision: getThreadSendIntake(db, claim.id)!.revision, action: { kind: "cancel" }, now: 105 })).toThrow(/sealed/i);
    const errorOutcome = JSON.stringify({ kind: "error", status: 409, body: { code: "dispatch_rejected", message: "Hook rejected", details: { custodyRetained: true } } });
    failThreadSendIntake(db, claim, "hook outcome uncertain", 106, errorOutcome);
    failThreadSendIntake(db, { ...claim, claimToken: "stale" }, "stale replacement", 107, "wrong");
    expect(getThreadSendIntake(db, claim.id)).toMatchObject({ state: "failed", currentEnvelope: expect.stringContaining("new draft"), admissionReceipt: "accepted", nativeReceipt: errorOutcome, lastError: "hook outcome uncertain" });
    expect(() => mutateThreadSendIntake(db, { id: claim.id, revision: getThreadSendIntake(db, claim.id)!.revision, action: { kind: "retry" }, now: 107 })).toThrow(/sealed/i);
    expect(claimThreadSendIntake(db, { threadId: thread.id, token: "b", now: 108, leaseMs: 100 })).toBeNull();
  });

  it("retains expired sealed uncertainty instead of replaying effects or skipping the head", () => {
    const { db, thread, reserve, ready } = setup();
    reserve("sealed"); ready("sealed"); reserve("next"); ready("next");
    const claim = claimThreadSendIntake(db, { threadId: thread.id, token: "a", now: 101, leaseMs: 10 })!;
    db.transaction(tx => sealThreadSendIntake(tx, claim, 102));
    expect(claimThreadSendIntake(db, { threadId: thread.id, token: "b", now: 112, leaseMs: 100 })).toBeNull();
    expect(getThreadSendIntake(db, claim.id)).toMatchObject({ state: "failed", lastError: "Recovery required: effect-sealed claim expired" });
  });

  it("allows explicit retry or cancellation of a pre-seal failure and cascades with thread deletion", () => {
    const { db, thread, reserve, ready } = setup();
    reserve("retry"); ready("retry");
    const claim = claimThreadSendIntake(db, { threadId: thread.id, token: "a", now: 101, leaseMs: 100 })!;
    failThreadSendIntake(db, claim, "catalog offline", 102);
    let row = getThreadSendIntake(db, claim.id)!;
    row = mutateThreadSendIntake(db, { id: row.id, revision: row.revision, action: { kind: "retry" }, now: 103 });
    row = mutateThreadSendIntake(db, { id: row.id, revision: row.revision, action: { kind: "cancel" }, now: 104 });
    expect(row).toMatchObject({ state: "cancelled", currentEnvelope: null, originalFingerprint: "original-hash" });
    db.delete(threads).where(eq(threads.id, thread.id)).run();
    expect(getThreadSendIntake(db, claim.id)).toBeNull();
  });
});
