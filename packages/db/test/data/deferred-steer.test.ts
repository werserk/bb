import { threadScope } from "@bb/domain";
import { insertEvents } from "../../src/data/events.js";
import { expect, it } from "vitest";
import { createMigratedConnection } from "../../src/testing.js";
import { noopNotifier } from "../../src/notifier.js";
import { createProject } from "../../src/data/projects.js";
import { createThread } from "../../src/data/threads.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  createQueuedThreadMessage,
  hasQueuedRetryOfTurnRequest,
  parseStoredQueuedMessagePayload,
  setQueuedThreadMessageGroupBoundary,
  deleteQueuedRetriesForThreadEventSuffixInTransaction,
  listQueuedThreadMessages,
} from "../../src/data/queued-thread-messages.js";

it("stores deferred source without retry semantics and rejects malformed stored shapes", () => {
  const db = createMigratedConnection();
  try {
    const host = upsertHost(db, noopNotifier, { name: "host" });
    const { project } = createProject(db, noopNotifier, {
      name: "project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/deferred" },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });
    const sourceRequestId = "creq_2345678933";
    const row = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: [{ type: "text", text: "owner input", mentions: [] }],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "deferredSteer", sourceRequestId },
      systemNotice: null,
    });
    expect(row.retryOfTurnRequestId).toBe(sourceRequestId);
    expect(row.retryAttempt).toBeNull();
    expect(row.retryReason).toBeNull();
    expect(parseStoredQueuedMessagePayload(row)).toEqual({
      kind: "deferredSteer",
      sourceRequestId,
    });
    expect(
      hasQueuedRetryOfTurnRequest(db, {
        threadId: thread.id,
        retryOfTurnRequestId: sourceRequestId,
      }),
    ).toBe(false);
    expect(() =>
      parseStoredQueuedMessagePayload({ ...row, retryOfTurnRequestId: null }),
    ).toThrow();
    expect(() =>
      parseStoredQueuedMessagePayload({ ...row, retryAttempt: 2 }),
    ).toThrow();
    expect(() =>
      parseStoredQueuedMessagePayload({ ...row, payloadKind: "retry" }),
    ).toThrow();
    expect(() =>
      parseStoredQueuedMessagePayload({ ...row, payloadKind: "inline" }),
    ).toThrow();
    const inline = createQueuedThreadMessage(db, noopNotifier, {
      threadId: thread.id,
      content: [{ type: "text", text: "next", mentions: [] }],
      model: "gpt-5",
      reasoningLevel: "medium",
      permissionMode: "full",
      serviceTier: "default",
      waitingOn: null,
      sendAt: null,
      payload: { kind: "inline" },
      systemNotice: null,
    });
    const grouped = setQueuedThreadMessageGroupBoundary({
      db,
      notifier: noopNotifier,
      threadId: thread.id,
      expectedGroupedPrefixQueuedMessageIds: [row.id, inline.id],
      groupBoundaryQueuedMessageId: inline.id,
    });
    expect(grouped.kind).not.toBe("updated");
    insertEvents(db, noopNotifier, [
      {
        threadId: thread.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        itemId: null,
        itemKind: null,
        parentToolCallId: null,
        data: JSON.stringify({ requestId: sourceRequestId }),
      },
    ]);
    const deleted = db.transaction((tx) =>
      deleteQueuedRetriesForThreadEventSuffixInTransaction(tx, {
        threadId: thread.id,
        cutoffSequence: 1,
        oldMaxSequence: 1,
      }),
    );
    expect(deleted).toBe(1);
    expect(
      listQueuedThreadMessages(db, thread.id).map((entry) => entry.id),
    ).toEqual([inline.id]);
  } finally {
    db.$client.close();
  }
});
