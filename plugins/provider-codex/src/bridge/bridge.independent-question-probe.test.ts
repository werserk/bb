import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { experimental_createBridgeJsonRpcTestHarness as createHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

it("continues after an independent question publication without a user answer", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-independent-question-"));
  const script = join(root, "script.json");
  const responses = join(root, "responses.jsonl");
  writeFileSync(
    script,
    JSON.stringify({
      responseLogPath: responses,
      turns: [
        [
          {
            method: "turn/started",
            params: {
              threadId: "codex-thread",
              turn: { id: "turn-question", status: "inProgress" },
            },
          },
          {
            kind: "request",
            method: "item/tool/requestUserInput",
            params: {
              threadId: "codex-thread",
              turnId: "turn-question",
              itemId: "native-question",
              questions: [
                { id: "voice", header: "Voice", question: "Which voice?" },
              ],
            },
          },
          {
            kind: "request",
            method: "item/tool/call",
            params: {
              threadId: "codex-thread",
              turnId: "turn-question",
              callId: "publish-question",
              tool: "bb_ask_question",
              arguments: { question: "Choose a voice" },
            },
          },
          {
            method: "item/completed",
            params: {
              threadId: "codex-thread",
              turnId: "turn-question",
              item: {
                type: "agentMessage",
                id: "async-voice",
                text: "Compare the voices",
                phase: "final_answer",
                delivery: "async",
                memoryCitation: null,
                questions: [{ title: "Which voice?", options: ["A", "B"] }],
              },
            },
          },
          {
            kind: "request",
            method: "item/tool/call",
            params: {
              threadId: "codex-thread",
              turnId: "turn-question",
              callId: "continue-work",
              tool: "continue_probe",
              arguments: {},
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "codex-thread",
              turn: { id: "turn-question", status: "completed" },
            },
          },
        ],
      ],
    }),
  );
  stubFakeCodexAppServer(script);
  const bridge = createHarness(handleLine);
  const threadId = "bb-independent-question";
  try {
    bridge.sendRequest(1, "thread/start", {
      threadId,
      cwd: root,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
      dynamicTools: [
        {
          name: "bb_ask_question",
          description: "Publish a persistent question and return immediately",
          inputSchema: {
            type: "object",
            properties: { question: { type: "string" } },
            required: ["question"],
          },
        },
        {
          name: "continue_probe",
          description: "Continue working",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
    const started = await bridge.waitForResponse(1);
    const providerThreadId = (started.result as { providerThreadId: string })
      .providerThreadId;
    bridge.sendRequest(2, "turn/start", {
      threadId,
      providerThreadId,
      input: [{ type: "text", text: "Ask and continue", mentions: [] }],
      clientRequestId: "creq_a2b3c4d5e6",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    for (const [callId, content] of [
      [
        "publish-question",
        JSON.stringify({
          questionId: "q_probe_1",
          revision: 1,
          status: "open",
        }),
      ],
      [
        "async-question:async-voice",
        JSON.stringify({ questionId: "q_async", status: "open" }),
      ],
      ["continue-work", "Continued before any answer"],
    ]) {
      await vi.waitFor(() =>
        expect(
          bridge.messages.some((m) => {
            expect(m.method).not.toBe("interaction/request");
            return (
              m.method === "item/tool/call" &&
              typeof m.params === "object" &&
              m.params !== null &&
              !Array.isArray(m.params) &&
              m.params.callId === callId
            );
          }),
        ).toBe(true),
      );
      const request = bridge.messages.find(
        (m) =>
          m.method === "item/tool/call" &&
          typeof m.params === "object" &&
          m.params !== null &&
          !Array.isArray(m.params) &&
          m.params.callId === callId,
      );
      if (callId === "async-question:async-voice")
        expect(request?.params).toMatchObject({
          turnId: "turn-question",
          providerThreadId,
          tool: "bb_ask_question",
          arguments: {
            body: "Compare the voices",
            materials: [],
            questions: [
              {
                id: "question_1",
                prompt: "Which voice?",
                options: [
                  { value: "option_1", label: "A" },
                  { value: "option_2", label: "B" },
                ],
              },
            ],
          },
        });
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request?.id,
          result: {
            success: true,
            contentItems: [{ type: "inputText", text: content }],
          },
        }),
      );
    }
    await bridge.waitForResponse(2);
    await vi.waitFor(() =>
      expect(readFileSync(responses, "utf8").trim().split("\n")).toHaveLength(
        3,
      ),
    );
    const delivered = readFileSync(responses, "utf8")
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    expect(delivered[0]).toMatchObject({
      error: { message: expect.stringContaining("bb_ask_question") },
    });
    expect(delivered[0]).not.toHaveProperty("result");
    expect(delivered[1].result).toMatchObject({
      success: true,
      contentItems: [
        { type: "inputText", text: expect.stringContaining("q_probe_1") },
      ],
    });
    expect(delivered[2].result).toMatchObject({ success: true });
    expect(JSON.stringify(bridge.messages)).not.toContain(
      "provider-codex/async-question",
    );
    expect(
      bridge.messages.some((m) => m.method === "interaction/request"),
    ).toBe(false);
  } finally {
    bridge.sendRequest(3, "thread/stop", { threadId });
    await bridge.waitForResponse(3);
    bridge.restore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
