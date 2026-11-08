import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildBridgeMcpServer } from "../tool-proxy-mcp.js";

const RESULT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    value: {
      type: "object",
      required: ["verdict", "blockers"],
      properties: {
        verdict: { enum: ["merge", "do-not-merge"] },
        blockers: {
          type: "array",
          items: {
            type: "object",
            required: ["title"],
            properties: { title: { type: "string" } },
          },
        },
      },
    },
  },
  required: ["value"],
  additionalProperties: false,
};

async function connect(server: ReturnType<typeof buildBridgeMcpServer>) {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

describe("buildBridgeMcpServer", () => {
  it("always loads the plan tool while leaving other tools deferrable", async () => {
    const coreSource = readFileSync(
      new URL(
        "../../../../../apps/server/src/services/threads/thread-plan-tool.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const name = coreSource.match(
      /export const BB_UPDATE_PLAN_TOOL[^=]*=\s*\{\s*name:\s*"([^"]+)"/,
    )?.[1];
    if (name === undefined) {
      throw new Error("Cannot read BB_UPDATE_PLAN_TOOL.name from core");
    }
    const server = buildBridgeMcpServer(
      [name, "bb_workflow_result"].map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
      async () => ({ content: "Plan updated" }),
    );
    const client = await connect(server);

    try {
      const listed = await client.listTools();
      expect(listed.tools[0]?._meta).toEqual({
        "anthropic/alwaysLoad": true,
      });
      expect(listed.tools[1]?._meta).toBeUndefined();
      const result = await client.callTool({
        name,
        arguments: { plan: [{ step: "First", status: "completed" }] },
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: "Plan updated (1/1 steps completed). Ensure you keep using the plan to track your progress and mark it complete when you finish.",
        },
      ]);
    } finally {
      await client.close();
    }
  });

  it("serves registered JSON schemas verbatim over tools/list", async () => {
    const server = buildBridgeMcpServer(
      [
        {
          name: "bb_workflow_result",
          description: "Return the structured result.",
          inputSchema: RESULT_SCHEMA,
        },
        {
          name: "bb_odd_tool",
          description: "Tool registered with a non-object schema.",
          inputSchema: { type: "string" },
        },
      ],
      async () => ({ content: "unused" }),
    );
    const client = await connect(server);

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(2);
    expect(listed.tools[0]).toMatchObject({
      name: "bb_workflow_result",
      description: "Return the structured result.",
      inputSchema: RESULT_SCHEMA,
    });
    expect(listed.tools[1]?.inputSchema).toEqual({ type: "object" });
    await client.close();
  });

  it.each([
    { statuses: ["pending", "in_progress"], completed: 0 },
    { statuses: ["completed", "in_progress", "pending"], completed: 1 },
    { statuses: ["completed", "completed"], completed: 2 },
    { statuses: [], completed: 0 },
  ])("returns plan progress for $statuses", async ({ statuses, completed }) => {
    const args = {
      plan: statuses.map((status, index) => ({
        step: `Step ${index}`,
        status,
      })),
    };
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> =
      [];
    const server = buildBridgeMcpServer(
      [
        {
          name: "bb_update_plan",
          description: "Plan",
          inputSchema: { type: "object" },
        },
      ],
      async (toolName, args) => {
        calls.push({ toolName, args });
        return {
          content: "Plan updated",
          contentBlocks: [{ type: "text", text: "Plan updated" }],
        };
      },
    );
    const client = await connect(server);

    try {
      const result = await client.callTool({
        name: "bb_update_plan",
        arguments: args,
      });
      expect(result.content).toEqual([
        {
          type: "text",
          text: `Plan updated (${completed}/${statuses.length} steps completed). Ensure you keep using the plan to track your progress and mark it complete when you finish.`,
        },
      ]);
      expect(result.isError).toBeUndefined();
      expect(calls).toEqual([{ toolName: "bb_update_plan", args }]);
    } finally {
      await client.close();
    }
  });

  it.each([
    { name: "bb_update_plan", isError: true },
    { name: "bb_workflow_result", isError: false },
  ])(
    "preserves forwarded content for $name with isError=$isError",
    async ({ name, isError }) => {
      const contentBlocks = [
        {
          type: "text" as const,
          text: isError ? "Plan rejected" : "Plan updated",
        },
      ];
      const server = buildBridgeMcpServer(
        [{ name, description: name, inputSchema: { type: "object" } }],
        async () => ({ content: "fallback", contentBlocks, isError }),
      );
      const client = await connect(server);

      try {
        const result = await client.callTool({
          name,
          arguments: { plan: [{ step: "First", status: "completed" }] },
        });
        expect(result.content).toEqual(contentBlocks);
        expect(Boolean(result.isError)).toBe(isError);
      } finally {
        await client.close();
      }
    },
  );

  it.each([undefined, null, {}, [null], [{ status: "invalid" }]])(
    "preserves the result when progress cannot be read from %j",
    async (plan) => {
      const server = buildBridgeMcpServer(
        [
          {
            name: "bb_update_plan",
            description: "Plan",
            inputSchema: { type: "object" },
          },
        ],
        async () => ({ content: "Plan updated" }),
      );
      const client = await connect(server);

      try {
        const result = await client.callTool({
          name: "bb_update_plan",
          arguments: { plan },
        });
        expect(result.content).toEqual([
          { type: "text", text: "Plan updated" },
        ]);
      } finally {
        await client.close();
      }
    },
  );

  it("forwards tool calls with raw arguments and reports errors", async () => {
    const calls: Array<{ toolName: string; args: Record<string, unknown> }> =
      [];
    const server = buildBridgeMcpServer(
      [
        {
          name: "bb_workflow_result",
          description: "Return the structured result.",
          inputSchema: RESULT_SCHEMA,
        },
      ],
      async (toolName, args) => {
        calls.push({ toolName, args });
        return { content: '{"accepted":true}' };
      },
    );
    const client = await connect(server);

    const result = await client.callTool({
      name: "bb_workflow_result",
      arguments: { value: { verdict: "merge", blockers: [] } },
    });
    expect(result).toMatchObject({
      content: [{ type: "text", text: '{"accepted":true}' }],
    });
    expect(result.isError).toBeUndefined();
    expect(calls).toEqual([
      {
        toolName: "bb_workflow_result",
        args: { value: { verdict: "merge", blockers: [] } },
      },
    ]);

    const unknown = await client.callTool({
      name: "bb_missing",
      arguments: {},
    });
    expect(unknown).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Unknown tool: bb_missing" }],
    });
    await client.close();
  });

  it("serves an image-only tool result as an MCP image block", async () => {
    const server = buildBridgeMcpServer(
      [
        {
          name: "browser_screenshot",
          description: "A PNG of the current page.",
          inputSchema: { type: "object" },
        },
      ],
      async () => ({
        content: "",
        contentBlocks: [
          {
            type: "image" as const,
            data: "iVBORw0KGgo=",
            mimeType: "image/png",
          },
        ],
        images: [{ data: "iVBORw0KGgo=", mimeType: "image/png" }],
      }),
    );
    const client = await connect(server);

    const result = await client.callTool({
      name: "browser_screenshot",
      arguments: {},
    });
    expect(result.content).toEqual([
      { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
    ]);
    await client.close();
  });
});
