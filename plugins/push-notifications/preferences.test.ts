import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS_BY_LEVEL,
  NOTIFICATION_LEVEL_LABELS,
  notificationLevelSchema,
  parseStoredNotificationLevel,
  parseStoredChildNotificationLevel,
  ownNotificationLevelSchema,
  type ThreadNotificationInputs,
  type NotificationDefaults,
  type ThreadNotifications,
  type NotificationSource,
  resolveThreadNotifications,
  type NotificationLevel,
} from "./preferences";

const levels = notificationLevelSchema.options;
const defaults = { defaultLevel: "all", childLevel: "inherit" } as const;

describe("notification levels", () => {
  it("lists levels from loud to quiet and labels Questions only", () => {
    expect(levels).toEqual(["all", "input-only", "questions-only", "muted"]);
    expect(NOTIFICATION_LEVEL_LABELS["questions-only"]).toBe("Questions only");
  });

  it("pushes only questions and owner posts at Questions only", () => {
    expect([...NOTIFICATION_KINDS_BY_LEVEL["questions-only"]].sort()).toEqual([
      "owner-post",
      "pending-interaction",
    ]);
  });

  it("leaves the other levels unchanged", () => {
    expect([...NOTIFICATION_KINDS_BY_LEVEL["input-only"]].sort()).toEqual([
      "owner-post",
      "pending-interaction",
      "thread-error",
    ]);
    expect(NOTIFICATION_KINDS_BY_LEVEL.all.size).toBe(4);
    expect(NOTIFICATION_KINDS_BY_LEVEL.muted.size).toBe(0);
  });

  it.each(levels.flatMap((cap) => levels.map((own) => [cap, own] as const)))(
    "an ancestor capped at %s limits a thread set to %s",
    (cap, own) => {
      const quieterCap = levels.indexOf(cap) > levels.indexOf(own);
      const resolved = resolveThreadNotifications(
        { own, ancestorCap: { level: cap, threadId: "parent" } },
        { parentThreadId: "parent" },
        defaults,
      );
      const expected: NotificationLevel = quieterCap ? cap : own;
      expect(resolved.effective).toBe(expected);
      expect(resolved.source).toBe(quieterCap ? "parent" : "self");
    },
  );

  it("reads stored levels, including an unchanged Needs input only", () => {
    for (const own of levels) {
      expect(parseStoredNotificationLevel({ notifications: { own } })).toBe(
        own,
      );
    }
    expect(
      parseStoredNotificationLevel({ notifications: { own: "bogus" } }),
    ).toBeNull();
  });
});

function previousResolve(
  stored: ThreadNotificationInputs,
  thread: { parentThreadId: string | null },
  defaults: NotificationDefaults,
): ThreadNotifications {
  const { own, ancestorCap } = stored;
  const base: { level: NotificationLevel; source: NotificationSource } =
    own !== "inherit"
      ? { level: own, source: "self" }
      : thread.parentThreadId !== null && defaults.childLevel !== "inherit"
        ? { level: defaults.childLevel, source: "child-default" }
        : { level: defaults.defaultLevel, source: "global" };
  if (
    ancestorCap === null ||
    !(levels.indexOf(ancestorCap.level) > levels.indexOf(base.level))
  ) {
    return { own, effective: base.level, source: base.source };
  }
  return {
    own,
    effective: ancestorCap.level,
    source:
      ancestorCap.threadId === thread.parentThreadId ? "parent" : "ancestor",
  };
}

describe("child notification defaults", () => {
  it("preserves every previous own/cap/parent/default combination", () => {
    for (const own of ownNotificationLevelSchema.options)
      for (const cap of [null, ...levels])
        for (const parentThreadId of [null, "parent"])
          for (const defaultLevel of levels)
            for (const childLevel of ownNotificationLevelSchema.options) {
              const stored = {
                own,
                ancestorCap:
                  cap === null ? null : { level: cap, threadId: "parent" },
              };
              const defaults = { defaultLevel, childLevel };
              expect(
                resolveThreadNotifications(
                  stored,
                  { parentThreadId },
                  defaults,
                ),
              ).toEqual(previousResolve(stored, { parentThreadId }, defaults));
            }
  });
  it("ignores child level on self and applies the inherited base before the cap", () => {
    const stored: ThreadNotificationInputs = {
      own: "inherit",
      ancestorCap: null,
      childLevel: "muted",
      inheritedChildLevel: { level: "all", threadId: "root" },
    };
    expect(
      resolveThreadNotifications(
        stored,
        { parentThreadId: "parent" },
        { defaultLevel: "muted", childLevel: "input-only" },
      ),
    ).toMatchObject({ effective: "all", source: "ancestor-child-default" });
    expect(
      resolveThreadNotifications(
        {
          ...stored,
          ancestorCap: { level: "questions-only", threadId: "parent" },
        },
        { parentThreadId: "parent" },
        defaults,
      ),
    ).toMatchObject({ effective: "questions-only", source: "parent" });
    expect(
      resolveThreadNotifications(
        stored,
        { parentThreadId: null },
        { defaultLevel: "input-only", childLevel: "muted" },
      ),
    ).toMatchObject({ effective: "input-only", source: "global" });
  });
  it("keeps the own level with both keys and ignores invalid child metadata", () => {
    expect(
      parseStoredNotificationLevel({
        notifications: { own: "muted" },
        childNotifications: { level: "all" },
      }),
    ).toBe("muted");
    for (const value of [
      undefined,
      {},
      { level: "future" },
      { level: "all", extra: true },
    ])
      expect(
        parseStoredChildNotificationLevel({ childNotifications: value }),
      ).toBeNull();
    expect(
      parseStoredChildNotificationLevel({
        childNotifications: { level: "all" },
      }),
    ).toBe("all");
  });
});
