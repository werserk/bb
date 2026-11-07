import { describe, expect, it } from "vitest";
import type { ThreadEventRow } from "@bb/domain";
import {
  createTimelineEventFactory,
  fromRows,
} from "./timeline-test-harness.js";
import { EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT } from "../src/accepted-client-request-context.js";
import { buildThreadTimelineFromEvents } from "../src/build-thread-timeline.js";

const options = {
  completedTurnDisplay: "collapse",
  includeDiagnosticOperations: false,
  isLatestPage: true,
  includeNestedRows: false,
  summarizeShellCommands: true,
  threadStatus: "active",
  threadName: "",
  workspaceRoot: null,
} as const;
const reasons = [
  "coordinator-background",
  "helper-result",
  "direction-result",
  "self-reminder",
  "future-rotation-seed",
] as const;
function fixture(reason: (typeof reasons)[number]) {
  const e = createTimelineEventFactory({ threadId: "thread-1" });
  const request = e.clientTurnRequested({
    text: "ordinary wording",
    initiator: "agent",
  });
  request.data.serviceTurn = {
    version: 1,
    visibility: "hidden",
    reason,
    origin: { pluginId: "wprojects", senderThreadId: "helper" },
  };
  return {
    e,
    request,
    rows: [
      request,
      e.turnStarted(),
      e.inputAccepted({ clientRequestId: request.data.requestId }),
      e.assistantCompleted({ text: "private reply" }),
      e.commandCompleted({ command: "secret details" }),
      e.planStepsCompleted({
        steps: [{ step: "private plan", status: "active" }],
      }),
    ],
  };
}
function timeline(
  events: ThreadEventRow[],
  includeService = false,
) {
  return buildThreadTimelineFromEvents({
    acceptedClientRequestContext: EMPTY_ACCEPTED_CLIENT_REQUEST_CONTEXT,
    contextWindowEvents: [],
    events: fromRows(events),
    options: { ...options, includeService },
  });
}
describe("service presentation", () => {
  it.each(reasons)(
    "hides %s input, reply, tools and plans, including when opened mid-turn",
    (reason) => {
      const { rows } = fixture(reason);
      const hidden = timeline(rows);
      expect(hidden.rows).toEqual([]);
      expect(hidden.pendingTodos).toBeNull();
      expect(hidden.activeThinking).toBeNull();
      expect(hidden.serviceTurn).toEqual({ busy: true, failed: false });
      expect(timeline(rows, true).rows.length).toBeGreaterThan(0);
    },
  );
  it("renders a successful typed owner post standalone without leaking adjacent replies", () => {
    const { e, rows } = fixture("direction-result");
    const result = timeline([
      ...rows,
      e.toolCallCompleted({
        tool: "arbitrary",
        arguments: { text: "Public post" },
        presentation: {
          ownerPost: true,
          label: { pending: "Posting", completed: "Posted" },
          icon: { glyph: "MessageSquare" },
        },
      }),
    ]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "work",
      workKind: "tool",
      presentation: {
        ownerPost: true,
        label: { pending: "Posting", completed: "Posted" },
        icon: { glyph: "MessageSquare" },
      },
    });
  });
  it("does not classify content that looks like a service message", () => {
    const { rows } = fixture("self-reminder");
    const request = rows[0];
    if (request?.type === "client/turn/requested")
      delete request.data.serviceTurn;
    expect(timeline(rows).rows.length).toBeGreaterThan(0);
  });
  it("keeps a native approval standalone", () => {
    const { e, rows } = fixture("self-reminder");
    const result = timeline([...rows, e.permissionGrantLifecycle()]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      kind: "work",
      workKind: "approval",
    });
  });
  it("hides events before input acceptance, then shows the next owner turn", () => {
    const { e, request } = fixture("helper-result");
    const serviceStart = e.turnStarted();
    const privateReply = e.assistantCompleted({
      text: "Private before acceptance",
    });
    const owner = e.clientTurnRequested({
      text: "Owner next",
      initiator: "user",
    });
    const result = timeline([
      request,
      serviceStart,
      privateReply,
      owner,
      e.turnStarted({ turnId: "owner" }),
      e.inputAccepted({
        clientRequestId: owner.data.requestId,
        turnId: "owner",
      }),
      e.assistantCompleted({ text: "Owner reply", turnId: "owner" }),
    ]);
    const text = JSON.stringify(result.rows);
    expect(text).not.toContain("Private before acceptance");
    expect(text).toContain("Owner reply");
  });
});
