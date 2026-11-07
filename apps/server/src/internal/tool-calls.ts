import {
  hostDaemonToolCallRequestSchema,
  typedRoutes,
  type HostDaemonInternalSchema,
} from "@bb/host-daemon-contract";
import type { ToolCallResponse } from "@bb/domain";
import type { Hono } from "hono";
import type { AppDeps } from "../types.js";
import { ApiError } from "../errors.js";
import { requireThreadEnvironment } from "../services/lib/entity-lookup.js";
import {
  findPluginAgentTool,
  invokePluginAgentTool,
} from "../services/plugins/plugin-agent-contributions.js";
import { deliverDetachedToolResult } from "../services/plugins/detached-tool-result-delivery.js";
import { requirePluginToolCallRegistry } from "../services/plugins/plugin-tool-calls.js";
import { raiseOwnerPostAttention } from "../services/threads/owner-post.js";
import {
  handleUpdateEnvironmentDirectoryToolCall,
  UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME,
} from "../services/threads/thread-environment-directory.js";
import { requireAuthenticatedDaemonSession } from "./session-state.js";

import {
  BB_UPDATE_PLAN_TOOL,
  handleUpdatePlanToolCall,
} from "../services/threads/thread-plan-tool.js";

const textEncoder = new TextEncoder();

function streamToolCallResponse(
  result: Promise<ToolCallResponse>,
  abortController: AbortController,
): Response {
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      abortController.abort();
    },
    start(controller) {
      void result.then(
        (response) => {
          try {
            controller.enqueue(textEncoder.encode(JSON.stringify(response)));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
        (error) => controller.error(error),
      );
    },
  });
  return new Response(body, {
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

export function registerInternalToolCallRoutes(app: Hono, deps: AppDeps): void {
  const { post } = typedRoutes<HostDaemonInternalSchema>(app, {
    onValidationError: (msg) => new ApiError(400, "invalid_request", msg),
  });

  post(
    "/session/tool-call",
    hostDaemonToolCallRequestSchema,
    async (context, payload) => {
      const session = requireAuthenticatedDaemonSession({
        context,
        db: deps.db,
        sessionId: payload.sessionId,
      });
      const { environment, thread } = requireThreadEnvironment(
        deps.db,
        payload.threadId,
      );
      if (environment.hostId !== session.hostId) {
        throw new ApiError(
          403,
          "invalid_request",
          "Thread does not belong to the session host",
        );
      }

      if (
        payload.turnId === undefined &&
        (payload.tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME ||
          payload.tool === BB_UPDATE_PLAN_TOOL.name)
      ) {
        throw new ApiError(400, "invalid_request", "This tool requires turnId");
      }

      if (
        payload.tool === UPDATE_ENVIRONMENT_DIRECTORY_TOOL_NAME &&
        payload.turnId !== undefined
      ) {
        return context.json(
          await handleUpdateEnvironmentDirectoryToolCall(deps, {
            currentEnvironment: environment,
            input: payload.arguments,
            thread,
            turnId: payload.turnId,
          }),
        );
      }

      if (
        payload.tool === BB_UPDATE_PLAN_TOOL.name &&
        payload.turnId !== undefined
      ) {
        return context.json(
          handleUpdatePlanToolCall(deps, {
            threadId: thread.id,
            providerThreadId: payload.providerThreadId,
            turnId: payload.turnId,
            callId: payload.callId,
            input: payload.arguments,
          }),
        );
      }

      const pluginTool = findPluginAgentTool(payload.tool);
      if (pluginTool) {
        const roundTrip = new AbortController();
        const response = requirePluginToolCallRegistry().run({
          pluginId: pluginTool.pluginId,
          threadId: thread.id,
          callId: payload.callId,
          toolName: payload.tool,
          roundTrip: AbortSignal.any([
            context.req.raw.signal,
            roundTrip.signal,
          ]),
          invoke: async (signal) => {
            const result = await invokePluginAgentTool(pluginTool, {
              input: payload.arguments,
              ctx: {
                threadId: thread.id,
                projectId: thread.projectId,
                ...(payload.turnId !== undefined
                  ? { turnId: payload.turnId }
                  : {}),
                callId: payload.callId,
                signal,
              },
            });
            if (!signal.aborted) {
              try {
                raiseOwnerPostAttention(deps, {
                  input: payload.arguments,
                  presentation: pluginTool.record.presentation,
                  response: result,
                  threadId: thread.id,
                });
              } catch (error) {
                deps.logger.warn(
                  { err: error, threadId: thread.id, tool: payload.tool },
                  "Failed to raise attention for an owner post",
                );
              }
            }
            return result;
          },
          onDetachedResult: (result) =>
            deliverDetachedToolResult(deps, {
              threadId: thread.id,
              toolName: payload.tool,
              presentation: pluginTool.record.presentation,
              response: result,
            }),
        });
        return streamToolCallResponse(response, roundTrip);
      }

      return context.json({
        success: false,
        contentItems: [
          { type: "inputText", text: `Unsupported tool: ${payload.tool}` },
        ],
      });
    },
  );
}
