import { expect, it, vi } from "vitest";
import { createAppQueryClient } from "@/lib/query-client";
import { sdk } from "@/lib/sdk";
import { makeThreadTimelineResponse } from "@/test/fixtures/thread-responses";
import { makeThreadQueuedMessage } from "@bb/test-helpers/domain-fixtures";
import {
  beginSendThreadMessageTransaction,
  applySendThreadMessageSuccess,
} from "./thread-runtime-cache-owner";
import {
  pendingSendOwner,
  composePendingSends,
  refreshPendingSends,
  clearPendingSendScope,
  settleFailedPendingSend,
} from "./pending-send-owner";
import {
  threadTimelineQueryKey,
  threadQueuedMessagesQueryKey,
} from "../queries/query-keys";
import type { SendThreadMessageMutationRequest } from "../mutations/mutation-request-types";

it("keeps legacy steer custody until the joint post-receipt timeline and delayed queue read apply", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    input: [{ type: "text", text: "owner", mentions: [] }],
    mode: "steer",
  };
  client.setQueryData(
    threadTimelineQueryKey(request.id),
    makeThreadTimelineResponse({ rows: [] }),
  );
  client.setQueryData(threadQueuedMessagesQueryKey(request.id), []);
  let resolveQueue!: (
    rows: ReturnType<typeof makeThreadQueuedMessage>[],
  ) => void;
  const queueRead = new Promise<ReturnType<typeof makeThreadQueuedMessage>[]>(
    (resolve) => {
      resolveQueue = resolve;
    },
  );
  const timelineSpy = vi
    .spyOn(sdk.threads, "timeline")
    .mockResolvedValue(makeThreadTimelineResponse({ rows: [] }));
  const queueSpy = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockReturnValue(queueRead);
  try {
    const transaction = await beginSendThreadMessageTransaction({
      queryClient: client,
      request,
    });
    expect(
      client.getQueryData(threadTimelineQueryKey(request.id)),
    ).toMatchObject({ rows: [] });
    applySendThreadMessageSuccess({
      queryClient: client,
      request,
      result: { ok: true, delivery: "sent" },
      transaction,
      realtimeConnected: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(composePendingSends(client, request.id).rows).toHaveLength(1);
    const deferred = makeThreadQueuedMessage({
      id: "deferred",
      threadId: request.id,
    });
    resolveQueue([deferred]);
    await refreshPendingSends(client, request.id);
    expect(pendingSendOwner(client).list(request.id)).toHaveLength(0);
    expect(composePendingSends(client, request.id).rows).toHaveLength(0);
    expect(composePendingSends(client, request.id).queue).toEqual([deferred]);
  } finally {
    timelineSpy.mockRestore();
    queueSpy.mockRestore();
    client.clear();
  }
});
it("does not apply a recovery read after its server scope has been cleared", async () => {
  const client = createAppQueryClient();
  const { systemConfigQueryKey } = await import("../queries/query-keys");
  client.setQueryData(systemConfigQueryKey(), {});
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    input: [{ type: "text", text: "owner", mentions: [] }],
    mode: "auto",
  };
  await beginSendThreadMessageTransaction({ queryClient: client, request });
  let resolve!: (value: ReturnType<typeof makeThreadTimelineResponse>) => void;
  const timeline = new Promise<ReturnType<typeof makeThreadTimelineResponse>>(
    (r) => {
      resolve = r;
    },
  );
  const a = vi.spyOn(sdk.threads, "timeline").mockReturnValue(timeline),
    b = vi.spyOn(sdk.threads.queuedMessages, "list").mockResolvedValue([]);
  try {
    const refresh = refreshPendingSends(client, request.id);
    clearPendingSendScope(client);
    client.clear();
    resolve(makeThreadTimelineResponse({ rows: [] }));
    await refresh;
    expect(pendingSendOwner(client).list()).toEqual([]);
    expect(
      client.getQueryData(threadTimelineQueryKey(request.id)),
    ).toBeUndefined();
  } finally {
    a.mockRestore();
    b.mockRestore();
    client.clear();
  }
});
it("does not hand identical legacy sends to a late pre-receipt read or a timeline-only fallback", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    input: [{ type: "text", text: "same", mentions: [] }],
    mode: "steer",
  };
  client.setQueryData(
    threadTimelineQueryKey(request.id),
    makeThreadTimelineResponse({ rows: [], maxSeq: 10 }),
  );
  client.setQueryData(threadQueuedMessagesQueryKey(request.id), []);
  const first = await beginSendThreadMessageTransaction({
    queryClient: client,
    request,
  });
  const secondRequest = { ...request, clientSubmissionId: crypto.randomUUID() };
  const second = await beginSendThreadMessageTransaction({
    queryClient: client,
    request: secondRequest,
  });
  let finishOld!: (
    value: ReturnType<typeof makeThreadTimelineResponse>,
  ) => void;
  let finishQueue!: (
    rows: ReturnType<typeof makeThreadQueuedMessage>[],
  ) => void;
  const old = new Promise<ReturnType<typeof makeThreadTimelineResponse>>(
    (resolve) => {
      finishOld = resolve;
    },
  );
  const held = new Promise<ReturnType<typeof makeThreadQueuedMessage>[]>(
    (resolve) => {
      finishQueue = resolve;
    },
  );
  const timeline = vi
    .spyOn(sdk.threads, "timeline")
    .mockReturnValueOnce(old)
    .mockResolvedValue(makeThreadTimelineResponse({ rows: [], maxSeq: 20 }));
  const queue = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockResolvedValueOnce([])
    .mockReturnValue(held);
  try {
    const beforeReceipt = refreshPendingSends(client, request.id);
    for (const [payload, transaction] of [
      [request, first],
      [secondRequest, second],
    ] as const)
      applySendThreadMessageSuccess({
        queryClient: client,
        request: payload,
        result: { ok: true, delivery: "sent" },
        transaction,
        realtimeConnected: true,
      });
    finishOld(makeThreadTimelineResponse({ rows: [], maxSeq: 11 }));
    await beforeReceipt;
    expect(composePendingSends(client, request.id).rows).toHaveLength(2);
    client.setQueryData(
      threadTimelineQueryKey(request.id),
      makeThreadTimelineResponse({ rows: [], maxSeq: 20 }),
    );
    await Promise.resolve();
    expect(composePendingSends(client, request.id).rows).toHaveLength(2);
    const deferred = ["one", "two"].map((id) =>
      makeThreadQueuedMessage({
        id,
        threadId: request.id,
        content: request.input,
      }),
    );
    finishQueue(deferred);
    await refreshPendingSends(client, request.id);
    expect(composePendingSends(client, request.id)).toEqual({
      rows: [],
      queue: deferred,
    });
    expect(pendingSendOwner(client).list(request.id)).toEqual([]);
  } finally {
    timeline.mockRestore();
    queue.mockRestore();
    client.clear();
  }
});

it("keeps custody when an unobserved system config is garbage collected", async () => {
  vi.useFakeTimers();
  const client = createAppQueryClient();
  const { systemConfigQueryKey } = await import("../queries/query-keys");
  client.setQueryDefaults(systemConfigQueryKey(), { gcTime: 1 });
  client.setQueryData(systemConfigQueryKey(), {});
  await beginSendThreadMessageTransaction({
    queryClient: client,
    request: {
      id: "thread-1",
      mode: "auto",
      input: [{ type: "text", text: "owner", mentions: [] }],
    },
  });
  try {
    const owner = pendingSendOwner(client);
    const pending = owner.list()[0];
    await vi.advanceTimersByTimeAsync(2);
    expect(client.getQueryData(systemConfigQueryKey())).toBeUndefined();
    expect(owner.list()).toEqual([pending]);
    expect(composePendingSends(client, "thread-1").rows).toEqual([
      pending!.row,
    ]);
  } finally {
    client.clear();
    vi.useRealTimers();
  }
});

it.each([true, false])(
  "does not amplify 100 pushes for lingering definitive=%s custody and still observes identity",
  async (definitive) => {
    vi.useFakeTimers();
    const client = createAppQueryClient();
    const request: SendThreadMessageMutationRequest = {
      id: "thread-1",
      mode: "auto",
      input: [{ type: "text", text: "owner", mentions: [] }],
    };
    await beginSendThreadMessageTransaction({ queryClient: client, request });
    const owner = pendingSendOwner(client),
      entry = owner.list()[0]!;
    owner.fail(request.id, entry.id, definitive, "transport");
    const timeline = vi
      .spyOn(sdk.threads, "timeline")
      .mockResolvedValue(makeThreadTimelineResponse({ rows: [], maxSeq: 101 }));
    const queue = vi
      .spyOn(sdk.threads.queuedMessages, "list")
      .mockResolvedValue([]);
    try {
      for (let sequence = 1; sequence <= 100; sequence++) {
        client.setQueryData(
          threadTimelineQueryKey(request.id),
          makeThreadTimelineResponse({ rows: [], maxSeq: sequence }),
        );
        await vi.advanceTimersByTimeAsync(20);
      }
      await vi.advanceTimersByTimeAsync(1000);
      expect(timeline).not.toHaveBeenCalled();
      expect(queue).not.toHaveBeenCalled();
      expect(composePendingSends(client, request.id).rows).toHaveLength(1);
      client.setQueryData(
        threadTimelineQueryKey(request.id),
        makeThreadTimelineResponse({
          rows: [
            {
              ...entry.row,
              id: "canonical",
              sourceSeqEnd: 102,
              clientSubmissionIds: [entry.id],
            },
          ],
          maxSeq: 102,
        }),
      );
      expect(owner.list()).toEqual([]);
      expect(composePendingSends(client, request.id).rows).toHaveLength(1);
      expect(timeline).not.toHaveBeenCalled();
    } finally {
      timeline.mockRestore();
      queue.mockRestore();
      client.clear();
      vi.useRealTimers();
    }
  },
);
it("observes bounded reads without replacing native deferred segmented cache", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    mode: "auto",
    input: [{ type: "text", text: "owner", mentions: [] }],
  };
  await beginSendThreadMessageTransaction({ queryClient: client, request });
  const native = makeThreadTimelineResponse({ rows: [], maxSeq: 10 });
  client.setQueryData(threadTimelineQueryKey(request.id), native);
  const timeline = vi
    .spyOn(sdk.threads, "timeline")
    .mockResolvedValue(makeThreadTimelineResponse({ rows: [], maxSeq: 20 }));
  const queue = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockResolvedValue([]);
  try {
    const cached = client.getQueryData(threadTimelineQueryKey(request.id));
    await refreshPendingSends(client, request.id);
    expect(timeline).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: request.id,
        deferContent: "true",
        segmentLimit: "8",
      }),
    );
    expect(client.getQueryData(threadTimelineQueryKey(request.id))).toBe(
      cached,
    );
  } finally {
    timeline.mockRestore();
    queue.mockRestore();
    client.clear();
  }
});

it("retains custody when a bounded read sees requested content before native cache catches up", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    mode: "auto",
    input: [{ type: "text", text: "owner", mentions: [] }],
  };
  client.setQueryData(
    threadTimelineQueryKey(request.id),
    makeThreadTimelineResponse({ rows: [], maxSeq: 1 }),
  );
  await beginSendThreadMessageTransaction({ queryClient: client, request });
  const owner = pendingSendOwner(client),
    entry = owner.list()[0]!;
  owner.fail(request.id, entry.id, false, "transport");
  const canonical = {
    ...entry.row,
    id: "canonical",
    sourceSeqEnd: 20,
    clientSubmissionIds: [entry.id],
  };
  const timeline = vi
    .spyOn(sdk.threads, "timeline")
    .mockResolvedValue(
      makeThreadTimelineResponse({ rows: [canonical], maxSeq: 20 }),
    );
  const queue = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockResolvedValue([]);
  try {
    await refreshPendingSends(client, request.id);
    expect(composePendingSends(client, request.id).rows).toHaveLength(1);
    expect(owner.list()).toHaveLength(1);
    client.setQueryData(
      threadTimelineQueryKey(request.id),
      makeThreadTimelineResponse({ rows: [canonical], maxSeq: 20 }),
    );
    expect(owner.list()).toEqual([]);
    expect(composePendingSends(client, request.id).rows).toHaveLength(1);
  } finally {
    timeline.mockRestore();
    queue.mockRestore();
    clearPendingSendScope(client);
    client.clear();
  }
});
it("debounces 100 invalidations into one bounded handoff and keeps unresolved custody", async () => {
  vi.useFakeTimers();
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    mode: "auto",
    input: [{ type: "text", text: "owner", mentions: [] }],
  };
  client.setQueryData(
    threadTimelineQueryKey(request.id),
    makeThreadTimelineResponse({ rows: [], maxSeq: 10 }),
  );
  await beginSendThreadMessageTransaction({ queryClient: client, request });
  const owner = pendingSendOwner(client),
    entry = owner.list()[0]!;
  owner.receipt(request.id, entry.id, {
    ok: true,
    delivery: "sent",
    requested: { requestId: "creq_0000000000", sequence: 2 },
  });
  const timeline = vi
    .spyOn(sdk.threads, "timeline")
    .mockResolvedValue(makeThreadTimelineResponse({ rows: [], maxSeq: 10 }));
  const queue = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockResolvedValue([]);
  try {
    for (let n = 0; n < 100; n++)
      await client.invalidateQueries({
        queryKey: threadTimelineQueryKey(request.id),
        refetchType: "none",
      });
    expect(timeline).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(timeline).toHaveBeenCalledTimes(1);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(owner.list()[0]?.state).toBe("unresolved");
    for (let n = 0; n < 100; n++)
      client.setQueryData(
        threadTimelineQueryKey(request.id),
        makeThreadTimelineResponse({ rows: [], maxSeq: 11 + n }),
      );
    await vi.advanceTimersByTimeAsync(1000);
    expect(timeline).toHaveBeenCalledTimes(1);
  } finally {
    timeline.mockRestore();
    queue.mockRestore();
    clearPendingSendScope(client);
    client.clear();
    vi.useRealTimers();
  }
});

it("reconciles known unresolved queue identity on invalidation without a visible request row", async () => {
  vi.useFakeTimers();
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    mode: "auto",
    input: [{ type: "text", text: "owner", mentions: [] }],
  };
  client.setQueryData(
    threadTimelineQueryKey(request.id),
    makeThreadTimelineResponse({ rows: [], maxSeq: 1 }),
  );
  await beginSendThreadMessageTransaction({ queryClient: client, request });
  const owner = pendingSendOwner(client),
    entry = owner.list()[0]!;
  owner.admittedQueue(request.id, entry.id, "known");
  client.setQueryData(
    threadTimelineQueryKey(request.id),
    makeThreadTimelineResponse({ rows: [], maxSeq: 20 }),
  );
  const timeline = vi
    .spyOn(sdk.threads, "timeline")
    .mockResolvedValue(makeThreadTimelineResponse({ rows: [], maxSeq: 20 }));
  const queue = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockResolvedValue([]);
  const snapshot = vi.spyOn(sdk.threads, "queueSnapshot").mockResolvedValue({
    rows: [],
    eventMaxSeq: 20,
    queuePresence: [{ id: "known", present: false }],
    coverage: "complete",
    placements: [
      {
        queueId: "known",
        submissionIds: [entry.id],
        state: "requested",
        requestId: "creq_0000000000",
        requestSequence: 10,
      },
    ],
    diagnostics: { scannedRows: 2, scannedBytes: 100, elapsedMs: 1 },
  });
  try {
    await client.invalidateQueries({
      queryKey: threadTimelineQueryKey(request.id),
      refetchType: "none",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(snapshot).toHaveBeenCalledWith({
      threadId: request.id,
      knownAdmittedQueueIds: ["known"],
    });
    expect(owner.list()).toEqual([]);
  } finally {
    timeline.mockRestore();
    queue.mockRestore();
    snapshot.mockRestore();
    clearPendingSendScope(client);
    client.clear();
    vi.useRealTimers();
  }
});
it("offers unresolved custody after a failed legacy handoff read", async () => {
  const client = createAppQueryClient();
  await beginSendThreadMessageTransaction({
    queryClient: client,
    request: {
      id: "thread-1",
      mode: "auto",
      input: [{ type: "text", text: "owner", mentions: [] }],
    },
  });
  const owner = pendingSendOwner(client),
    entry = owner.list()[0]!;
  owner.receipt("thread-1", entry.id, { ok: true, delivery: "sent" });
  const timeline = vi
    .spyOn(sdk.threads, "timeline")
    .mockRejectedValue(Error("offline"));
  const queue = vi
    .spyOn(sdk.threads.queuedMessages, "list")
    .mockResolvedValue([]);
  try {
    await expect(refreshPendingSends(client, "thread-1")).rejects.toThrow(
      "offline",
    );
    expect(owner.list()[0]?.state).toBe("unresolved");
    expect(composePendingSends(client, "thread-1").rows).toHaveLength(1);
  } finally {
    timeline.mockRestore();
    queue.mockRestore();
    clearPendingSendScope(client);
    client.clear();
  }
});

it("keeps projection identity stable without a loaded queue", async () => {
  const client = createAppQueryClient();
  const request = {
    id: "thread-1",
    mode: "steer" as const,
    input: [{ type: "text" as const, text: "owner", mentions: [] }],
  };
  await beginSendThreadMessageTransaction({ queryClient: client, request });
  const rows: import("@bb/server-contract").TimelineRow[] = [];
  expect(composePendingSends(client, request.id, rows)).toBe(
    composePendingSends(client, request.id, rows),
  );
  expect(request).not.toHaveProperty("clientSubmissionId");
  expect(
    pendingSendOwner(client).list()[0]?.legacyQueueBaselineIds,
  ).toBeUndefined();
  client.clear();
});

it("restores the draft and hides the failed entry only after a definite rejection", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    input: [{ type: "text", text: "draft", mentions: [] }],
    mode: "auto",
    clientSubmissionId: "9d6b6a52-7c1f-4c43-8d57-0f5d5a1f6a10",
  };
  try {
    await beginSendThreadMessageTransaction({ queryClient: client, request });
    const owner = pendingSendOwner(client);
    const id = request.clientSubmissionId!;
    owner.fail(request.id, id, true, "rejected");
    const restore = vi.fn(() => true);
    expect(settleFailedPendingSend(client, request.id, id, restore)).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(owner.list(request.id)).toHaveLength(0);
  } finally {
    clearPendingSendScope(client);
    client.clear();
  }
});

it("keeps a failed entry when the draft was not restored", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    input: [{ type: "text", text: "draft", mentions: [] }],
    mode: "auto",
    clientSubmissionId: "9d6b6a52-7c1f-4c43-8d57-0f5d5a1f6a11",
  };
  try {
    await beginSendThreadMessageTransaction({ queryClient: client, request });
    const owner = pendingSendOwner(client);
    const id = request.clientSubmissionId!;
    owner.fail(request.id, id, true, "rejected");
    expect(settleFailedPendingSend(client, request.id, id, () => false)).toBe(
      false,
    );
    expect(owner.list(request.id)).toHaveLength(1);
  } finally {
    clearPendingSendScope(client);
    client.clear();
  }
});

it("does not restore the draft while delivery is unconfirmed and lets the same id be resent", async () => {
  const client = createAppQueryClient();
  const request: SendThreadMessageMutationRequest = {
    id: "thread-1",
    input: [{ type: "text", text: "draft", mentions: [] }],
    mode: "auto",
    clientSubmissionId: "9d6b6a52-7c1f-4c43-8d57-0f5d5a1f6a12",
  };
  try {
    await beginSendThreadMessageTransaction({ queryClient: client, request });
    const owner = pendingSendOwner(client);
    const id = request.clientSubmissionId!;
    owner.fail(request.id, id, false, "Delivery unconfirmed");
    const restore = vi.fn(() => true);
    expect(settleFailedPendingSend(client, request.id, id, restore)).toBe(
      false,
    );
    expect(restore).not.toHaveBeenCalled();
    expect(owner.list(request.id)[0]?.state).toBe("unconfirmed");
    expect(owner.resend(request.id, id)).toBe(true);
    const resent = owner.list(request.id)[0];
    expect(resent?.state).toBe("sending");
    expect(resent?.id).toBe(id);
    expect(owner.resend(request.id, id)).toBe(false);
  } finally {
    clearPendingSendScope(client);
    client.clear();
  }
});

it("restores the draft when no pending entry exists for the send", () => {
  const client = createAppQueryClient();
  try {
    const restore = vi.fn(() => true);
    expect(
      settleFailedPendingSend(client, "thread-1", "missing", restore),
    ).toBe(true);
    expect(restore).toHaveBeenCalledTimes(1);
  } finally {
    client.clear();
  }
});
