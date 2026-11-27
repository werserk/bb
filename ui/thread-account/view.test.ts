import { describe, expect, it } from "vitest";
import {
  aAtLimit,
  accountList,
  entry,
  getState,
  limitEvent,
  named,
  T0,
} from "./fixtures.js";
import { confirmParts, needsNewSession, pickerRows, setInputFor, setResultNote } from "./pick.js";
import {
  formatReset,
  isLimitCurrent,
  nextTimerAt,
  threadAccountView,
  type ThreadAccountGet,
  type ThreadAccountList,
} from "./view.js";

const HOUR = 3600_000;

function view(get: ThreadAccountGet | null, accounts: ThreadAccountList | null = accountList(), extra: { error?: object | null; dismissedId?: number | null; now?: number } = {}) {
  return threadAccountView({
    get,
    accounts,
    error: extra.error ?? null,
    dismissedId: extra.dismissedId ?? null,
    now: extra.now ?? T0,
  });
}

describe("state mapping (test 1)", () => {
  it.each([
    ["loading", null, null, "Account", "Spinner"],
    ["offline", null, { code: "transport_error", message: "x" }, "Pool offline", "CloudOff"],
    ["offline", null, { code: "unknown_method", message: "x" }, "Pool offline", "CloudOff"],
    ["offline", null, { code: "handler_error", status: 503, message: "x" }, "Pool offline", "CloudOff"],
    ["error", null, { code: "handler_error", message: "boom" }, "Account unknown", "AlertTriangle"],
  ] as const)("%s from the rpc state", (state, get, error, label, icon) => {
    const result = view(get, null, { error });
    expect(result).toMatchObject({ state, label, icon, canPick: false });
  });

  it("hides for an unpooled provider", () => {
    expect(view(getState({ provider: null })).state).toBe("hidden");
  });

  it("machine token for a grandfathered auto thread, whatever it served", () => {
    const result = view(getState({ route: "machine-token", grandfathered: true }));
    expect(result).toMatchObject({ state: "machine-token", label: "Machine token", icon: "ComputerCloud", tone: "muted" });
    expect(result.details).toContain("machine's pool token");
  });

  it("route wins over grandfathered: a grandfathered thread on its own pass is not S3", () => {
    expect(view(getState({ route: "pass", grandfathered: true })).state).toBe("auto");
  });

  it("not routed when the last turn got no central routing", () => {
    expect(view(getState({ route: "none" }))).toMatchObject({ state: "not-routed", label: "Not routed" });
  });

  it("an unknown route reads as none", () => {
    const get = getState({ route: "future" as unknown as "none" });
    expect(view(get).state).toBe("not-routed");
  });

  it("auto with nothing served yet", () => {
    expect(view(getState({ route: "none", serving: null }))).toMatchObject({ state: "auto-idle", label: "Auto", tone: "muted" });
    expect(view(getState({ serving: null })).state).toBe("auto-idle");
  });

  it("auto served by an account", () => {
    expect(view(getState())).toMatchObject({ state: "auto", label: "Auto · Work B", icon: "Layers", dot: false });
  });

  it("named, on the machine token, says when the pin applies", () => {
    const result = view(getState({ policy: named(), route: "machine-token", grandfathered: true }));
    expect(result).toMatchObject({ state: "named", label: "Work A", icon: "Pin" });
    expect(result.details).toContain("next turn on its own pass");
  });

  it("named states with a current limit", () => {
    const stopped = view(
      getState({ policy: named("acc_a", "Work A", "stop"), updatedAt: T0 - HOUR, lastLimit: limitEvent({ action: "stopped" }) }),
      aAtLimit(T0 + HOUR),
    );
    expect(stopped).toMatchObject({ state: "named-stopped", label: "Work A · stopped", icon: "Pause", tone: "destructive" });
    expect(stopped.details).toContain("Stopped until");
    const onAuto = view(
      getState({ policy: named(), updatedAt: T0 - HOUR, lastLimit: limitEvent({ cause: "unavailable", action: "served-auto" }) }),
      { ...accountList(), accounts: [entry({ accountId: "acc_a", accountLabel: "Work A", usable: false, reason: "unavailable" })] },
    );
    expect(onAuto).toMatchObject({ state: "named-on-auto", label: "Work A · on Auto", tone: "warning" });
  });

  it("auto after a fallback shows the dot", () => {
    const result = view(getState({ updatedAt: T0 - 5 * 60_000, lastLimit: limitEvent() }), aAtLimit());
    expect(result).toMatchObject({ state: "auto-fallback", label: "Auto · Work B", dot: true });
    expect(result.limit?.title).toBe("Work A hit its limit");
  });
});

describe("limit is current (test 2)", () => {
  const stoppedGet = (patch: Partial<ThreadAccountGet> = {}) =>
    getState({ policy: named("acc_a", "Work A", "stop"), updatedAt: T0 - HOUR, lastLimit: limitEvent({ action: "stopped" }), ...patch });

  it("needs a limit event", () => {
    expect(isLimitCurrent(getState(), accountList(), null, T0)).toBe(false);
  });

  it("a later policy write resolves it", () => {
    expect(isLimitCurrent(stoppedGet({ updatedAt: T0 }), aAtLimit(), null, T0)).toBe(false);
    expect(isLimitCurrent(stoppedGet(), aAtLimit(), null, T0)).toBe(true);
  });

  it("the fallback's own policy write (same clock, before the event) keeps it current", () => {
    const limit = limitEvent();
    expect(isLimitCurrent(getState({ updatedAt: limit.at, lastLimit: limit }), aAtLimit(), null, T0)).toBe(true);
  });

  it("a local dismissal of that event resolves it", () => {
    expect(isLimitCurrent(stoppedGet(), aAtLimit(), 7, T0)).toBe(false);
    expect(isLimitCurrent(stoppedGet(), aAtLimit(), 6, T0)).toBe(true);
  });

  it("stopped resolves once the account is usable again, not by serving.since", () => {
    expect(isLimitCurrent(stoppedGet(), accountList(), null, T0)).toBe(false);
    // Mutation guard: a stopped thread is never served, so serving.since
    // must not be what resolves it.
    const served = stoppedGet({ serving: { accountId: "acc_a", accountLabel: "Work A", provider: "claude", since: T0 } });
    expect(isLimitCurrent(served, aAtLimit(), null, T0)).toBe(true);
  });

  it("stopped stays current while accounts are not loaded, or the account is gone", () => {
    expect(isLimitCurrent(stoppedGet(), null, null, T0)).toBe(true);
    expect(isLimitCurrent(stoppedGet({ lastLimit: limitEvent({ action: "stopped", cause: "deleted" }) }), { ...accountList(), accounts: [] }, null, T0)).toBe(true);
  });

  it("served-auto resolves when the account serves again after the event", () => {
    const get = getState({ policy: named(), updatedAt: T0 - HOUR, lastLimit: limitEvent({ cause: "unavailable", action: "served-auto" }) });
    const unavailable = { ...accountList(), accounts: [entry({ accountId: "acc_a", usable: false, reason: "unavailable" as const })] };
    expect(isLimitCurrent(get, unavailable, null, T0)).toBe(true);
    const back = { ...get, serving: { accountId: "acc_a", accountLabel: "Work A", provider: "claude" as const, since: T0 } };
    expect(isLimitCurrent(back, unavailable, null, T0)).toBe(false);
  });

  it("fell-back resolves when the account is usable or after 24 h", () => {
    const get = getState({ updatedAt: T0 - 5 * 60_000, lastLimit: limitEvent() });
    expect(isLimitCurrent(get, aAtLimit(), null, T0)).toBe(true);
    expect(isLimitCurrent(get, accountList(), null, T0)).toBe(false);
    expect(isLimitCurrent(get, aAtLimit(), null, T0 + 24 * HOUR)).toBe(false);
  });

  it("a limit for another policy shape is not current", () => {
    expect(isLimitCurrent(getState({ lastLimit: limitEvent({ action: "stopped" }) }), aAtLimit(), null, T0)).toBe(false);
    expect(isLimitCurrent(getState({ policy: named(), lastLimit: limitEvent() }), aAtLimit(), null, T0)).toBe(false);
  });
});

describe("reset timer (test 3)", () => {
  it("is the account's reset when in the future", () => {
    const get = getState({ policy: named("acc_a", "Work A", "stop"), lastLimit: limitEvent({ action: "stopped" }) });
    expect(nextTimerAt(get, aAtLimit(T0 + HOUR), T0)).toBe(T0 + HOUR);
    expect(nextTimerAt(get, aAtLimit(T0 - 1), T0)).toBeNull();
    expect(nextTimerAt(get, aAtLimit(null), T0)).toBeNull();
    expect(nextTimerAt(getState(), aAtLimit(), T0)).toBeNull();
  });
});

describe("unknown enums and labels (test 4)", () => {
  it("an unknown limit action gives no card and no limit state", () => {
    const get = getState({ policy: named(), updatedAt: T0 - HOUR, lastLimit: limitEvent({ action: "future" as unknown as "stopped" }) });
    const result = view(get, aAtLimit());
    expect(result.state).toBe("named");
    expect(result.limit).toBeNull();
  });

  it("a null label reads Removed account, never the raw id", () => {
    const result = view(getState({ policy: named("acc_a", null), serving: null }));
    expect(result.label).toBe("Removed account");
    expect(JSON.stringify(result)).not.toContain("acc_a");
    const served = view(getState({ serving: { accountId: "acc_q", accountLabel: null, provider: "claude", since: T0 } }));
    expect(served.label).toBe("Auto · Removed account");
  });

  it("an unknown policy mode is shown neutrally and never written (N3)", () => {
    const get = getState({ policy: { mode: "future" } as unknown as ThreadAccountGet["policy"] });
    const result = view(get);
    expect(result).toMatchObject({ state: "policy-unknown", label: "Account policy unknown", canPick: false });
    expect(setInputFor(get, { kind: "auto" }, false)).toBeNull();
    expect(setInputFor(get, { kind: "named", accountId: "acc_a", accountLabel: "Work A" }, false)).toBeNull();
  });

  it("an unknown cause reads 'could not serve' (N4)", () => {
    const get = getState({ policy: named("acc_a", "Work A", "stop"), updatedAt: T0 - HOUR, lastLimit: limitEvent({ cause: "future" as unknown as "limit", action: "stopped" }) });
    const result = view(get, aAtLimit());
    expect(result.limit?.title).toBe("Work A could not serve: stopped");
    expect(result.details).toContain("which could not serve");
  });

  it("the pinned details state the on-limit rule in a sentence (N5)", () => {
    expect(view(getState({ policy: named("acc_a", "Work A", "stop") })).details).toBe("Pinned to Work A. At its limit it stops until reset.");
  });

  it("an unknown refusal gives the pool's message", () => {
    expect(setResultNote({ ok: false, reason: "future" as unknown as "not-idle", message: "Nope." })).toBe("Nope.");
  });
});

describe("formatReset (test 5)", () => {
  it("formats local time, weekday beyond 24 h, and unknown", () => {
    const at = new Date(2026, 10, 27, 14, 20).getTime();
    expect(formatReset(at, at - HOUR)).toBe("14:20");
    expect(formatReset(at, at - 25 * HOUR)).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) 14:20$/u);
    expect(formatReset(null, T0)).toBe("its reset");
  });
});

describe("set inputs (test 6)", () => {
  it("sends nothing when the target is the current policy", () => {
    expect(setInputFor(getState(), { kind: "auto" }, false)).toBeNull();
    expect(setInputFor(getState({ policy: named() }), { kind: "named", accountId: "acc_a", accountLabel: "Work A" }, false)).toBeNull();
    expect(setInputFor(getState({ policy: named() }), { kind: "on-limit", onLimit: "fallback-auto" }, false)).toBeNull();
  });

  it("an on-limit change keeps the account and never sends newSession", () => {
    const get = getState({ provider: "codex", policy: named(), revision: 4 });
    expect(setInputFor(get, { kind: "on-limit", onLimit: "stop" }, true)).toEqual({
      threadId: "thr_test1",
      expectedRevision: 4,
      policy: { mode: "named", accountId: "acc_a", onLimit: "stop" },
    });
    expect(needsNewSession(get, { kind: "on-limit", onLimit: "stop" })).toBe(false);
  });

  it("switching pinned accounts keeps the on-limit rule (F3)", () => {
    const pinB = { kind: "named", accountId: "acc_b", accountLabel: "Work B" } as const;
    expect(setInputFor(getState({ policy: named("acc_a", "Work A", "stop"), revision: 3 }), pinB, false)).toEqual({
      threadId: "thr_test1",
      expectedRevision: 3,
      policy: { mode: "named", accountId: "acc_b", onLimit: "stop" },
    });
    expect(setInputFor(getState({ policy: named("acc_a", "Work A", "fallback-auto") }), pinB, false)?.policy).toEqual({
      mode: "named",
      accountId: "acc_b",
      onLimit: "fallback-auto",
    });
  });

  it("carries expectedRevision and newSession for a pin", () => {
    expect(setInputFor(getState({ revision: 9 }), { kind: "named", accountId: "acc_a", accountLabel: "Work A" }, true)).toEqual({
      threadId: "thr_test1",
      expectedRevision: 9,
      policy: { mode: "named", accountId: "acc_a" },
      newSession: true,
    });
  });
});

describe("newSession table (test 7)", () => {
  const pinA = { kind: "named", accountId: "acc_a", accountLabel: "Work A" } as const;
  it.each([
    ["Claude, anything", getState({ provider: "claude" }), pinA, false],
    ["Codex to Auto", getState({ provider: "codex", policy: named() }), { kind: "auto" } as const, false],
    ["Codex pin, serving another", getState({ provider: "codex" }), pinA, true],
    ["Codex pin, grandfathered", getState({ provider: "codex", grandfathered: true, serving: null }), pinA, true],
    ["Codex pin, nothing served", getState({ provider: "codex", serving: null }), pinA, false],
    ["Codex pin, serving A", getState({ provider: "codex", serving: { accountId: "acc_a", accountLabel: "Work A", provider: "codex", since: T0 } }), pinA, false],
  ])("%s", (_name, get, target, expected) => {
    expect(needsNewSession(get, target)).toBe(expected);
  });

  it("one dialog lists both effects for a grandfathered Codex pin", () => {
    const parts = confirmParts(getState({ provider: "codex", grandfathered: true, serving: null }), pinA);
    expect(parts?.paragraphs).toHaveLength(2);
    expect(parts?.confirmLabel).toBe("Pin and start new session");
    expect(parts?.title).toBe("Pin this thread to Work A?");
  });

  it("a grandfathered Claude pin explains the own pass; a plain pin needs no dialog", () => {
    expect(confirmParts(getState({ grandfathered: true }), pinA)?.confirmLabel).toBe("Pin to Work A");
    expect(confirmParts(getState(), pinA)).toBeNull();
    expect(confirmParts(getState({ provider: "codex", grandfathered: true }), { kind: "auto" })).toBeNull();
  });
});

describe("set answers (test 9)", () => {
  const ok = { ...getState(), ok: true as const, changed: true, sessionRebuild: "none" as const, message: null };
  it.each([
    [{ ...ok, changed: false }, null],
    [{ ...ok, sessionRebuild: "next-turn" as const, message: "Moves to its own pass at its next turn." }, "Moves to its own pass at its next turn."],
    [{ ...ok, sessionRebuild: "new-session" as const }, "New Codex session started."],
    [{ ok: false as const, reason: "revision-conflict" as const, message: "x" }, "Changed elsewhere; refreshed."],
    [{ ok: false as const, reason: "not-idle" as const, message: "x" }, "The thread is busy. Try again when it is idle."],
    [{ ok: false as const, reason: "at-limit" as const, message: "Work C is at its limit." }, "Work C is at its limit."],
  ])("note %#", (result, note) => {
    expect(setResultNote(result)).toBe(note);
  });
});

describe("picker rows", () => {
  it("keeps pool order, hides other-provider rows, explains unusable ones", () => {
    const rows = pickerRows(accountList(), T0);
    expect(rows.map((row) => row.label)).toEqual(["Work A", "Work B", "Work C"]);
    expect(rows[1]?.secondary).toBe("Pro");
    expect(rows[0]?.secondary).toBe("Max");
    expect(rows[2]).toMatchObject({ usable: false, reasonText: expect.stringMatching(/^At limit until \d\d:\d\d$/u) });
  });

  it("without a plan, shows the account kind in words", () => {
    const list = { ...accountList(), accounts: [entry({ accountId: "acc_a", subscriptionType: null, kind: "api-key" }), entry({ accountId: "acc_b", subscriptionType: null, kind: "oauth" })] };
    expect(pickerRows(list, T0).map((row) => row.secondary)).toEqual(["API key", "Subscription"]);
  });
});

describe("limit card rows (§4)", () => {
  const cases = [
    [{ cause: "limit", action: "fell-back" }, "auto", "Work A hit its limit", "choose", "Keep Auto", "warning"],
    [{ cause: "deleted", action: "fell-back" }, "auto", "Work A was removed", "choose", "Keep Auto", "warning"],
    [{ cause: "unavailable", action: "served-auto" }, "named", "Work A is unavailable", "use-auto", "Dismiss", "warning"],
    [{ cause: "limit", action: "stopped" }, "named", "Work A hit its limit: stopped", "back-to-auto", "Dismiss (keep waiting)", "destructive"],
    [{ cause: "deleted", action: "stopped" }, "named", "Work A was removed: stopped", "back-to-auto", "Dismiss", "destructive"],
    [{ cause: "unavailable", action: "stopped" }, "named", "Work A is unavailable: stopped", "back-to-auto", "Dismiss", "destructive"],
  ] as const;
  it.each(cases)("%o", (event, mode, title, action, dismiss, tone) => {
    const get = getState({
      policy: mode === "auto" ? { mode: "auto" } : named("acc_a", "Work A", event.action === "stopped" ? "stop" : "fallback-auto"),
      updatedAt: T0 - HOUR,
      lastLimit: limitEvent(event),
    });
    const accounts = event.cause === "deleted" ? { ...accountList(), accounts: [] } : event.cause === "unavailable" ? { ...accountList(), accounts: [entry({ accountId: "acc_a", usable: false, reason: "unavailable" as const })] } : aAtLimit();
    const card = view(get, accounts).limit;
    expect(card).toMatchObject({ title, action, dismissLabel: dismiss, tone });
  });
});

describe("synthetic labels only (test 14)", () => {
  it("fixtures use made-up account labels", () => {
    const labels = accountList().accounts.map((item) => item.accountLabel);
    expect(labels.every((label) => /^(Work [A-C]|Codex X)$/u.test(label))).toBe(true);
  });
});
