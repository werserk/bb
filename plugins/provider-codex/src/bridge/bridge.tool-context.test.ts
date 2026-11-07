import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
