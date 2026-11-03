import { afterEach, describe, expect, it } from "vitest";
import {
  appendStoredThreadEvent,
  createEnvironment,
  createProject,
  createThread,
  getThread,
  noopNotifier,
  upsertHost,
  type DbConnection,
} from "@bb/db";
import { createMigratedConnection } from "@bb/db/testing";
import {
  formatClientTurnRequestIdSuffix,
  threadScope,
  turnScope,
  type ThreadEvent,
  type ThreadTurnInitiator,
} from "@bb/domain";
import { applyTurnCompletedEvent } from "../../src/internal/turn-completed-events.js";
import { setPluginThreadEventEmitter } from "../../src/services/plugins/plugin-thread-events.js";
import type { PluginThreadEventEmitter } from "../../src/services/plugins/plugin-service.js";
import {
  resetThreadAttentionPolicies,
  setThreadAttentionPolicy,
} from "../../src/services/threads/thread-attention-policy.js";
import { NotificationHub } from "../../src/ws/hub.js";
import { createTestProviderRegistry } from "../helpers/provider-registry.js";
import { testLogger } from "../helpers/test-app.js";

const providerRegistry = await createTestProviderRegistry();
const PLUGIN_ID = "attention-plugin";

interface Setup {
  db: DbConnection;
  deps: Parameters<typeof applyTurnCompletedEvent>[0];
  threadId: string;
}

function setup(): Setup {
  const db = createMigratedConnection();
  const host = upsertHost(db, noopNotifier, { id: "host-bg", name: "Host" });
  const { project } = createProject(db, noopNotifier, {
    name: "Background attention",
    source: { type: "local_path", hostId: host.id, path: "/tmp/bg" },
  });
  const environment = createEnvironment(db, noopNotifier, {
    providerOwnsPath: false,
    hostId: host.id,
    projectId: project.id,
    path: "/tmp/bg/env",
    status: "ready",
  });
  const thread = createThread(db, noopNotifier, {
    projectId: project.id,
    environmentId: environment.id,
    providerId: "codex",
    status: "active",
  });
  return {
    db,
    deps: {
      db,
      hub: new NotificationHub(),
      logger: testLogger,
      providerRegistry,
    },
    threadId: thread.id,
  };
}

function requestEvent(
  db: DbConnection,
  args: {
    initiator: ThreadTurnInitiator;
    suffix: string;
    target: { kind: "new-turn" } | { kind: "steer"; expectedTurnId: string };
    threadId: string;
  },
): string {
  const requestId = formatClientTurnRequestIdSuffix({ suffix: args.suffix });
  appendStoredThreadEvent(db, noopNotifier, {
    threadId: args.threadId,
    scope: threadScope(),
    type: "client/turn/requested",
    data: {
      direction: "outbound",
      source: "tell",
      initiator: args.initiator,
      senderThreadId: args.initiator === "agent" ? "thr_child" : null,
      requestId,
      input: [{ type: "text", text: "go", mentions: [] }],
      target: args.target,
      request: { method: "turn/start", params: {} },
      execution: {
        model: "gpt-5",
        reasoningLevel: "medium",
        permissionMode: "workspace-write",
        source: "client/turn/requested",
        serviceTier: "default",
      },
    },
  });
  return requestId;
}

function acceptInput(
  db: DbConnection,
  args: { requestId: string; threadId: string; turnId: string },
): void {
  appendStoredThreadEvent(db, noopNotifier, {
    threadId: args.threadId,
    scope: turnScope(args.turnId),
    providerThreadId: "provider-bg",
    type: "turn/input/accepted",
    data: { providerThreadId: "provider-bg", clientRequestId: args.requestId },
  });
}

/** A root turn that a request with the given initiator started. */
function seedRootTurn(
  db: DbConnection,
  args: {
    initiator: ThreadTurnInitiator;
    suffix: string;
    threadId: string;
    turnId: string;
  },
): void {
  const requestId = requestEvent(db, {
    ...args,
    target: { kind: "new-turn" },
  });
  appendStoredThreadEvent(db, noopNotifier, {
    threadId: args.threadId,
    scope: turnScope(args.turnId),
    providerThreadId: "provider-bg",
    type: "turn/started",
    data: { providerThreadId: "provider-bg" },
  });
  acceptInput(db, { requestId, threadId: args.threadId, turnId: args.turnId });
}

/** A steer of the given initiator that the running turn accepted. */
function seedSteer(
  db: DbConnection,
  args: {
    initiator: ThreadTurnInitiator;
    suffix: string;
    threadId: string;
    turnId: string;
  },
): void {
  const requestId = requestEvent(db, {
    ...args,
    target: { kind: "steer", expectedTurnId: args.turnId },
  });
  acceptInput(db, { requestId, threadId: args.threadId, turnId: args.turnId });
}

function completeTurn(
  s: Setup,
  turnId: string,
  status: Extract<
    ThreadEvent,
    { type: "turn/completed" }
  >["status"] = "completed",
): void {
  applyTurnCompletedEvent(s.deps, {
    type: "turn/completed",
    threadId: s.threadId,
    providerThreadId: "provider-bg",
    scope: turnScope(turnId),
    status,
  });
}

function attentionAt(s: Setup): number {
  return getThread(s.db, s.threadId)?.latestAttentionAt ?? -1;
}

function silence(s: Setup): void {
  setThreadAttentionPolicy({
    pluginId: PLUGIN_ID,
    policy: { backgroundTurns: "silent" },
    threadId: s.threadId,
  });
}

afterEach(() => {
  resetThreadAttentionPolicies();
  setPluginThreadEventEmitter(undefined);
});

describe("silent background-turn attention", () => {
  it("raises attention for a user-started turn on a silent thread", () => {
    const s = setup();
    silence(s);
    const before = attentionAt(s);
    seedRootTurn(s.db, {
      initiator: "user",
      suffix: "aaaaaaaaaa",
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1");
    expect(getThread(s.db, s.threadId)?.status).toBe("idle");
    expect(attentionAt(s)).toBeGreaterThan(before);
  });

  it.each(["agent", "system"] as const)(
    "leaves attention alone for a %s-started turn on a silent thread",
    (initiator) => {
      const s = setup();
      silence(s);
      const before = attentionAt(s);
      seedRootTurn(s.db, {
        initiator,
        suffix: "bbbbbbbbbb",
        threadId: s.threadId,
        turnId: "t1",
      });
      completeTurn(s, "t1");
      expect(getThread(s.db, s.threadId)?.status).toBe("idle");
      expect(attentionAt(s)).toBe(before);
    },
  );

  it("still raises attention when the background turn fails", () => {
    const s = setup();
    silence(s);
    const before = attentionAt(s);
    seedRootTurn(s.db, {
      initiator: "agent",
      suffix: "cccccccccc",
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1", "failed");
    expect(getThread(s.db, s.threadId)?.status).toBe("error");
    expect(attentionAt(s)).toBeGreaterThan(before);
  });

  it("raises attention when no policy is set (stock behaviour)", () => {
    const s = setup();
    const before = attentionAt(s);
    seedRootTurn(s.db, {
      initiator: "agent",
      suffix: "dddddddddd",
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1");
    expect(attentionAt(s)).toBeGreaterThan(before);
  });

  it("raises attention after the policy is cleared or the plugin unloads", () => {
    const s = setup();
    silence(s);
    setThreadAttentionPolicy({
      pluginId: PLUGIN_ID,
      policy: null,
      threadId: s.threadId,
    });
    const before = attentionAt(s);
    seedRootTurn(s.db, {
      initiator: "agent",
      suffix: "eeeeeeeeee",
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1");
    expect(attentionAt(s)).toBeGreaterThan(before);
  });

  it("raises attention when the turn's request cannot be found (server restarted before the plugin re-asserted, or unreadable)", () => {
    const s = setup();
    resetThreadAttentionPolicies();
    const before = attentionAt(s);
    appendStoredThreadEvent(s.db, noopNotifier, {
      threadId: s.threadId,
      scope: turnScope("t1"),
      providerThreadId: "provider-bg",
      type: "turn/started",
      data: { providerThreadId: "provider-bg" },
    });
    completeTurn(s, "t1");
    expect(attentionAt(s)).toBeGreaterThan(before);

    const t = setup();
    silence(t);
    const beforeT = attentionAt(t);
    appendStoredThreadEvent(t.db, noopNotifier, {
      threadId: t.threadId,
      scope: turnScope("t2"),
      providerThreadId: "provider-bg",
      type: "turn/started",
      data: { providerThreadId: "provider-bg" },
    });
    completeTurn(t, "t2");
    expect(attentionAt(t)).toBeGreaterThan(beforeT);
  });

  it.each(["agent", "system"] as const)(
    "keeps attention for an owner turn that a %s steer joined",
    (initiator) => {
      const s = setup();
      silence(s);
      const before = attentionAt(s);
      seedRootTurn(s.db, {
        initiator: "user",
        suffix: "hhhhhhhhhh",
        threadId: s.threadId,
        turnId: "t1",
      });
      seedSteer(s.db, {
        initiator,
        suffix: "iiiiiiiiii",
        threadId: s.threadId,
        turnId: "t1",
      });
      completeTurn(s, "t1");
      expect(attentionAt(s)).toBeGreaterThan(before);
    },
  );

  it.each(["agent", "system"] as const)(
    "keeps attention for a %s turn that the owner steered",
    (initiator) => {
      const s = setup();
      silence(s);
      const before = attentionAt(s);
      seedRootTurn(s.db, {
        initiator,
        suffix: "jjjjjjjjjj",
        threadId: s.threadId,
        turnId: "t1",
      });
      seedSteer(s.db, {
        initiator: "user",
        suffix: "kkkkkkkkkk",
        threadId: s.threadId,
        turnId: "t1",
      });
      completeTurn(s, "t1");
      expect(attentionAt(s)).toBeGreaterThan(before);
    },
  );

  it("stays silent for a background turn that only background steers joined", () => {
    const s = setup();
    silence(s);
    const before = attentionAt(s);
    seedRootTurn(s.db, {
      initiator: "system",
      suffix: "pppppppppp",
      threadId: s.threadId,
      turnId: "t1",
    });
    seedSteer(s.db, {
      initiator: "agent",
      suffix: "mmmmmmmmmm",
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1");
    expect(attentionAt(s)).toBe(before);
  });

  it("raises attention when an accepted steer's request cannot be found", () => {
    const s = setup();
    silence(s);
    const before = attentionAt(s);
    seedRootTurn(s.db, {
      initiator: "system",
      suffix: "nnnnnnnnnn",
      threadId: s.threadId,
      turnId: "t1",
    });
    acceptInput(s.db, {
      requestId: formatClientTurnRequestIdSuffix({ suffix: "qqqqqqqqqq" }),
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1");
    expect(attentionAt(s)).toBeGreaterThan(before);
  });

  it("tells plugins the idle event skipped attention", () => {
    const idleCalls: Array<{ attentionSkipped?: boolean } | undefined> = [];
    const emitter = new Proxy({} as PluginThreadEventEmitter, {
      get: (_target, name) =>
        name === "emitThreadIdle"
          ? (_thread: unknown, options?: { attentionSkipped?: boolean }) => {
              idleCalls.push(options);
            }
          : () => {},
    });
    setPluginThreadEventEmitter(emitter);
    const s = setup();
    silence(s);
    seedRootTurn(s.db, {
      initiator: "agent",
      suffix: "ffffffffff",
      threadId: s.threadId,
      turnId: "t1",
    });
    completeTurn(s, "t1");
    expect(idleCalls).toEqual([{ attentionSkipped: true }]);

    const u = setup();
    seedRootTurn(u.db, {
      initiator: "user",
      suffix: "gggggggggg",
      threadId: u.threadId,
      turnId: "t1",
    });
    completeTurn(u, "t1");
    expect(idleCalls.at(-1)).toEqual({ attentionSkipped: false });
  });
});
