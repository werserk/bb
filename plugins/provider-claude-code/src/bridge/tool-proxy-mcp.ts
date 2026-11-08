import {
  type DynamicTool,
  experimental_buildBridgeToolCallContent,
} from "@get-bb/plugin-sdk/provider-bridge";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { BB_BRIDGE_MCP_SERVER_NAME } from "../tool-classification.js";

type BridgeToolCallContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type ToolCallForwarder = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<{
  content: string;
  contentBlocks?: BridgeToolCallContent[];
  isError?: boolean;
}>;

export function buildBridgeMcpServer(
  dynamicTools: DynamicTool[],
  forwardToolCall: ToolCallForwarder,
): McpSdkServerConfigWithInstance {
  const toolsByName = new Map(dynamicTools.map((def) => [def.name, def]));
  const instance = new McpServer(
    { name: BB_BRIDGE_MCP_SERVER_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  instance.server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: dynamicTools.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: normalizeInputSchema(def.inputSchema),
      ...(def.name === "bb_update_plan"
        ? { _meta: { "anthropic/alwaysLoad": true } }
        : {}),
    })),
  }));
  instance.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const def = toolsByName.get(request.params.name);
    if (def === undefined) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown tool: ${request.params.name}`,
          },
        ],
        isError: true,
      };
    }
    const args = request.params.arguments ?? {};
    const result = await forwardToolCall(def.name, args);
    let content = experimental_buildBridgeToolCallContent(result);
    if (def.name === "bb_update_plan" && !result.isError) {
      const plan = z
        .array(
          z.object({
            status: z.enum(["pending", "in_progress", "completed"]),
          }),
        )
        .safeParse(args.plan);
      if (plan.success) {
        const completed = plan.data.filter(
          (step) => step.status === "completed",
        ).length;
        content = [
          {
            type: "text",
            text: `Plan updated (${completed}/${plan.data.length} steps completed). Ensure you keep using the plan to track your progress and mark it complete when you finish.`,
          },
        ];
      }
    }
    return {
      content,
      ...(result.isError ? { isError: true } : {}),
    };
  });
  return { type: "sdk", name: BB_BRIDGE_MCP_SERVER_NAME, instance };
}

export function getAllowedToolNames(dynamicTools: DynamicTool[]): string[] {
  return dynamicTools.map(
    (def) => `mcp__${BB_BRIDGE_MCP_SERVER_NAME}__${def.name}`,
  );
}

function normalizeInputSchema(
  inputSchema: unknown,
): Record<string, unknown> & { type: "object" } {
  if (
    inputSchema !== null &&
    typeof inputSchema === "object" &&
    !Array.isArray(inputSchema) &&
    (inputSchema as { type?: unknown }).type === "object"
  ) {
    return inputSchema as Record<string, unknown> & { type: "object" };
  }
  return { type: "object" };
}
