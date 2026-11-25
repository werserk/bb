import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BridgeToolCallRequest } from "./bridge-tool-calls.js";
import { createPendingToolCallTracker } from "./pending-tool-call-tracker.js";

function createTracker() {
  const sent: BridgeToolCallRequest[] = [];
  const tracker = createPendingToolCallTracker({
    sendToolCall: (request) => sent.push(request),
  });
  return { sent, tracker };
}

describe("createPendingToolCallTracker", () => {
  it("mints incrementing item/tool/call requests", () => {
    const { sent, tracker } = createTracker();
    const scope = {};
    void tracker.forwardToolCall({
      arguments: { a: 1 },
      providerThreadId: "provider-1",
      scope,
      threadId: "thread-1",
      toolName: "my_tool",
    });
    void tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope,
      threadId: "thread-1",
      toolName: "other_tool",
    });

    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        providerThreadId: "provider-1",
        turnId: null,
        callId: "call-1",
        tool: "my_tool",
        arguments: { a: 1 },
      },
    });
    expect(sent[1]?.id).toBe(2);
    expect(sent[1]?.params.callId).toBe("call-2");
  });

  it("settles a pending call from an error response", async () => {
    const { tracker } = createTracker();
    const result = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope: {},
      threadId: "thread-1",
      toolName: "my_tool",
    });

    expect(
      tracker.handleToolCallResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32000, message: "boom" },
      }),
    ).toBe(true);
    await expect(result).resolves.toEqual({ content: "boom", isError: true });
  });

  it("returns false for responses that match no pending call", () => {
    const { tracker } = createTracker();
    expect(
      tracker.handleToolCallResponse({ jsonrpc: "2.0", id: 99, result: {} }),
    ).toBe(false);
  });

  it("does not settle the same call twice", async () => {
    const { tracker } = createTracker();
    void tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope: {},
      threadId: "thread-1",
      toolName: "my_tool",
    });
    const response = {
      jsonrpc: "2.0",
      id: 1,
      result: { success: true, contentItems: [] },
    } as const;
    expect(tracker.handleToolCallResponse(response)).toBe(true);
    expect(tracker.handleToolCallResponse(response)).toBe(false);
  });

  it("error-resolves only the pending calls of the given scope", async () => {
    const { tracker } = createTracker();
    const sessionA = {};
    const sessionB = {};
    const resultA = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-a",
      scope: sessionA,
      threadId: "thread-a",
      toolName: "my_tool",
    });
    const resultB = tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-b",
      scope: sessionB,
      threadId: "thread-b",
      toolName: "my_tool",
    });

    tracker.resolvePendingToolCalls(sessionA, "session closed");
    await expect(resultA).resolves.toEqual({
      content: "session closed",
      isError: true,
    });

    expect(
      tracker.handleToolCallResponse({
        jsonrpc: "2.0",
        id: 2,
        result: {
          success: true,
          contentItems: [{ type: "inputText", text: "b" }],
        },
      }),
    ).toBe(true);
    await expect(resultB).resolves.toEqual({
      content: "b",
      contentBlocks: [{ type: "text", text: "b" }],
      images: [],
      isError: false,
    });
  });
});

describe("createPendingToolCallTracker send failures", () => {
  it("resolves an error result instead of rejecting when the sender throws", async () => {
    const tracker = createPendingToolCallTracker({
      sendToolCall: () => {
        throw new Error("transport closed");
      },
    });
    const scope = {};

    const result = await tracker.forwardToolCall({
      arguments: {},
      providerThreadId: "provider-1",
      scope,
      threadId: "thread-1",
      toolName: "my_tool",
    });
    expect(result).toEqual({ content: "transport closed", isError: true });

    tracker.resolvePendingToolCalls(scope, "closing");
    const response = tracker.handleToolCallResponse({
      jsonrpc: "2.0",
      id: 1,
      result: { content: "late" },
    });
    expect(response).toBe(false);
  });
});

describe("pending tool call cancellation", () => {
  const args = {
    arguments: {},
    providerThreadId: "provider",
    scope: {},
    threadId: "thread",
    toolName: "tool",
  };

  it("skips dispatch when aborted beforehand", async () => {
    const sendToolCall = vi.fn();
    const sendCancellation = vi.fn();
    const tracker = createPendingToolCallTracker({
      sendToolCall,
      sendCancellation,
    });
    await expect(
      tracker.forwardToolCall({ ...args, signal: AbortSignal.abort() }),
    ).resolves.toMatchObject({ isError: true });
    expect(sendToolCall).not.toHaveBeenCalled();
    expect(sendCancellation).not.toHaveBeenCalled();
  });

  it.each([
    "success",
    "error",
    "send failure",
    "abort",
    "scope disposal",
  ] as const)(
    "removes the listener after %s and ignores later signals and replies",
    async (end) => {
      const controller = new AbortController();
      const sendCancellation = vi.fn();
      const tracker = createPendingToolCallTracker({
        sendToolCall() {
          if (end === "send failure") throw new Error("transport closed");
        },
        sendCancellation,
      });
      const result = tracker.forwardToolCall({
        ...args,
        signal: controller.signal,
      });
      const success = {
        jsonrpc: "2.0",
        id: 1,
        result: { success: true, contentItems: [] },
      } as const;
      if (end === "success")
        expect(tracker.handleToolCallResponse(success)).toBe(true);
      if (end === "error")
        expect(
          tracker.handleToolCallResponse({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -1 },
          }),
        ).toBe(true);
      if (end === "abort") controller.abort();
      if (end === "scope disposal")
        tracker.resolvePendingToolCalls(args.scope, "session closed");
      expect((await result).isError).toBe(end !== "success");
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      controller.abort();
      tracker.resolvePendingToolCalls(args.scope, "closed again");
      expect(tracker.handleToolCallResponse(success)).toBe(false);
      if (end === "abort" || end === "scope disposal") {
        expect(sendCancellation.mock.calls).toEqual([
          [
            {
              jsonrpc: "2.0",
              method: "notifications/cancelled",
              params: { requestId: 1 },
            },
          ],
        ]);
      } else {
        expect(sendCancellation).not.toHaveBeenCalled();
      }
    },
  );

  it("settles locally when the cancellation transport has closed", async () => {
    const controller = new AbortController();
    const tracker = createPendingToolCallTracker({
      sendToolCall: vi.fn(),
      sendCancellation() {
        throw new Error("transport closed");
      },
    });
    const result = tracker.forwardToolCall({
      ...args,
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).resolves.toEqual({
      content: "transport closed",
      isError: true,
    });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
