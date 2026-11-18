// @vitest-environment jsdom
import { MutationObserver, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { BbHttpError, sdk } from "@/lib/sdk";
import { makeSystemConfig } from "@/test/fixtures/system-config";
import { sendThreadMessageMutationOptions } from "../mutations/thread-runtime-mutations";
import { systemConfigQueryKey } from "../queries/query-keys";
import {
  clearPendingSendScope,
  pendingSendJournal,
  pendingSendOwner,
  settleFailedPendingSend,
} from "./pending-send-owner";

const held = new Set<string>();
const releases: (() => void)[] = [];
let clients: QueryClient[] = [];

beforeEach(() => {
  window.sessionStorage.clear();
  held.clear();
  vi.stubGlobal("navigator", {
    ...navigator,
    locks: {
      request: async (
        name: string,
        _options: unknown,
        callback: (lock: object | null) => Promise<void>,
      ) => {
        if (held.has(name)) return callback(null);
        held.add(name);
        try {
          return await callback({});
        } finally {
          held.delete(name);
        }
      },
    },
  });
  vi.spyOn(sdk.threads, "timeline").mockRejectedValue(Error("offline"));
  vi.spyOn(sdk.threads.queuedMessages, "list").mockRejectedValue(
    Error("offline"),
  );
});

afterEach(() => {
  for (const client of clients) {
    clearPendingSendScope(client);
    client.clear();
  }
  clients = [];
  for (const release of releases.splice(0)) release();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function openTab() {
  const client = createAppQueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    showMutationErrorToasts: false,
  });
  clients.push(client);
  client.setQueryData(
    systemConfigQueryKey(),
    makeSystemConfig({ primaryHostId: "host-reload" }),
  );
  pendingSendOwner(client);
  await vi.waitFor(() =>
    expect(pendingSendJournal(client)?.status).toBe("owned"),
  );
  return client;
}

/** The previous document unloads: its lock is released, storage stays. */
async function unload(client: QueryClient) {
  pendingSendJournal(client)?.dispose();
  clients = clients.filter((current) => current !== client);
  await vi.waitFor(() => expect(held.size).toBe(0));
}

const send = (client: QueryClient, request: Record<string, unknown>) =>
  new MutationObserver(client, sendThreadMessageMutationOptions(client))
    .mutate(request as never)
    .catch((error: unknown) => error);

async function failBeforeServer(input: unknown[]) {
  const before = await openTab();
  const id = crypto.randomUUID();
  vi.spyOn(sdk.threads, "send").mockRejectedValueOnce(
    new TypeError("Failed to fetch"),
  );
  await send(before, {
    id: "thread-1",
    clientSubmissionId: id,
    mode: "auto",
    input,
  });
  expect(pendingSendOwner(before).list("thread-1")).toMatchObject([
    { id, state: "unconfirmed" },
  ]);
  expect(settleFailedPendingSend(before, "thread-1", id, () => true)).toBe(
    false,
  );
  const firstCall = vi.mocked(sdk.threads.send).mock.calls[0]![0];
  await unload(before);
  const after = await openTab();
  return { after, id, firstCall };
}

it("resends a send lost before the server after a reload with the same submission id and payload", async () => {
  const { after, id, firstCall } = await failBeforeServer([
    { type: "text", text: "lost on core restart", mentions: [] },
  ]);
  const owner = pendingSendOwner(after);
  const [entry] = owner.list("thread-1");
  expect(entry).toMatchObject({ id, state: "unconfirmed" });
  expect(entry?.request?.clientSubmissionId).toBe(id);
  const resent = vi.spyOn(sdk.threads, "send").mockResolvedValueOnce({
    ok: true,
    delivery: "sent",
    submissionIds: [id],
    requested: { requestId: "creq_23456789ab" as never, sequence: 7 },
  });
  expect(owner.resend("thread-1", id)).toBe(true);
  const result = await send(after, { ...entry!.request!, id: "thread-1" });
  expect(result).not.toBeInstanceOf(Error);
  expect(resent).toHaveBeenCalledTimes(2);
  expect(resent.mock.calls[1]![0]).toEqual(firstCall);
  expect(owner.list("thread-1")).toHaveLength(1);
  expect(owner.outcome("thread-1", id)).toBe("accepted");
});

it("treats an already admitted resend after reload as delivered, without a second message", async () => {
  const { after, id } = await failBeforeServer([
    { type: "text", text: "reached the server after all", mentions: [] },
  ]);
  const owner = pendingSendOwner(after);
  const [entry] = owner.list("thread-1");
  vi.spyOn(sdk.threads, "send").mockRejectedValueOnce(
    new BbHttpError({
      status: 409,
      code: "submission_already_admitted",
      message: "Submission already admitted",
      body: {
        code: "submission_already_admitted",
        details: { requested: { requestId: "creq_abcdefghij", sequence: 3 } },
      },
    } as never),
  );
  expect(owner.resend("thread-1", id)).toBe(true);
  await send(after, { ...entry!.request!, id: "thread-1" });
  expect(owner.list("thread-1")).toHaveLength(1);
  expect(owner.outcome("thread-1", id)).toBe("accepted");
  expect(settleFailedPendingSend(after, "thread-1", id, () => true)).toBe(
    false,
  );
});

it("keeps the text but no resend payload after reload for an inline image send", async () => {
  const { after, id } = await failBeforeServer([
    { type: "text", text: "see screenshot", mentions: [] },
    { type: "image", url: "data:image/png;base64,aW5saW5l" },
  ]);
  expect(window.sessionStorage.getItem(sessionStorageKey())).not.toContain(
    "aW5saW5l",
  );
  const [entry] = pendingSendOwner(after).list("thread-1");
  expect(entry).toMatchObject({ id, state: "unconfirmed" });
  expect(entry?.request).toBeUndefined();
  expect(entry?.row.text).toContain("see screenshot");
  expect(pendingSendOwner(after).resend("thread-1", id)).toBe(false);
});

function sessionStorageKey() {
  for (let index = 0; index < window.sessionStorage.length; index++) {
    const key = window.sessionStorage.key(index)!;
    if (key.startsWith("bb-pending-send/")) return key;
  }
  throw Error("no journal");
}
