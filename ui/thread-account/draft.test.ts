import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchAccountSchema, type DispatchAccount } from "../../src/dispatch-account.js";
import {
  DRAFT_ACCOUNTS_ERROR_NOTE,
  DRAFT_REFUSED_NOTE,
  DraftAccountStore,
  draftAccountList,
  draftView,
} from "./draft.js";
import { ID_A, ID_B, ID_C, summaries, summary, T0 } from "./fixtures.js";

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

  it("marks a disabled account unavailable", () => {
    const [entry] = draftAccountList("claude", [summary({ id: ID_A, label: "Work A", enabled: false })], T0).accounts;
    expect(entry).toMatchObject({ usable: false, reason: "unavailable" });
  });
});

describe("DraftAccountStore", () => {
  it("starts on Auto at revision 0 with no thread, and clears core's draft", async () => {
    const { store, submit, load } = setup();
    store.start();
    expect(submit).toHaveBeenCalledWith(null);
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
    store.start();
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
