import { describe, expect, it } from "vitest";
import {
  NOTIFICATION_KINDS_BY_LEVEL,
  NOTIFICATION_LEVEL_LABELS,
  notificationLevelSchema,
  parseStoredNotificationLevel,
  resolveThreadNotifications,
  type NotificationLevel,
} from "./preferences";

const levels = notificationLevelSchema.options;
const defaults = { defaultLevel: "all", childLevel: "inherit" } as const;

describe("notification levels", () => {
  it("lists levels from loud to quiet and labels Needs you only", () => {
    expect(levels).toEqual(["all", "input-only", "questions-only", "muted"]);
    expect(NOTIFICATION_LEVEL_LABELS["questions-only"]).toBe("Needs you only");
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

  it.each(
    levels.flatMap((cap) => levels.map((own) => [cap, own] as const)),
  )("an ancestor capped at %s limits a thread set to %s", (cap, own) => {
    const quieterCap = levels.indexOf(cap) > levels.indexOf(own);
    const resolved = resolveThreadNotifications(
      { own, ancestorCap: { level: cap, threadId: "parent" } },
      { parentThreadId: "parent" },
      defaults,
    );
    const expected: NotificationLevel = quieterCap ? cap : own;
    expect(resolved.effective).toBe(expected);
    expect(resolved.source).toBe(quieterCap ? "parent" : "self");
  });

  it("reads stored levels, including an unchanged Needs input only", () => {
    for (const own of levels) {
      expect(parseStoredNotificationLevel({ notifications: { own } })).toBe(own);
    }
    expect(
      parseStoredNotificationLevel({ notifications: { own: "bogus" } }),
    ).toBeNull();
  });
});
