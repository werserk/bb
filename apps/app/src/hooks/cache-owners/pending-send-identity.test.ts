// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { systemConfigQueryKey } from "../queries/query-keys";
import { bindPendingSendIdentity } from "./pending-send-identity";
import {
  dispatchPendingSend,
  pendingSendOwner,
  pendingSendJournal,
  composePendingSends,
} from "./pending-send-owner";
import {
  beginSendThreadMessageTransaction,
  applySendThreadMessageSuccess,
} from "./thread-runtime-cache-owner";

it("clears custody across real account signals and fences old receipts and status reads", async () => {
  const client = createAppQueryClient();
  let signal!: Parameters<typeof wsManager.onPluginSignal>[0];
  const off = vi.fn();
  const listener = vi
    .spyOn(wsManager, "onPluginSignal")
    .mockImplementation((fn) => {
      signal = fn;
      return off;
    });
  const connected = vi.spyOn(wsManager, "onConnected").mockReturnValue(off);
  let resolve!: (value: unknown) => void;
  const rpc = vi.spyOn(sdk.plugins, "callRpc").mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const dispose = bindPendingSendIdentity(client);
  const status = (userId: string, revision: number) => ({
    state: "signed-in",
    revision,
    account: { userId, serverId: "server", baseUrl: "https://getbb.app" },
  });
  const emit = (value: unknown) =>
    signal({
      type: "plugin-signal",
      pluginId: "bb-account",
      channel: "account",
      payload: { status: value },
    });
  try {
    client.setQueryData(systemConfigQueryKey(), makeSystemConfig());
    emit(status("a", 1));
    const request = {
      id: "thread-1",
      clientSubmissionId: crypto.randomUUID(),
      mode: "steer" as const,
      input: [{ type: "text" as const, text: "private A", mentions: [] }],
    };
    const transaction = await beginSendThreadMessageTransaction({
      queryClient: client,
      request,
    });
    expect(pendingSendOwner(client).journalEntries()).toHaveLength(1);
    const send = vi.fn();
    const oldSend = dispatchPendingSend(
      client,
      request.id,
      request.clientSubmissionId,
      request,
      [],
      send,
    );
    emit({ state: "signed-out", revision: 2, account: null });
    await expect(oldSend).rejects.toThrow("scope changed");
    expect(send).not.toHaveBeenCalled();
    expect(pendingSendOwner(client).journalEntries()).toEqual([]);
    emit(status("b", 3));
    applySendThreadMessageSuccess({
      queryClient: client,
      request,
      transaction,
      result: { ok: true, delivery: "sent" },
      realtimeConnected: true,
    });
    resolve(status("a", 1));
    await Promise.resolve();
    expect(pendingSendOwner(client).list()).toEqual([]);
    expect(composePendingSends(client, "thread-1").rows).toEqual([]);
    expect(pendingSendJournal(client)?.status).toBe("unavailable");
  } finally {
    dispose();
    listener.mockRestore();
    connected.mockRestore();
    rpc.mockRestore();
    client.clear();
  }
});

it("erases the owned account journal and rejects a late old-account Web Lock grant", async () => {
  const client = createAppQueryClient();
  window.sessionStorage.clear();
  const grants: {
    signal: AbortSignal;
    callback: (lock: object | null) => Promise<void>;
  }[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        options: { signal: AbortSignal },
        callback: (lock: object | null) => Promise<void>,
      ) => {
        grants.push({ signal: options.signal, callback });
      },
    },
  });
  let emit!: Parameters<typeof wsManager.onPluginSignal>[0];
  const listener = vi
    .spyOn(wsManager, "onPluginSignal")
    .mockImplementation((fn) => {
      emit = fn;
      return () => {};
    });
  const connected = vi
    .spyOn(wsManager, "onConnected")
    .mockReturnValue(() => {});
  const rpc = vi
    .spyOn(sdk.plugins, "callRpc")
    .mockImplementation(() => new Promise(() => {}));
  const dispose = bindPendingSendIdentity(client);
  const account = (userId: string, revision: number) =>
    emit({
      type: "plugin-signal",
      pluginId: "bb-account",
      channel: "account",
      payload: {
        status: {
          state: "signed-in",
          revision,
          account: { userId, serverId: "server", baseUrl: "https://getbb.app" },
        },
      },
    });
  try {
    client.setQueryData(systemConfigQueryKey(), makeSystemConfig());
    account("a", 1);
    void grants[0]!.callback({});
    await beginSendThreadMessageTransaction({
      queryClient: client,
      request: {
        id: "thread-1",
        mode: "steer",
        input: [{ type: "text", text: "private A", mentions: [] }],
      },
    });
    expect(Object.values(window.sessionStorage).join(" ")).toContain(
      "private A",
    );
    account("b", 2);
    expect(Object.values(window.sessionStorage).join(" ")).not.toContain(
      "private A",
    );
    const waiting = grants.at(-1)!;
    account("c", 3);
    expect(waiting.signal.aborted).toBe(true);
    await waiting.callback({});
    expect(pendingSendOwner(client).journalEntries()).toEqual([]);
    expect(pendingSendJournal(client)?.status).toBe("waiting");
  } finally {
    dispose();
    listener.mockRestore();
    connected.mockRestore();
    rpc.mockRestore();
    vi.unstubAllGlobals();
    client.clear();
  }
});
