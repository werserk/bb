import { expect, it, vi } from "vitest";
import { createMigratedConnection } from "../../src/testing.js";
import { listPlanHistoryEventRows, getLatestCompletedThreadContextClearSequence } from "../../src/data/events.js";

it("reuses bounded plan read statements across threads, bounds and transactions", () => {
  const db = createMigratedConnection();
  try {
    const read = (threadId: string, boundary: number) => {
      expect(listPlanHistoryEventRows(db, {threadId, boundary, limit: 32})).toEqual([]);
      expect(listPlanHistoryEventRows(db, {threadId, boundary, atOrBeforeSequence: 10, limit: 1})).toEqual([]);
      expect(getLatestCompletedThreadContextClearSequence(db, {threadId})).toBeNull();
      expect(getLatestCompletedThreadContextClearSequence(db, {threadId, atOrBeforeSequence: 10})).toBeNull();
    };
    read("absent-a", 0);
    const select = vi.spyOn(db, "select");
    try {
      db.transaction(() => read("absent-b", 5));
      db.transaction(() => read("absent-a", 0));
      expect(select).not.toHaveBeenCalled();
    } finally { select.mockRestore(); }
  } finally { db.$client.close(); }
});

it("preserves thread isolation, inclusive bounds, ordering and fresh transactional reads", async () => {
  const { upsertHost } = await import("../../src/data/hosts.js");
  const { createProject } = await import("../../src/data/projects.js");
  const { createThread } = await import("../../src/data/threads.js");
  const { insertEvents } = await import("../../src/data/events.js");
  const { noopNotifier } = await import("../../src/notifier.js");
  const { threadScope, THREAD_CONTEXT_CLEAR_OPERATION } = await import("@bb/domain");
  const db = createMigratedConnection();
  try {
    const host = upsertHost(db, noopNotifier, {name: "test"});
    const {project} = createProject(db, noopNotifier, {name: "test", source: {type: "local_path", hostId: host.id, path: "/tmp/prepared-plans"}});
    const a = createThread(db, noopNotifier, {projectId: project.id, providerId: "codex"});
    const b = createThread(db, noopNotifier, {projectId: project.id, providerId: "codex"});
    const plan = (threadId: string, sequence: number) => insertEvents(db, noopNotifier, [{threadId, sequence, type: "turn/plan/updated", scope: threadScope(), itemId: null, itemKind: null, parentToolCallId: null, data: "{}"}]);
    const clear = (sequence: number) => insertEvents(db, noopNotifier, [{threadId: a.id, sequence, type: "system/operation", scope: threadScope(), itemId: null, itemKind: null, parentToolCallId: null, data: JSON.stringify({operation: THREAD_CONTEXT_CLEAR_OPERATION, status: "completed"})}]);
    const read = (threadId: string, boundary: number, atOrBeforeSequence?: number, limit = 32) => listPlanHistoryEventRows(db, {threadId, boundary, atOrBeforeSequence, limit}).map(r => r.sequence);
    plan(a.id, 1); plan(a.id, 3); plan(a.id, 5); plan(b.id, 2); clear(4); clear(6);
    expect(read(a.id, 0, undefined, 2)).toEqual([5, 3]);
    expect(read(a.id, 3, 3)).toEqual([3]);
    expect(read(b.id, 0)).toEqual([2]);
    expect(read(a.id, 0, 4)).toEqual([3, 1]);
    expect(getLatestCompletedThreadContextClearSequence(db, {threadId: a.id})).toBe(6);
    expect(getLatestCompletedThreadContextClearSequence(db, {threadId: a.id, atOrBeforeSequence: 4})).toBe(4);
    expect(getLatestCompletedThreadContextClearSequence(db, {threadId: b.id})).toBeNull();
    expect(() => db.transaction(() => { plan(a.id, 7); clear(8); expect(read(a.id, 0)[0]).toBe(7); expect(getLatestCompletedThreadContextClearSequence(db, {threadId: a.id})).toBe(8); throw new Error("rollback"); })).toThrow("rollback");
    expect(read(a.id, 0)[0]).toBe(5);
    expect(getLatestCompletedThreadContextClearSequence(db, {threadId: a.id})).toBe(6);
    plan(a.id, 7);
    expect(read(a.id, 0)[0]).toBe(7);
  } finally { db.$client.close(); }
});
