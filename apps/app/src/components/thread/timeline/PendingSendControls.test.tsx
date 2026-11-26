// @vitest-environment jsdom

import { memo, useContext } from "react";
import { PendingSendPresentationContext } from "./pending-send-presentation";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { seedPendingSendThread } from "@/test/fixtures/pending-send";
import {
  pendingSendOwner,
  clearPendingSendScope,
} from "@/hooks/cache-owners/pending-send-owner";
import { expect, it, vi } from "vitest";
import {
  fireEvent,
  waitFor,
  render,
  screen,
  cleanup,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "@/lib/query-client";
import { beginSendThreadMessageTransaction } from "@/hooks/cache-owners/thread-runtime-cache-owner";
import { MemoryRouter } from "react-router-dom";
import { composePendingSends } from "@/hooks/cache-owners/pending-send-owner";
import { ThreadTimelineSurface } from "./ThreadTimelineSurface";
import {
  PendingSendControls,
  PendingSendPresentation,
} from "./PendingSendControls";

it("keeps per-message delivery labels out of the shared recovery banner", async () => {
  const client = createAppQueryClient();
  await beginSendThreadMessageTransaction({
    queryClient: client,
    request: {
      id: "thread-1",
      mode: "auto",
      input: [{ type: "text", text: "owner content", mentions: [] }],
    },
  });
  try {
    render(
      <QueryClientProvider client={client}>
        <PendingSendControls threadId="thread-1" />
      </QueryClientProvider>,
    );
    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.getByText("Reload recovery unavailable")).toBeTruthy();
  } finally {
    cleanup();
    client.clear();
  }
});

it("attaches delivery controls to the native pending owner message", async () => {
  const client = createAppQueryClient();
  await beginSendThreadMessageTransaction({
    queryClient: client,
    request: {
      id: "thread-1",
      mode: "auto",
      input: [{ type: "text", text: "owner content", mentions: [] }],
    },
  });
  try {
    render(
      <MemoryRouter>
        <QueryClientProvider client={client}>
          <PendingSendPresentation threadId="thread-1">
            <ThreadTimelineSurface
              activeThinking={null}
              contextBoundarySeq={null}
              isThreadTimelinePending={false}
              showOngoingIndicator={false}
              threadId="thread-1"
              threadRuntimeDisplayStatus="idle"
              timelineError={false}
              timelineRows={composePendingSends(client, "thread-1").rows}
            />
          </PendingSendPresentation>
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("owner content")).toBeTruthy();
    expect(
      screen.getByText("Sending…").closest("[data-pending-send-id]"),
    ).toBeTruthy();
  } finally {
    cleanup();
    client.clear();
  }
});

it("keeps the presentation context stable across unrelated parent renders", () => {
  const client = createAppQueryClient();
  const values: unknown[] = [];
  const Probe = memo(function Probe() {
    values.push(useContext(PendingSendPresentationContext));
    return null;
  });
  const view = () => (
    <QueryClientProvider client={client}>
      <PendingSendPresentation threadId="thread-1">
        <Probe />
      </PendingSendPresentation>
    </QueryClientProvider>
  );
  try {
    const rendered = render(view());
    const initial = values[0];
    rendered.rerender(view());
    expect(values).toHaveLength(1);
    expect(values[0]).toBe(initial);
  } finally {
    cleanup();
    client.clear();
  }
});

it("hands custody back to the draft on an actual server scope change and explicit logout, not query removal", async () => {
  const client = createAppQueryClient();
  client.setQueryData(
    systemConfigQueryKey(),
    makeSystemConfig({ primaryHostId: "host-a", dataDir: "/fixture-a" }),
  );
  const send = () =>
    beginSendThreadMessageTransaction({
      queryClient: client,
      request: {
        id: "thread-1",
        mode: "auto",
        input: [{ type: "text", text: "owner", mentions: [] }],
      },
    });
  const draft = seedPendingSendThread(client);
  try {
    await send();
    const owner = pendingSendOwner(client);
    client.removeQueries({ queryKey: systemConfigQueryKey() });
    expect(owner.list()).toHaveLength(1);
    client.setQueryData(
      systemConfigQueryKey(),
      makeSystemConfig({ primaryHostId: "host-b", dataDir: "/fixture-b" }),
    );
    expect(owner.list()).toEqual([]);
    expect(draft.getCurrent().text).toBe("owner");
    draft.clear();
    await send();
    clearPendingSendScope(client);
    expect(owner.list()).toEqual([]);
    expect(draft.getCurrent().text).toBe("owner");
    await send();
    clearPendingSendScope(client);
    expect(owner.list()).toMatchObject([{ row: { text: "owner" } }]);
  } finally {
    draft.clear();
    clearPendingSendScope(client);
    client.clear();
  }
});

it("shows unavailable recovery after startup account failure and retries through Refresh without sending", async () => {
  const { bindPendingSendIdentity } =
    await import("@/hooks/cache-owners/pending-send-identity");
  const { sdk } = await import("@/lib/sdk");
  const { wsManager } = await import("@/lib/ws");
  const client = createAppQueryClient();
  const signal = vi.spyOn(wsManager, "onPluginSignal").mockReturnValue(vi.fn());
  const connected = vi.spyOn(wsManager, "onConnected").mockReturnValue(vi.fn());
  const status = vi
    .spyOn(sdk.plugins, "callRpc")
    .mockRejectedValueOnce(Error("account not ready"))
    .mockResolvedValue({ state: "signed-out", revision: 1, account: null });
  const send = vi.spyOn(sdk.threads, "send");
  const dispose = bindPendingSendIdentity(client);
  try {
    render(
      <QueryClientProvider client={client}>
        <PendingSendControls threadId="thread-1" />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("Reload recovery unavailable")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Reload recovery unavailable")).toBeNull(),
    );
    expect(send).not.toHaveBeenCalled();
    expect(pendingSendOwner(client).list()).toEqual([]);
  } finally {
    cleanup();
    dispose();
    signal.mockRestore();
    connected.mockRestore();
    status.mockRestore();
    send.mockRestore();
    client.clear();
  }
});
