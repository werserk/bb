import { appendStoredThreadEventInTransaction } from "../src/data/events.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  canonicalJsonBytes,
  sha256Digest,
  turnRequestEventDataSchema,
  threadScope,
  clientSubmissionQueueId,
  type TurnRequestEventData,
} from "@bb/domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as S from "../src/index.js";
import {
  threads,
  placementEffects,
  queuedThreadMessages as queue,
  events,
} from "../src/schema.js";
import {
  setupPlacement,
  candidate,
  fixtureAuthority,
  observation,
  workspace,
} from "./helpers/placement.js";
import {
  appendFixture,
  claimFixture,
  fixtureExecution,
  fixtureCommand,
} from "./helpers/placement-dispatch.js";

let db: S.DbConnection, other: S.DbConnection, dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "placement-first-"));
  const path = join(dir, "scratch.db");
  db = S.createConnection(path);
  S.migrate(db);
  setupPlacement(db);
  other = S.createConnection(path);
});
afterEach(() => {
  db.$client.close();
  other.$client.close();
  rmSync(dir, { force: true, recursive: true });
});
function firstFixture(sendAt: number | null, timeWait = sendAt !== null) {
  const input = [{ type: "text" as const, text: "fixture", mentions: [] }];
  const environment = { type: "reuse" as const, environmentId: "env" };
  const request = {
    projectId: "project",
    providerId: "claude",
    environment,
    input,
    origin: "app",
    ...(sendAt === null ? {} : { sendAt }),
  };
  const a = S.acceptPlacementOperation(db, {
    principalScope: "owner",
    authority: fixtureAuthority,
    providerId: "claude",
    ownerPluginId: "workers",
    submissionKey: "first",
    request: {
      schemaVersion: 1,
      intent: { kind: "independent", selection: { mode: "auto" }, request },
    },
  });
  if (a.kind !== "accepted") throw Error("accept");
  const id = a.operation.id;
  const p = S.preparePlacementOperation(db, {
    operationId: id,
    expectedRevision: a.operation.revision,
    preparedRequest: request,
    preparedExecution: fixtureExecution,
    workspace,
    attachmentReceipts: [],
  });
  if (p.kind !== "prepared") throw Error("prepare");
  const r = S.reservePlacementWorker(db, candidate(db, id));
  if (r.kind !== "reserved") throw Error("reserve");
  const uuid = S.readPlacementActionReceipt(db, id)!.submissionUuid!;
  const qid = clientSubmissionQueueId(uuid);
  const threadId = db.transaction(
    (tx) => {
      const b = S.attachPlacementThread(tx, {
        operationId: id,
        fence: r.fence,
        runtimeRootKey: "fixture-root",
        sourceProviderThreadId: null,
        sourceCheckpoint: null,
        insertThread: (write, threadId) =>
          S.insertThreadInTransaction(write, threadId, {
            providerId: "claude",
            projectId: "project",
            environmentId: "env",
            status: "pending",
            startupContext: JSON.stringify({
              kind: "pending",
              environmentIntent: environment,
              fork: null,
              startedOnBehalfOf: null,
              titleProvided: false,
              execution: fixtureExecution,
            }),
          }),
        onCommitted: () => {},
      });
      if (b.kind !== "attached" || !b.operation.threadId) throw Error("attach");
      const threadId = b.operation.threadId;
      const queued = S.recordPlacementQueueReceipt(tx, {
        operationId: id,
        fence: r.fence,
        queuedMessageId: qid,
        insertQueue: (write, identity) => {
          S.createQueuedThreadMessageInTransaction(write, {
            placement: identity,
            clientSubmissionId: uuid,
            threadId,
            content: input,
            ...fixtureExecution,
            senderThreadId: null,
            origin: null,
            originPluginId: null,
            requestedBy: null,
            systemNotice: null,
            sendAt,
            waitingOn: timeWait ? { kind: "time" } : null,
            payload: { kind: "inline" },
          });
        },
        onCommitted: () => {},
      });
      if (queued.kind !== "recorded") throw Error("queue");
      return threadId;
    },
    { behavior: "immediate" },
  );
  const explicit = {
    queueId: qid,
    principal: fixtureAuthority.principal,
    actor: fixtureAuthority.actor,
  };
  return { id, qid, threadId, explicit };
}
const nativeFirst: Partial<TurnRequestEventData> = {
  source: "spawn",
  target: { kind: "thread-start" },
  request: { method: "thread/start", params: {} },
};
const requestId = "creq_2222222222";
it.each([
  "early",
  "timer",
  "scope",
  "actor",
  "selection",
  "cleared",
  "earlier",
  "method",
] as const)(
  "scopes the first scheduled send and rolls back disallowed %s",
  (mode) => {
    const when = Date.now() + 600_000;
    const { id, qid, explicit } = firstFixture(when);
    if (mode === "cleared" || mode === "earlier")
      db.update(queue)
        .set({
          state: mode === "cleared" ? "queued" : "scheduled",
          sendAt: mode === "cleared" ? null : when - 300_000,
          waitingOn:
            mode === "cleared" ? null : JSON.stringify({ kind: "time" }),
        })
        .where(eq(queue.id, qid))
        .run();
    const claims = claimFixture(db, qid);
    const write = () =>
      db.transaction(
        (tx) =>
          appendFixture(
            tx,
            id,
            claims,
            requestId,
            mode === "method" ? {} : nativeFirst,
            1,
            mode === "timer"
              ? undefined
              : {
                  ...explicit,
                  principal: mode === "scope" ? "other" : explicit.principal,
                  actor: mode === "actor" ? "plugin" : explicit.actor,
                  queueId: mode === "selection" ? "other" : qid,
                },
          ),
        { behavior: "immediate" },
      );
    if (mode === "early") {
      expect(write().receipt.members[0]?.op).toBe(id);
      expect(other.select().from(queue).all()).toHaveLength(0);
    } else {
      expect(write).toThrow(S.PlacementDispatchConflictError);
      expect(other.select().from(placementEffects).all()).toHaveLength(0);
      expect(other.select().from(events).all()).toHaveLength(0);
      expect(S.getQueuedThreadMessage(other, qid)?.claimToken).toBe(
        claims[0]!.claimToken,
      );
    }
  },
);
it.each(["due", "future", "cleared"] as const)(
  "checks %s follower schedule against retained first group",
  (mode) => {
    const when = Date.now() + 600_000;
    const { id, qid, explicit, threadId } = firstFixture(when);
    const sendAt = mode === "due" ? Date.now() - 1000 : when + 1000;
    const request = { input: "follower", sendAt };
    const a = S.acceptPlacementOperation(db, {
      principalScope: "owner",
      authority: fixtureAuthority,
      ownerPluginId: "workers",
      providerId: "claude",
      submissionKey: "f",
      request: {
        schemaVersion: 1,
        intent: { kind: "continuation", threadId, request },
      },
    });
    if (a.kind !== "accepted") throw Error("accept follower");
    const f = a.operation.id;
    expect(
      S.preparePlacementOperation(db, {
        operationId: f,
        expectedRevision: a.operation.revision,
        workspace,
        preparedRequest: request,
        preparedExecution: fixtureExecution,
        attachmentReceipts: [],
      }).kind,
    ).toBe("prepared");
    const uuid = S.readPlacementActionReceipt(db, f)!.submissionUuid!;
    const second = clientSubmissionQueueId(uuid);
    db.transaction((tx) =>
      S.recordPlacementQueueReceipt(tx, {
        operationId: f,
        fence: 1,
        queuedMessageId: second,
        insertQueue: (w, i) => {
          S.createQueuedThreadMessageInTransaction(w, {
            placement: i,
            clientSubmissionId: uuid,
            threadId,
            ...fixtureExecution,
            content: [{ type: "text", text: "follower", mentions: [] }],
            senderThreadId: null,
            origin: null,
            originPluginId: null,
            requestedBy: null,
            systemNotice: null,
            sendAt: mode === "cleared" ? null : sendAt,
            waitingOn: mode === "cleared" ? null : { kind: "time" },
            payload: { kind: "inline" },
          });
        },
        onCommitted: () => {},
      }),
    );
    db.update(queue)
      .set({ sortKey: "A", groupWithNext: true })
      .where(eq(queue.id, qid))
      .run();
    db.update(queue).set({ sortKey: "B" }).where(eq(queue.id, second)).run();
    const claimed = claimFixture(db, qid);
    expect(claimed.length).toBe(2);
    const write = () =>
      db.transaction(
        (tx) =>
          appendFixture(tx, id, claimed, requestId, nativeFirst, 1, explicit),
        { behavior: "immediate" },
      );
    if (mode === "due")
      expect(write().receipt.members.map((m) => m.op)).toEqual([id, f]);
    else {
      expect(write).toThrow(S.PlacementDispatchConflictError);
      expect(other.select().from(events).all()).toHaveLength(0);
      expect(S.getQueuedThreadMessage(other, second)?.sendAt).toBe(
        mode === "future" ? sendAt : null,
      );
    }
  },
);
it.each([
  { offset: -1, timeWait: true, early: false, allowed: true },

  { offset: 0, timeWait: true, early: false, allowed: true },
  { offset: 1, timeWait: true, early: false, allowed: false },

  { offset: 1, timeWait: true, early: true, allowed: true },
])(
  "applies the trusted admission clock to offset $offset, timeWait=$timeWait, explicit=$early",
  ({ offset, timeWait, early, allowed }) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const { id, qid, explicit } = firstFixture(now + offset, timeWait);
      expect(S.getQueuedThreadMessage(db, qid)?.sendAt).toBe(now + offset);
      const claims = claimFixture(db, qid);
      const commit = () =>
        db.transaction((tx) =>
          appendFixture(
            tx,
            id,
            claims,
            requestId,
            nativeFirst,
            1,
            early ? explicit : undefined,
          ),
        );
      if (allowed) expect(commit().receipt.request).toBe(requestId);
      else expect(commit).toThrow(S.PlacementDispatchConflictError);
    } finally {
      clock.mockRestore();
    }
  },
);

it.each([-1, 0, 1])(
  "native insertion preserves the SQL time marker for every non-null schedule (%i)",
  (offset) => {
    const now = Date.now();
    expect(() => firstFixture(now + offset, false)).toThrow(
      /queued_thread_messages_schedule_check/,
    );
    expect(db.select().from(queue).all()).toHaveLength(0);
    expect(db.select().from(threads).all()).toHaveLength(0);
  },
);
it.each([
  "valid",
  "missing",
  "event",
  "context",
  "provider",
  "started",
  "status",
  "archive",
  "input",
  "new-digest",
  "partial",
  "stripped",
  "manifest",
  "profile",
  "generation",
  "session",
  "root",
  "rotate",
  "throw",
  "thenable",
] as const)(
  "revalidates committed cold-start facts before a standalone send claim (%s)",
  (mode) => {
    const { id, qid, threadId, explicit } = firstFixture(null);
    const claimed = claimFixture(db, qid);
    const { guard, receipt } = db.transaction(
      (tx) =>
        appendFixture(tx, id, claimed, requestId, nativeFirst, 1, explicit),
      { behavior: "immediate" },
    );
    const command = {
      ...guard,
      ...fixtureCommand,
      currentAgentSessionId: fixtureCommand.agentSessionId,
    };
    expect(S.preparePlacementExecutionCommand(db, command).kind).toBe(
      "prepared",
    );
    const readBody = () =>
      turnRequestEventDataSchema.parse(
        JSON.parse(
          other
            .select()
            .from(events)
            .where(eq(events.id, receipt.eventId))
            .get()!.data,
        ),
      );
    const readDigest = () => sha256Digest(canonicalJsonBytes(readBody()));
    const expectedDigest = readDigest();
    const expectedManifest = {
      launchProfileId: "fixture",
      runtimeRootKey: "fixture-root",
      agentSessionId: fixtureCommand.agentSessionId,
    };
    const registry = { current: { ...expectedManifest } };
    const pinned = registry.current;
    const proof: S.PlacementFirstStartClaim = {
      eventId: receipt.eventId,
      requestDigest: expectedDigest,
      readCurrentManifest: () => {
        if (mode === "throw") throw Error("fixture registry unavailable");
        if (mode === "thenable")
          return Object.assign(Promise.resolve(), expectedManifest);
        return registry.current === pinned ? registry.current : null;
      },
    };
    if (mode === "rotate") registry.current = { ...pinned };
    if (mode === "session")
      registry.current.agentSessionId = "new-registration";
    if (mode === "root") registry.current.runtimeRootKey = "another-root";
    if (mode === "manifest")
      registry.current.launchProfileId = "different-profile";
    if (mode === "event") proof.eventId = "another-event";
    if (mode === "archive")
      other
        .update(threads)
        .set({ archivedAt: 1 })
        .where(eq(threads.id, threadId))
        .run();
    if (mode === "status")
      other
        .update(threads)
        .set({ status: "idle" })
        .where(eq(threads.id, threadId))
        .run();
    if (mode === "context") {
      const context = JSON.parse(S.getThreadStartupContext(other, threadId)!);
      other
        .update(threads)
        .set({
          startupContext: JSON.stringify({ ...context, providerInput: [] }),
        })
        .where(eq(threads.id, threadId))
        .run();
    }
    if (
      mode === "input" ||
      mode === "new-digest" ||
      mode === "partial" ||
      mode === "stripped"
    ) {
      const body = readBody();
      if (mode === "partial") body.request.method = "turn/start";
      else if (mode === "stripped") {
        body.request.method = "turn/start";
        body.target = { kind: "auto", expectedTurnId: null };
        body.source = "tell";
        other
          .update(threads)
          .set({ status: "idle", startupContext: null })
          .where(eq(threads.id, threadId))
          .run();
      } else {
        body.input = [{ type: "text", text: "changed", mentions: [] }];
        body.inputGroups = [body.input];
      }
      other
        .update(events)
        .set({ data: JSON.stringify(body) })
        .where(eq(events.id, receipt.eventId))
        .run();
      if (mode === "new-digest" || mode === "partial")
        proof.requestDigest = readDigest();
    }
    if (mode === "profile" || mode === "generation") {
      const w = observation({
        revision: 2,
        launchProfileId: mode === "profile" ? null : "fixture",
      });
      if (mode === "generation") {
        w.generation = "next";
        w.custody.generation = "next";
        w.routes[0]!.agent.generation = "next";
      }
      expect(
        S.observePlacementWorkers(other, {
          ownerPluginId: "workers",
          providerId: "claude",
          expectedOwnerRevision: 2,
          workers: [w],
        }).kind,
      ).toBe("observed");
    }
    if (mode === "started" || mode === "provider")
      other.transaction((tx) =>
        appendStoredThreadEventInTransaction(tx, {
          threadId,
          scope: threadScope(),
          type: "client/thread/start",
          providerThreadId: mode === "provider" ? "fixture-provider" : null,
          data: {
            direction: "outbound",
            source: "spawn",
            initiator: "user",
            request: { method: "thread/start", params: {} },
          },
        }),
      );
    const args =
      mode === "missing" || mode === "stripped"
        ? command
        : { ...command, firstStart: proof };
    const first = S.claimPlacementExecutionCommand(db, args);
    let simulatedTransport = 0;
    if (first.kind === "won") simulatedTransport++;
    expect(simulatedTransport).toBe(mode === "valid" ? 1 : 0);
    expect(S.readPlacementDispatchReceipt(other, guard)?.state).toBe(
      mode === "valid" ? "possibly_sent" : "prepared",
    );
    if (mode === "valid") {
      db.$client.close();
      db = S.createConnection(join(dir, "scratch.db"));
      expect(S.claimPlacementExecutionCommand(db, args).kind).toBe("held");
    }
  },
);
