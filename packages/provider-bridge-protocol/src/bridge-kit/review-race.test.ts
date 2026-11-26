import { getEventListeners } from "node:events";
import { expect, it } from "vitest";
import { createPendingToolCallTracker } from "./pending-tool-call-tracker.js";

it.each(["response", "abort", "close"])("reentrant dispatch, first terminal event %s wins", async (first) => {
  const controller = new AbortController();
  const scope = {};
  const notifications: unknown[] = [];
  const response = { jsonrpc: "2.0", id: 1, result: {success:true,contentItems:[]} } as const;
  const tracker = createPendingToolCallTracker({
    sendToolCall() {
      if (first === "response") expect(tracker.handleToolCallResponse(response)).toBe(true);
      if (first === "close") tracker.resolvePendingToolCalls(scope, "closed");
      controller.abort();
      throw new Error("late write error");
    },
    sendCancellation(notification) {
      notifications.push(notification.params);
      expect(tracker.handleToolCallResponse(response)).toBe(false);
      tracker.resolvePendingToolCalls(scope, "reentrant close");
    }
  });
  const result = await tracker.forwardToolCall({arguments:{},providerThreadId:"p",scope,threadId:"t",toolName:"probe",signal:controller.signal});
  expect(notifications).toEqual(first === "response" ? [] : [{requestId:1}]);
  expect(result.isError).toBe(first !== "response");
  if (first !== "response") expect(result.content).toBe(first === "close" ? "closed" : "Tool call cancellation requested");
  expect(tracker.handleToolCallResponse(response)).toBe(false);
  expect(getEventListeners(controller.signal,"abort")).toHaveLength(0);
});
