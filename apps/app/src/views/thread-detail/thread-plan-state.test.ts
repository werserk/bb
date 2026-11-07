import { describe, expect, it } from "vitest";
import { latestPlanTurn, threadPlanState } from "./thread-plan-state";
import type { ThreadTimelinePendingTodos } from "@bb/domain";

const plan: ThreadTimelinePendingTodos = {
  sourceSeq: 10,
  updatedAt: 100,
  items: [{ id: "a", text: "Check", status: "in_progress" }],
};
describe("thread plan state", () => {
  it("retains a live plan after its turn ends and while waiting", () => {
    expect(
      threadPlanState(plan, { sourceSeq: 1, startedAt: 50 }, false),
    ).toEqual({ state: "active", autoCollapse: false });
    expect(threadPlanState(plan, null, true).state).toBe("waiting");
  });
  it("collapses only after a newer turn, including equal timestamps", () => {
    expect(
      threadPlanState(
        { ...plan, items: [{ ...plan.items[0]!, status: "completed" }] },
        { sourceSeq: 11, startedAt: 100 },
        true,
      ),
    ).toEqual({ state: "finished", autoCollapse: true });
    expect(
      threadPlanState(plan, { sourceSeq: 9, startedAt: 110 }, false).state,
    ).toBe("active");
    expect(
      threadPlanState(plan, { sourceSeq: 11, startedAt: 99 }, false).state,
    ).toBe("active");
  });
  it("collapses finished plans and gives stale precedence over waiting", () => {
    const finished = {
      ...plan,
      items: [{ ...plan.items[0]!, status: "completed" as const }],
    };
    expect(threadPlanState(finished, null, true)).toEqual({
      state: "finished",
      autoCollapse: false,
    });
    expect(
      threadPlanState(finished, { sourceSeq: 20, startedAt: 200 }, true).state,
    ).toBe("finished");
  });
});

it("recognizes an accepted new-turn message even when its empty turn has no group", () => {
  const message: import("@bb/server-contract").TimelineUserConversationRow = {
    id: "message",
    threadId: "thread",
    turnId: "new-turn",
    kind: "conversation",
    role: "user",
    sourceSeqStart: 20,
    sourceSeqEnd: 20,
    startedAt: 200,
    createdAt: 200,
    messageSeq: 20,
    text: "Next task",
    attachments: null,
    initiator: "user",
    senderThreadId: null,
    systemMessageKind: "unlabeled",
    systemMessageSubject: null,
    mentions: [],
    turnRequest: { kind: "message", status: "accepted", isGrouped: false },
  };
  expect(threadPlanState(plan, latestPlanTurn([message]), false).state).toBe(
    "active",
  );
  expect(
    latestPlanTurn([
      { ...message, turnRequest: { ...message.turnRequest, kind: "steer" } },
    ]),
  ).toBeNull();
  expect(
    latestPlanTurn([
      {
        ...message,
        turnRequest: { ...message.turnRequest, status: "rejected" },
      },
    ]),
  ).toBeNull();
});

it("does not collapse or complete a failed plan after a newer turn", () => {
  const failed: ThreadTimelinePendingTodos = {
    ...plan,
    items: [
      { id: "a", text: "Build", status: "completed" },
      { id: "b", text: "Verify", status: "failed" },
    ],
  };
  expect(
    threadPlanState(failed, { sourceSeq: 20, startedAt: 200 }, false),
  ).toEqual({ state: "active", autoCollapse: false });
});
