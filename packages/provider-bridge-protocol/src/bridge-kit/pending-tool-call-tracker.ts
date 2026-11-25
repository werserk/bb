import { PROVIDER_TOOL_CALL_CANCELLED_METHOD } from "./provider-tool-call-contract.js";
import {
  decodeToolCallResponsePayload,
  type BridgeJsonRpcResponse,
  type BridgeToolCallContent,
  type BridgeToolCallImage,
  type BridgeToolCallRequest,
} from "./bridge-tool-calls.js";

export interface BridgeToolCallResult {
  content: string;
  contentBlocks?: BridgeToolCallContent[];
  images?: BridgeToolCallImage[];
  isError?: boolean;
}

interface PendingToolCall {
  detachAbortListener: () => void;
  resolve: (value: BridgeToolCallResult) => void;
  scope: object;
}

export interface ForwardBridgeToolCallArgs {
  arguments: Record<string, unknown>;
  providerThreadId: string;
  scope: object;
  threadId: string;
  toolName: string;
  signal?: AbortSignal;
  turnId?: string;
}

export interface PendingToolCallTracker {
  forwardToolCall: (
    args: ForwardBridgeToolCallArgs,
  ) => Promise<BridgeToolCallResult>;
  handleToolCallResponse: (response: BridgeJsonRpcResponse) => boolean;
  resolvePendingToolCalls: (scope: object, message: string) => void;
}

export function createPendingToolCallTracker(options: {
  sendToolCall: (request: BridgeToolCallRequest) => void;
  sendCancellation?: (notification: {
    jsonrpc: "2.0";
    method: typeof PROVIDER_TOOL_CALL_CANCELLED_METHOD;
    params: { requestId: string | number };
  }) => void;
}): PendingToolCallTracker {
  const pendingToolCalls = new Map<string | number, PendingToolCall>();
  let requestIdCounter = 0;

  function takePending(
    requestId: string | number,
  ): PendingToolCall | undefined {
    const pending = pendingToolCalls.get(requestId);
    if (pending) {
      pendingToolCalls.delete(requestId);
      pending.detachAbortListener();
    }
    return pending;
  }

  function cancel(requestId: string | number, message: string): void {
    const pending = takePending(requestId);
    if (!pending) return;
    try {
      options.sendCancellation?.({
        jsonrpc: "2.0",
        method: PROVIDER_TOOL_CALL_CANCELLED_METHOD,
        params: { requestId },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    pending.resolve({ content: message, isError: true });
  }

  return {
    forwardToolCall: (args) => {
      return new Promise<BridgeToolCallResult>((resolve) => {
        if (args.signal?.aborted) {
          resolve({
            content: "Tool call aborted before dispatch",
            isError: true,
          });
          return;
        }
        requestIdCounter += 1;
        const requestId = requestIdCounter;
        const onAbort = () =>
          cancel(requestId, "Tool call cancellation requested");
        pendingToolCalls.set(requestId, {
          resolve,
          scope: args.scope,
          detachAbortListener: () =>
            args.signal?.removeEventListener("abort", onAbort),
        });
        args.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          options.sendToolCall({
            jsonrpc: "2.0",
            id: requestId,
            method: "item/tool/call",
            params: {
              threadId: args.threadId,
              providerThreadId: args.providerThreadId,
              turnId: args.turnId ?? null,
              callId: `call-${requestId}`,
              tool: args.toolName,
              arguments: args.arguments,
            },
          });
        } catch (error) {
          takePending(requestId)?.resolve({
            content: error instanceof Error ? error.message : String(error),
            isError: true,
          });
        }
      });
    },
    handleToolCallResponse: (response) => {
      const pending = takePending(response.id);
      if (!pending) {
        return false;
      }
      if ("error" in response) {
        pending.resolve({
          content: response.error.message ?? "Tool call failed",
          isError: true,
        });
      } else {
        pending.resolve(decodeToolCallResponsePayload(response.result));
      }
      return true;
    },
    resolvePendingToolCalls: (scope, message) => {
      for (const [requestId, pending] of pendingToolCalls) {
        if (pending.scope !== scope) {
          continue;
        }
        cancel(requestId, message);
      }
    },
  };
}
