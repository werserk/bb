// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  aAtLimit,
  accountList,
  entry,
  getState,
  limitEvent,
  named,
  T0,
  THREAD,
} from "./fixtures.js";
import {
  DEBOUNCE_MS,
  DISMISS_KEY_PREFIX,
  getStore,
  resetStoresForTest,
  retainStore,
  ThreadAccountStore,
} from "./store.js";
import type { ThreadAccountGet, ThreadAccountList } from "./view.js";

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => resetStoresForTest());
afterEach(() => {
  cleanup();
  resetStoresForTest();
  vi.useRealTimers();
  window.localStorage.clear();
});

type Handler = (input: unknown) => unknown;
function handlers(get: ThreadAccountGet, accounts: ThreadAccountList = accountList(), set?: Handler) {
  return {
    "thread-account.v1.get": () => get,
    "thread-account.v1.accounts": () => accounts,
    "thread-account.v1.set": set ?? ((input: unknown) => ({ ...get, ok: true, changed: true, sessionRebuild: "none", message: null, _input: input })),
  };
}

function rowRegistration() {
  const row = app.threadContextCardRows.find((item) => item.id === "thread-account");
  if (!row) throw new Error("row not registered");
  return row;
}

function renderRow(rpc: Record<string, Handler>, options: Parameters<typeof renderSlot>[2] = {}) {
  return renderSlot(rowRegistration(), { threadId: THREAD, projectId: "prj_1", environment: null }, { rpc, ...options });
}

function bannerRegistration() {
  const custom = app.composerCustomizations.find((item) => item.id === "thread-account");
  const banner = custom?.banners?.find((item) => item.id === "limit");
  if (!custom || !banner) throw new Error("banner not registered");
  return { custom, banner };
}

function renderCard(rpc: Record<string, Handler>) {
  const { banner } = bannerRegistration();
  return renderSlot({ component: banner.component }, {}, { rpc, composer: { scope: { kind: "thread", threadId: THREAD } } });
}

function setCalls(slot: ReturnType<typeof renderSlot>) {
  return slot.rpcCalls.filter((call) => call.method === "thread-account.v1.set");
}

async function openPicker(slot: ReturnType<typeof renderSlot>) {
  const trigger = await slot.findByRole("button", { name: /^Change account for this thread/u });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await slot.findByRole("menu");
  return trigger;
}

describe("registrations", () => {
  it("adds the row in the thread group and a card-chrome thread banner", () => {
    expect(rowRegistration()).toMatchObject({ group: "1_thread", order: 50 });
    const { custom, banner } = bannerRegistration();
    expect(custom.scopes).toEqual(["thread"]);
    expect(banner.chrome).toBe("card");
  });
});

describe("account row (tests 6, 12)", () => {
  it("shows the serving account with a plain label; the action is the only trigger", async () => {
    const slot = renderRow(handlers(getState()));
    expect(await slot.findByText("Auto · Work B")).toBeTruthy();
    const row = slot.getByTestId("bb-thread-context-card-row");
    expect(row.tagName).toBe("DIV");
    expect(row.getAttribute("title")).toContain("Served by Work B");
    const buttons = slot.getAllByRole("button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.getAttribute("aria-label")).toBe("Change account for this thread (Auto · Work B)");
    expect(buttons[0]?.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("renders nothing for an unpooled provider", async () => {
    const slot = renderRow(handlers(getState({ provider: null })));
    await waitFor(() => expect(slot.rpcCalls.length).toBeGreaterThan(0));
    await waitFor(() => expect(slot.queryByTestId("bb-thread-context-card-row")).toBeNull());
    expect(slot.queryByText("Account")).toBeNull();
  });

  it("shows Pool offline on a transport error", async () => {
    const slot = renderRow({
      "thread-account.v1.get": () => {
        throw Object.assign(new Error("down"), { code: "transport_error" });
      },
      "thread-account.v1.accounts": () => accountList(),
    });
    expect(await slot.findByText("Pool offline")).toBeTruthy();
  });

  it("pins an account with expectedRevision and no newSession", async () => {
    const slot = renderRow(handlers(getState({ revision: 3 })));
    await openPicker(slot);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    await waitFor(() => expect(setCalls(slot)).toHaveLength(1));
    expect(setCalls(slot)[0]?.input).toEqual({
      threadId: THREAD,
      expectedRevision: 3,
      policy: { mode: "named", accountId: "acc_a" },
    });
  });

  it("sends nothing for the current policy or an unusable account", async () => {
    const slot = renderRow(handlers(getState()));
    await openPicker(slot);
    const auto = await slot.findByRole("menuitemradio", { name: /^Auto/u });
    expect(auto.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(auto);
    await openPicker(slot);
    const limited = await slot.findByRole("menuitemradio", { name: /Work C/u });
    expect(limited.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(limited.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toMatch(/^At limit until /u);
    fireEvent.click(limited);
    expect(slot.queryByRole("menu")).toBeTruthy();
    expect(setCalls(slot)).toHaveLength(0);
  });

  it("hides other-provider accounts and disables the on-limit rule under Auto", async () => {
    const slot = renderRow(handlers(getState()));
    await openPicker(slot);
    expect(slot.queryByText("Codex X")).toBeNull();
    const rule = await slot.findByRole("menuitemradio", { name: /Stop until reset/u });
    expect(rule.getAttribute("aria-disabled")).toBe("true");
  });

  it("an on-limit change keeps the account and never sends newSession, also on Codex", async () => {
    const get = getState({ provider: "codex", policy: named(), revision: 5 });
    const slot = renderRow(handlers(get));
    await openPicker(slot);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Stop until reset/u }));
    await waitFor(() => expect(setCalls(slot)).toHaveLength(1));
    expect(setCalls(slot)[0]?.input).toEqual({
      threadId: THREAD,
      expectedRevision: 5,
      policy: { mode: "named", accountId: "acc_a", onLimit: "stop" },
    });
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("refetches on a revision conflict and says so", async () => {
    const slot = renderRow(handlers(getState(), accountList(), () => ({ ok: false, reason: "revision-conflict", message: "stale" })));
    await openPicker(slot);
    const gets = () => slot.rpcCalls.filter((call) => call.method === "thread-account.v1.get").length;
    const before = gets();
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    await waitFor(() => expect(gets()).toBe(before + 1));
    expect((await slot.findAllByText("Changed elsewhere; refreshed.")).length).toBeGreaterThan(0);
  });
});

describe("confirm dialog (test 8)", () => {
  it("a grandfathered pin asks first; focus starts on Cancel; Cancel sends nothing", async () => {
    const slot = renderRow(handlers(getState({ route: "machine-token", grandfathered: true, serving: null })));
    expect(await slot.findByText("Machine token")).toBeTruthy();
    await openPicker(slot);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).toContain("Pin this thread to Work A?");
    expect(dialog.textContent).toContain("own pass at its next turn");
    const cancel = slot.getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    fireEvent.click(cancel);
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(setCalls(slot)).toHaveLength(0);
  });

  it("a Codex pin from another account confirms a new session", async () => {
    const slot = renderRow(handlers(getState({ provider: "codex" })));
    await openPicker(slot);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    fireEvent.click(await slot.findByRole("button", { name: "Pin and start new session" }));
    await waitFor(() => expect(setCalls(slot)).toHaveLength(1));
    expect(setCalls(slot)[0]?.input).toMatchObject({ newSession: true, policy: { mode: "named", accountId: "acc_a" } });
  });
});

describe("keyboard (test 13)", () => {
  it("arrows reach an aria-disabled row; Escape closes and returns focus to the trigger", async () => {
    const slot = renderRow(handlers(getState()));
    const trigger = await slot.findByRole("button", { name: /^Change account/u });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await slot.findByRole("menu");
    const limited = await slot.findByRole("menuitemradio", { name: /Work C/u });
    // Radix moves roving focus on the next task.
    for (let step = 0; step < 6 && document.activeElement !== limited; step += 1) {
      fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    }
    expect(document.activeElement).toBe(limited);
    fireEvent.keyDown(document.activeElement ?? menu, { key: "Escape" });
    await waitFor(() => expect(slot.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});

describe("limit card (test 11)", () => {
  it("renders nothing without a current limit", async () => {
    const slot = renderCard(handlers(getState()));
    await waitFor(() => expect(slot.rpcCalls.length).toBeGreaterThan(1));
    expect(slot.container.textContent).toBe("");
  });

  it("is plain content: a labelled section, no nested stack card", async () => {
    const at = Date.now() - 60_000;
    const slot = renderCard(handlers(getState({ updatedAt: at, lastLimit: limitEvent({ at }) }), aAtLimit()));
    const title = await slot.findByText("Work A hit its limit");
    const section = slot.container.querySelector("section");
    expect(slot.container.firstElementChild).toBe(section);
    expect(section?.getAttribute("aria-labelledby")).toBe(title.id);
    expect(section?.getAttribute("role")).toBeNull();
    expect(slot.queryByTestId("bb-collapsible-stack-card")).toBeNull();
    expect(slot.getByText(/Work B serves it now/u)).toBeTruthy();
    expect(slot.getByRole("button", { name: /Choose account/u })).toBeTruthy();
  });

  it("dismiss stores the event id and hides the card", async () => {
    const at = Date.now() - 60_000;
    const slot = renderCard(handlers(getState({ updatedAt: at, lastLimit: limitEvent({ at }) }), aAtLimit()));
    fireEvent.click(await slot.findByRole("button", { name: "Keep Auto" }));
    await waitFor(() => expect(slot.container.textContent).toBe(""));
    expect(window.localStorage.getItem(DISMISS_KEY_PREFIX + THREAD)).toBe("7");
  });

  it("Back to Auto on a stopped Codex thread sends auto without newSession", async () => {
    const get = getState({
      provider: "codex",
      policy: named("acc_a", "Work A", "stop"),
      updatedAt: T0 - 3600_000,
      lastLimit: limitEvent({ action: "stopped" }),
    });
    const slot = renderCard(handlers(get, aAtLimit(Date.now() + 3600_000)));
    expect(await slot.findByText("Work A hit its limit: stopped")).toBeTruthy();
    expect(slot.container.querySelector("time")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Back to Auto" }));
    await waitFor(() => expect(setCalls(slot)).toHaveLength(1));
    expect(setCalls(slot)[0]?.input).toEqual({ threadId: THREAD, expectedRevision: 1, policy: { mode: "auto" } });
  });

  it("served-auto offers Use Auto", async () => {
    const get = getState({ policy: named(), updatedAt: T0 - 3600_000, lastLimit: limitEvent({ cause: "unavailable", action: "served-auto" }) });
    const slot = renderCard(handlers(get, { ...accountList(), accounts: [entry({ accountId: "acc_a", usable: false, reason: "unavailable" })] }));
    expect(await slot.findByText("Work A is unavailable")).toBeTruthy();
    expect(slot.getByRole("button", { name: "Use Auto" })).toBeTruthy();
  });
});

describe("store (test 10)", () => {
  function fakeCaller(get = getState()) {
    return vi.fn(async (method: string) => (method.endsWith(".get") ? get : accountList()));
  }

  it("one store per thread; retained twice it fetches once", async () => {
    const call = fakeCaller();
    const first = getStore(THREAD, call);
    expect(getStore(THREAD, call)).toBe(first);
    const releaseA = retainStore(first);
    const releaseB = retainStore(first);
    expect(call).toHaveBeenCalledTimes(2); // get + accounts, once
    releaseA();
    releaseB();
  });

  it("coalesces events with a trailing debounce and filters by thread", async () => {
    vi.useFakeTimers();
    const call = fakeCaller();
    const store = new ThreadAccountStore(THREAD, call);
    store.refs = 1;
    store.onThreadChanged({ threadId: "thr_other" });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2);
    expect(call).not.toHaveBeenCalled();
    store.onThreadChanged({ threadId: THREAD });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    store.onThreadChanged({ threadId: THREAD });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 50);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(call.mock.calls.map((args) => args[0])).toEqual(["thread-account.v1.get"]);
    store.dispose();
  });

  it("accounts-changed fetches accounts only while a picker is open or a limit exists", async () => {
    vi.useFakeTimers();
    const call = fakeCaller();
    const store = new ThreadAccountStore(THREAD, call);
    store.refs = 1;
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    call.mockClear();
    store.onAccountsChanged();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(call.mock.calls.map((args) => args[0])).toEqual(["thread-account.v1.get"]);
    call.mockClear();
    store.pickerOpened(); // accounts are dirty after the event
    expect(call.mock.calls.map((args) => args[0])).toEqual(["thread-account.v1.accounts"]);
    call.mockClear();
    store.onAccountsChanged();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(call.mock.calls.map((args) => args[0]).sort()).toEqual(["thread-account.v1.accounts", "thread-account.v1.get"]);
    store.dispose();
  });

  it("the reset timer refetches accounts once at the reset time", async () => {
    vi.useFakeTimers({ now: T0 });
    const get = getState({ policy: named("acc_a", "Work A", "stop"), updatedAt: T0 - 3600_000, lastLimit: limitEvent({ action: "stopped" }) });
    const call = vi.fn(async (method: string) => (method.endsWith(".get") ? get : aAtLimit(T0 + 60_000)));
    const store = new ThreadAccountStore(THREAD, call);
    store.refs = 1;
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    call.mockClear();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(call.mock.calls.map((args) => args[0])).toEqual(["thread-account.v1.accounts"]);
    store.dispose();
  });

  it("a reconnect refetches both; the first connect does not", async () => {
    const slot = renderRow(handlers(getState()), { realtimeConnectionState: "connecting" });
    await slot.findByText("Auto · Work B");
    await slot.setRealtimeConnectionState("connected");
    await act(async () => new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 50)));
    const count = slot.rpcCalls.length;
    expect(count).toBe(2); // the first load only
    await slot.setRealtimeConnectionState("reconnecting");
    await slot.setRealtimeConnectionState("connected");
    await waitFor(() => expect(slot.rpcCalls.length).toBe(count + 2), { timeout: 2000 });
  });

  it("realtime for this thread refreshes the row", async () => {
    let get = getState();
    const slot = renderRow({
      "thread-account.v1.get": () => get,
      "thread-account.v1.accounts": () => accountList(),
    });
    await slot.findByText("Auto · Work B");
    get = getState({ serving: { accountId: "acc_a", accountLabel: "Work A", provider: "claude", since: T0 } });
    await slot.emitRealtime("thread-account-changed", { threadId: THREAD });
    expect(await slot.findByText("Auto · Work A", {}, { timeout: 2000 })).toBeTruthy();
  });
});
