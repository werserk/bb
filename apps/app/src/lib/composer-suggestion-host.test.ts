import { describe, expect, it } from "vitest";
import { composerSuggestionContext } from "./composer-suggestion-host";
import type { ThreadEventRow } from "@bb/domain";
const base = {
  threadId: "thread",
  scope: { kind: "turn", turnId: "turn" } as const,
  createdAt: 1,
};
const started: ThreadEventRow = {
  ...base,
  id: "start",
  seq: 1,
  type: "turn/started",
  data: { providerThreadId: "provider" },
};
const completed: ThreadEventRow = {
  ...base,
  id: "end",
  seq: 3,
  type: "turn/completed",
  data: { providerThreadId: "provider", status: "completed" },
};
const events = [completed, started];
const questions = { total: 0, readRevision: "questions-1" };
const timeline = { tag: "tag", maxSeq: 3, contextBoundarySeq: null };
describe("suggestion host eligibility", () => {
  it("requires authoritative successful root completion even for flat timelines", () => {
    expect(
      composerSuggestionContext(timeline, "idle", [], 0, true).eligible,
    ).toBe(false);
    expect(
      composerSuggestionContext(timeline, "idle", [], 0, true, [started])
        .eligible,
    ).toBe(false);
    expect(
      composerSuggestionContext(
        timeline,
        "idle",
        [],
        0,
        true,
        events,
        questions,
      ).eligible,
    ).toBe(true);
    expect(
      composerSuggestionContext(
        timeline,
        "idle",
        [],
        0,
        true,
        [
          { ...completed, data: { ...completed.data, status: "interrupted" } },
          started,
        ],
        questions,
      ).eligible,
    ).toBe(false);
  });
  it("rejects a newer root turn and ignores a nested turn completion", () => {
    const newer: ThreadEventRow = {
      ...started,
      id: "new",
      seq: 4,
      scope: { kind: "turn", turnId: "new" },
    };
    expect(
      composerSuggestionContext(
        timeline,
        "idle",
        [],
        0,
        true,
        [newer, ...events],
        questions,
      ).eligible,
    ).toBe(false);
    const nested = {
      ...newer,
      data: { providerThreadId: "p", parentToolCallId: "tool" },
    };
    expect(
      composerSuggestionContext(timeline, "idle", [], 0, true, [
        nested,
        ...events,
      ]).completedTurnId,
    ).toBe("turn");
  });
  it("invalidates independent question, queue, lifecycle and connection changes", () => {
    const ready = composerSuggestionContext(
      timeline,
      "idle",
      [],
      0,
      true,
      events,
      questions,
    );
    for (const blocked of [
      composerSuggestionContext(
        timeline,
        "idle",
        [{ id: "question" }],
        0,
        true,
        events,
        questions,
      ),
      composerSuggestionContext(
        timeline,
        "idle",
        [],
        1,
        true,
        events,
        questions,
      ),
      composerSuggestionContext(
        timeline,
        "active",
        [],
        0,
        true,
        events,
        questions,
      ),
      composerSuggestionContext(
        timeline,
        "idle",
        [],
        0,
        false,
        events,
        questions,
      ),
      composerSuggestionContext(
        { ...timeline, contextBoundarySeq: 3 },
        "idle",
        [],
        0,
        true,
        events,
        questions,
      ),
    ]) {
      expect(blocked.eligible).toBe(false);
      expect(blocked.contextRevision).not.toBe(ready.contextRevision);
    }
  });
});

it("fails closed without durable-question knowledge and revisions survive a close", () => {
  const ready = composerSuggestionContext(
    timeline,
    "idle",
    [],
    0,
    true,
    events,
    questions,
  );
  expect(ready.eligible).toBe(true);
  expect(
    composerSuggestionContext(timeline, "idle", [], 0, true, events).eligible,
  ).toBe(false);
  const open = composerSuggestionContext(
    timeline,
    "idle",
    [],
    0,
    true,
    events,
    { total: 1, readRevision: "questions-2" },
  );
  expect(open.eligible).toBe(false);
  expect(open.contextRevision).not.toBe(ready.contextRevision);
  const closed = composerSuggestionContext(
    timeline,
    "idle",
    [],
    0,
    true,
    events,
    { total: 0, readRevision: "questions-3" },
  );
  expect(closed.eligible).toBe(true);
  expect(closed.contextRevision).not.toBe(ready.contextRevision);
});
