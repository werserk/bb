// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { sdk } from "@/lib/sdk";
import { wsManager } from "@/lib/ws";
import { seedPendingSendThread } from "@/test/fixtures/pending-send";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { systemConfigQueryKey } from "../queries/query-keys";
import { bindPendingSendIdentity } from "./pending-send-identity";
import {
  pendingRecoveryStatus,
  pendingSendIdentityUnavailable,
  retryPendingSendRecovery,
  dispatchPendingSend,
  pendingSendOwner,
  pendingSendJournal,
  composePendingSends,
  clearPendingSendScope,
  pendingSendDraftId,
} from "./pending-send-owner";
import {
  beginSendThreadMessageTransaction,
  applySendThreadMessageSuccess,
} from "./thread-runtime-cache-owner";

it("clears custody across account payloads via mocked ws/sdk and fences old receipts and status reads", async () => {
  const client = createAppQueryClient();
  const draft = seedPendingSendThread(client);
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
    // The unacknowledged text went back to its draft, not to the journal.
    expect(draft.getCurrent().text).toBe("private A");
    expect(Object.values(window.sessionStorage).join(" ")).not.toContain(
      "private A",
    );
    expect(pendingSendDraftId("thread-1", draft.getCurrent())).toBe(
      request.clientSubmissionId,
    );
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
  seedPendingSendThread(client);
  window.sessionStorage.clear();
  const grants: {
    signal: AbortSignal | undefined;
    callback: (lock: object | null) => Promise<void>;
  }[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        options: { signal?: AbortSignal },
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
    expect(waiting.signal).toBeUndefined();
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

function identityHarness() {
  const client = createAppQueryClient();
  const draft = seedPendingSendThread(client);
  window.sessionStorage.clear();
  let signal!: Parameters<typeof wsManager.onPluginSignal>[0];
  let connect!: Parameters<typeof wsManager.onConnected>[0];
  const reads: {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }[] = [];
  const listener = vi
    .spyOn(wsManager, "onPluginSignal")
    .mockImplementation((fn) => {
      signal = fn;
      return vi.fn();
    });
  const connected = vi
    .spyOn(wsManager, "onConnected")
    .mockImplementation((fn) => {
      connect = fn;
      return vi.fn();
    });
  const rpc = vi.spyOn(sdk.plugins, "callRpc").mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        reads.push({ resolve, reject });
      }),
  );
  const dispose = bindPendingSendIdentity(client);
  client.setQueryData(systemConfigQueryKey(), makeSystemConfig());
  const status = (userId: string, revision: number) => ({
    state: "signed-in",
    revision,
    account: { userId, serverId: "server", baseUrl: "https://getbb.app" },
  });
  return {
    client,
    draft,
    reads,
    status,
    reconnect: () => connect({ reconnected: true, disconnectedAt: Date.now() }),
    emit: (status: unknown) =>
      signal({
        type: "plugin-signal",
        pluginId: "bb-account",
        channel: "account",
        payload: { status },
      }),
    close: () => {
      dispose();
      listener.mockRestore();
      connected.mockRestore();
      rpc.mockRestore();
      client.clear();
    },
  };
}

it("adopts initial account status without losing a send or rejecting its admitted receipt", async () => {
  const h = identityHarness();
  try {
    const request = {
      id: "thread-1",
      clientSubmissionId: crypto.randomUUID(),
      mode: "steer" as const,
      input: [{ type: "text" as const, text: "boot send", mentions: [] }],
    };
    const transaction = await beginSendThreadMessageTransaction({
      queryClient: h.client,
      request,
    });
    let resolve!: (value: { ok: true; delivery: "sent" }) => void;
    const dispatched = dispatchPendingSend(
      h.client,
      request.id,
      request.clientSubmissionId,
      request,
      [],
      () =>
        new Promise<{ ok: true; delivery: "sent" }>((done) => {
          resolve = done;
        }),
    );
    await Promise.resolve();
    const entry = pendingSendOwner(h.client).list()[0];
    h.reads[0]!.resolve(h.status("a", 1));
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingSendOwner(h.client).list()[0]).toBe(entry);
    resolve({ ok: true, delivery: "sent" });
    await expect(dispatched).resolves.toEqual({ ok: true, delivery: "sent" });
    const timeline = vi
      .spyOn(sdk.threads, "timeline")
      .mockImplementation(() => new Promise(() => {}));
    const queue = vi
      .spyOn(sdk.threads.queuedMessages, "list")
      .mockImplementation(() => new Promise(() => {}));
    try {
      applySendThreadMessageSuccess({
        queryClient: h.client,
        request,
        transaction,
        result: {
          ok: true,
          delivery: "sent",
          requested: { requestId: "creq_0000000000", sequence: 12 },
        },
        realtimeConnected: true,
      });
      expect(pendingSendOwner(h.client).list()[0]?.state).toBe("sent");
    } finally {
      timeline.mockRestore();
      queue.mockRestore();
    }
  } finally {
    h.close();
  }
});

it("preserves confirmed custody across profile-pending and same-account recovery, but clears on a true switch", async () => {
  const h = identityHarness();
  const grants: {
    signal: AbortSignal | undefined;
    callback: (lock: object | null) => Promise<void>;
  }[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        options: { signal?: AbortSignal },
        callback: (lock: object | null) => Promise<void>,
      ) => {
        grants.push({ signal: options.signal, callback });
      },
    },
  });
  try {
    h.emit(h.status("a", 1));
    await beginSendThreadMessageTransaction({
      queryClient: h.client,
      request: {
        id: "thread-1",
        mode: "steer",
        input: [{ type: "text", text: "owner A", mentions: [] }],
      },
    });
    const entry = pendingSendOwner(h.client).list()[0];
    const before = grants[0]!;
    h.emit({ state: "profile-pending", revision: 2, account: null });
    expect(before.signal).toBeUndefined();
    await before.callback({});
    expect(pendingSendOwner(h.client).list()[0]).toBe(entry);
    expect(pendingRecoveryStatus(h.client)).toBe("unavailable");
    expect(pendingSendIdentityUnavailable(h.client)).toBe(true);
    h.emit(h.status("a", 3));
    expect(pendingSendOwner(h.client).list()[0]).toBe(entry);
    expect(grants).toHaveLength(2);
    h.emit({ state: "profile-pending", revision: 4, account: null });
    h.emit(h.status("b", 5));
    expect(pendingSendOwner(h.client).list()).toEqual([]);
    await grants[1]!.callback({});
    expect(pendingSendOwner(h.client).list()).toEqual([]);
  } finally {
    h.close();
    vi.unstubAllGlobals();
  }
});

it("retains sends on startup failure and retries only through explicit recovery or reconnect", async () => {
  const h = identityHarness();
  try {
    await beginSendThreadMessageTransaction({
      queryClient: h.client,
      request: {
        id: "thread-1",
        mode: "steer",
        input: [{ type: "text", text: "offline boot", mentions: [] }],
      },
    });
    const entry = pendingSendOwner(h.client).list()[0];
    h.reads[0]!.reject(Error("account not ready"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingRecoveryStatus(h.client)).toBe("unavailable");
    expect(pendingSendIdentityUnavailable(h.client)).toBe(true);
    expect(pendingSendOwner(h.client).list()[0]).toBe(entry);
    expect(h.reads).toHaveLength(1);
    const retry = retryPendingSendRecovery(h.client);
    const repeated = retryPendingSendRecovery(h.client);
    expect(h.reads).toHaveLength(2);
    h.reads[1]!.resolve(h.status("a", 1));
    await Promise.all([retry, repeated]);
    expect(pendingSendIdentityUnavailable(h.client)).toBe(false);
    expect(pendingSendOwner(h.client).list()[0]).toBe(entry);
    h.reconnect();
    expect(h.reads).toHaveLength(3);
    h.reads[2]!.reject(Error("offline"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingSendOwner(h.client).list()[0]).toBe(entry);
    expect(pendingSendIdentityUnavailable(h.client)).toBe(true);
    h.reconnect();
    h.reads[3]!.resolve(h.status("b", 2));
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingSendOwner(h.client).list()).toEqual([]);
  } finally {
    h.close();
  }
});

it("never recreates the previous namespace during reentrant reset notifications", async () => {
  const h = identityHarness();
  const names: string[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (name: string) => {
        names.push(name);
      },
    },
  });
  try {
    h.emit(h.status("a", 1));
    const before = names.length;
    const owner = pendingSendOwner(h.client);
    const stop = owner.subscribe(() => {
      pendingSendJournal(h.client);
    });
    h.emit(h.status("b", 2));
    stop();
    expect(names.length).toBe(before + 1);
    expect(names.at(-1)).toContain(
      JSON.stringify(
        JSON.stringify(["https://getbb.app", "b", "server"]),
      ).slice(1, -1),
    );
    expect(names.at(-1)).not.toContain(
      JSON.stringify(
        JSON.stringify(["https://getbb.app", "a", "server"]),
      ).slice(1, -1),
    );
    expect(owner.list()).toEqual([]);
  } finally {
    h.close();
    vi.unstubAllGlobals();
  }
});

it("keeps an owned journal through profile uncertainty and saves memory sends when the same identity returns", async () => {
  const h = identityHarness();
  const grants: ((lock: object | null) => Promise<void>)[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        _key: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        grants.push(callback);
      },
    },
  });
  try {
    h.emit(h.status("a", 1));
    void grants[0]!({});
    await beginSendThreadMessageTransaction({
      queryClient: h.client,
      request: {
        id: "thread-1",
        mode: "steer",
        input: [{ type: "text", text: "before uncertainty", mentions: [] }],
      },
    });
    const journal = pendingSendJournal(h.client);
    h.emit({ state: "profile-pending", revision: 2, account: null });
    await beginSendThreadMessageTransaction({
      queryClient: h.client,
      request: {
        id: "thread-1",
        mode: "steer",
        input: [{ type: "text", text: "during uncertainty", mentions: [] }],
      },
    });
    expect(Object.values(window.sessionStorage).join(" ")).not.toContain(
      "during uncertainty",
    );
    h.emit(h.status("a", 3));
    expect(pendingSendJournal(h.client)).toBe(journal);
    expect(grants).toHaveLength(1);
    expect(pendingSendOwner(h.client).list()).toHaveLength(2);
    expect(Object.values(window.sessionStorage).join(" ")).toContain(
      "during uncertainty",
    );
    h.emit({ state: "signed-out", revision: 4, account: null });
    expect(Object.values(window.sessionStorage).join(" ")).not.toContain(
      "before uncertainty",
    );
    expect(Object.values(window.sessionStorage).join(" ")).not.toContain(
      "during uncertainty",
    );
    // The first unacknowledged text fills the empty draft; the second cannot
    // overwrite it and stays visible under its own id.
    expect(h.draft.getCurrent().text).toBe("before uncertainty");
    expect(pendingSendOwner(h.client).list()).toMatchObject([
      { row: { text: "during uncertainty" } },
    ]);
  } finally {
    h.close();
    vi.unstubAllGlobals();
  }
});

it("does not undo an explicit recovery Hide on reconnect to the same account", async () => {
  const h = identityHarness();
  const locks = vi.fn(async () => {});
  vi.stubGlobal("navigator", { locks: { request: locks } });
  try {
    h.emit(h.status("a", 1));
    const journal = pendingSendJournal(h.client)!;
    expect(journal.status).toBe("waiting");
    journal.hide();
    h.reconnect();
    h.reads[1]!.resolve(h.status("a", 2));
    await Promise.resolve();
    await Promise.resolve();
    expect(pendingSendJournal(h.client)).toBe(journal);
    expect(journal.status).toBe("hidden");
    expect(locks).toHaveBeenCalledTimes(1);
  } finally {
    h.close();
    vi.unstubAllGlobals();
  }
});

it("keeps stored journal entries when the navigation lock is held elsewhere, and still keeps them as inherited after the first own entry", async () => {
  const client = createAppQueryClient();
  window.sessionStorage.clear();
  const config = makeSystemConfig({ primaryHostId: "host-held" });
  const key = `bb-pending-send/${JSON.stringify([
    window.location.origin,
    config.primaryHostId,
    config.dataDir,
    undefined,
  ])}`;
  const stored = JSON.stringify({
    version: 1,
    journalId: "held-elsewhere",
    entries: [{ id: "stored-entry" }],
  });
  window.sessionStorage.setItem(key, stored);
  const names: string[] = [];
  vi.stubGlobal("navigator", {
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        names.push(name);
        if (name.endsWith("/held-elsewhere")) await callback(null);
        else void callback({});
      },
    },
  });
  try {
    client.setQueryData(systemConfigQueryKey(), config);
    pendingSendOwner(client);
    await vi.waitFor(() =>
      expect(pendingSendJournal(client)?.status).toBe("owned"),
    );
    expect(names).toHaveLength(3);
    expect(window.sessionStorage.getItem(key)).toBe(stored);
    await beginSendThreadMessageTransaction({
      queryClient: client,
      request: {
        id: "thread-1",
        clientSubmissionId: crypto.randomUUID(),
        mode: "auto",
        input: [{ type: "text", text: "own entry", mentions: [] }],
      },
    });
    const saved = JSON.parse(window.sessionStorage.getItem(key)!);
    expect(saved.journalId).not.toBe("held-elsewhere");
    expect(JSON.stringify(saved.entries)).toContain("own entry");
    expect(JSON.stringify(saved.entries)).not.toContain("stored-entry");
    expect(saved.inherited).toEqual([
      { journalId: "held-elsewhere", entries: [{ id: "stored-entry" }] },
    ]);
  } finally {
    vi.unstubAllGlobals();
    clearPendingSendScope(client);
    client.clear();
  }
});
