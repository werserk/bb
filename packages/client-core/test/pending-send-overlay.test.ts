import { PendingSendOverlay } from "../src/pending-send-overlay.js";
import { expect, it } from "vitest";
import type { TimelineUserConversationRow } from "@bb/server-contract";
import {
  mergeLoadedTimelineWithLatest,
  type LoadedTimelineState,
} from "../src/timeline/timeline-merge.js";
interface TimelineTestRowArgs {
  id: string;
  sequence: number;
  endSequence?: number;
  turnRequestStatus?: "accepted" | "pending" | "rejected";
}
function userRow(args: TimelineTestRowArgs): TimelineUserConversationRow {
  return {
    id: args.id,
    threadId: "thread-1",
    turnId: "turn-1",
    sourceSeqStart: args.sequence,
    sourceSeqEnd: args.endSequence ?? args.sequence,
    messageSeq: args.endSequence ?? args.sequence,
    startedAt: args.sequence,
    createdAt: args.sequence,
    kind: "conversation",
    role: "user",
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    text: args.id,
    mentions: [],
    attachments: null,
    turnRequest: {
      isGrouped: false,
      kind: "message",
      status: args.turnRequestStatus ?? "accepted",
    },
  };
}

it("keeps the owner send through an unrelated authoritative refresh", () => {
  const pending = userRow({ id: "optimistic-user-fixture", sequence: 0 });
  const canonical = userRow({ id: "canonical", sequence: 12 });
  const owner = new PendingSendOverlay();
  owner.begin({
    id: "one",
    threadId: "thread-1",
    row: pending,
    submissionIds: ["one"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  canonical.clientSubmissionIds = ["one"];
  const count = (
    rows:
      | TimelineUserConversationRow[]
      | import("@bb/server-contract").TimelineRow[],
  ) => owner.project("thread-1", rows, []).rows.length;
  let state: LoadedTimelineState = {
    rows: [],
    surfaceKey: "thread-1",
    latestWindowEndSequence: 10,
    olderCursor: null,
    historySnapshot: "same-history",
  };
  const counts = [count(state.rows)];
  state = mergeLoadedTimelineWithLatest({
    current: state,
    latestTimeline: {
      contextBoundarySeq: null,
      completedTurnDisplay: "collapse",
      activePromptMode: null,
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      pendingTodos: null,
      extensionStates: {},
      providerCommands: null,
      sessionOptions: null,
      modelFallback: null,
      tag: "test",
      rows: [],
      maxSeq: 11,
      timelinePage: {
        returnedSegmentCount: 1,
        historySnapshot: "same-history",
        olderCursor: null,
        olderRowsSourceSeqEnd: null,
      },
    },
    surfaceKey: "thread-1",
  });
  counts.push(count(state.rows));
  state = mergeLoadedTimelineWithLatest({
    current: state,
    latestTimeline: {
      contextBoundarySeq: null,
      completedTurnDisplay: "collapse",
      activePromptMode: null,
      activeThinking: null,
      activeWorkflows: [],
      activeBackgroundCommands: [],
      pendingTodos: null,
      extensionStates: {},
      providerCommands: null,
      sessionOptions: null,
      modelFallback: null,
      tag: "test",
      rows: [canonical],
      maxSeq: 12,
      timelinePage: {
        returnedSegmentCount: 1,
        historySnapshot: "same-history",
        olderCursor: null,
        olderRowsSourceSeqEnd: null,
      },
    },
    surfaceKey: "thread-1",
  });
  counts.push(count(state.rows));
  console.log("Owner bubble counts:", counts.join(" -> "));
  expect(counts).toEqual([1, 1, 1]);
});

it("requires both reads after a legacy receipt, including identical sends", () => {
  const owner = new PendingSendOverlay();
  for (const id of ["a", "b"])
    owner.begin({
      id,
      threadId: "thread-1",
      row: userRow({ id, sequence: 0 }),
      submissionIds: [id],
      queueIds: [],
      queueRows: [],
      state: "sending",
      sequence: 0,
    });
  const before = owner.startRead();
  owner.receipt("thread-1", "a", { ok: true, delivery: "sent" });
  owner.receipt("thread-1", "b", { ok: true, delivery: "sent" });
  owner.applyLegacyJointRead("thread-1", before);
  expect(owner.list()).toHaveLength(2);
  const after = owner.startRead();
  expect(owner.project("thread-1", [], []).rows).toHaveLength(2);
  owner.applyLegacyJointRead("thread-1", after);
  expect(owner.list()).toHaveLength(0);
});
it("keeps uncertain sends and isolates fork custody", () => {
  const owner = new PendingSendOverlay();
  const row = userRow({ id: "p", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row,
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  owner.fail("thread-1", "a", false, "offline");
  expect(owner.list()[0]?.state).toBe("unconfirmed");
  const fork = {
    ...row,
    id: "fork",
    threadId: "fork",
    clientSubmissionIds: ["a"],
  };
  expect(owner.project("thread-1", [fork], []).rows).toHaveLength(2);
  expect(owner.project("fork", [fork], []).rows).toHaveLength(1);
  owner.hide("thread-1", "a");
  expect(owner.list()).toHaveLength(0);
});
it("does not regress requested custody on a delayed queued receipt", () => {
  const owner = new PendingSendOverlay();
  const row = userRow({ id: "pending", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row,
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  owner.observe(
    "thread-1",
    [{ ...row, id: "canonical", sourceSeqEnd: 12, clientSubmissionIds: ["a"] }],
    [],
  );
  owner.receipt("thread-1", "a", {
    ok: true,
    delivery: "queued",
    queuedMessage: importQueue("q", ["a"]),
  });
  expect(owner.list()).toHaveLength(0);
  expect(
    owner.project(
      "thread-1",
      [{ ...row, id: "canonical", clientSubmissionIds: ["a"] }],
      [importQueue("q", ["a"])],
    ).rows,
  ).toHaveLength(1);
});
function importQueue(
  id: string,
  clientSubmissionIds: string[],
): import("@bb/domain").ThreadQueuedMessage {
  return {
    id,
    threadId: "thread-1",
    clientSubmissionIds,
    content: [{ type: "text", text: "same", mentions: [] }],
    origin: null,
    originPluginId: null,
    initiator: "user",
    senderThreadId: null,
    model: "test",
    reasoningLevel: "medium",
    permissionMode: "full",
    serviceTier: "default",
    groupWithNext: false,
    sendAt: null,
    state: "queued",
    waitingOn: { kind: "thread-busy" },
    failureReason: null,
    payload: { kind: "inline" },
    systemNotice: null,
    editable: true,
    createdAt: 1,
    updatedAt: 1,
  };
}
it("moves a grouped request into one deferred card and rejects an older absence snapshot", () => {
  const owner = new PendingSendOverlay();
  const row = userRow({ id: "pending", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row,
    submissionIds: ["a", "b"],
    queueIds: ["q"],
    queueRows: [],
    state: "sent",
    sequence: 10,
  });
  const snapshot: import("@bb/server-contract").QueueSnapshotResponse = {
    rows: [importQueue("deferred", ["a", "b"])],
    eventMaxSeq: 20,
    queuePresence: [{ id: "q", present: false }],
    coverage: "complete",
    placements: [
      {
        queueId: "q",
        submissionIds: ["a", "b"],
        state: "deferred",
        requestSequence: 20,
        requestId: "creq_0000000000",
        deferredToQueuedMessageId: "deferred",
      },
    ],
    diagnostics: { scannedRows: 2, scannedBytes: 100, elapsedMs: 1 },
  };
  owner.applySnapshot("thread-1", snapshot);
  const projection = owner.project("thread-1", [], []);
  expect(projection.rows).toHaveLength(0);
  expect(projection.queue).toHaveLength(1);
  expect(projection.queue[0]?.clientSubmissionIds).toEqual(["a", "b"]);
  owner.applySnapshot("thread-1", {
    ...snapshot,
    rows: [],
    eventMaxSeq: 15,
    placements: [{ queueId: "deferred", submissionIds: [], state: "removed" }],
  });
  expect(owner.project("thread-1", [], []).queue).toHaveLength(1);
});
it("canonical queue observation acknowledges a lost receipt without text matching", () => {
  const owner = new PendingSendOverlay();
  const row = userRow({ id: "pending", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row,
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "unconfirmed",
    sequence: 0,
  });
  const queue = importQueue("q", ["a"]);
  owner.observe("thread-1", [], [queue]);
  expect(owner.project("thread-1", [], [queue])).toEqual({
    rows: [],
    queue: [queue],
  });
  expect(owner.project("thread-1", [], []).queue).toEqual([queue]);
});
it("keeps distinct same-ID canonical executions visible outside replay retention", () => {
  const owner = new PendingSendOverlay();
  const rows = [1, 2].map((sequence) => ({
    ...userRow({ id: `canonical-${sequence}`, sequence }),
    clientSubmissionIds: ["a"],
  }));
  expect(owner.project("thread-1", rows, []).rows).toEqual(rows);
});
it("a late sent receipt cannot undo a newer deferral", () => {
  const owner = new PendingSendOverlay();
  const row = userRow({ id: "p", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row,
    submissionIds: ["a"],
    queueIds: ["q"],
    queueRows: [],
    state: "sent",
    sequence: 10,
  });
  owner.applySnapshot("thread-1", {
    rows: [importQueue("deferred", ["a"])],
    eventMaxSeq: 20,
    queuePresence: [],
    coverage: "complete",
    placements: [
      {
        queueId: "q",
        submissionIds: ["a"],
        state: "deferred",
        requestId: "creq_0000000000",
        requestSequence: 20,
        deferredToQueuedMessageId: "deferred",
      },
    ],
    diagnostics: { scannedRows: 2, scannedBytes: 1, elapsedMs: 1 },
  });
  owner.receipt("thread-1", "a", {
    ok: true,
    delivery: "sent",
    requested: { requestId: "creq_0000000000", sequence: 10 },
  });
  expect(owner.list()[0]?.state).toBe("queued");
  expect(owner.project("thread-1", [], []).queue).toHaveLength(1);
});
it("accepts a send-now requeue beyond an existing timeline watermark", () => {
  const owner = new PendingSendOverlay();
  const queue = importQueue("scheduled", []);
  owner.begin({
    id: "queue:scheduled",
    threadId: "thread-1",
    row: userRow({ id: "sending", sequence: 0 }),
    submissionIds: [],
    queueIds: [queue.id],
    queueRows: [queue],
    state: "sending",
    sequence: 0,
    afterSequence: 100,
  });
  owner.receipt("thread-1", "queue:scheduled", {
    ok: true,
    delivery: "queued",
    queuedMessage: queue,
  });
  expect(owner.project("thread-1", [], [queue])).toEqual({
    rows: [],
    queue: [queue],
  });
});
it("retains deferral and receipt fences across validated recovery", () => {
  const owner = new PendingSendOverlay();
  const id = crypto.randomUUID();
  const pending = {
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "p", sequence: 0 }),
    submissionIds: [id],
    queueIds: ["deferred"],
    queueRows: [importQueue("deferred", [id])],
    state: "queued" as const,
    sequence: 20,
    afterSequence: 1,
    deferredRequestId: "creq_0000000000",
    requestedRequestId: "creq_0000000000",
    legacyFence: 10,
  };
  const recovered = owner.parseRecovered(pending);
  expect(recovered).toEqual(pending);
  owner.begin(recovered!);
  owner.receipt("thread-1", "a", {
    ok: true,
    delivery: "sent",
    requested: { requestId: "creq_0000000000", sequence: 10 },
  });
  expect(owner.project("thread-1", [], []).queue).toHaveLength(1);
});
it("compacts content after every represented group reaches canonical timeline", () => {
  const owner = new PendingSendOverlay();
  const pending = userRow({ id: "p", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: pending,
    submissionIds: ["a", "b"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  const first = {
    ...userRow({ id: "first", sequence: 10 }),
    clientSubmissionIds: ["a"],
  };
  const second = {
    ...userRow({ id: "second", sequence: 10 }),
    clientSubmissionIds: ["b"],
  };
  owner.observe("thread-1", [first], []);
  expect(owner.list()).toHaveLength(1);
  owner.observe("thread-1", [first, second], []);
  expect(owner.list()).toHaveLength(0);
  owner.receipt("thread-1", "a", {
    ok: true,
    delivery: "queued",
    queuedMessage: importQueue("late", ["a", "b"]),
  });
  expect(owner.project("thread-1", [first, second], []).rows).toEqual([
    first,
    second,
  ]);
});
it("replaces a failed attempt atomically with a distinct retry identity", () => {
  const owner = new PendingSendOverlay();
  const pending = {
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "p", sequence: 0 }),
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "failed" as const,
    sequence: 0,
  };
  owner.begin(pending);
  const counts: number[] = [];
  owner.subscribe(() =>
    counts.push(owner.project("thread-1", [], []).rows.length),
  );
  expect(
    owner.replaceFailed("thread-1", "a", {
      ...pending,
      id: "b",
      row: { ...pending.row, id: "retry" },
      submissionIds: ["b"],
      state: "sending",
    }),
  ).toBe(true);
  expect(counts).toEqual([1]);
  expect(owner.list()[0]?.submissionIds).toEqual(["b"]);
});
it("journals visible references without agent-only inputs or retry request payloads", () => {
  const owner = new PendingSendOverlay(),
    queue = importQueue("q", []);
  queue.content.push({
    type: "text",
    text: "private context",
    mentions: [],
    visibility: "agent-only",
  });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "p", sequence: 0 }),
    submissionIds: [],
    queueIds: ["q"],
    queueRows: [queue],
    state: "queued",
    sequence: 0,
    request: { input: queue.content, mode: "auto" },
  });
  owner.list()[0]!.queueRows[0]!.content.push({
    type: "image",
    url: "data:image/png;base64,raw-attachment",
  });
  const bytes = JSON.stringify(owner.journalEntries());
  expect(bytes).not.toContain("raw-attachment");
  expect(bytes).not.toContain("private context");
  expect(bytes).not.toContain('"request"');
  expect(bytes).toContain("same");
  expect(queue.content).toHaveLength(3);
});
it("holds new legacy canonical pushes behind the same joint presentation fence", () => {
  const owner = new PendingSendOverlay();
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "local", sequence: 0 }),
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  owner.receipt(
    "thread-1",
    "a",
    { ok: true, delivery: "sent" },
    { maxSeq: 10, queueIds: [] },
  );
  const push = userRow({ id: "legacy-native", sequence: 11 });
  const deferred = importQueue("legacy-deferred", []);
  expect(
    owner.project("thread-1", [push], []).rows.map((row) => row.id),
  ).toEqual(["local"]);
  expect(owner.project("thread-1", [], [deferred])).toMatchObject({
    rows: [{ id: "local" }],
    queue: [],
  });
  owner.applyLegacyJointRead("thread-1", owner.startRead());
  expect(owner.project("thread-1", [push], []).rows).toEqual([push]);
});
it("rejects an absence read begun before a fresh queue receipt at the same event watermark", () => {
  const owner = new PendingSendOverlay();
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "p", sequence: 0 }),
    submissionIds: [],
    queueIds: ["q"],
    queueRows: [importQueue("q", [])],
    state: "queued",
    sequence: 0,
  });
  const started = owner.startRead();
  owner.receipt("thread-1", "a", {
    ok: true,
    delivery: "queued",
    queuedMessage: importQueue("q", []),
  });
  owner.applySnapshot(
    "thread-1",
    {
      rows: [],
      eventMaxSeq: 0,
      queuePresence: [{ id: "q", present: false }],
      coverage: "complete",
      placements: [{ queueId: "q", submissionIds: [], state: "removed" }],
      diagnostics: { scannedRows: 0, scannedBytes: 0, elapsedMs: 0 },
    },
    started,
  );
  expect(owner.project("thread-1", [], []).queue).toHaveLength(1);
});
it("hands an out-of-window requested queue placement to covered canonical history", () => {
  const owner = new PendingSendOverlay();
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "p", sequence: 0 }),
    submissionIds: [],
    queueIds: ["legacy"],
    queueRows: [importQueue("legacy", [])],
    state: "queued",
    sequence: 0,
  });
  const snapshot: import("@bb/server-contract").QueueSnapshotResponse = {
    rows: [],
    eventMaxSeq: 30,
    queuePresence: [{ id: "legacy", present: false }],
    coverage: "partial",
    placements: [
      {
        queueId: "legacy",
        submissionIds: [],
        state: "requested",
        requestId: "creq_0000000000",
        requestSequence: 20,
      },
    ],
    diagnostics: { scannedRows: 100, scannedBytes: 100, elapsedMs: 1 },
  };
  owner.applySnapshot("thread-1", snapshot, Infinity, 10);
  expect(owner.project("thread-1", [], []).rows).toHaveLength(1);
  owner.applySnapshot("thread-1", snapshot, Infinity, 30);
  expect(owner.list()).toHaveLength(0);
  expect(owner.project("thread-1", [], [])).toEqual({ rows: [], queue: [] });
});
it("keeps deferred queue custody when its stale requested row is still in the cache", () => {
  const owner = new PendingSendOverlay();
  const pending = userRow({ id: "local", sequence: 0 }),
    requestId = "creq_0000000000";
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: pending,
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "unconfirmed",
    sequence: 0,
  });
  const canonical = {
    ...userRow({ id: "canonical", sequence: 10 }),
    submissionRequestId: requestId,
    clientSubmissionIds: ["a"],
  };
  const deferred = importQueue("deferred", ["a"]);
  deferred.payload = { kind: "deferredSteer", sourceRequestId: requestId };
  owner.observe("thread-1", [canonical], [deferred]);
  expect(owner.project("thread-1", [canonical], [deferred])).toEqual({
    rows: [],
    queue: [deferred],
  });
  expect(owner.project("thread-1", [canonical], [])).toEqual({
    rows: [],
    queue: [deferred],
  });
  const next = {
    ...canonical,
    id: "next",
    sourceSeqEnd: 20,
    submissionRequestId: "creq_1111111111",
    sourceQueuedMessageIds: [deferred.id],
  };
  owner.observe("thread-1", [canonical, next], [deferred]);
  expect(owner.project("thread-1", [next], [deferred])).toEqual({
    rows: [next],
    queue: [],
  });
});
it("keeps a single owner copy through real delta, fallback, push and pagination merges", async () => {
  const { applyThreadTimelineDelta, computeThreadTimelineDelta } =
    await import("@bb/server-contract");
  const { prependOlderTimelineRows, recoverLoadedTimelineAfterStaleCursor } =
    await import("../src/timeline/timeline-merge.js");
  const owner = new PendingSendOverlay();
  const pending = userRow({ id: "pending", sequence: 0 });
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: pending,
    submissionIds: ["a"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  const base: import("@bb/server-contract").ThreadTimelineResponse = {
    contextBoundarySeq: null,
    completedTurnDisplay: "collapse",
    activePromptMode: null,
    activeThinking: null,
    activeWorkflows: [],
    activeBackgroundCommands: [],
    pendingTodos: null,
    extensionStates: {},
    providerCommands: null,
    sessionOptions: null,
    modelFallback: null,
    tag: "base",
    rows: [],
    maxSeq: 10,
    timelinePage: {
      returnedSegmentCount: 0,
      historySnapshot: "same-history",
      olderCursor: null,
      olderRowsSourceSeqEnd: null,
    },
  };
  let held = base,
    state: LoadedTimelineState = {
      rows: [],
      surfaceKey: "thread-1",
      latestWindowEndSequence: 10,
      olderCursor: null,
      historySnapshot: "same-history",
    };
  const assertOwner = () =>
    expect(
      owner
        .project("thread-1", state.rows, [])
        .rows.filter((row) => row.id === pending.id),
    ).toHaveLength(1);
  for (const kind of [
    "full",
    "delta",
    "fallback",
    "full-push",
    "delta-push",
    "page",
  ]) {
    const next = { ...held, maxSeq: held.maxSeq + 1, tag: kind };
    if (kind === "delta" || kind === "delta-push")
      held = applyThreadTimelineDelta(
        held,
        computeThreadTimelineDelta(held, next),
      )!;
    else held = next;
    state =
      kind === "fallback"
        ? recoverLoadedTimelineAfterStaleCursor({
            current: state,
            latestTimeline: held,
            surfaceKey: "thread-1",
          })
        : mergeLoadedTimelineWithLatest({
            current: state,
            latestTimeline: held,
            surfaceKey: "thread-1",
          });
    if (kind === "page")
      state = {
        ...state,
        rows: prependOlderTimelineRows({
          loadedRows: state.rows,
          olderRows: [userRow({ id: "older", sequence: 1 })],
        }),
      };
    assertOwner();
    expect(held.rows).toEqual([]);
  }
});
it("does not infer queue removal after the observed history watermark regresses", () => {
  const owner = new PendingSendOverlay(),
    queue = importQueue("legacy", []);
  owner.begin({
    id: "a",
    threadId: "thread-1",
    row: userRow({ id: "pending", sequence: 0 }),
    queueIds: [queue.id],
    submissionIds: [],
    queueRows: [queue],
    state: "queued",
    sequence: 0,
    afterSequence: 100,
  });
  owner.applySnapshot(
    "thread-1",
    {
      rows: [],
      eventMaxSeq: 0,
      coverage: "complete",
      queuePresence: [{ id: queue.id, present: false }],
      placements: [{ queueId: queue.id, submissionIds: [], state: "removed" }],
      diagnostics: { scannedRows: 0, scannedBytes: 0, elapsedMs: 0 },
    },
    owner.startRead(),
  );
  expect(owner.list("thread-1")).toHaveLength(1);
  expect(owner.list("thread-1")[0]?.state).toBe("unresolved");
  expect(owner.project("thread-1", [], []).rows).toHaveLength(1);
});

it("preserves empty and unchanged projection references and untouched turn children", () => {
  const owner = new PendingSendOverlay();
  const child = userRow({ id: "old", sequence: 1 });
  const rows: import("@bb/server-contract").TimelineRow[] = [
    {
      kind: "turn",
      id: "turn",
      threadId: "thread-1",
      turnId: "turn-1",
      sourceSeqStart: 1,
      sourceSeqEnd: 1,
      startedAt: 1,
      createdAt: 1,
      children: [child],
      status: "completed",
      summaryCount: 1,
      completedAt: 1,
    },
  ];
  const queue: import("@bb/domain").ThreadQueuedMessage[] = [];
  expect(owner.project("thread-1", rows, queue)).toEqual({ rows, queue });
  expect(owner.project("thread-1", rows, queue).rows).toBe(rows);
  expect(owner.project("thread-1", rows, queue).queue).toBe(queue);
  owner.begin({
    id: "pending",
    threadId: "thread-1",
    row: userRow({ id: "pending", sequence: 0 }),
    submissionIds: ["pending"],
    queueIds: [],
    queueRows: [],
    state: "sending",
    sequence: 0,
  });
  const projected = owner.project("thread-1", rows, queue);
  expect(projected.rows[0]).toBe(rows[0]);
  expect(projected.queue).toBe(queue);
  expect(owner.project("thread-1", rows, queue).rows).toBe(projected.rows);
  owner.hide("thread-1", "pending");
  expect(owner.project("thread-1", rows, queue).rows).toBe(rows);
});

it.each([10_000, 100_000])(
  "measures client projection with %s history rows",
  (size) => {
    const base = userRow({ id: "history", sequence: 1 });
    const rows = Array.from({ length: size }, (_, index) => ({
      ...base,
      id: `history-${index}`,
      sourceSeqEnd: index + 1,
    }));
    const queue: import("@bb/domain").ThreadQueuedMessage[] = [];
    const owner = new PendingSendOverlay();
    const measure = () => {
      const cold: number[] = [],
        warm: number[] = [];
      let result = owner.project("thread-1", rows, queue);
      for (let index = 0; index < 20; index++) {
        const input = [...rows];
        let start = performance.now();
        result = owner.project("thread-1", input, queue);
        cold.push(performance.now() - start);
        start = performance.now();
        owner.project("thread-1", input, queue);
        warm.push(performance.now() - start);
      }
      const stats = (values: number[]) => {
        values.sort((a, b) => a - b);
        return { p50: values[9], p95: values[18], max: values[19] };
      };
      return { cold: stats(cold), warm: stats(warm), result };
    };
    const empty = measure();
    queue.push(importQueue("unrelated", []));
    const emptyWithQueue = measure();
    queue.pop();
    owner.begin({
      id: "pending",
      threadId: "thread-1",
      row: userRow({ id: "pending", sequence: 0 }),
      submissionIds: ["pending"],
      queueIds: [],
      queueRows: [],
      state: "unconfirmed",
      sequence: 0,
    });
    const lingering = measure();
    console.log(
      "Client projection benchmark:",
      JSON.stringify({
        size,
        samples: 20,
        empty: { cold: empty.cold, warm: empty.warm },
        emptyWithQueue: {
          cold: emptyWithQueue.cold,
          warm: emptyWithQueue.warm,
        },
        lingering: { cold: lingering.cold, warm: lingering.warm },
      }),
    );
    expect(empty.result.rows[0]).toBe(rows[0]);
    expect(lingering.result.rows[0]).toBe(rows[0]);
    expect(lingering.result.rows).toHaveLength(size + 1);
  },
);

it("only clones the ancestry changed by deferral suppression", () => {
  const owner = new PendingSendOverlay();
  const hidden = {
    ...userRow({ id: "source", sequence: 2 }),
    submissionRequestId: "creq_0000000000",
  };
  const sibling: import("@bb/server-contract").TimelineRow = {
    id: "other-turn",
    kind: "turn",
    threadId: "thread-1",
    turnId: "turn-other",
    sourceSeqStart: 1,
    sourceSeqEnd: 1,
    startedAt: 1,
    createdAt: 1,
    children: [userRow({ id: "untouched", sequence: 1 })],
    status: "completed",
    summaryCount: 1,
    completedAt: 1,
  };
  const branch = { ...sibling, id: "branch", children: [hidden] };
  const rows = [branch, sibling],
    queue: import("@bb/domain").ThreadQueuedMessage[] = [];
  owner.begin({
    id: "pending",
    threadId: "thread-1",
    row: userRow({ id: "pending", sequence: 0 }),
    submissionIds: ["pending"],
    queueIds: [],
    queueRows: [],
    state: "unconfirmed",
    sequence: 0,
    deferredRequestId: "creq_0000000000",
  });
  const result = owner.project("thread-1", rows, queue);
  expect(result.rows[0]).not.toBe(branch);
  expect(result.rows[0]).toMatchObject({ children: [] });
  expect(result.rows[1]).toBe(sibling);
  expect(branch.children).toEqual([hidden]);
  expect(owner.project("thread-1", rows, queue)).toBe(result);
  owner.hide("thread-1", "pending");
  expect(owner.project("thread-1", rows, queue).rows).toBe(rows);
});

it("retires unresolved custody when the same receipt sequence arrives canonically", () => {
  const owner = new PendingSendOverlay();
  const row = userRow({ id: "pending", sequence: 0 });
  owner.begin({
    id: "one",
    threadId: "thread-1",
    row,
    submissionIds: ["one"],
    queueIds: [],
    queueRows: [],
    state: "sent",
    sequence: 12,
  });
  owner.readFailed("thread-1");
  const canonical = {
    ...userRow({ id: "canonical", sequence: 12 }),
    clientSubmissionIds: ["one"],
  };
  owner.observe("thread-1", [canonical], []);
  expect(owner.list()).toEqual([]);
  expect(owner.journalEntries()).toEqual([]);
});

it("measures observe over 100k rows with lingering custody", () => {
  const owner = new PendingSendOverlay();
  owner.begin({
    id: "one",
    threadId: "thread-1",
    row: userRow({ id: "pending", sequence: 0 }),
    submissionIds: ["one"],
    queueIds: [],
    queueRows: [],
    state: "failed",
    sequence: 0,
  });
  const rows = Array.from({ length: 100_000 }, (_, i) =>
    userRow({ id: `row-${i}`, sequence: i + 1 }),
  );
  const samples = Array.from({ length: 20 }, () => {
    const start = performance.now();
    owner.observe("thread-1", rows, []);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(
    "observe-100k-ms",
    JSON.stringify({ p50: samples[10], p95: samples[19], max: samples[19] }),
  );
  expect(owner.list()).toHaveLength(1);
});

it("repairs grouping when a settled queue member disappears with no remaining custody", () => {
  const owner = new PendingSendOverlay();
  const first = { ...importQueue("first", []), groupWithNext: true };
  const second = importQueue("second", ["one"]);
  owner.begin({
    id: "one",
    threadId: "thread-1",
    row: userRow({ id: "p", sequence: 0 }),
    submissionIds: ["one"],
    queueIds: ["second"],
    queueRows: [second],
    state: "sent",
    sequence: 12,
  });
  owner.observe(
    "thread-1",
    [{ ...userRow({ id: "c", sequence: 12 }), clientSubmissionIds: ["one"] }],
    [],
  );
  expect(owner.list()).toEqual([]);
  expect(owner.project("thread-1", [], [first, second]).queue).toEqual([
    { ...first, groupWithNext: false },
  ]);
});
