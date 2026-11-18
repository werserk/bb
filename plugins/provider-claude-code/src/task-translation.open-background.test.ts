import { describe, expect, it } from "vitest";
import {
  createClaudeDeltaHarness,
  spawningToolUseMessage,
} from "./delta-test-harness.js";

const THREAD_ID = "bb-thread-open";
const context = { threadId: THREAD_ID };

function taskStarted(
  taskId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_started",
    task_id: taskId,
    description: `Task ${taskId}`,
    task_type: "local_bash",
    uuid: `u-start-${taskId}`,
    session_id: "s-open",
    ...fields,
  };
}

function taskUpdated(
  taskId: string,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_updated",
    task_id: taskId,
    patch,
    uuid: `u-update-${taskId}`,
    session_id: "s-open",
  };
}

function taskNotification(
  taskId: string,
  status: "completed" | "failed" | "stopped",
): Record<string, unknown> {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: taskId,
    status,
    output_file: "",
    summary: `Task ${taskId} ${status}`,
    uuid: `u-notify-${taskId}`,
    session_id: "s-open",
  };
}

function openHarness() {
  const harness = createClaudeDeltaHarness();
  return {
    harness,
    send(event: Record<string, unknown>) {
      harness.translate(event, context);
    },
    isOpen() {
      return harness.translator.hasOpenBackgroundTasks(THREAD_ID);
    },
  };
}

describe("claude-code open background task ids", () => {
  it("opens an id for a Monitor-type task", () => {
    const { send, isOpen } = openHarness();

    send(taskStarted("monitor-1", { task_type: "monitor" }));

    expect(isOpen()).toBe(true);
  });

  it("opens an id for a task whose tool use was not forwarded", () => {
    const { send, isOpen } = openHarness();

    send(
      taskStarted("child-bash", {
        tool_use_id: "toolu_not_forwarded",
        is_backgrounded: true,
      }),
    );

    expect(isOpen()).toBe(true);
  });

  it("keeps a foreground task closed until it moves to the background", () => {
    const { send, isOpen } = openHarness();
    send(
      spawningToolUseMessage({
        toolUseId: "toolu_bash_moved",
        toolName: "Bash",
        input: { command: "pnpm build" },
      }),
    );

    send(
      taskStarted("bmoved", {
        tool_use_id: "toolu_bash_moved",
        is_backgrounded: false,
      }),
    );
    expect(isOpen()).toBe(false);

    send(taskUpdated("bmoved", { is_backgrounded: true }));
    expect(isOpen()).toBe(true);
  });

  it.each(["completed", "failed", "stopped"] as const)(
    "closes the id on a %s notification",
    (status) => {
      const { send, isOpen } = openHarness();
      send(taskStarted("bg-1"));
      expect(isOpen()).toBe(true);

      send(taskNotification("bg-1", status));

      expect(isOpen()).toBe(false);
    },
  );

  it.each(["completed", "failed", "killed"])(
    "terminal task_updated closes: %s",
    (status) => {
      const { send, isOpen } = openHarness();
      send(taskStarted("bg-1", { task_type: "monitor" }));

      send(taskUpdated("bg-1", { status }));

      expect(isOpen()).toBe(false);
    },
  );

  it("keeps the id open on a paused task_updated", () => {
    const { send, isOpen } = openHarness();
    send(taskStarted("bg-1"));

    send(taskUpdated("bg-1", { status: "paused" }));

    expect(isOpen()).toBe(true);
  });

  it("leaves the id closed when one task_updated moves it to the background and completes it", () => {
    const { send, isOpen } = openHarness();
    send(taskStarted("bg-1", { is_backgrounded: false }));

    send(taskUpdated("bg-1", { is_backgrounded: true, status: "completed" }));

    expect(isOpen()).toBe(false);
  });

  it("keeps the id open until every open task has closed", () => {
    const { send, isOpen } = openHarness();
    send(taskStarted("bg-1"));
    send(taskStarted("bg-2", { task_type: "monitor" }));

    send(taskNotification("bg-1", "completed"));
    expect(isOpen()).toBe(true);

    send(taskUpdated("bg-2", { status: "killed" }));
    expect(isOpen()).toBe(false);
  });

  it("clears every id when the session is interrupted", () => {
    const { harness, send, isOpen } = openHarness();
    send(taskStarted("bg-1"));
    send(taskStarted("monitor-1", { task_type: "monitor" }));

    harness.settleSession(THREAD_ID);

    expect(isOpen()).toBe(false);
  });

  it("clears every id when the SDK stream ends", () => {
    const { harness, send, isOpen } = openHarness();
    send(taskStarted("bg-1"));

    harness.translator.buildBackgroundTaskSettlementDeltas(THREAD_ID);

    expect(isOpen()).toBe(false);
  });

  it("keeps ids per thread", () => {
    const harness = createClaudeDeltaHarness();
    harness.translate(taskStarted("bg-1"), { threadId: "thread-a" });

    expect(harness.translator.hasOpenBackgroundTasks("thread-a")).toBe(true);
    expect(harness.translator.hasOpenBackgroundTasks("thread-b")).toBe(false);
  });
});
