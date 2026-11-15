import { experimental_resolveThreadStatus } from "@get-bb/plugin-sdk/internal/thread-status";
import { makeThreadListEntry } from "@bb/test-helpers/domain-fixtures";
import type { ThreadListEntry } from "@bb/domain";
import { describe, expect, it } from "vitest";
import {
  toPluginSidebarThread,
  toThreadStatusThread,
} from "./plugin-sidebar-threads";


type EntryOverrides = Parameters<typeof makeThreadListEntry>[0];

function indicatorFor(overrides: EntryOverrides) {
  const entry: ThreadListEntry = makeThreadListEntry({
    id: "thr_1",
    projectId: "proj_1",
    lastReadAt: 2,
    latestAttentionAt: 2,
    ...overrides,
  });
  return experimental_resolveThreadStatus({
    thread: toThreadStatusThread(entry),
    hiddenThreads: [],
    hasUnsubmittedDraft: false,
    rowStatus: null,
  }).indicator;
}

const hiddenServiceTurn = {
  version: 1,
  visibility: "hidden",
  reason: "helper-result",
  origin: { pluginId: "plugin", senderThreadId: null },
} as const;

describe("fork thread status rules", () => {
  it("shows a thread with an open question card as waiting for input", () => {
    expect(indicatorFor({ hasOpenQuestion: true })).toBe("waiting-for-input");
  });

  it("keeps a hidden service turn's error out of the glyph", () => {
    expect(
      indicatorFor({
        status: "error",
        lastReadAt: 1,
        serviceTurn: hiddenServiceTurn,
      }),
    ).toBe("unread-success");
  });

  it("keeps a hidden service turn's side work out of the glyph", () => {
    expect(
      indicatorFor({
        serviceTurn: hiddenServiceTurn,
        activity: {
          activeWorkflowCount: 1,
          activeBackgroundAgentCount: 1,
          activeBackgroundCommandCount: 1,
          activePlanModeCount: 1,
        },
      }),
    ).toBe("none");
  });

  it("leaves the plugin-facing thread on the raw status and activity", () => {
    const entry = makeThreadListEntry({
      id: "thr_1",
      projectId: "proj_1",
      status: "error",
      hasOpenQuestion: true,
      serviceTurn: hiddenServiceTurn,
      activity: {
        activeWorkflowCount: 1,
        activeBackgroundAgentCount: 2,
        activeBackgroundCommandCount: 3,
        activePlanModeCount: 4,
      },
    });
    const plugin = toPluginSidebarThread(entry);
    expect(plugin.status).toBe("error");
    expect(plugin.hasPendingInteraction).toBe(entry.hasPendingInteraction);
    expect(plugin.activity).toEqual({
      workflows: 1,
      backgroundAgents: 2,
      backgroundCommands: 3,
      planMode: 4,
      goals: 0,
    });
    expect(toThreadStatusThread(entry).status).toBe("idle");
  });
});
