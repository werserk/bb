// @vitest-environment jsdom

import { memo, useContext } from "react";
import { PendingSendPresentationContext } from "./pending-send-presentation";
import { systemConfigQueryKey } from "@/hooks/queries/query-keys";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import {
  pendingSendOwner,
  clearPendingSendScope,
} from "@/hooks/cache-owners/pending-send-owner";
import { expect, it } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
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

it("clears custody for an actual server scope change and explicit logout, not query removal", async () => {
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
    await send();
    clearPendingSendScope(client);
    expect(owner.list()).toEqual([]);
  } finally {
    clearPendingSendScope(client);
    client.clear();
  }
});
