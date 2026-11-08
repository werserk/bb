import { describe, expect, it } from "vitest";
import {
  buildChildThreadNeedsAttentionInput,
  buildChildThreadTurnStatusBatchInput,
  type ChildThreadNotificationSource,
  type ChildThreadTurnNotificationBatchItem,
} from "../../../src/services/threads/child-thread-notifications.js";

interface TestThreadArgs {
  id: string;
  title: string | null;
}

function testThread(args: TestThreadArgs): ChildThreadNotificationSource {
  return {
    id: args.id,
    projectId: "proj_alpha",
    title: args.title,
  };
}

function renderBatchMessage(args: {
  items: ChildThreadTurnNotificationBatchItem[];
}): string {
  const [input] = buildChildThreadTurnStatusBatchInput(args);
  if (!input || input.type !== "text") {
    throw new Error("Expected one text input");
  }
  return input.text;
}

describe("child thread notifications", () => {
  it("keeps final output for a single completed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Implemented the requested change.",
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed:",
        "",
        "Implemented the requested change.",
      ].join("\n"),
    );
    expect(message).not.toContain("Child thread updates:");
  });

  it("omits output for a single failed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child failed.",
        "",
        "Review the thread before deciding next steps.",
      ].join("\n"),
    );
    expect(message).not.toContain("Deploy script failed on preflight.");
  });

  it("omits terminal output for a single interrupted outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Stopped after writing the checkout summary.",
          turnStatus: "interrupted",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child was interrupted.",
        "",
        "Review the thread before deciding next steps.",
      ].join("\n"),
    );
    expect(message).not.toContain("Child thread updates:");
    expect(message).not.toContain(
      "Stopped after writing the checkout summary.",
    );
  });

  it("renders multiple child outcomes with each completed child's result text", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_three",
            title: "Update docs",
          }),
          terminalOutput: null,
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "Child thread updates:",
        "",
        "- @thread:thr_child_one completed:",
        "",
        "Checkout flow is fixed.",
        "",
        "- @thread:thr_child_two failed.",
        "",
        "- @thread:thr_child_three completed:",
        "",
        "No final output was recorded.",
      ].join("\n"),
    );
    expect(message).not.toContain("Deploy script failed on preflight.");
  });

  it("keeps a batch of long results inside one total bound", () => {
    const long = (mark: string) =>
      `${mark}-head ${"x".repeat(5_000)} ${mark}-tail`;
    const items = ["a", "b", "c", "d", "e", "f"].map((mark) => ({
      activeWorkflowCount: 0,
      childThread: testThread({ id: `thr_child_${mark}`, title: mark }),
      terminalOutput: long(mark),
      turnStatus: "completed" as const,
    }));
    const message = renderBatchMessage({ items });

    expect(message.length).toBeLessThan(9_000);
    for (const mark of ["a", "b", "c", "d", "e", "f"]) {
      expect(message).toContain(`${mark}-head`);
      expect(message).toContain(`${mark}-tail`);
    }
  });

  it("renders status-only bullet lines when no child completed with a result", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({ id: "thr_child_one", title: "One" }),
          terminalOutput: "ignored",
          turnStatus: "failed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({ id: "thr_child_two", title: "Two" }),
          terminalOutput: "ignored",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "Child thread updates:",
        "",
        "- @thread:thr_child_one failed.",
        "- @thread:thr_child_two failed.",
      ].join("\n"),
    );
  });

  it("builds mention ranges for batched outcome thread references", () => {
    const input = buildChildThreadTurnStatusBatchInput({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: "Fix checkout flow",
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: null,
          }),
          terminalOutput: "Deploy script failed.",
          turnStatus: "failed",
        },
      ],
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }
    expect(textInput).toEqual({
      type: "text",
      text: expect.stringContaining("@thread:thr_child_one"),
      mentions: [
        {
          start: expect.any(Number),
          end: expect.any(Number),
          resource: {
            kind: "thread",
            label: "Fix checkout flow",
            projectId: "proj_alpha",
            threadId: "thr_child_one",
          },
        },
        {
          start: expect.any(Number),
          end: expect.any(Number),
          resource: {
            kind: "thread",
            label: "thr_child_two",
            projectId: "proj_alpha",
            threadId: "thr_child_two",
          },
        },
      ],
    });
    expect(textInput.text).toContain("@thread:thr_child_two");
    expect(textInput.text).toContain("Child thread updates:");
    expect(
      textInput.mentions.map((mention) =>
        textInput.text.slice(mention.start, mention.end),
      ),
    ).toEqual(["@thread:thr_child_one", "@thread:thr_child_two"]);
  });

  it("does not render raw title suffixes next to rich thread mentions", () => {
    const nestedToken = "@thread:thr_child_two";
    const input = buildChildThreadTurnStatusBatchInput({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_one",
            title: `Title mentions ${nestedToken}`,
          }),
          terminalOutput: "Checkout flow is fixed.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Second thread",
          }),
          terminalOutput: "Deploy script failed.",
          turnStatus: "failed",
        },
      ],
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }

    const secondLineTokenStart = textInput.text.lastIndexOf(nestedToken);
    expect(textInput.text).not.toContain("Title mentions");
    expect(textInput.mentions.map((mention) => mention.start)).toEqual([
      textInput.text.indexOf("@thread:thr_child_one"),
      secondLineTokenStart,
    ]);
    expect(
      textInput.mentions.map((mention) =>
        textInput.text.slice(mention.start, mention.end),
      ),
    ).toEqual(["@thread:thr_child_one", nestedToken]);
  });

  it("renders a final output fallback for a completed child without output", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child",
            title: "Patch deploy script",
          }),
          terminalOutput: null,
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed:",
        "",
        "No final output was recorded.",
      ].join("\n"),
    );
  });

  it("flags a still-running workflow on a single completed outcome", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 1,
          childThread: testThread({
            id: "thr_child",
            title: "Rebalance archetypes",
          }),
          terminalOutput: "Kicked off the balance pass.",
          turnStatus: "completed",
        },
      ],
    });

    expect(message).toContain(
      [
        "@thread:thr_child completed, with 1 workflow still running:",
        "",
        "Kicked off the balance pass.",
        "",
        "A workflow it started is still running, so this output is not its final result. The thread will report again when the workflow finishes.",
      ].join("\n"),
    );
  });

  it("pluralizes and flags still-running workflows across batched outcomes", () => {
    const message = renderBatchMessage({
      items: [
        {
          activeWorkflowCount: 2,
          childThread: testThread({
            id: "thr_child_one",
            title: "Rebalance archetypes",
          }),
          terminalOutput: "Kicked off two workflows.",
          turnStatus: "completed",
        },
        {
          activeWorkflowCount: 0,
          childThread: testThread({
            id: "thr_child_two",
            title: "Patch deploy script",
          }),
          terminalOutput: "Deploy script failed on preflight.",
          turnStatus: "failed",
        },
      ],
    });

    expect(message).toContain(
      [
        "Child thread updates:",
        "",
        "- @thread:thr_child_one completed, with 2 workflows still running:",
        "",
        "Kicked off two workflows.",
        "",
        "- @thread:thr_child_two failed.",
        "",
        "Threads with a workflow still running have not finished; they will report again when their workflow does.",
      ].join("\n"),
    );
  });

  it("builds mention ranges for needs-attention thread references", () => {
    const input = buildChildThreadNeedsAttentionInput({
      blockerSummary: null,
      childThread: testThread({
        id: "thr_child",
        title: "Backend cleanup",
      }),
    });

    expect(input).toHaveLength(1);
    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }
    const threadMention = "@thread:thr_child";
    const mentionStart = textInput.text.indexOf(threadMention);
    expect(textInput.mentions).toEqual([
      {
        start: mentionStart,
        end: mentionStart + threadMention.length,
        resource: {
          kind: "thread",
          label: "Backend cleanup",
          projectId: "proj_alpha",
          threadId: "thr_child",
        },
      },
    ]);
    expect(textInput.text).toContain(
      "Review the blocker. If you can resolve it from existing context, reply to the thread with guidance.",
    );
  });

  it("renders needs-attention blocker summaries when provided", () => {
    const input = buildChildThreadNeedsAttentionInput({
      blockerSummary: ["Blocked on command approval:", "git push"].join("\n"),
      childThread: testThread({
        id: "thr_child",
        title: "Backend cleanup",
      }),
    });

    const [textInput] = input;
    if (!textInput || textInput.type !== "text") {
      throw new Error("Expected one text input");
    }

    expect(textInput.text).toContain(
      ["Blocked on command approval:", "git push"].join("\n"),
    );
    expect(textInput.text).not.toContain(
      "It is blocked on a pending interaction.",
    );
  });
});
