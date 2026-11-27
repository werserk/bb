// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { dispatchAccountSchema } from "../../src/dispatch-account.js";
import { DRAFT_REFUSED_NOTE, DRAFT_TITLE } from "./draft.js";
import { CODEX_PICKER_NOTE } from "./pick.js";
import { getState, ID_A, named, summaries, THREAD } from "./fixtures.js";
import { RUN_ROW_ITEM_ID, RUN_ROW_ITEM_ORDER, ThreadAccountRunRowItem } from "./RunRowItem.js";
import { registerRunRowItem, type ExperimentalComposerRunRowItemProps } from "./run-row-slot.js";
import { resetStoresForTest } from "./store.js";

const app = await loadPluginApp(() => import("../../app"));

beforeEach(() => resetStoresForTest());
afterEach(() => {
  cleanup();
  resetStoresForTest();
});

const registration = { version: 1 as const, id: RUN_ROW_ITEM_ID, order: RUN_ROW_ITEM_ORDER, component: ThreadAccountRunRowItem };

describe("run-row registration (5.1)", () => {
  it("registers only when the slot exists, with the slot's `this`", () => {
    expect(registerRunRowItem({}, registration)).toBe(false);
    const slots = {
      calls: [] as unknown[],
      experimental_composerRunRowItem(this: { calls: unknown[] }, value: unknown) {
        this.calls.push(value);
      },
    };
    expect(registerRunRowItem(slots, registration)).toBe(true);
    expect(slots.calls).toEqual([registration]);
  });

  it("app.tsx registers the item on a core with the slot and still loads on stock", async () => {
    // Stock harness: no run-row slot, every other registration intact.
    expect(app.threadContextCardRows.some((row) => row.id === "thread-account")).toBe(true);
    const definition = (await import("../../app")).default as unknown as { setup(builder: unknown): void };
    const runRow = vi.fn();
    const builder = {
      slots: {
        settingsSection: vi.fn(),
        experimental_threadContextCardRow: vi.fn(),
        experimental_composerRunRowItem: runRow,
      },
      composer: { customize: vi.fn() },
    };
    definition.setup(builder);
    expect(runRow).toHaveBeenCalledTimes(1);
    expect(runRow.mock.calls[0]?.[0]).toMatchObject({ version: 1, id: "thread-account", order: RUN_ROW_ITEM_ORDER });
    expect(runRow.mock.calls[0]?.[0].component).toBe(ThreadAccountRunRowItem);
  });
});

type Props = ExperimentalComposerRunRowItemProps;

function renderItem(props: Props, rpc: Record<string, (input: unknown) => unknown>) {
  return renderSlot({ component: ThreadAccountRunRowItem }, props, { rpc });
}

async function openMenu(slot: ReturnType<typeof renderSlot>, name: RegExp) {
  const trigger = await slot.findByRole("button", { name });
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
  await slot.findByRole("menu");
}

describe("open thread (5.2)", () => {
  const scope = { kind: "thread" as const, threadId: THREAD, projectId: "prj_1" };
  const rpc = {
    "thread-account.v1.get": () => getState({ policy: named() }),
    "thread-account.v1.accounts": () => ({ threadId: THREAD, provider: "claude", accounts: [] }),
  };

  it("shows the thread's own account and opens the U1 menu", async () => {
    const slot = renderItem({ scope, compact: false }, rpc);
    expect(await slot.findByText("Work A")).toBeTruthy();
    expect(slot.rpcCalls.find((call) => call.method === "thread-account.v1.get")?.input).toEqual({ threadId: THREAD });
    await openMenu(slot, /^Account: Work A$/u);
    expect(slot.getByText("Account for this thread")).toBeTruthy();
  });

  it("is icon-first when compact", async () => {
    const slot = renderItem({ scope, compact: true }, rpc);
    const chip = await slot.findByRole("button", { name: "Account: Work A" });
    expect(chip.textContent).toBe("");
  });
});

describe("new thread (5.3)", () => {
  const scope = (providerId: string | null, projectId: string | null = "prj_1") => ({
    kind: "new-thread" as const,
    projectId,
    providerId,
  });
  const rpc = { "account.list": () => summaries() };

  function draft(providerId: string | null, answer = true) {
    const setSubmission = vi.fn((_data: JsonValue | null) => answer);
    const slot = renderItem({ scope: scope(providerId), compact: false, setSubmission }, rpc);
    return { slot, setSubmission };
  }

  it("picks a named account into the submission, with no thread RPC", async () => {
    const { slot, setSubmission } = draft("claude-code");
    await waitFor(() => expect(setSubmission).toHaveBeenCalledWith(null));
    await openMenu(slot, /^Account: Auto$/u);
    expect(slot.getByText(DRAFT_TITLE)).toBeTruthy();
    expect(slot.queryByRole("menuitemradio", { name: /Codex X/u })).toBeNull();
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    const data = setSubmission.mock.calls.at(-1)?.[0];
    expect(data).toEqual({ policy: { mode: "named", accountId: ID_A } });
    expect(dispatchAccountSchema.safeParse(data).success).toBe(true);
    expect(await slot.findByRole("button", { name: "Account: Work A" })).toBeTruthy();
    expect(slot.rpcCalls.map((call) => call.method).filter((method) => method.startsWith("thread-account"))).toEqual([]);
  });

  it("Auto sends null", async () => {
    const { slot, setSubmission } = draft("claude-code");
    await openMenu(slot, /^Account: Auto$/u);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    await openMenu(slot, /^Account: Work A$/u);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /^Auto/u }));
    expect(setSubmission.mock.calls.at(-1)).toEqual([null]);
    expect(await slot.findByRole("button", { name: "Account: Auto" })).toBeTruthy();
  });

  it("maps codex and lists only its accounts", async () => {
    const { slot } = draft("codex");
    await openMenu(slot, /^Account: Auto$/u);
    expect(await slot.findByRole("menuitemradio", { name: /Codex X/u })).toBeTruthy();
    expect(slot.queryByRole("menuitemradio", { name: /Work A/u })).toBeNull();
    // A new thread has no session yet, so the open thread's Codex session note does not apply.
    expect(slot.queryByText(CODEX_PICKER_NOTE)).toBeNull();
  });

  it("is hidden for a provider the pool does not route, or with no provider", async () => {
    for (const providerId of ["pi", null]) {
      const { slot, setSubmission } = draft(providerId);
      await act(async () => {});
      expect(slot.queryByRole("button")).toBeNull();
      expect(setSubmission).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("is hidden where core cannot carry the choice (no setSubmission)", async () => {
    const slot = renderItem({ scope: scope("claude-code"), compact: false }, rpc);
    await act(async () => {});
    expect(slot.queryByRole("button")).toBeNull();
    expect(slot.rpcCalls).toEqual([]);
  });

  it("a provider change starts again on Auto", async () => {
    const setSubmission = vi.fn((_data: JsonValue | null) => true);
    const slot = renderItem({ scope: scope("claude-code"), compact: false, setSubmission }, rpc);
    await openMenu(slot, /^Account: Auto$/u);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    await slot.findByRole("button", { name: "Account: Work A" });
    setSubmission.mockClear();
    slot.lifecycle.rerender(
      <ThreadAccountRunRowItem scope={scope("codex")} compact={false} setSubmission={setSubmission} />,
    );
    expect(await slot.findByRole("button", { name: "Account: Auto" })).toBeTruthy();
    expect(setSubmission.mock.calls).toEqual([[null]]);
    await openMenu(slot, /^Account: Auto$/u);
    expect(await slot.findByRole("menuitemradio", { name: /Codex X/u })).toBeTruthy();
  });

  it("a refused submission shows why and keeps Auto", async () => {
    const { slot } = draft("claude-code", false);
    await openMenu(slot, /^Account: Auto$/u);
    fireEvent.click(await slot.findByRole("menuitemradio", { name: /Work A/u }));
    expect((await slot.findAllByText(DRAFT_REFUSED_NOTE)).length).toBeGreaterThan(0);
    expect(slot.getByRole("button", { name: "Account: Auto" })).toBeTruthy();
  });
});
