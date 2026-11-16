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
      composerSuggestionContext(timeline, "idle", [], 0, true, events).eligible,
    ).toBe(true);
    expect(
      composerSuggestionContext(timeline, "idle", [], 0, true, [
        { ...completed, data: { ...completed.data, status: "interrupted" } },
        started,
      ]).eligible,
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
      composerSuggestionContext(timeline, "idle", [], 0, true, [
        newer,
        ...events,
      ]).eligible,
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
  it("invalidates independent approval, queue, lifecycle and connection changes", () => {
    const ready = composerSuggestionContext(
      timeline,
      "idle",
      [],
      0,
      true,
      events,
    );
    for (const blocked of [
      composerSuggestionContext(
        timeline,
        "idle",
        [
          {
            id: "approval",
            payload: {
              kind: "approval",
              subject: {
                kind: "command",
                itemId: "cmd",
                command: "echo ok",
                cwd: null,
                actions: [],
                sessionGrant: null,
              },
              reason: null,
              availableDecisions: ["allow_once", "deny"],
            },
          },
        ],
        0,
        true,
        events,
      ),
      composerSuggestionContext(timeline, "idle", [], 1, true, events),
      composerSuggestionContext(timeline, "active", [], 0, true, events),
      composerSuggestionContext(timeline, "idle", [], 0, false, events),
      composerSuggestionContext(
        { ...timeline, contextBoundarySeq: 3 },
        "idle",
        [],
        0,
        true,
        events,
      ),
    ]) {
      expect(blocked.eligible).toBe(false);
      expect(blocked.contextRevision).not.toBe(ready.contextRevision);
    }
  });
});

it("keeps suggestions eligible and stable while native questions open and close", () => {
  const ready = composerSuggestionContext(
    timeline,
    "idle",
    [],
    0,
    true,
    events,
  );
  const open = composerSuggestionContext(
    timeline,
    "idle",
    [{ id: "question", payload: { kind: "user_question", questions: [] } }],
    0,
    true,
    events,
  );
  expect(ready.eligible).toBe(true);
  expect(open).toEqual(ready);
  expect(
    composerSuggestionContext(timeline, "idle", [], 0, true, events),
  ).toEqual(ready);
});
