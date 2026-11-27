import { makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { BindingStore, type Binding } from "./bindings.js";
import { decideDispatch, READY_DEADLINE_MS, RELEASED_MESSAGE, safeDecide, WAIT_RECHECK_MS } from "./dispatch.js";

const ME = "account-workers";
const T0 = 1_000_000;

function ctx(originPluginId: string | null, providerId = "claude-code", createdAt = T0) {
  return makeMessageDispatchHookContext({
    thread: { id: "t1", originPluginId, createdAt },
    requestedExecution: { providerId, model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
  });
}

function binding(patch: Partial<Binding> = {}): Binding {
  const store = new BindingStore(new Database(":memory:"), () => T0);
  const created = store.create({
    id: "aw_0123456789abcdef",
    workerHostId: "w",
    scratchPath: "/s",
    workspaceHostId: "ws",
    workspaceHostName: "ws",
    root: "/r",
    instructions: [],
    profile: "claude",
  });
  return { ...created, threadId: "t1", ...patch };
}

describe("dispatch hold", () => {
  const cases: [string, ReturnType<typeof ctx>, Binding | null, number, string][] = [
    ["a foreign thread without a binding proceeds", ctx("other-plugin"), null, T0, "proceed"],
    ["a thread nobody created without a binding proceeds", ctx(null), null, T0, "proceed"],
    ["our thread waits for its binding", ctx(ME), null, T0 + 1, "wait"],
    ["our thread without a binding is refused after the deadline", ctx(ME), null, T0 + READY_DEADLINE_MS + 1, "reject"],
    ["a released binding is refused, whoever created the thread", ctx(null), binding({ releasedAt: T0 }), T0, "reject"],
    ["a provider the profile does not guard is refused (G8)", ctx(ME, "codex"), binding(), T0, "reject"],
    ["an unready binding waits", ctx(ME), binding({ ready: false }), T0 + 1, "wait"],
    ["a ready binding proceeds", ctx(ME), binding(), T0, "proceed"],
    ["a ready binding on a thread another plugin created proceeds", ctx("other-plugin"), binding(), T0, "proceed"],
  ];
  for (const [name, context, record, now, action] of cases) {
    it(name, () => {
      const verdict = decideDispatch(ME, context, record, now);
      expect(verdict.decision.action).toBe(action);
      expect(verdict.abandoned).toBeUndefined();
    });
  }

  it("waits ask core to re-ask shortly, and the released message says what to do", () => {
    expect(decideDispatch(ME, ctx(ME), null, T0)).toEqual({
      decision: { action: "wait", reason: "account-workers: waiting for the workspace binding", sendAt: T0 + WAIT_RECHECK_MS },
    });
    expect(decideDispatch(ME, ctx(ME), binding({ releasedAt: T0 }), T0).decision).toEqual({ action: "reject", message: RELEASED_MESSAGE });
  });

  it("an unready binding past the deadline is refused and handed back for stop and release", () => {
    const record = binding({ ready: false });
    const verdict = decideDispatch(ME, ctx(ME), record, T0 + READY_DEADLINE_MS + 1);
    expect(verdict.decision.action).toBe("reject");
    expect(verdict.abandoned).toBe(record);
  });

  it("never throws: a failed lookup holds our thread and lets a foreign one through", () => {
    const errors: unknown[] = [];
    const broken = () => {
      throw new Error("database locked");
    };
    expect(safeDecide(ME, ctx(ME), broken, T0, (e) => errors.push(e)).decision.action).toBe("wait");
    expect(safeDecide(ME, ctx("other-plugin"), broken, T0, (e) => errors.push(e)).decision.action).toBe("proceed");
    expect(errors).toHaveLength(2);
  });
});
