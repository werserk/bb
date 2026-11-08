import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  BRIDGE_JSON_RPC_ERRORS,
  type JsonValue,
} from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@get-bb/plugin-sdk/provider-bridge/testing";
import { experimental_killAllChildrenForTests, handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const THREAD_ID = "thr_steer_stale_1";

const AUTO_ASK_SESSION_OPTIONS = {
  permissionMode: "auto",
  permissionScope: "workspace",
  approvalReviewer: "automatic",
  permissionEscalation: "ask",
} as const;

async function steerAfterStart(args: {
  script: Record<string, unknown>;
  expectedTurnId: string;
  options: Record<string, JsonValue>;
}) {
  const cwd = mkdtempSync(join(tmpdir(), "bb-codex-steer-stale-"));
  const script = join(cwd, "script.json");
  writeFileSync(script, JSON.stringify(args.script));
  stubFakeCodexAppServer(script);
  const harness = createBridgeJsonRpcTestHarness(handleLine);
  try {
    harness.sendRequest(1, "thread/start", {
      threadId: THREAD_ID,
      cwd,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    const started = await harness.waitForResponse(1);
    expect(started.error).toBeUndefined();
    const { providerThreadId } = z
      .object({ providerThreadId: z.string() })
      .parse(started.result);
    harness.sendRequest(2, "turn/start", {
      threadId: THREAD_ID,
      providerThreadId,
      clientRequestId: "creq_2345678933",
      input: [{ type: "text", text: "/wait-for-interrupt", mentions: [] }],
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    expect((await harness.waitForResponse(2)).error).toBeUndefined();
    harness.sendRequest(3, "turn/steer", {
      threadId: THREAD_ID,
      providerThreadId,
      expectedTurnId: args.expectedTurnId,
      clientRequestId: "creq_2345678934",
      input: [{ type: "text", text: "late steer", mentions: [] }],
      options: args.options,
    });
    return await harness.waitForResponse(3);
  } finally {
    harness.sendRequest(4, "thread/stop", {
      threadId: THREAD_ID,
      providerThreadId: "steer-stale-cleanup",
      intent: "release",
      activeTurnId: null,
    });
    await harness.waitForResponse(4).catch(() => undefined);
    experimental_killAllChildrenForTests();
    harness.restore();
    vi.unstubAllEnvs();
    rmSync(cwd, { recursive: true, force: true });
  }
}

function staleTurnError(message: string) {
  return {
    code: BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
    message,
    data: { recovery: { kind: "staleTurn", message, retryable: false } },
  };
}

it("reports a steer Codex refuses for a finished turn as a stale turn", async () => {
  const steered = await steerAfterStart({
    script: {
      steerError: { code: -32600, message: "no active turn to steer" },
    },
    expectedTurnId: "turn-fx-1",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });

  expect(steered.error).toMatchObject(
    staleTurnError("no active turn to steer"),
  );
});

it("reports a permission-changing steer into a closed turn as a stale turn", async () => {
  const steered = await steerAfterStart({
    script: {},
    expectedTurnId: "turn-already-closed",
    options: AUTO_ASK_SESSION_OPTIONS,
  });

  expect(steered.error).toMatchObject(
    staleTurnError("The turn to steer is no longer active"),
  );
});

it("keeps other steer failures as bridge errors", async () => {
  const steered = await steerAfterStart({
    script: { steerError: { code: -32603, message: "steer exploded" } },
    expectedTurnId: "turn-fx-1",
    options: FULL_ACCESS_SESSION_OPTIONS,
  });

  expect(steered.error).toMatchObject({
    code: BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
    message: "steer exploded",
  });
});
