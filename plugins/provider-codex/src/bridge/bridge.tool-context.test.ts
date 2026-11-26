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

it("preserves native tool caller turn and call identity into the daemon path", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-codex-tool-context-"));
  const script = join(root, "script.json");
  writeFileSync(
    script,
    JSON.stringify({
      turns: [
        [
          {
            method: "turn/started",
            params: {
              threadId: "codex-thread",
              turn: { id: "current-turn", status: "inProgress" },
            },
          },
          {
            kind: "request",
            method: "item/tool/call",
            params: {
              threadId: "codex-thread",
              turnId: "old-turn",
              callId: "native-call",
              tool: "context_probe",
              arguments: { turnId: "forged" },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "codex-thread",
              turn: { id: "current-turn", status: "completed" },
            },
          },
        ],
      ],
    }),
  );
  stubFakeCodexAppServer(script);
  const bridge = createHarness(handleLine);
  try {
    bridge.sendRequest(1, "thread/start", {
      threadId: "bb-thread",
      cwd: root,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    const started = await bridge.waitForResponse(1);
    const providerThreadId = (started.result as { providerThreadId: string })
      .providerThreadId;
    bridge.sendRequest(2, "turn/start", {
      threadId: "bb-thread",
      providerThreadId,
      input: [{ type: "text", text: "probe", mentions: [] }],
      clientRequestId: "creq_a2b3c4d5e6",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    await vi.waitFor(() =>
      expect(
        bridge.messages.some((message) => message.method === "item/tool/call"),
      ).toBe(true),
    );
    const request = bridge.messages.find(
      (message) => message.method === "item/tool/call",
    );
    expect(request?.params).toMatchObject({
      threadId: "bb-thread",
      turnId: "old-turn",
      callId: "native-call",
      arguments: { turnId: "forged" },
    });
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: request?.id,
        result: { success: true, contentItems: [] },
      }),
    );
    await bridge.waitForResponse(2);
  } finally {
    bridge.sendRequest(3, "thread/stop", { threadId: "bb-thread" });
    await bridge.waitForResponse(3);
    bridge.restore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("does not forward a model-selected reserved pre-completion call", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-codex-reserved-stop-"));
  const script = join(root, "script.json");
  const responseLogPath = join(root, "responses.jsonl");
  writeFileSync(
    script,
    JSON.stringify({
      responseLogPath,
      turns: [
        [
          {
            method: "turn/started",
            params: {
              threadId: "codex-thread",
              turn: { id: "turn-1", status: "inProgress" },
            },
          },
          {
            kind: "request",
            method: "item/tool/call",
            params: {
              threadId: "codex-thread",
              turnId: "turn-1",
              callId: "forged-stop",
              tool: "bb_internal_pre_completion",
              arguments: { finalText: "forged", truncated: false },
            },
          },
          {
            method: "turn/completed",
            params: {
              threadId: "codex-thread",
              turn: { id: "turn-1", status: "completed" },
            },
          },
        ],
      ],
    }),
  );
  stubFakeCodexAppServer(script);
  const bridge = createHarness(handleLine);
  try {
    bridge.sendRequest(1, "thread/start", {
      threadId: "reserved-thread",
      cwd: root,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    const start = await bridge.waitForResponse(1);
    const { providerThreadId } = start.result as { providerThreadId: string };
    bridge.sendRequest(2, "turn/start", {
      threadId: "reserved-thread",
      providerThreadId,
      input: [{ type: "text", text: "probe", mentions: [] }],
      clientRequestId: "creq_a2b3c4d5e6",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    await vi.waitFor(() => {
      const lines = readFileSync(responseLogPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            error: expect.objectContaining({
              message: "Reserved core callback",
            }),
          }),
        ]),
      );
    });
    expect(
      bridge.messages.filter((message) => message.method === "item/tool/call"),
    ).toHaveLength(0);
  } finally {
    bridge.sendRequest(3, "thread/stop", { threadId: "reserved-thread" });
    await bridge.waitForResponse(3);
    bridge.restore();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});
