import { describe, expect, it, vi } from "vitest";
import type { SystemEnvironmentProvider } from "@bb/server-contract";
import type { ExperimentalRunOnChoice } from "@get-bb/plugin-sdk";
import type { PluginRunOnProviderSlot } from "@/lib/plugin-slots";
import {
  acceptRunOnRegistrations,
  resetRunOnWarningsForTest,
  warnRunOnRejectionOnce,
} from "./registrations";
import {
  createRunRowSubmissionStore,
  mergePluginSubmissions,
  RUN_ROW_SUBMISSION_MAX_BYTES,
  TWO_PLUGIN_SUBMISSIONS_MESSAGE,
} from "./submission";
import {
  buildGroups,
  chipText,
  chipView,
  choiceUnavailableReason,
  sameInputs,
  type RunOnHost,
} from "./model";

const WORKER = "account-workers-worker";
const useChoices = () => ({ status: "ready" as const, choices: [] });
const useThreadWorkspace = () => null;

function provider(
  overrides: Partial<SystemEnvironmentProvider> = {},
): SystemEnvironmentProvider {
  return {
    id: WORKER,
    machineProviderId: null,
    displayName: "Worker",
    description: null,
    icon: null,
    logoUrl: null,
    pluginId: "account-workers",
    requires: {
      projectCheckout: false,
      gitCheckout: false,
      gitRemote: false,
      projectless: false,
    },
    inputs: null,
    acceptsEmptyInputs: false,
    availability: null,
    machineAvailability: {},
    ...overrides,
  };
}

function slot(
  overrides: Partial<PluginRunOnProviderSlot> = {},
): PluginRunOnProviderSlot {
  return {
    pluginId: "account-workers",
    generation: 1,
    version: 1,
    environmentProviderId: WORKER,
    title: "Workers",
    useChoices,
    useThreadWorkspace,
    ...overrides,
  };
}

describe("acceptRunOnRegistrations", () => {
  it("accepts the owner of the plain provider entry", () => {
    const warn = vi.fn();
    const entry = provider();
    expect(acceptRunOnRegistrations([slot()], [entry], warn)).toEqual([
      { slot: slot(), provider: entry },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("skips silently while the provider is not listed yet", () => {
    const warn = vi.fn();
    expect(acceptRunOnRegistrations([slot()], [], warn)).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects a plugin that does not own the provider", () => {
    const warn = vi.fn();
    const intruder = slot({ pluginId: "intruder" });
    expect(acceptRunOnRegistrations([intruder], [provider()], warn)).toEqual(
      [],
    );
    expect(warn).toHaveBeenCalledWith(intruder, "owned-by-another-plugin");
  });

  it("matches compositions by environmentProviderId and never trusts machineProviderPluginId", () => {
    const warn = vi.fn();

    const composed = provider({
      id: "intruder-box",
      environmentProviderId: WORKER,
      machineProviderId: "intruder-machine",
      pluginId: "intruder",
      machineProviderPluginId: "account-workers",
    });

    expect(acceptRunOnRegistrations([slot()], [composed], warn)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(slot(), "owned-by-another-plugin");

    warn.mockClear();
    const intruder = slot({ pluginId: "intruder" });
    expect(
      acceptRunOnRegistrations(
        [slot(), intruder],
        [provider(), composed],
        warn,
      ),
    ).toEqual([]);
    expect(warn).toHaveBeenCalledWith(slot(), "owned-by-another-plugin");
    expect(warn).toHaveBeenCalledWith(intruder, "owned-by-another-plugin");
  });

  it("rejects a provider listed only inside a composition", () => {
    const warn = vi.fn();
    const composedOnly = provider({
      id: "workers-box",
      environmentProviderId: WORKER,
      machineProviderId: "box",
    });
    expect(acceptRunOnRegistrations([slot()], [composedOnly], warn)).toEqual(
      [],
    );
    expect(warn).toHaveBeenCalledWith(slot(), "composed-only");
  });

  it("accepts the plain entry next to the owner's own composition", () => {
    const own = provider({
      id: "workers-box",
      environmentProviderId: WORKER,
      machineProviderId: "box",
    });
    const plain = provider();
    expect(acceptRunOnRegistrations([slot()], [own, plain], vi.fn())).toEqual([
      { slot: slot(), provider: plain },
    ]);
  });

  it("keeps the first registration per provider by order", () => {
    const warn = vi.fn();
    const first = slot({ order: 1, generation: 2 });
    const second = slot({ order: 5 });
    const accepted = acceptRunOnRegistrations(
      [second, first],
      [provider()],
      warn,
    );
    expect(accepted.map((entry) => entry.slot)).toEqual([first]);
    expect(warn).toHaveBeenCalledWith(second, "second-registration");
  });

  it("warns once per plugin, provider and reason", () => {
    resetRunOnWarningsForTest();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    warnRunOnRejectionOnce(slot(), "composed-only");
    warnRunOnRejectionOnce(slot(), "composed-only");
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(consoleWarn.mock.calls[0]?.[0]).toContain(
      `[plugin:account-workers] slots.experimental_runOnProvider "${WORKER}"`,
    );
    consoleWarn.mockRestore();
    resetRunOnWarningsForTest();
  });
});

describe("single pluginSubmission", () => {
  const pool = { pluginId: "account-pool", data: { policy: "named" } };

  it("uses the row item data when the send carries none", () => {
    expect(mergePluginSubmissions(pool, undefined)).toEqual({
      ok: true,
      value: pool,
    });
    expect(mergePluginSubmissions(null, undefined)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  it("lets the same plugin's submit win", () => {
    const submitted = { pluginId: "account-pool", data: { other: 1 } };
    expect(mergePluginSubmissions(pool, submitted)).toEqual({
      ok: true,
      value: submitted,
    });
  });

  it("refuses data from two plugins", () => {
    expect(
      mergePluginSubmissions(pool, { pluginId: "other", data: 1 }),
    ).toEqual({ ok: false, message: TWO_PLUGIN_SUBMISSIONS_MESSAGE });
  });

  it("holds one plugin per scope and refuses data over 16 KB", () => {
    const store = createRunRowSubmissionStore();
    expect(store.set("p\0codex", "account-pool", { a: 1 })).toBe(true);
    expect(store.set("p\0codex", "other", { b: 2 })).toBe(false);
    expect(store.get()?.value).toEqual({
      pluginId: "account-pool",
      data: { a: 1 },
    });
    const big = "x".repeat(RUN_ROW_SUBMISSION_MAX_BYTES);
    expect(store.set("p\0codex", "account-pool", big)).toBe(false);
    expect(store.get()?.value.data).toEqual({ a: 1 });

    expect(store.set("p\0codex", "other", null)).toBe(true);
    expect(store.get()?.value.pluginId).toBe("account-pool");
    expect(store.set("p\0codex", "account-pool", null)).toBe(true);
    expect(store.get()).toBeNull();
  });

  it("treats data from another project or agent provider as stale", () => {
    const store = createRunRowSubmissionStore();
    store.set("p\0codex", "account-pool", { a: 1 });

    expect(store.set("p\0claude-code", "other", { b: 2 })).toBe(true);
    expect(store.get()).toEqual({
      scopeKey: "p\0claude-code",
      value: { pluginId: "other", data: { b: 2 } },
    });
  });

  it("keeps the data through a refused or failed create and clears it only after success", () => {
    const store = createRunRowSubmissionStore();
    store.set("p\0codex", "account-pool", { a: 1 });
    const refused = mergePluginSubmissions(store.get()?.value ?? null, {
      pluginId: "other",
      data: 1,
    });
    expect(refused.ok).toBe(false);
    expect(store.get()?.value.data).toEqual({ a: 1 });

    expect(store.get()?.value.data).toEqual({ a: 1 });
    store.clear();
    expect(store.get()).toBeNull();
  });
});

describe("Run on view model", () => {
  const hosts: RunOnHost[] = [
    { id: "h-b", name: "machine-b", status: "connected", lastSeenAt: 10 },
    { id: "h-a", name: "machine-a", status: "connected", lastSeenAt: 20 },
    {
      id: "h-old",
      name: "old",
      status: "disconnected",
      lastSeenAt: 30,
    },
  ];
  const choice = (
    overrides: Partial<ExperimentalRunOnChoice> = {},
  ): ExperimentalRunOnChoice => ({
    id: "b-a",
    agentHostId: "h-b",
    inputs: { workspaceHostId: "h-a", root: "repo" },
    workspace: { hostId: "h-a", branch: "main" },
    ...overrides,
  });

  it("compares inputs regardless of key order", () => {
    expect(
      sameInputs(
        { a: 1, b: [1, { c: 2, d: 3 }] },
        {
          b: [1, { d: 3, c: 2 }],
          a: 1,
        },
      ),
    ).toBe(true);
    expect(sameInputs({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameInputs(null, undefined)).toBe(false);
  });

  it("orders unavailable reasons: agent offline, provider, workspace offline, plugin", () => {
    const entry = provider();
    expect(choiceUnavailableReason(choice(), entry, hosts)).toBeNull();
    expect(
      choiceUnavailableReason(choice({ agentHostId: "h-old" }), entry, hosts),
    ).toBe("Worker old is offline");
    expect(
      choiceUnavailableReason(
        choice({ agentHostId: "h-unknown" }),
        entry,
        hosts,
      ),
    ).toBe("Worker h-unknown is offline");
    expect(
      choiceUnavailableReason(
        choice({ disabledReason: "No source" }),
        provider({
          machineAvailability: {
            "h-b": { status: "unavailable", message: "Not a worker" },
          },
        }),
        hosts,
      ),
    ).toBe("Not a worker");
    expect(
      choiceUnavailableReason(
        choice({
          workspace: { hostId: "h-old" },
          disabledReason: "No source",
        }),
        entry,
        hosts,
      ),
    ).toBe("Workspace old is offline");
    expect(
      choiceUnavailableReason(
        choice({
          workspace: { hostId: null, label: "cloud" },
          disabledReason: "No source",
        }),
        entry,
        hosts,
      ),
    ).toBe("No source");
  });

  it("builds groups with loading, error and rows", () => {
    const accepted = [{ slot: slot(), provider: provider() }];
    expect(buildGroups(accepted, new Map(), hosts)[0]).toMatchObject({
      status: "loading",
      rows: [],
    });
    const failed = buildGroups(
      accepted,
      new Map([[WORKER, { status: "error" as const, choices: [] }]]),
      hosts,
    );
    expect(failed[0]?.error).toBe("Unavailable");
    const ready = buildGroups(
      accepted,
      new Map([
        [
          WORKER,
          {
            status: "ready" as const,
            choices: [choice(), choice({ id: "x", agentHostId: "h-old" })],
          },
        ],
      ]),
      hosts,
    );
    expect(ready[0]?.rows.map((row) => row.value)).toEqual([
      `runon:${WORKER}:b-a`,
      `runon:${WORKER}:x`,
    ]);
    expect(ready[0]?.rows[1]).toMatchObject({
      agentName: "old",
      workspaceName: "machine-a",
      agentConnected: false,
      unavailableReason: "Worker old is offline",
      lastSeenAt: 30,
    });
  });

  it("labels the chip with agent and workspace and amber states", () => {
    expect(chipText(chipView(hosts, "h-b", choice().workspace))).toEqual({
      agent: "machine-b",
      workspace: "machine-a",
    });
    const offline = chipView(hosts, "h-b", { hostId: "h-old" });
    expect(offline.warning).toBe(true);
    expect(chipText(offline).workspace).toBe("old offline");
    const none = chipView(hosts, "h-old", null);
    expect(chipText(none)).toEqual({
      agent: "old offline",
      workspace: "Choose a workspace",
    });
    expect(
      chipView(hosts, "h-b", { hostId: "h-a", issue: "Behind main" }).warning,
    ).toBe(true);
  });
});
