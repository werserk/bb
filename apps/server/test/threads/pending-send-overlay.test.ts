import { expect, it } from "vitest";
import {
  createQueuedThreadMessageInTransaction,
  getLatestThreadSequence,
  listQueuedThreadMessages,
  listStoredEventRows,
} from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import { readQueueSnapshot } from "../../src/services/threads/queue-snapshot.js";
import {
  assertSubmissionNotAdmitted,
  findRequestedSubmission,
  guardSubmission,
  submissionAdmissionFloor,
} from "../../src/services/threads/submission-admission.js";
import { appendThreadEventInTransaction } from "../../src/services/threads/thread-events.js";
import { withTestHarness } from "../helpers/test-app.js";
import {
  seedProjectWithSource,
  seedHostSession,
  seedThread,
  seedTurnStarted,
} from "../helpers/seed.js";

it("coalesces concurrent public submissions and rejects retained queue custody", async () => {
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "overlay-host" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      status: "idle",
    });
    const id = crypto.randomUUID();
    let calls = 0;
    let resolve!: () => void;
    const wait = new Promise<void>((r) => {
      resolve = r;
    });
    const send = async () => {
      calls++;
      await wait;
      return { ok: true as const, delivery: "sent" as const };
    };
    const first = guardSubmission(h.db, thread.id, id, { input: "same" }, send);
    const second = guardSubmission(
      h.db,
      thread.id,
      id,
      { input: "same" },
      send,
    );
    expect(first).toBe(second);
    expect(() =>
      guardSubmission(h.db, thread.id, id, { input: "different" }, send),
    ).toThrow("Conflicting");
    resolve();
    await first;
    expect(calls).toBe(1);
    h.db.transaction((tx) =>
      createQueuedThreadMessageInTransaction(tx, {
        threadId: thread.id,
        clientSubmissionId: id,
        content: [{ type: "text", text: "same", mentions: [] }],
        model: "test",
        reasoningLevel: "medium",
        permissionMode: "full",
        serviceTier: "default",
        sendAt: null,
        waitingOn: null,
        payload: { kind: "inline" },
        systemNotice: null,
      }),
    );
    expect(() => assertSubmissionNotAdmitted(h.db, thread.id, id)).toThrow(
      "already admitted",
    );
    const snapshot = readQueueSnapshot(h.db, thread.id, [`qsub_${id}`]);
    expect(snapshot.rows[0]?.clientSubmissionIds).toEqual([id]);
    expect(snapshot.queuePresence).toEqual([
      { id: `qsub_${id}`, present: true },
    ]);
    expect(listQueuedThreadMessages(h.db, thread.id)).toHaveLength(1);
  });
});
it("bounds an aged lookup and never infers removal from uncovered history", async () => {
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "overlay-aged" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      status: "idle",
    });
    h.db.transaction((tx) => {
      for (let i = 0; i < 2100; i++)
        appendThreadEventInTransaction(tx, {
          threadId: thread.id,
          type: "system/error",
          scope: threadScope(),
          data: { message: "fixture" },
        });
    });
    const before = getLatestThreadSequence(h.db, { threadId: thread.id });
    const snapshot = readQueueSnapshot(h.db, thread.id, ["legacy-unknown"]);
    expect(snapshot.eventMaxSeq).toBe(before);
    expect(snapshot.diagnostics.scannedRows).toBeLessThanOrEqual(2000);
    expect(snapshot.coverage).toBe("partial");
    expect(snapshot.placements[0]?.state).toBe("unresolved");
    expect(
      listStoredEventRows(h.db, {
        threadId: thread.id,
        limit: 1,
        order: "desc",
      })[0]?.sequence,
    ).toBe(before);
  });
});
it("measures bounded placements and fenced admission on aged histories", async () => {
  const { sql } = await import("drizzle-orm");
  const { appendFileSync } = await import("node:fs");
  const { createClientTurnRequestId } =
    await import("../../src/services/threads/thread-events.js");
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "overlay-benchmark" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    for (const count of [10000, 100000]) {
      const thread = seedThread(h.deps, {
        projectId: project.id,
        status: "idle",
      });
      h.db.run(
        sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${count}) INSERT INTO events(id,thread_id,scope_kind,sequence,type,data,created_at) SELECT ${thread.id}||'-aged-'||x,${thread.id},'thread',x,'system/error','{"message":"aged fixture"}',x FROM n`,
      );
      const samples = [];
      for (let i = 0; i < 20; i++) {
        const snapshot = readQueueSnapshot(
          h.db,
          thread.id,
          Array.from({ length: 200 }, (_, i) => `legacy-${i}`),
        );
        samples.push(snapshot.diagnostics);
        expect(
          snapshot.placements.every((row) => row.state === "unresolved"),
        ).toBe(true);
      }
      const id = crypto.randomUUID();
      h.db.transaction((tx) => {
        for (let i = 0; i < 1000; i++)
          appendThreadEventInTransaction(tx, {
            threadId: thread.id,
            type: "client/turn/requested",
            scope: threadScope(),
            data: {
              requestId: createClientTurnRequestId(),
              direction: "outbound",
              source: "tell",
              initiator: "user",
              senderThreadId: null,
              input: [
                { type: "text", text: "aged requested fixture", mentions: [] },
              ],
              target: { kind: "new-turn" },
              request: { method: "turn/start", params: {} },
              execution: {
                model: "test",
                serviceTier: "default",
                reasoningLevel: "medium",
                permissionMode: "full",
                source: "client/turn/requested",
              },
            },
          });
      });
      const floor = getLatestThreadSequence(h.db, { threadId: thread.id });
      const full: number[] = [],
        fenced: number[] = [],
        fullLocked: number[] = [],
        fullLockDuration: number[] = [],
        lock: number[] = [],
        fullScans: { scannedRows: number; scannedBytes: number }[] = [],
        fencedScans: { scannedRows: number; scannedBytes: number }[] = [];
      for (let i = 0; i < 20; i++) {
        let start = performance.now();
        fullScans.push(assertSubmissionNotAdmitted(h.db, thread.id, id));
        full.push(performance.now() - start);
        start = performance.now();
        h.db.transaction(
          (tx) => {
            const heldAt = performance.now();
            const scanned = assertSubmissionNotAdmitted(tx, thread.id, id);
            expect(scanned).toEqual({
              scannedRows: 0,
              scannedBytes: 0,
              parsedRows: 0,
            });
            fullLocked.push(performance.now() - heldAt);
          },
          { behavior: "immediate" },
        );
        fullLockDuration.push(performance.now() - start);
        h.db.transaction(
          (tx) => {
            const start = performance.now();
            fencedScans.push(
              assertSubmissionNotAdmitted(tx, thread.id, id, floor),
            );
            fenced.push(performance.now() - start);
          },
          { behavior: "immediate" },
        );
        start = performance.now();
        h.db.transaction(
          (tx) => {
            assertSubmissionNotAdmitted(tx, thread.id, id, floor);
          },
          { behavior: "immediate" },
        );
        lock.push(performance.now() - start);
      }
      const stats = (values: number[]) => {
        const sorted = [...values].sort((a, b) => a - b);
        return {
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          max: sorted.at(-1),
        };
      };
      const concurrentLock: number[] = [],
        concurrentScans: { scannedRows: number; scannedBytes: number }[] = [];
      const simultaneous = Array.from({ length: 16 }, () =>
        crypto.randomUUID(),
      );
      await Promise.all(
        simultaneous.map((submissionId) =>
          guardSubmission(
            h.db,
            thread.id,
            submissionId,
            { input: "simultaneous fixture" },
            async () => {
              h.db.transaction(
                (tx) => {
                  const heldAt = performance.now();
                  concurrentScans.push(
                    assertSubmissionNotAdmitted(
                      tx,
                      thread.id,
                      submissionId,
                      submissionAdmissionFloor(h.db, thread.id, submissionId),
                    ),
                  );
                  appendThreadEventInTransaction(tx, {
                    threadId: thread.id,
                    type: "client/turn/requested",
                    scope: threadScope(),
                    data: {
                      requestId: createClientTurnRequestId(),
                      direction: "outbound",
                      source: "tell",
                      initiator: "user",
                      senderThreadId: null,
                      input: [
                        {
                          type: "text",
                          text: "simultaneous fixture",
                          mentions: [],
                        },
                      ],
                      clientSubmissions: [
                        { id: submissionId, inputGroupIndex: 0 },
                      ],
                      target: { kind: "new-turn" },
                      request: { method: "turn/start", params: {} },
                      execution: {
                        model: "test",
                        serviceTier: "default",
                        reasoningLevel: "medium",
                        permissionMode: "full",
                        source: "client/turn/requested",
                      },
                    },
                  });
                  concurrentLock.push(performance.now() - heldAt);
                },
                { behavior: "immediate" },
              );
              return { ok: true, delivery: "sent" };
            },
          ),
        ),
      );
      for (const submissionId of simultaneous)
        expect(() =>
          assertSubmissionNotAdmitted(h.db, thread.id, submissionId),
        ).toThrow("already admitted");
      const report = {
        fixtureEvents: count,
        placements: {
          ...stats(samples.map((row) => row.elapsedMs)),
          maxRows: Math.max(...samples.map((row) => row.scannedRows)),
          maxBytes: Math.max(...samples.map((row) => row.scannedBytes)),
          maxOvershootMs: Math.max(
            0,
            ...samples.map((row) => row.elapsedMs - 100),
          ),
          unresolvedRate: 1,
        },
        admission1000Requests: {
          full: stats(full),
          fullWriteLockHold: stats(fullLocked),
          fullImmediateTransactionDuration: stats(fullLockDuration),
          fenced: stats(fenced),
          immediateTransactionDuration: stats(lock),
          fullRows: Math.max(...fullScans.map((scan) => scan.scannedRows)),
          fullBytes: Math.max(...fullScans.map((scan) => scan.scannedBytes)),
          fencedRows: Math.max(...fencedScans.map((scan) => scan.scannedRows)),
          fencedBytes: Math.max(
            ...fencedScans.map((scan) => scan.scannedBytes),
          ),
          concurrentAdmissions: {
            count: 16,
            writeLockHold: stats(concurrentLock),
            maxRows: Math.max(
              ...concurrentScans.map((scan) => scan.scannedRows),
            ),
            maxBytes: Math.max(
              ...concurrentScans.map((scan) => scan.scannedBytes),
            ),
          },
        },
      };
      if (process.env.BB_PENDING_SEND_BENCH_OUTPUT)
        appendFileSync(
          process.env.BB_PENDING_SEND_BENCH_OUTPUT,
          JSON.stringify(report) + "\n",
        );
      expect(report.placements.maxRows).toBeLessThanOrEqual(2000);
    }
  });
}, 60000);
it("resolves a legacy queue through deferral and a later request, never the stale source", async () => {
  const { createClientTurnRequestId } =
    await import("../../src/services/threads/thread-events.js");
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "lineage-host" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      status: "idle",
    });
    const first = createClientTurnRequestId(),
      second = createClientTurnRequestId();
    const data = (
      requestId: typeof first,
      queue: string,
    ): import("@bb/domain").TurnRequestEventData => ({
      requestId,
      direction: "outbound",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "legacy", mentions: [] }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "test",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
      sourceQueuedMessageIds: [queue],
    });
    h.db.transaction((tx) => {
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: data(first, "legacy"),
      });
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/rejected",
        scope: threadScope(),
        data: {
          requestId: first,
          reason: "busy",
          message: "busy",
          deferredToQueuedMessageId: "deferred",
        },
      });
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: { ...data(second, "deferred"), deferredFromRequestId: first },
      });
    });
    expect(
      readQueueSnapshot(h.db, thread.id, ["legacy"]).placements[0],
    ).toMatchObject({ state: "requested", requestId: second });
  });
});
it("preserves forked request JSON without consuming source-thread custody", async () => {
  const { copyForkSourceHistory } =
    await import("../../src/services/threads/thread-fork-history.js");
  const { createClientTurnRequestId } =
    await import("../../src/services/threads/thread-events.js");
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "fork-overlay" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const source = seedThread(h.deps, {
        projectId: project.id,
        status: "idle",
      }),
      fork = seedThread(h.deps, { projectId: project.id, status: "idle" });
    const id = crypto.randomUUID();
    const data: import("@bb/domain").TurnRequestEventData = {
      requestId: createClientTurnRequestId(),
      direction: "outbound",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text: "source custody", mentions: [] }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      clientSubmissions: [{ id, inputGroupIndex: 0 }],
      sourceQueuedMessageIds: [`qsub_${id}`],
      execution: {
        model: "test",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    };
    h.db.transaction((tx) =>
      appendThreadEventInTransaction(tx, {
        threadId: source.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data,
      }),
    );
    seedTurnStarted(h.deps, {
      threadId: source.id,
      turnId: "fork-turn",
      providerThreadId: "fork-provider",
    });
    h.db.transaction((tx) =>
      appendThreadEventInTransaction(tx, {
        threadId: source.id,
        type: "turn/input/accepted",
        scope: turnScope("fork-turn"),
        data: {
          clientRequestId: data.requestId,
          providerThreadId: "fork-provider",
        },
      }),
    );
    const before = listStoredEventRows(h.db, {
      threadId: source.id,
      order: "asc",
      limit: 100,
    });
    copyForkSourceHistory(h.deps, {
      fork,
      sourceThreadId: source.id,
      historyEndSequence: getLatestThreadSequence(h.db, {
        threadId: source.id,
      }),
    });
    expect(
      listStoredEventRows(h.db, {
        threadId: source.id,
        order: "asc",
        limit: 100,
      }),
    ).toEqual(before);
    const copied = listStoredEventRows(h.db, {
      threadId: fork.id,
      order: "asc",
      limit: 100,
    }).find((row) => row.type === "client/turn/requested");
    expect(copied?.data).toBe(
      before.find((row) => row.type === "client/turn/requested")?.data,
    );
  });
});
it("rebases multiple deferred and retry groups without assigning IDs to legacy groups", async () => {
  const { queuedSubmissionMembership, queuedInputGroups } =
    await import("../../src/services/threads/submission-membership.js");
  const { createClientTurnRequestId } =
    await import("../../src/services/threads/thread-events.js");
  const { makeThreadQueuedMessage } =
    await import("@bb/test-helpers/domain-fixtures");
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "multi-membership" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      status: "idle",
    });
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const requestId = createClientTurnRequestId();
    const group = [{ type: "text" as const, text: "same", mentions: [] }];
    h.db.transaction((tx) =>
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          requestId,
          direction: "outbound",
          source: "tell",
          initiator: "user",
          senderThreadId: null,
          input: group,
          inputGroups: [group, group, group],
          clientSubmissions: [
            { id: ids[0]!, inputGroupIndex: 0 },
            { id: ids[1]!, inputGroupIndex: 2 },
          ],
          target: { kind: "new-turn" },
          request: { method: "turn/start", params: {} },
          execution: {
            model: "test",
            serviceTier: "default",
            reasoningLevel: "medium",
            permissionMode: "full",
            source: "client/turn/requested",
          },
        },
      }),
    );
    const rows = [
      makeThreadQueuedMessage({ id: "legacy", threadId: thread.id }),
      makeThreadQueuedMessage({
        id: "deferred",
        threadId: thread.id,
        payload: { kind: "deferredSteer", sourceRequestId: requestId },
      }),
      makeThreadQueuedMessage({
        id: "retry",
        content: [group, group, group]
          .flat()
          .map((input) => ({ ...input, visibility: "agent-only" as const })),
        threadId: thread.id,
        payload: {
          kind: "retry",
          retryOfTurnRequestId: requestId,
          attempt: 2,
          reason: "manual retry",
        },
      }),
      makeThreadQueuedMessage({
        id: `qsub_${ids[2]}`,
        threadId: thread.id,
        clientSubmissionIds: [ids[2]!],
      }),
    ];
    expect(queuedInputGroups(h.db, rows)).toHaveLength(8);
    expect(
      queuedInputGroups(h.db, [rows[2]!])
        .flat()
        .every((input) => input.visibility === "agent-only"),
    ).toBe(true);
    const continuation = {
      ...rows[2]!,
      content: [
        {
          type: "text" as const,
          text: "Please continue.",
          mentions: [],
          visibility: "agent-only" as const,
        },
      ],
    };
    expect(queuedInputGroups(h.db, [continuation])).toEqual([
      continuation.content,
    ]);
    expect(queuedSubmissionMembership(h.db, [continuation])).toEqual(
      ids.slice(0, 2).map((id) => ({ id, inputGroupIndex: 0 })),
    );

    expect(queuedSubmissionMembership(h.db, rows)).toEqual([
      { id: ids[0], inputGroupIndex: 1 },
      { id: ids[1], inputGroupIndex: 3 },
      { id: ids[0], inputGroupIndex: 4 },
      { id: ids[1], inputGroupIndex: 6 },
      { id: ids[2], inputGroupIndex: 7 },
    ]);
  });
});
it("rechecks a competing admission after the pre-check sequence under the write lock", async () => {
  const { createClientTurnRequestId } =
    await import("../../src/services/threads/thread-events.js");
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "competing-admission" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      status: "idle",
    });
    const id = crypto.randomUUID();
    let appended = 0;
    await expect(
      guardSubmission(h.db, thread.id, id, { input: "owner" }, async () => {
        h.db.transaction((tx) => {
          appendThreadEventInTransaction(tx, {
            threadId: thread.id,
            type: "client/turn/requested",
            scope: threadScope(),
            data: {
              requestId: createClientTurnRequestId(),
              direction: "outbound",
              source: "tell",
              initiator: "user",
              senderThreadId: null,
              input: [
                { type: "text", text: "competing ingress", mentions: [] },
              ],
              clientSubmissions: [{ id, inputGroupIndex: 0 }],
              target: { kind: "new-turn" },
              request: { method: "turn/start", params: {} },
              execution: {
                model: "test",
                serviceTier: "default",
                reasoningLevel: "medium",
                permissionMode: "full",
                source: "client/turn/requested",
              },
            },
          });
          appended++;
        });
        h.db.transaction(
          (tx) => {
            assertSubmissionNotAdmitted(
              tx,
              thread.id,
              id,
              submissionAdmissionFloor(h.db, thread.id, id),
            );
            appended++;
          },
          { behavior: "immediate" },
        );
        return { ok: true, delivery: "sent" };
      }),
    ).rejects.toMatchObject({
      status: 409,
      body: { code: "submission_already_admitted" },
    });
    expect(appended).toBe(1);
  });
});
it("prefilters requested events by the raw submission id with the same admission answer", async () => {
  const { sql } = await import("drizzle-orm");
  const { createClientTurnRequestId } =
    await import("../../src/services/threads/thread-events.js");
  await withTestHarness(async (h) => {
    const { host } = seedHostSession(h.deps, { id: "prefilter-host" });
    const { project } = seedProjectWithSource(h.deps, {
      hostId: host.id,
      path: "/fixture",
    });
    const thread = seedThread(h.deps, {
      projectId: project.id,
      status: "idle",
    });
    const requested = (
      text: string,
      clientSubmissions?: { id: string; inputGroupIndex: number }[],
    ): import("@bb/domain").TurnRequestEventData => ({
      requestId: createClientTurnRequestId(),
      ...(clientSubmissions ? { clientSubmissions } : {}),
      direction: "outbound",
      source: "tell",
      initiator: "user",
      senderThreadId: null,
      input: [{ type: "text", text, mentions: [] }],
      target: { kind: "new-turn" },
      request: { method: "turn/start", params: {} },
      execution: {
        model: "test",
        serviceTier: "default",
        reasoningLevel: "medium",
        permissionMode: "full",
        source: "client/turn/requested",
      },
    });
    const admitted = crypto.randomUUID(),
      mentioned = crypto.randomUUID(),
      escaped = crypto.randomUUID(),
      absent = crypto.randomUUID();
    h.db.transaction((tx) => {
      for (let i = 0; i < 50; i++)
        appendThreadEventInTransaction(tx, {
          threadId: thread.id,
          type: "client/turn/requested",
          scope: threadScope(),
          data: requested(`unrelated ${i}`, [
            { id: crypto.randomUUID(), inputGroupIndex: 0 },
          ]),
        });
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: requested("admitted", [{ id: admitted, inputGroupIndex: 0 }]),
      });
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: requested(`the text names ${mentioned} without admitting it`),
      });
    });
    const sequence = getLatestThreadSequence(h.db, { threadId: thread.id }) + 1;
    const raw = JSON.stringify(
      requested("escaped", [{ id: escaped, inputGroupIndex: 0 }]),
    ).replace(escaped, `${escaped.slice(0, 8)}\\u002d${escaped.slice(9)}`);
    expect(raw).not.toContain(escaped);
    h.db.run(
      sql`INSERT INTO events(id,thread_id,scope_kind,sequence,type,data,created_at) VALUES (${`${thread.id}-escaped`},${thread.id},'thread',${sequence},'client/turn/requested',${raw},${sequence})`,
    );
    const rows = listStoredEventRows(h.db, {
      threadId: thread.id,
      types: ["client/turn/requested"],
      limit: 1000,
      order: "desc",
    });
    expect(rows.length).toBe(53);
    const answer = (id: string) => {
      try {
        return assertSubmissionNotAdmitted(h.db, thread.id, id);
      } catch (error) {
        return (error as { body?: { code?: string } }).body?.code;
      }
    };
    expect(answer(admitted)).toBe("submission_already_admitted");
    expect(
      rows.filter((row) => row.data.includes(admitted)).map((row) => row.id),
    ).toHaveLength(1);
    expect(answer(escaped)).toMatchObject({ scannedRows: 0 });
    expect(answer(mentioned)).toMatchObject({ scannedRows: 1, parsedRows: 1 });
    expect(answer(absent)).toMatchObject({ scannedRows: 0, parsedRows: 0 });
    h.db.transaction((tx) => {
      for (let i = 0; i < 997; i++)
        appendThreadEventInTransaction(tx, {
          threadId: thread.id,
          type: "client/turn/requested",
          scope: threadScope(),
          data: requested(`newer ${i}`),
        });
    });
    expect(
      findRequestedSubmission(h.db, thread.id, admitted).requested,
    ).toBeDefined();
    h.db.transaction((tx) =>
      appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        type: "client/turn/requested",
        scope: threadScope(),
        data: requested("one more"),
      }),
    );
    expect(
      findRequestedSubmission(h.db, thread.id, admitted).requested,
    ).toBeUndefined();
    expect(answer(admitted)).toMatchObject({ scannedRows: 0 });
  });
});
