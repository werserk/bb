import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAccountSchema, type DispatchAccount } from "../../src/dispatch-account.js";
import {
  DRAFT_ACCOUNTS_ERROR_NOTE,
  DRAFT_PINNED_LABEL,
  DRAFT_REFUSED_NOTE,
  DRAFT_REMOVED_DETAILS,
  DraftAccountStore,
  draftAccountList,
  draftMemoryKey,
  draftView,
  sessionDraftMemory,
  type DraftMemory,
} from "./draft.js";
import { ID_A, ID_B, ID_C, summaries, summary, T0 } from "./fixtures.js";
import { REMOVED_ACCOUNT } from "./view.js";

afterEach(() => vi.useRealTimers());

function setup(answer: (data: DispatchAccount | null) => boolean = () => true) {
  const submit = vi.fn(answer);
  const load = vi.fn(async () => summaries());
  const store = new DraftAccountStore("claude", submit, load, () => T0);
  return { store, submit, load };
}

/** What core would carry: it must parse exactly as the hook parses it. */
function lastSubmission(submit: ReturnType<typeof vi.fn>): unknown {
  return submit.mock.calls.at(-1)?.[0];
}

describe("draftAccountList", () => {
  it("keeps the provider's accounts in priority order", () => {
    const list = draftAccountList("claude", summaries(), T0);
    expect(list.provider).toBe("claude");
    expect(list.accounts.map((item) => item.accountLabel)).toEqual(["Work A", "Work B", "Work C"]);
    expect(draftAccountList("codex", summaries(), T0).accounts.map((item) => item.accountLabel)).toEqual(["Codex X"]);
  });

  it("marks usable by the named-account rule with no thread model, not by the switch threshold", () => {
    const byId = new Map(draftAccountList("claude", summaries(), T0).accounts.map((item) => [item.accountId, item]));
    expect(byId.get(ID_A)).toMatchObject({ usable: true, reason: null, resetAt: null });
    // B is "exhausted" for Auto (switch threshold) yet a pin may still use it.
    expect(byId.get(ID_B)).toMatchObject({ usable: true, reason: null });
    expect(byId.get(ID_C)).toMatchObject({ usable: false, reason: "at-limit", resetAt: T0 + 3600_000 });
  });

  it("ignores a model family's window: the first dispatch has no model yet", () => {
    const spent = { utilization: 1, resetAt: T0 + 86_400_000, status: null, observedAt: T0 - 60_000, source: "usage" as const };
    const familyWeekly = { fable: spent, sonnet: spent, opus: spent, haiku: spent, other: spent };
    const [entry] = draftAccountList("claude", [summary({ id: ID_A, label: "Work A", familyWeekly })], T0).accounts;
    expect(entry).toMatchObject({ usable: true, reason: null, resetAt: null });
  });

  it("marks a disabled account unavailable", () => {
    const [entry] = draftAccountList("claude", [summary({ id: ID_A, label: "Work A", enabled: false })], T0).accounts;
    expect(entry).toMatchObject({ usable: false, reason: "unavailable" });
  });
});

describe("DraftAccountStore", () => {
  it("starts on Auto at revision 0 with no thread when core holds nothing, and leaves core's draft alone", async () => {
    const { store, submit, load } = setup();
    store.start(null);
    expect(submit).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
    const get = store.getSnapshot().get;
    expect(get).toMatchObject({
      threadId: "",
      provider: "claude",
      policy: { mode: "auto" },
      revision: 0,
      grandfathered: false,
      serving: null,
    });
    await vi.waitFor(() => expect(store.getSnapshot().accounts?.accounts).toHaveLength(3));
    expect(draftView(store.getSnapshot(), T0)).toMatchObject({ state: "auto-idle", label: "Auto", canPick: true });
  });

  it("a named pick submits the policy the dispatch hook parses", async () => {
    const { store, submit } = setup();
    store.start(null);
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    const data = lastSubmission(submit);
    expect(data).toEqual({ policy: { mode: "named", accountId: ID_A } });
    expect(dispatchAccountSchema.parse(data)).toEqual(data);
    expect(store.getSnapshot().get?.policy).toEqual({
      mode: "named",
      accountId: ID_A,
      accountLabel: "Work A",
      onLimit: "fallback-auto",
    });
    expect(draftView(store.getSnapshot(), T0)).toMatchObject({ state: "named", label: "Work A" });
  });

  it("restores core's draft pin on mount and names it from the account list", async () => {
    const { store, submit } = setup();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const load = vi.fn(async () => {
      await gate;
      return summaries();
    });
    store.setSources(submit, load);
    store.start({ policy: { mode: "named", accountId: ID_A, onLimit: "stop" } });
    expect(submit).not.toHaveBeenCalled();
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "named", accountId: ID_A, accountLabel: null, onLimit: "stop" });
    expect(draftView(store.getSnapshot(), T0)).toMatchObject({ state: "named", label: DRAFT_PINNED_LABEL });
    release();
    await vi.waitFor(() => expect(store.getSnapshot().accounts).not.toBeNull());
    expect(draftView(store.getSnapshot(), T0)).toMatchObject({ state: "named", label: "Work A" });
    // The restored pin is core's data: a refused re-pick clears it.
    submit.mockImplementation(() => false);
    await store.pick({ kind: "on-limit", onLimit: "fallback-auto" });
    expect(submit.mock.calls.at(-1)).toEqual([null]);
  });

  it("a restored pin the account list no longer has reads as removed", async () => {
    const { store } = setup();
    store.start({ policy: { mode: "named", accountId: "gone" } });
    await vi.waitFor(() => expect(store.getSnapshot().accounts).not.toBeNull());
    expect(draftView(store.getSnapshot(), T0)).toMatchObject({
      state: "named",
      label: REMOVED_ACCOUNT,
      tone: "warning",
      details: DRAFT_REMOVED_DETAILS,
    });
    expect(store.getSnapshot().get?.policy).toMatchObject({ onLimit: "fallback-auto" });
  });

  it("a pick whose account later leaves the list turns to the removed warning", async () => {
    const { store, load } = setup();
    store.start(null);
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    await vi.waitFor(() => expect(store.getSnapshot().accounts).not.toBeNull());
    expect(draftView(store.getSnapshot(), T0)).toMatchObject({ label: "Work A", tone: "default" });
    load.mockImplementation(async () => summaries().filter((item) => item.id !== ID_A));
    store.retry();
    await vi.waitFor(() => expect(draftView(store.getSnapshot(), T0)).toMatchObject({ label: REMOVED_ACCOUNT, tone: "warning" }));
  });

  it("clears draft data the dispatch hook would not parse and stays on Auto", () => {
    for (const bad of [{ policy: { mode: "named" } }, { policy: { mode: "auto" } }, "x"]) {
      const { store, submit } = setup();
      store.start(bad);
      expect(submit.mock.calls).toEqual([[null]]);
      expect(store.getSnapshot().get?.policy).toEqual({ mode: "auto" });
    }
  });

  it("an on-limit pick keeps the account and submits the rule", async () => {
    const { store, submit } = setup();
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    await store.pick({ kind: "on-limit", onLimit: "stop" });
    const data = lastSubmission(submit);
    expect(data).toEqual({ policy: { mode: "named", accountId: ID_A, onLimit: "stop" } });
    expect(dispatchAccountSchema.parse(data)).toEqual(data);
    expect(store.getSnapshot().get?.policy).toMatchObject({ accountLabel: "Work A", onLimit: "stop" });
  });

  it("Auto clears the submission", async () => {
    const { store, submit } = setup();
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    submit.mockClear();
    await store.pick({ kind: "auto" });
    expect(submit.mock.calls).toEqual([[null]]);
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "auto" });
  });

  it("the same pick again submits nothing", async () => {
    const { store, submit } = setup();
    await store.pick({ kind: "auto" });
    expect(submit).not.toHaveBeenCalled();
  });

  it("a refused submission keeps Auto and says why", async () => {
    vi.useFakeTimers();
    const { store, submit } = setup(() => false);
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "auto" });
    expect(store.getSnapshot().note).toBe(DRAFT_REFUSED_NOTE);
    expect(submit.mock.calls).toEqual([[{ policy: { mode: "named", accountId: ID_A } }]]);
    vi.advanceTimersByTime(6000);
    expect(store.getSnapshot().note).toBeNull();
  });

  it("a refusal after an accepted pick also drops the earlier data from core", async () => {
    let accept = true;
    const { store, submit } = setup(() => accept);
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    accept = false;
    await store.pick({ kind: "named", accountId: ID_B, accountLabel: "Work B" });
    expect(submit.mock.calls.at(-1)).toEqual([null]);
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "auto" });
  });

  it("a failed account read leaves no rows and a note", async () => {
    const store = new DraftAccountStore("claude", () => true, async () => Promise.reject(new Error("down")), () => T0);
    store.pickerOpened();
    await vi.waitFor(() => expect(store.getSnapshot().note).toBe(DRAFT_ACCOUNTS_ERROR_NOTE));
    expect(store.getSnapshot().accounts).toBeNull();
    store.stop();
  });
});

function memoryStore(initial: DispatchAccount | null = null) {
  let value = initial;
  const memory: DraftMemory = { read: () => value, write: vi.fn((data) => void (value = data)) };
  return { memory, current: () => value };
}

function setupWithMemory(initial: DispatchAccount | null, answer: (data: DispatchAccount | null) => boolean = () => true) {
  const submit = vi.fn(answer);
  const load = vi.fn(async () => summaries());
  const mem = memoryStore(initial);
  const store = new DraftAccountStore("claude", submit, load, () => T0, mem.memory);
  return { store, submit, ...mem };
}

describe("DraftAccountStore memory (a pick outlives a reload or a remount)", () => {
  it("core holds nothing: the remembered pin goes back into core's draft and shows on the chip", async () => {
    const pin: DispatchAccount = { policy: { mode: "named", accountId: ID_A, onLimit: "stop" } };
    const { store, submit } = setupWithMemory(pin);
    store.start(null);
    expect(submit.mock.calls).toEqual([[pin]]);
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "named", accountId: ID_A, accountLabel: null, onLimit: "stop" });
    await vi.waitFor(() => expect(draftView(store.getSnapshot(), T0)).toMatchObject({ state: "named", label: "Work A" }));
  });

  it("core still holds a pin: core wins, nothing is resubmitted, memory follows core", () => {
    const { store, submit, current } = setupWithMemory({ policy: { mode: "named", accountId: ID_B } });
    store.start({ policy: { mode: "named", accountId: ID_A } });
    expect(submit).not.toHaveBeenCalled();
    expect(current()).toEqual({ policy: { mode: "named", accountId: ID_A } });
  });

  it("core refuses the remembered pin: Auto, and the memory is dropped", () => {
    const { store, current } = setupWithMemory({ policy: { mode: "named", accountId: ID_A } }, () => false);
    store.start(null);
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "auto" });
    expect(current()).toBeNull();
  });

  it("a pick is remembered, Auto forgets it, a refused pick forgets it", async () => {
    let accept = true;
    const { store, current } = setupWithMemory(null, () => accept);
    store.start(null);
    await store.pick({ kind: "named", accountId: ID_A, accountLabel: "Work A" });
    expect(current()).toEqual({ policy: { mode: "named", accountId: ID_A } });
    await store.pick({ kind: "auto" });
    expect(current()).toBeNull();
    await store.pick({ kind: "named", accountId: ID_B, accountLabel: "Work B" });
    accept = false;
    await store.pick({ kind: "named", accountId: ID_C, accountLabel: "Work C" });
    expect(current()).toBeNull();
  });

  it("draft data the hook would not parse also clears the memory", () => {
    const { store, current } = setupWithMemory({ policy: { mode: "named", accountId: ID_A } });
    store.start("x");
    expect(current()).toBeNull();
    expect(store.getSnapshot().get?.policy).toEqual({ mode: "auto" });
  });
});

describe("sessionDraftMemory", () => {
  function fakeStorage() {
    const map = new Map<string, string>();
    return {
      map,
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    };
  }

  it("round-trips a named pin under a key per project and provider", () => {
    const storage = fakeStorage();
    const key = draftMemoryKey("proj_1", "codex");
    expect(key).not.toBe(draftMemoryKey("proj_2", "codex"));
    expect(key).not.toBe(draftMemoryKey("proj_1", "claude"));
    const memory = sessionDraftMemory(key, storage);
    memory.write({ policy: { mode: "named", accountId: ID_A, onLimit: "stop" } });
    expect(memory.read()).toEqual({ policy: { mode: "named", accountId: ID_A, onLimit: "stop" } });
    memory.write(null);
    expect(memory.read()).toBeNull();
    expect(storage.map.size).toBe(0);
  });

  it("drops stored data the hook would not parse, and survives a throwing storage", () => {
    const storage = fakeStorage();
    const key = draftMemoryKey(null, "claude");
    storage.setItem(key, JSON.stringify({ policy: { mode: "auto" } }));
    expect(sessionDraftMemory(key, storage).read()).toBeNull();
    expect(storage.map.has(key)).toBe(false);
    storage.setItem(key, "{not json");
    expect(sessionDraftMemory(key, storage).read()).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {},
    };
    const memory = sessionDraftMemory(key, broken);
    expect(memory.read()).toBeNull();
    expect(() => memory.write({ policy: { mode: "named", accountId: ID_A } })).not.toThrow();
    expect(sessionDraftMemory(key, null).read()).toBeNull();
  });
});
