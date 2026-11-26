// @vitest-environment jsdom
import { writeFile } from "node:fs/promises";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type {
  AccountPoolConfig,
  AccountSummary,
  PoolStatus,
} from "./src/contracts.js";

const app = await loadPluginApp(() => import("./app"));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

const STATUS_CACHE_KEY = "account-pool:status";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function measureAccountRows() {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      const handle = this.querySelector(
        'button[aria-roledescription="sortable"]',
      );
      const rows = Array.from(this.parentElement?.children ?? []);
      return new DOMRect(0, handle ? rows.indexOf(this) * 60 : 0, 600, 60);
    },
  );
}

async function keyboardMove(handle: HTMLElement, code = "ArrowDown") {
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space" });
  await waitFor(() => expect(handle.getAttribute("aria-pressed")).toBe("true"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  fireEvent.keyDown(document, { code });
}

function account(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    accessBlocked: null,
    id: "11111111-1111-4111-8111-111111111111",
    provider: "claude",
    kind: "oauth",
    label: "person@example.com",
    email: "person@example.com",
    accountUuid: null,
    subscriptionType: "Max",
    rateLimitTier: "default_claude_max_5x",
    enabled: true,
    priority: 100,
    createdAt: 1,
    lastUsedAt: 2,
    lastUsedHostId: "host-one",
    lastUsedHostName: "bee",
    fiveHourUtilization: 0.21,
    fiveHourResetAt: null,
    fiveHourStatus: null,
    sevenDayUtilization: null,
    sevenDayResetAt: null,
    sevenDayStatus: null,
    representativeClaim: null,
    familyWeekly: {
      fable: null,
      sonnet: null,
      opus: null,
      haiku: null,
      other: null,
    },
    limitWindows: [],
    extraUsage: null,
    usageRestriction: null,
    observedAt: 1,
    heldUntil: null,
    error: null,
    inFlight: 0,
    status: "ready",
    ...overrides,
  };
}

function status(accounts: AccountSummary[] = [account()]): PoolStatus {
  return {
    route: "/api/v1/plugins/account-pool/http",
    enabledAccountCount: accounts.filter((item) => item.enabled).length,
    inFlight: 2,
    accepting: true,
    hosts: [
      { hostId: "host-one", hostName: "bee", mintedAt: 1, lastUsedAt: 2 },
    ],
    accounts,
    routing: { claude: true, codex: true },
    parent: null,
  };
}

function config(overrides: Partial<AccountPoolConfig> = {}): AccountPoolConfig {
  return {
    anthropicUpstreamBaseUrl: "https://api.anthropic.com",
    codexUpstreamBaseUrl: "https://chatgpt.com/backend-api/codex",
    switchThreshold: 0.98,
    parentMode: "proxy",
    ...overrides,
  };
}

function render(
  accounts = [account()],
  extraRpc: Record<string, () => object | null | Promise<object | null>> = {},
  copyToClipboard?: () => Promise<boolean>,
) {
  return renderSlot(
    app.settingsSections[0]!,
    {},
    {
      rpc: {
        "status.get": () => status(accounts),
        "config.get": () => config(),
        "hostExclusion.list": () => [],
        ...extraRpc,
      },
      openUrl: () => true,
      experimental_copyToClipboard: copyToClipboard,
    },
  );
}

describe("Account Pool parent banner", () => {
  const PARENT_URL = "http://127.0.0.1:25231/api/v1/plugins/account-pool/http";

  function renderWithParent(parent: PoolStatus["parent"]) {
    return renderSlot(
      app.settingsSections[0]!,
      {},
      {
        rpc: {
          "status.get": () => ({ ...status(), parent }),
          "config.get": () => config(),
          "hostExclusion.list": () => [],
        },
        openUrl: () => true,
      },
    );
  }

  it("says nothing about a parent when this server has none", async () => {
    const slot = renderWithParent(null);
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.queryByText(/Account Pooler available/i)).toBeNull();
  });

  it("invites pooling through the parent while isolated, without leaking the api path", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "isolate",
      availability: { claude: true, codex: true },
    });
    expect(
      await slot.findByText("Parent Account Pooler available"),
    ).toBeTruthy();
    expect(
      slot.getByText(/started from a thread on 127\.0\.0\.1:25231/),
    ).toBeTruthy();
    expect(slot.queryByText(/api\/v1\/plugins/)).toBeNull();
  });

  it("names both providers and says local accounts go unused while proxying", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "proxy",
      availability: { claude: true, codex: true },
    });
    expect(
      await slot.findByText("Using the parent Account Pooler"),
    ).toBeTruthy();
    expect(
      slot.getByText(
        /Claude and Codex requests are sent to the pool on 127\.0\.0\.1:25231\. Accounts on this server are not used/,
      ),
    ).toBeTruthy();
  });

  it("calls out a provider the parent cannot serve", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "proxy",
      availability: { claude: true, codex: false },
    });
    expect(
      await slot.findByText(
        /Claude requests are sent to the pool on .*Codex has no accounts there, so those requests fall back/,
      ),
    ).toBeTruthy();
  });

  it("says nothing is routed when the parent has no accounts at all", async () => {
    const slot = renderWithParent({
      baseUrl: PARENT_URL,
      mode: "proxy",
      availability: { claude: false, codex: false },
    });
    expect(
      await slot.findByText(/has no accounts available right now/),
    ).toBeTruthy();
  });
});

describe("Account Pool settings", () => {
  it("shows disabled participation separately from ready health", async () => {
    const slot = render([account({ enabled: false, status: "ready" })]);
    expect(await slot.findByText("Ready")).toBeTruthy();
    expect(slot.getByText("Disabled")).toBeTruthy();
  });

  it("shows disabled verification-required accounts in settings", async () => {
    const target = account({
      enabled: false,
      status: "verification-required",
      accessBlocked: {
        status: 400,
        type: "invalid_request_error",
        message: "Identity verification is required to continue.",
        observedAt: 1,
      },
    });
    const slot = render([target]);
    expect(await slot.findByText("Requires verification (400)")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: `Open ${target.label}` }));
    expect(
      await slot.findByText(/Identity verification is required/),
    ).toBeTruthy();
    expect(slot.getByRole("button", { name: "Enable" })).toBeTruthy();
    expect(slot.getByRole("button", { name: "Diagnostic retry" })).toBeTruthy();
  });

  it("shows disabled access-blocked accounts and sends an explicit diagnostic retry", async () => {
    const target = account({
      enabled: false,
      status: "access-blocked",
      accessBlocked: {
        status: 403,
        type: "permission_error",
        message: "Access denied",
        observedAt: 1,
      },
    });
    const ping = vi.fn(() => ({
      accountId: target.id,
      model: "haiku",
      status: 200,
      ok: true,
    }));
    const slot = render([target], { "account.ping": ping });
    expect(await slot.findByText("Access blocked (403)")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: `Open ${target.label}` }));
    expect(await slot.findByText(/Access denied/)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Enable" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Diagnostic retry" }));
    await waitFor(() =>
      expect(ping).toHaveBeenCalledWith({ id: target.id, diagnostic: true }),
    );
  });

  it("renders cached accounts as refreshing until live status arrives, then caches it", async () => {
    window.localStorage.setItem(
      STATUS_CACHE_KEY,
      JSON.stringify(status([account({ fiveHourUtilization: 0.21 })])),
    );
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("21%")).toBeTruthy();
    expect(slot.getByText("refreshing usage…")).toBeTruthy();
    expect(slot.getByText(/· refreshing…$/)).toBeTruthy();
    expect(slot.queryByText("Loading…")).toBeNull();
    expect(slot.queryByText("No accounts in the central pool")).toBeNull();
    live.resolve(status([account({ fiveHourUtilization: 0.6 })]));
    expect(await slot.findByText("60%")).toBeTruthy();
    expect(slot.queryByText("refreshing usage…")).toBeNull();
    expect(slot.queryByText(/· refreshing…$/)).toBeNull();
    const cached = JSON.parse(
      window.localStorage.getItem(STATUS_CACHE_KEY) ?? "null",
    ) as PoolStatus;
    expect(cached.accounts[0]?.fiveHourUtilization).toBe(0.6);
  });

  it("discards a legacy disabled status cache and loads independent live health", async () => {
    const old = status([account({ enabled: false, status: "ready" })]);
    window.localStorage.setItem(
      STATUS_CACHE_KEY,
      JSON.stringify({
        ...old,
        accounts: old.accounts.map((a) => ({ ...a, status: "disabled" })),
      }),
    );
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getAllByText("Loading…")).toHaveLength(2);
    live.resolve(status([account({ enabled: false, status: "ready" })]));
    expect(await slot.findByText("Ready")).toBeTruthy();
    expect(slot.getByText("Disabled")).toBeTruthy();
  });

  it("ignores a malformed status cache and shows the loading state", async () => {
    window.localStorage.setItem(STATUS_CACHE_KEY, '{"accounts":"nope"}');
    const live = deferred<PoolStatus>();
    const slot = render([], { "status.get": () => live.promise });
    expect(slot.getAllByText("Loading…")).toHaveLength(2);
    live.resolve(status());
    expect(await slot.findByText("person@example.com")).toBeTruthy();
  });

  it("marks a row as refreshing while its usage refresh is in flight", async () => {
    const refresh = deferred<{ account: null }>();
    const slot = render([account()], {
      "account.refreshUsage": () => refresh.promise,
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Refresh usage"));
    expect(await slot.findByText("refreshing usage…")).toBeTruthy();
    refresh.resolve({ account: null });
    await waitFor(() =>
      expect(slot.queryByText("refreshing usage…")).toBeNull(),
    );
  });

  it("renders fixed quota slots with missing buckets as em dashes", async () => {
    const slot = render();
    expect(await slot.findByText("person@example.com")).toBeTruthy();
    expect(slot.getByText("5H")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("FABLE")).toBeTruthy();
    expect(slot.getAllByText("—")).toHaveLength(2);
    expect(
      slot.getByText("Hub accepting · 2 in flight · used by bee"),
    ).toBeTruthy();
  });

  it("keeps the quota slots visible at mobile widths", async () => {
    const slot = render();
    const group = (await slot.findByText("5H")).parentElement?.parentElement;
    expect(group).toBeTruthy();
    expect(group?.className).not.toMatch(/(^|\s)hidden(\s|$)/u);
  });

  it("renders only the windows a Codex account reports and no Fable slot", async () => {
    const blockingResetAt = Date.now() + 6 * 24 * 60 * 60 * 1_000;
    const slot = render([
      account({
        id: "22222222-2222-4222-8222-222222222222",
        provider: "codex",
        label: "pro@example.com",
        codexAccountId: "chatgpt-account",
        status: "exhausted",
        fiveHourUtilization: 0.25,
        fiveHourResetAt: Date.now() + 60 * 60 * 1_000,
        limitWindows: [
          {
            slot: "primary",
            windowMinutes: 10_080,
            utilization: 1,
            resetAt: blockingResetAt,
            status: "rejected",
            observedAt: 1,
            source: "usage",
          },
        ],
      }),
    ]);
    expect(await slot.findByText("pro@example.com")).toBeTruthy();
    expect(slot.getByText("7D")).toBeTruthy();
    expect(slot.getByText("100%")).toBeTruthy();
    expect(slot.queryByText("5H")).toBeNull();
    expect(slot.queryByText("FABLE")).toBeNull();
    expect(
      slot.getByText(
        `Exhausted · resets ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(blockingResetAt)}`,
      ),
    ).toBeTruthy();
    fireEvent.click(
      await slot.findByRole("button", { name: "Open pro@example.com details" }),
    );
    expect(await slot.findByText("Weekly")).toBeTruthy();
    expect(slot.queryByText("5 hour")).toBeNull();
    expect(slot.queryByText("7 day")).toBeNull();
  });

  it.each([
    {
      action: "Disable",
      method: "account.disable",
      input: { id: account().id },
    },
    {
      action: "Refresh usage",
      method: "account.refreshUsage",
      input: { accountId: account().id },
    },
  ])(
    "dispatches $action to its RPC contract",
    async ({ action, method, input }) => {
      const slot = render([account()], {
        [method]: () => ({ account: null }),
      });
      fireEvent.pointerDown(
        await slot.findByRole("button", { name: "person@example.com actions" }),
      );
      fireEvent.click(await slot.findByText(action));
      expect(slot.rpcCalls).toContainEqual({ method, input });
    },
  );

  it("confirms Remove before dispatching its RPC contract", async () => {
    const slot = render([account()], {
      "account.remove": () => ({ removed: true }),
    });
    fireEvent.pointerDown(
      await slot.findByRole("button", { name: "person@example.com actions" }),
    );
    fireEvent.click(await slot.findByText("Remove"));
    expect(await slot.findByText("Remove person@example.com?")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "account.remove")).toBe(
      false,
    );
    fireEvent.click(slot.getByRole("button", { name: "Remove" }));
    expect(slot.rpcCalls).toContainEqual({
      method: "account.remove",
      input: { id: account().id },
    });
  });

  it("opens the correct provider sign-in flow from each Add account menu", async () => {
    const slot = render([], {
      "login.start": () => ({
        sessionId: "22222222-2222-4222-8222-222222222222",
        authorizeUrl: "https://claude.ai/oauth/authorize",
      }),
      "codexLogin.start": () => ({
        sessionId: "33333333-3333-4333-8333-333333333333",
        verificationUri: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: Date.now() + 600_000,
        intervalMs: 60_000,
      }),
    });
    const addButtons = await slot.findAllByRole("button", {
      name: "Add account",
    });
    fireEvent.pointerDown(addButtons[0]!);
    fireEvent.click(
      await slot.findByText("Sign in to Claude", { selector: "span.block" }),
    );
    expect(
      await slot.findByLabelText("Claude authorization code"),
    ).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.pointerDown(addButtons[1]!);
    fireEvent.click(
      await slot.findByText("Sign in to Codex", { selector: "span.block" }),
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
  });

  it("persists provider routing from the section switch", async () => {
    const slot = render([account()], {
      "routing.set": () => ({ provider: "claude", enabled: false }),
    });
    fireEvent.click(
      await slot.findByRole("switch", { name: "Route Claude threads" }),
    );
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "routing.set",
        input: { provider: "claude", enabled: false },
      }),
    );
  });

  it("edits Advanced config fields and shows URL validation inline", async () => {
    const nextConfig = config({
      anthropicUpstreamBaseUrl: "https://proxy.example.com",
    });
    const slot = render([account()], {
      "config.set": () => nextConfig,
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const anthropic = await slot.findByLabelText("Anthropic upstream base URL");
    if (!(anthropic instanceof HTMLInputElement)) {
      throw new Error("Expected the Anthropic config field to be an input.");
    }
    await waitFor(() =>
      expect(anthropic.value).toBe("https://api.anthropic.com"),
    );
    expect(slot.getByLabelText("Codex upstream base URL")).toBeTruthy();
    expect(slot.getByLabelText("Quota switch threshold")).toBeTruthy();

    fireEvent.change(anthropic, { target: { value: "ftp://invalid.example" } });
    fireEvent.blur(anthropic);
    expect(await slot.findByText("Must be an HTTP or HTTPS URL.")).toBeTruthy();
    expect(slot.rpcCalls.some((call) => call.method === "config.set")).toBe(
      false,
    );

    fireEvent.change(anthropic, {
      target: { value: "https://proxy.example.com" },
    });
    fireEvent.blur(anthropic);
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "config.set",
        input: { anthropicUpstreamBaseUrl: "https://proxy.example.com" },
      }),
    );
  });

  it("shows every observed family bucket in the detail dialog", async () => {
    const fable = {
      utilization: 0.91,
      resetAt: Date.now() + 3_600_000,
      status: null,
      observedAt: 1,
      source: "usage" as const,
    };
    const slot = render([
      account({
        familyWeekly: {
          fable,
          sonnet: null,
          opus: { ...fable, utilization: 0.2 },
          haiku: null,
          other: null,
        },
      }),
    ]);
    fireEvent.click(
      await slot.findByRole("button", {
        name: "Open person@example.com details",
      }),
    );
    expect(await slot.findByText("Fable 7 day")).toBeTruthy();
    expect(slot.getByText("Opus 7 day")).toBeTruthy();
  });

  it("shows the email beside a display-name label in the row and detail dialog", async () => {
    const slot = render([
      account({ label: "Person Example", email: "person@example.com" }),
      account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Claude API key",
        email: null,
      }),
    ]);
    expect(await slot.findByText("Person Example")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(1);
    fireEvent.click(
      slot.getByRole("button", { name: "Open Person Example details" }),
    );
    expect(await slot.findByText("Email")).toBeTruthy();
    expect(slot.getAllByText("person@example.com")).toHaveLength(2);
  });

  function codexLoginStart() {
    return {
      sessionId: "33333333-3333-4333-8333-333333333333",
      verificationUri: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: Date.now() + 600_000,
      intervalMs: 60_000,
    };
  }

  function mockCompactViewport(matches: boolean) {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)" && matches,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }));
  }

  it("names the sign-in dialog once and keeps the step instructions", async () => {
    const slot = render([], { "codexLogin.start": codexLoginStart });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const dialog = await slot.findByRole("dialog", {
      name: "Sign in to Codex",
    });
    expect(
      slot.getAllByRole("heading", { name: "Sign in to Codex" }),
    ).toHaveLength(1);
    expect(dialog.textContent).toContain(
      "Open the verification page, sign in to ChatGPT, and enter this code.",
    );
    expect(
      (await slot.findByLabelText("Codex user code")).textContent,
    ).toContain("ABCD-1234");
    expect(slot.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it.each([false, true])(
    "cancels the pending sign-in from the header close with compact viewport %s",
    async (compact) => {
      mockCompactViewport(compact);
      const slot = render([], {
        "codexLogin.start": codexLoginStart,
        "codexLogin.poll": () => ({ status: "pending" }),
        "codexLogin.cancel": () => ({ cancelled: true }),
      });
      fireEvent.click(
        await slot.findByRole("button", { name: "Sign in to Codex" }),
      );
      await slot.findByRole("dialog", { name: "Sign in to Codex" });
      fireEvent.click(slot.getByRole("button", { name: "Close" }));
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "codexLogin.cancel",
          input: { sessionId: codexLoginStart().sessionId },
        }),
      );
      await waitFor(() =>
        expect(slot.queryByRole("dialog", { name: "Sign in to Codex" })).toBe(
          null,
        ),
      );
      const polls = () =>
        slot.rpcCalls.filter((call) => call.method === "codexLogin.poll")
          .length;
      const settled = polls();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(polls()).toBe(settled);
    },
  );

  it("does not claim success when copying the device code fails", async () => {
    const copy = deferred<boolean>();
    const slot = render(
      [],
      { "codexLogin.start": codexLoginStart },
      () => copy.promise,
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const button = await slot.findByRole("button", {
      name: "Copy Codex sign-in code",
    });
    fireEvent.click(button);
    expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: "ABCD-1234" },
    ]);
    await act(async () => copy.resolve(false));
    expect(window.getSelection()?.toString()).toBe("ABCD-1234");
    expect(slot.queryByText("Sign-in code copied")).toBeNull();
    expect(button.querySelector('[data-icon="Check"]')).toBeNull();
  });

  it("does not claim success when copying the authorization URL fails", async () => {
    const copy = deferred<boolean>();
    const slot = render(
      [],
      { "codexLogin.start": codexLoginStart },
      () => copy.promise,
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    const button = await slot.findByRole("button", {
      name: "Copy Codex authorization URL",
    });
    fireEvent.click(button);
    expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: "https://auth.openai.com/codex/device" },
    ]);
    await act(async () => copy.resolve(false));
    const input = slot.getByRole("textbox", {
      name: "Codex authorization URL",
    }) as HTMLInputElement;
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(button.textContent).not.toContain("Copied");
    expect(slot.queryByText("Authorization URL copied")).toBeNull();
  });

  it("keeps polling and the close action working after copying the code", async () => {
    const copy = deferred<boolean>();
    const slot = render(
      [],
      {
        "codexLogin.start": codexLoginStart,
        "codexLogin.poll": () => ({ status: "pending" }),
        "codexLogin.cancel": () => ({ cancelled: true }),
      },
      () => copy.promise,
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(
      await slot.findByRole("button", { name: "Copy Codex sign-in code" }),
    );
    expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: "ABCD-1234" },
    ]);
    await act(async () => copy.resolve(true));
    expect(
      (await slot.findByRole("dialog", { name: "Sign in to Codex" }))
        .textContent,
    ).toContain("Waiting for you to authorize");
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "codexLogin.cancel",
        input: { sessionId: codexLoginStart().sessionId },
      }),
    );
  });

  it("offers a fresh Codex login after device-code polling fails", async () => {
    let starts = 0;
    const slot = render([], {
      "codexLogin.start": () => {
        starts += 1;
        return {
          sessionId: "33333333-3333-4333-8333-333333333333",
          verificationUri: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
          expiresAt: Date.now() + 600_000,
          intervalMs: 1,
        };
      },
      "codexLogin.poll": () => ({ status: "error", message: "Code expired." }),
    });
    fireEvent.click(
      await slot.findByRole("button", { name: "Sign in to Codex" }),
    );
    fireEvent.click(await slot.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(starts).toBe(2));
  });
  it.each(["claude", "codex"] as const)(
    "reorders %s accounts with the keyboard and persists the displayed order",
    async (provider) => {
      measureAccountRows();
      const first = account({ label: "First", provider });
      const second = account({
        id: "22222222-2222-4222-8222-222222222222",
        label: "Second",
        provider,
      });
      const other = account({
        id: "33333333-3333-4333-8333-333333333333",
        provider: provider === "claude" ? "codex" : "claude",
        label: "Other",
      });
      const accounts = [first, second, other];
      let finishSave = () => {};
      const slot = render(accounts, {
        "account.reorder": () =>
          new Promise<null>((resolve) => {
            finishSave = () => {
              accounts.splice(0, 2, second, first);
              resolve(null);
            };
          }),
      });
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle);
      fireEvent.keyDown(document, { code: "Space" });
      await waitFor(() =>
        expect(slot.rpcCalls).toContainEqual({
          method: "account.reorder",
          input: { provider, accountIds: [second.id, first.id] },
        }),
      );
      const providerOrder = () =>
        slot
          .getAllByRole("button", { name: /Reorder (First|Second)/ })
          .map((button) => button.getAttribute("aria-label"));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(handle.hasAttribute("disabled")).toBe(true);
      finishSave();
      await waitFor(() => expect(handle.hasAttribute("disabled")).toBe(false));
      expect(providerOrder()).toEqual(["Reorder Second", "Reorder First"]);
      expect(
        slot
          .getByRole("button", { name: "Reorder Other" })
          .hasAttribute("disabled"),
      ).toBe(true);
    },
  );

  it("restores the displayed order and reports a rejected reorder", async () => {
    measureAccountRows();
    const slot = render(
      [
        account({ label: "First" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
        }),
      ],
      {
        "account.reorder": () => {
          throw new Error("Refresh the account list and try again.");
        },
      },
    );
    const handle = await slot.findByRole("button", { name: "Reorder First" });
    await keyboardMove(handle);
    fireEvent.keyDown(document, { code: "Space" });
    expect(
      await slot.findByText("Refresh the account list and try again."),
    ).toBeTruthy();
    expect(
      slot
        .getAllByRole("button", { name: /Reorder/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Reorder First", "Reorder Second"]);
    expect(handle.hasAttribute("disabled")).toBe(false);
  });

  it.each(["cancel", "unchanged"])(
    "does not save a %s drag",
    async (action) => {
      measureAccountRows();
      const slot = render([
        account({ label: "First" }),
        account({
          id: "22222222-2222-4222-8222-222222222222",
          label: "Second",
        }),
      ]);
      const handle = await slot.findByRole("button", { name: "Reorder First" });
      await keyboardMove(handle, action === "cancel" ? "ArrowDown" : "ArrowUp");
      fireEvent.keyDown(document, {
        code: action === "cancel" ? "Escape" : "Space",
      });
      await waitFor(() =>
        expect(handle.getAttribute("aria-pressed")).toBeNull(),
      );
      expect(
        slot.rpcCalls.filter((call) => call.method === "account.reorder"),
      ).toEqual([]);
      expect(
        slot
          .getAllByRole("button", { name: /Reorder/ })
          .map((button) => button.getAttribute("aria-label")),
      ).toEqual(["Reorder First", "Reorder Second"]);
    },
  );
});

it("adds an OpenAI API key from the Codex section", async () => {
  const slot = render([], {
    "account.add": () => account({ provider: "codex", kind: "api-key" }),
  });
  const buttons = await slot.findAllByRole("button", { name: "Add account" });
  fireEvent.pointerDown(buttons[1]!);
  fireEvent.click(
    await slot.findByText("Add API key…", { selector: "span.block" }),
  );
  fireEvent.change(await slot.findByLabelText("OpenAI API key"), {
    target: { value: "sk-ui-test-only" },
  });
  fireEvent.click(slot.getByRole("button", { name: "Add API key" }));
  await waitFor(() =>
    expect(slot.rpcCalls).toContainEqual({
      method: "account.add",
      input: {
        provider: "codex",
        source: { kind: "api-key", apiKey: "sk-ui-test-only" },
        label: null,
        priority: 100,
      },
    }),
  );
});

it("lists unminted and retained machines and saves exclusions authoritatively", async () => {
  let excluded = false;
  const slot = render([], {
    "hostExclusion.list": () => [
      { hostId: "new-host", hostName: "New", enrolled: true, excluded },
      { hostId: "gone", hostName: null, enrolled: false, excluded: true },
    ],
    "hostExclusion.set": () => {
      excluded = true;
      return { hostId: "new-host", hostName: "New", enrolled: true, excluded };
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
  const toggle = await slot.findByRole("switch", {
    name: "Exclude New from central pooling",
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  expect(await slot.findByText(/No longer enrolled/)).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect(slot.rpcCalls).toContainEqual({
    method: "hostExclusion.set",
    input: { hostId: "new-host", excluded: true },
  });
});

it("keeps the authoritative machine policy on a failed save", async () => {
  const slot = render([], {
    "hostExclusion.list": () => [
      { hostId: "new-host", hostName: "New", enrolled: true, excluded: false },
    ],
    "hostExclusion.set": () => {
      throw new Error("Policy save failed");
    },
  });
  fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
  const toggle = await slot.findByRole("switch", {
    name: "Exclude New from central pooling",
  });
  fireEvent.click(toggle);
  expect(await slot.findByText("Policy save failed")).toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

it("disables rotation for an excluded machine", async () => {
  const slot = render([], {
    "hostExclusion.list": () => [
      { hostId: "host-one", hostName: "bee", enrolled: true, excluded: true },
    ],
  });
  fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
  expect(
    (
      await slot.findByRole("button", {
        name: "bee: Excluded from central pooling",
      })
    ).hasAttribute("disabled"),
  ).toBe(true);
});

it("keeps the saved authoritative row when reconciliation fails and an older list completes", async () => {
  const stale = deferred<object>();
  let reads = 0;
  const initial = {
    hostId: "new-host",
    hostName: "New",
    enrolled: true,
    excluded: false,
  };
  const slot = render([], {
    "hostExclusion.list": () => {
      reads++;
      if (reads === 1) return [initial];
      if (reads === 2) return stale.promise;
      throw new Error("Reconciliation failed");
    },
    "hostExclusion.set": () => ({ ...initial, excluded: true }),
  });
  fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
  const toggle = await slot.findByRole("switch", {
    name: "Exclude New from central pooling",
  });
  await slot.emitRealtime("host-exclusions-changed", {});
  fireEvent.click(toggle);
  expect(await slot.findByText("Reconciliation failed")).toBeTruthy();
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => {
    stale.resolve([initial]);
  });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
});

it.each([true, false])(
  "includes a machine and removes an unenrolled retained row (enrolled=%s)",
  async (enrolled) => {
    const row = {
      hostId: "target",
      hostName: enrolled ? "Target" : null,
      enrolled,
      excluded: true,
    };
    let saved = false;
    const slot = render([], {
      "hostExclusion.list": () =>
        saved ? (enrolled ? [{ ...row, excluded: false }] : []) : [row],
      "hostExclusion.set": () => {
        saved = true;
        return { ...row, excluded: false };
      },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    const name = `Exclude ${row.hostName ?? row.hostId} from central pooling`;
    fireEvent.click(await slot.findByRole("switch", { name }));
    await waitFor(() =>
      expect(slot.rpcCalls).toContainEqual({
        method: "hostExclusion.set",
        input: { hostId: "target", excluded: false },
      }),
    );
    await waitFor(() =>
      enrolled
        ? expect(
            slot.getByRole("switch", { name }).getAttribute("aria-checked"),
          ).toBe("false")
        : expect(slot.queryByRole("switch", { name })).toBeNull(),
    );
  },
);

it("disables only the saving row and refreshes external realtime policy", async () => {
  const save = deferred<object>();
  let excluded = false;
  const row = {
    hostId: "one",
    hostName: "One",
    enrolled: true,
    excluded: false,
  };
  const slot = render([], {
    "hostExclusion.list": () => [
      row,
      { ...row, hostId: "two", hostName: "Two", excluded },
    ],
    "hostExclusion.set": () => save.promise,
  });
  fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
  const one = await slot.findByRole("switch", {
    name: "Exclude One from central pooling",
  });
  const two = slot.getByRole("switch", {
    name: "Exclude Two from central pooling",
  });
  fireEvent.click(one);
  await waitFor(() => expect(one.hasAttribute("disabled")).toBe(true));
  expect(two.hasAttribute("disabled")).toBe(false);
  excluded = true;
  await slot.emitRealtime("host-exclusions-changed", {});
  await waitFor(() => expect(two.getAttribute("aria-checked")).toBe("true"));
  await act(async () => {
    save.resolve({ ...row, excluded: true });
  });
  await waitFor(() => expect(one.hasAttribute("disabled")).toBe(false));
});

it.each([1440, 390])(
  "renders machine routing controls at %spx in the local settings harness",
  async (width) => {
    vi.stubGlobal("innerWidth", width);
    const slot = render([], {
      "hostExclusion.list": () => [
        {
          hostId: "native-one",
          hostName: "Native machine",
          enrolled: true,
          excluded: true,
        },
        { hostId: "retired", hostName: null, enrolled: false, excluded: true },
      ],
    });
    fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
    expect(await slot.findByText("Machine routing")).toBeTruthy();
    expect(
      await slot.findByRole("switch", {
        name: "Exclude Native machine from central pooling",
      }),
    ).toBeTruthy();
    expect(
      await slot.findByRole("switch", {
        name: "Exclude retired from central pooling",
      }),
    ).toBeTruthy();
    expect(await slot.findByText(/No longer enrolled/)).toBeTruthy();
    if (process.env.EXCLUSION_UI_CAPTURE_DIR) {
      await writeFile(
        `${process.env.EXCLUSION_UI_CAPTURE_DIR}/native-exclusion-ui-${width}.fragment.html`,
        slot.container.innerHTML,
      );
    }
  },
);

it.each([1440, 390])(
  "renders and submits native workers through real controller at %spx",
  async (width) => {
    vi.stubGlobal("innerWidth", width);
    const { default: Database } = await import("better-sqlite3");
    const { NativePool, NativePoolStore } =
      await import("./src/native-pool.js");
    const { nativeHandlers, nativePoolContract } =
      await import("./src/native-surface.js");
    const { QUOTA_MIGRATIONS } = await import("./src/store.js");
    const db = new Database(":memory:");
    for (const sql of QUOTA_MIGRATIONS) db.exec(sql);
    const store = new NativePoolStore(db);
    for (const [id, label] of [
      ["one", "Account One"],
      ["two", "Account Two"],
    ]) {
      store.enroll({
        id,
        hostId: `host-${id}`,
        generation: "g1",
        label,
        workspace: `/runtime/${id}`,
        sshTarget: `owner@${id}:/work`,
      });
      db.prepare("INSERT INTO pool_host_exclusion(host_id) VALUES (?)").run(
        `host-${id}`,
      );
      store.configure(id, true, true);
    }
    const send = vi.fn(async () => ({
      kind: "queued" as const,
      queueId: "native-q",
    }));
    const pool = new NativePool(
      store,
      {
        observe: async () => ({
          generation: "g1",
          epoch: "fake-boot",
          lock: "free",
          threadId: null,
        }),
        spawn: async () => ({ threadId: "native-thread" }),
        send,
        recheck: async () => {},
        findCreated: async () => [],
        releaseIdle: async () => "busy",
        stop: async () => {},
        cancelQueue: async () => {},
      },
      { enabled: true, qualified: true },
    );
    try {
      const slot = renderSlot(
        app.settingsSections[0]!,
        {},
        {
          rpc: {
            "status.get": () => status(),
            "config.get": () => config(),
            "hostExclusion.list": () => [],
            "native.status": () => nativeHandlers(pool)["native.status"](null),
            "native.reconcile": () =>
              nativeHandlers(pool)["native.reconcile"](null),
            "native.submit": (input: unknown) =>
              nativeHandlers(pool)["native.submit"](
                nativePoolContract["native.submit"].input.parse(input),
              ),
            "native.stop": (input: unknown) =>
              nativeHandlers(pool)["native.stop"](
                nativePoolContract["native.stop"].input.parse(input),
              ),
          },
        },
      );
      fireEvent.click(await slot.findByRole("button", { name: "Advanced" }));
      await slot.findByText("Account One / host-one");
      fireEvent.change(slot.getByLabelText("Project ID"), {
        target: { value: "project-native" },
      });
      fireEvent.change(slot.getByLabelText("Task"), {
        target: { value: "First native task" },
      });
      fireEvent.change(slot.getByLabelText("Cell"), {
        target: { value: "one" },
      });
      fireEvent.click(slot.getByRole("button", { name: "Submit" }));
      await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
      await waitFor(() =>
        expect((slot.getByLabelText("Task") as HTMLTextAreaElement).value).toBe(
          "",
        ),
      );
      fireEvent.change(slot.getByLabelText("Task"), {
        target: { value: "Waiting task" },
      });
      fireEvent.click(slot.getByRole("button", { name: "Submit" }));
      await waitFor(() => expect(store.status().intents).toHaveLength(2));
      expect(store.status().intents[1].phase).toBe("waiting");
      fireEvent.click(slot.getByRole("button", { name: "Reconcile" }));
      await waitFor(() =>
        expect(
          slot
            .getByRole("button", { name: "Reconcile" })
            .hasAttribute("disabled"),
        ).toBe(false),
      );
      expect(send).toHaveBeenCalledTimes(1);
      if (process.env.NATIVE_UI_CAPTURE_DIR)
        await writeFile(
          `${process.env.NATIVE_UI_CAPTURE_DIR}/native-controller-ui-${width}.fragment.html`,
          slot.container.innerHTML,
        );
    } finally {
      db.close();
    }
  },
);
