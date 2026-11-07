import { describe, expect, it, vi } from "vitest";
import {
  collectLogLines,
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import type { CommandRegistrar } from "../helpers/command-output-harness.js";
import * as fixtures from "../helpers/command-output-fixtures.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread output command output", () => {
  setupCommandOutputTestEnvironment();

  const register: CommandRegistrar = (program) =>
    registerThreadCommands(program, () => "http://server");

  it("bb thread output requires a thread id or --self", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-output-context");
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    stubServerApi({
      "v1.threads.:id.$get": async () =>
        fixtures.makeThread({
          id: "thread-output",
          projectId: "proj-test",
          providerId: "codex",
        }),
      "v1.threads.:id.output.$get": getOutput,
      "v1.threads.:id.events.$get": async () => [
        {
          id: "e",
          threadId: "thread-output",
          scope: { kind: "thread" },
          seq: 1,
          createdAt: 1,
          type: "system/manager/user_message",
          data: { text: "FINAL" },
        },
      ],
    });

    await expect(runCommand(["thread", "output"], register)).rejects.toThrow(
      "process.exit:1",
    );

    expect(getOutput).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error))).toContain(
      "Error: Missing thread ID. Pass <threadId> or use --self.",
    );
  });

  it("bb thread output --self resolves from BB_THREAD_ID", async () => {
    vi.stubEnv("BB_THREAD_ID", "thread-output-context");
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    stubServerApi({
      "v1.threads.:id.$get": async () =>
        fixtures.makeThread({
          id: "thread-output",
          projectId: "proj-test",
          providerId: "codex",
        }),
      "v1.threads.:id.output.$get": getOutput,
      "v1.threads.:id.events.$get": async () => [
        {
          id: "e",
          threadId: "thread-output",
          scope: { kind: "thread" },
          seq: 1,
          createdAt: 1,
          type: "system/manager/user_message",
          data: { text: "FINAL" },
        },
      ],
    });

    await runCommand(["thread", "output", "--self"], register);

    expect(getOutput).not.toHaveBeenCalled();
    expect(collectLogLines(vi.mocked(console.error))).not.toContain(
      "Thread thread-output-context (from BB_THREAD_ID)",
    );
    expect(collectLogLines(vi.mocked(console.log))).toContain("FINAL");
  });

  it("bb thread output --json prints the raw output payload", async () => {
    const getOutput = vi.fn(async () => ({ output: "FINAL" }));
    stubServerApi({
      "v1.threads.:id.$get": async () =>
        fixtures.makeThread({
          id: "thread-output",
          projectId: "proj-test",
          providerId: "codex",
        }),
      "v1.threads.:id.output.$get": getOutput,
      "v1.threads.:id.events.$get": async () => [
        {
          id: "e",
          threadId: "thread-output",
          scope: { kind: "thread" },
          seq: 1,
          createdAt: 1,
          type: "system/manager/user_message",
          data: { text: "FINAL" },
        },
      ],
    });

    await runCommand(
      ["thread", "output", "thread-json-output", "--json", "--include-service"],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0])),
    ).toEqual({
      output: "FINAL",
    });
  });
  it.each(["active", "error", "idle"] as const)(
    "hides the previous service answer while a later %s owner turn has no answer",
    async (status) => {
      const hidden = {
        version: 1,
        visibility: "hidden",
        reason: "direction-result",
        origin: { pluginId: "wprojects", senderThreadId: null },
      };
      const event = (
        seq: number,
        type: string,
        data: unknown,
        turnId?: string,
      ) => ({
        id: `e${seq}`,
        threadId: "thread-output",
        seq,
        createdAt: seq,
        scope: turnId ? { kind: "turn", turnId } : { kind: "thread" },
        type,
        data,
      });
      const events = [
        event(1, "client/turn/requested", {
          requestId: "service",
          serviceTurn: hidden,
        }),
        event(
          2,
          "turn/input/accepted",
          { clientRequestId: "service" },
          "hidden-turn",
        ),
        event(
          3,
          "item/completed",
          { item: { type: "agentMessage", text: "PRIVATE" } },
          "hidden-turn",
        ),
        event(4, "client/turn/requested", { requestId: "owner" }),
      ];
      stubServerApi({
        "v1.threads.:id.$get": async () =>
          fixtures.makeThread({
            id: "thread-output",
            projectId: "p",
            providerId: "codex",
            status,
          }),
        "v1.threads.:id.output.$get": async () => ({ output: "PRIVATE" }),
        "v1.threads.:id.events.$get": async () => events,
      });
      await runCommand(["thread", "output", "thread-output"], register);
      expect(collectLogLines(vi.mocked(console.log))).toEqual(["(no output)"]);
    },
  );
  it("classifies a late service answer by its accepted turn rather than the latest owner request", async () => {
    const hidden = {
      version: 1,
      visibility: "hidden",
      reason: "direction-result",
      origin: { pluginId: "wprojects", senderThreadId: null },
    };
    const event = (
      seq: number,
      type: string,
      data: unknown,
      turnId?: string,
    ) => ({
      id: `e${seq}`,
      threadId: "thread-output",
      seq,
      createdAt: seq,
      scope: turnId ? { kind: "turn", turnId } : { kind: "thread" },
      type,
      data,
    });
    const events = [
      event(1, "client/turn/requested", {
        requestId: "service",
        serviceTurn: hidden,
      }),
      event(
        2,
        "turn/input/accepted",
        { clientRequestId: "service" },
        "hidden-turn",
      ),
      event(3, "client/turn/requested", { requestId: "owner" }),
      event(
        4,
        "item/completed",
        { item: { type: "agentMessage", text: "PRIVATE" } },
        "hidden-turn",
      ),
    ];
    stubServerApi({
      "v1.threads.:id.$get": async () =>
        fixtures.makeThread({
          id: "thread-output",
          projectId: "p",
          providerId: "codex",
        }),
      "v1.threads.:id.output.$get": async () => ({ output: "PRIVATE" }),
      "v1.threads.:id.events.$get": async () => events,
    });
    await runCommand(["thread", "output", "thread-output"], register);
    expect(collectLogLines(vi.mocked(console.log))).toEqual(["(no output)"]);
  });
});
