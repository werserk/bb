// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { beginSendThreadMessageTransaction } from "@/hooks/cache-owners/thread-runtime-cache-owner";
import {
  clearPendingSendScope,
  pendingSendJournal,
  setPendingSendIdentity,
  setPendingSendIdentityRetry,
} from "@/hooks/cache-owners/pending-send-owner";
import { PendingSendControls } from "./PendingSendControls";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("updates recovery, identity and retained-send banners without a parent render", async () => {
  const client = createAppQueryClient();
  let acquire: (() => Promise<void>) | undefined;
  vi.stubGlobal("navigator", {
    ...navigator,
    locks: {
      request: vi.fn((_name, _options, callback) => {
        acquire = () => callback({});
        return Promise.resolve();
      }),
    },
  });
  client.setQueryData(
    systemConfigQueryKey(),
    makeSystemConfig({ primaryHostId: "host-banner", dataDir: "/banner-test" }),
  );
  try {
    render(
      <QueryClientProvider client={client}>
        <PendingSendControls threadId="thread-1" />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Restoring pending sends/)).toBeTruthy();
    act(() => {
      void acquire!();
    });
    expect(screen.queryByText(/Restoring pending sends/)).toBeNull();
    expect(screen.queryByText(/Kept in this tab/)).toBeNull();
    await act(async () => {
      await beginSendThreadMessageTransaction({
        queryClient: client,
        request: {
          id: "thread-1",
          mode: "auto",
          input: [{ type: "text", text: "local owner", mentions: [] }],
        },
      });
    });
    expect(screen.getByText(/Kept in this tab/)).toBeTruthy();
    const write = vi
      .spyOn(Object.getPrototypeOf(window.sessionStorage), "setItem")
      .mockImplementation(() => {
        throw Error("storage unavailable");
      });
    act(() => {
      pendingSendJournal(client)?.save([]);
    });
    expect(screen.getByText("Not saved for reload")).toBeTruthy();
    expect(screen.queryByText(/Kept in this tab/)).toBeNull();
    write.mockRestore();
    act(() => {
      pendingSendJournal(client)?.save([]);
    });
    expect(screen.queryByText("Not saved for reload")).toBeNull();
    expect(screen.getByText(/Kept in this tab/)).toBeTruthy();
    act(() => {
      pendingSendJournal(client)?.hide();
    });
    expect(screen.queryByText(/Kept in this tab/)).toBeNull();
    act(() => {
      pendingSendJournal(client)?.refresh();
      void acquire!();
    });
    expect(screen.getByText(/Kept in this tab/)).toBeTruthy();
    act(() => {
      setPendingSendIdentity(client, null);
    });
    expect(screen.getByText("Reload recovery unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    act(() => {
      setPendingSendIdentityRetry(client, async () => {});
    });
    expect(screen.getByRole("button", { name: "Refresh" })).toBeTruthy();
    act(() => {
      setPendingSendIdentityRetry(client, undefined);
      setPendingSendIdentity(client, "account-banner");
    });
    expect(screen.queryByText("Reload recovery unavailable")).toBeNull();
    expect(screen.queryByText(/Kept in this tab/)).toBeNull();
    expect(screen.getByText(/Restoring pending sends/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(screen.queryByText(/Restoring pending sends/)).toBeNull();
  } finally {
    clearPendingSendScope(client);
    client.clear();
  }
});
