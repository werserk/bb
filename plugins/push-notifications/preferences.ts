import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const notificationLevelSchema = z.enum([
  "all",
  "input-only",
  "questions-only",
  "muted",
]);
export const ownNotificationLevelSchema = z.enum([
  "inherit",
  ...notificationLevelSchema.options,
]);
export const notificationSourceSchema = z.enum([
  "self",
  "parent",
  "ancestor",
  "global",
  "child-default",
  "ancestor-child-default",
]);

export const threadNotificationInputsSchema = z
  .object({
    own: ownNotificationLevelSchema,
    ancestorCap: z
      .object({ level: notificationLevelSchema, threadId: z.string().min(1) })
      .strict()
      .nullable(),
    childLevel: ownNotificationLevelSchema.optional(),
    inheritedChildLevel: z
      .object({ level: notificationLevelSchema, threadId: z.string().min(1) })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export const threadNotificationsSchema = z
  .object({
    own: ownNotificationLevelSchema,
    effective: notificationLevelSchema,
    source: notificationSourceSchema,
  })
  .strict();

export type NotificationLevel = z.infer<typeof notificationLevelSchema>;
export type OwnNotificationLevel = z.infer<typeof ownNotificationLevelSchema>;
export type NotificationSource = z.infer<typeof notificationSourceSchema>;
export type ThreadNotificationInputs = z.infer<
  typeof threadNotificationInputsSchema
>;
export type ThreadNotifications = z.infer<typeof threadNotificationsSchema>;

export interface NotificationDefaults {
  defaultLevel: NotificationLevel;
  childLevel: OwnNotificationLevel;
}

export const UNSET_THREAD_NOTIFICATIONS: ThreadNotificationInputs = {
  own: "inherit",
  ancestorCap: null,
};

export const NOTIFICATION_LEVEL_LABELS: Record<OwnNotificationLevel, string> = {
  inherit: "Same as default",
  all: "All activity",
  "input-only": "Needs input only",
  "questions-only": "Questions only",
  muted: "Muted",
};

export type PushNotificationKind =
  | "pending-interaction"
  | "turn-finished"
  | "thread-error"
  | "owner-post";

export const NOTIFICATION_KINDS_BY_LEVEL: Record<
  NotificationLevel,
  ReadonlySet<PushNotificationKind>
> = {
  all: new Set([
    "pending-interaction",
    "thread-error",
    "owner-post",
    "turn-finished",
  ]),
  "input-only": new Set(["pending-interaction", "thread-error", "owner-post"]),
  "questions-only": new Set(["pending-interaction", "owner-post"]),
  muted: new Set(),
};

const LEVEL_RANK: Record<NotificationLevel, number> = {
  muted: 0,
  "questions-only": 1,
  "input-only": 2,
  all: 3,
};

function isQuieter(
  candidate: NotificationLevel,
  than: NotificationLevel,
): boolean {
  return LEVEL_RANK[candidate] < LEVEL_RANK[than];
}

export function resolveThreadNotifications(
  stored: ThreadNotificationInputs,
  thread: { parentThreadId: string | null },
  defaults: NotificationDefaults,
): ThreadNotifications {
  const { own, ancestorCap, inheritedChildLevel } = stored;
  const base: { level: NotificationLevel; source: NotificationSource } =
    own !== "inherit"
      ? { level: own, source: "self" }
      : thread.parentThreadId !== null && inheritedChildLevel
        ? { level: inheritedChildLevel.level, source: "ancestor-child-default" }
        : thread.parentThreadId !== null && defaults.childLevel !== "inherit"
          ? { level: defaults.childLevel, source: "child-default" }
          : { level: defaults.defaultLevel, source: "global" };
  if (ancestorCap === null || !isQuieter(ancestorCap.level, base.level)) {
    return { own, effective: base.level, source: base.source };
  }
  return {
    own,
    effective: ancestorCap.level,
    source:
      ancestorCap.threadId === thread.parentThreadId ? "parent" : "ancestor",
  };
}

export function describeNotificationSource(row: ThreadNotifications): string {
  if (row.source === "self") return "set on this thread";
  if (row.source === "parent") return "limited by parent";
  if (row.source === "ancestor") return "limited by an ancestor";
  if (row.source === "child-default") return "child-thread default";
  if (row.source === "ancestor-child-default")
    return "child-thread default set by an ancestor";
  return "default";
}

function isUnset(inputs: ThreadNotificationInputs): boolean {
  return (
    inputs.own === "inherit" &&
    inputs.ancestorCap === null &&
    (inputs.childLevel ?? "inherit") === "inherit" &&
    !inputs.inheritedChildLevel
  );
}

const SDK_THREAD_BATCH_MAX_IDS = 200;

function chunk<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += SDK_THREAD_BATCH_MAX_IDS) {
    chunks.push(items.slice(start, start + SDK_THREAD_BATCH_MAX_IDS));
  }
  return chunks;
}

const NOTIFICATIONS_METADATA_KEY = "notifications";

const CHILD_NOTIFICATIONS_METADATA_KEY = "childNotifications";

const storedNotificationsMetadataSchema = z.object({
  [NOTIFICATIONS_METADATA_KEY]: z
    .object({ own: notificationLevelSchema })
    .strict(),
});

const storedChildNotificationsMetadataSchema = z.object({
  [CHILD_NOTIFICATIONS_METADATA_KEY]: z
    .object({ level: notificationLevelSchema })
    .strict(),
});

export function parseStoredNotificationLevel(
  metadata: unknown,
): NotificationLevel | null {
  const parsed = storedNotificationsMetadataSchema.safeParse(metadata);
  return parsed.success ? parsed.data[NOTIFICATIONS_METADATA_KEY].own : null;
}

export function parseStoredChildNotificationLevel(
  metadata: unknown,
): NotificationLevel | null {
  const parsed = storedChildNotificationsMetadataSchema.safeParse(metadata);
  return parsed.success
    ? parsed.data[CHILD_NOTIFICATIONS_METADATA_KEY].level
    : null;
}

interface StoredLevels {
  own: NotificationLevel | null;
  child: NotificationLevel | null;
}

interface ResolvedThreadInputs {
  inputs: ThreadNotificationInputs;
  parentThreadId: string | null;
}

export interface NotificationPreferences {
  list(
    threadIds: readonly string[],
  ): Promise<Record<string, ThreadNotificationInputs>>;
  get(threadId: string): Promise<ThreadNotifications>;
  set(
    threadId: string,
    level: OwnNotificationLevel,
  ): Promise<ThreadNotificationInputs>;
  setChildLevel(
    threadId: string,
    level: OwnNotificationLevel,
  ): Promise<ThreadNotificationInputs>;
  effectiveLevel(thread: {
    id: string;
    parentThreadId: string | null;
  }): Promise<NotificationLevel>;
  publishSubtree(threadId: string): Promise<void>;
}

export function createNotificationPreferences(args: {
  bb: BbPluginApi;
  getDefaults(): Promise<NotificationDefaults>;
  publish(threadIds: readonly string[]): void;
}): NotificationPreferences {
  const { bb, getDefaults, publish } = args;

  async function readStoredLevels(
    threadIds: readonly string[],
  ): Promise<Map<string, StoredLevels>> {
    const levels = new Map<string, StoredLevels>();
    for (const batch of chunk(threadIds)) {
      const { threads } = await bb.sdk.threads.experimental_listPluginMetadata({
        threadIds: batch,
      });
      for (const { threadId, metadata } of threads) {
        const own = parseStoredNotificationLevel(metadata);
        const child = parseStoredChildNotificationLevel(metadata);
        if (own !== null || child !== null)
          levels.set(threadId, { own, child });
      }
    }
    return levels;
  }

  async function resolveInputs(
    threadIds: readonly string[],
  ): Promise<Map<string, ResolvedThreadInputs>> {
    const ancestry: { threadId: string; ancestorIds: string[] }[] = [];
    for (const batch of chunk(threadIds)) {
      const { threads } = await bb.sdk.threads.experimental_listAncestors({
        threadIds: batch,
      });
      ancestry.push(...threads);
    }
    const levels = await readStoredLevels([
      ...new Set(
        ancestry.flatMap(({ threadId, ancestorIds }) => [
          threadId,
          ...ancestorIds,
        ]),
      ),
    ]);
    const resolved = new Map<string, ResolvedThreadInputs>();
    for (const { threadId, ancestorIds } of ancestry) {
      let ancestorCap: ThreadNotificationInputs["ancestorCap"] = null;
      let inheritedChildLevel: ThreadNotificationInputs["inheritedChildLevel"] =
        null;
      for (const ancestorId of ancestorIds) {
        const stored = levels.get(ancestorId);
        const level = stored?.own ?? null;
        if (
          level !== null &&
          (ancestorCap === null || isQuieter(level, ancestorCap.level))
        ) {
          ancestorCap = { level, threadId: ancestorId };
        }
        if (inheritedChildLevel === null && stored?.child) {
          inheritedChildLevel = { level: stored.child, threadId: ancestorId };
        }
      }
      const self = levels.get(threadId);
      resolved.set(threadId, {
        inputs: {
          own: self?.own ?? "inherit",
          ancestorCap,
          childLevel: self?.child ?? "inherit",
          inheritedChildLevel,
        },
        parentThreadId: ancestorIds[0] ?? null,
      });
    }
    return resolved;
  }

  async function requireInputs(
    threadId: string,
  ): Promise<ResolvedThreadInputs> {
    const resolved = (await resolveInputs([threadId])).get(threadId);
    if (resolved === undefined) throw new Error("Thread not found");
    return resolved;
  }

  async function publishSubtree(threadId: string): Promise<void> {
    const { threads } = await bb.sdk.threads.experimental_listDescendants({
      threadIds: [threadId],
    });
    publish([threadId, ...(threads[0]?.descendantIds ?? [])]);
  }

  return {
    async list(threadIds) {
      const result: Record<string, ThreadNotificationInputs> = {};
      for (const [threadId, { inputs }] of await resolveInputs(threadIds)) {
        if (!isUnset(inputs)) result[threadId] = inputs;
      }
      return result;
    },
    async get(threadId) {
      const [{ inputs, parentThreadId }, defaults] = await Promise.all([
        requireInputs(threadId),
        getDefaults(),
      ]);
      return resolveThreadNotifications(inputs, { parentThreadId }, defaults);
    },
    async set(threadId, level) {
      await requireInputs(threadId);
      await bb.sdk.threads.updatePluginMetadata(
        level === "inherit"
          ? { threadId, remove: [NOTIFICATIONS_METADATA_KEY] }
          : { threadId, set: { [NOTIFICATIONS_METADATA_KEY]: { own: level } } },
      );
      await publishSubtree(threadId);
      return (await requireInputs(threadId)).inputs;
    },
    async setChildLevel(threadId, level) {
      await requireInputs(threadId);
      await bb.sdk.threads.updatePluginMetadata(
        level === "inherit"
          ? { threadId, remove: [CHILD_NOTIFICATIONS_METADATA_KEY] }
          : {
              threadId,
              set: { [CHILD_NOTIFICATIONS_METADATA_KEY]: { level } },
            },
      );
      await publishSubtree(threadId);
      return (await requireInputs(threadId)).inputs;
    },
    async effectiveLevel(thread) {
      const [resolved, defaults] = await Promise.all([
        resolveInputs([thread.id]),
        getDefaults(),
      ]);
      return resolveThreadNotifications(
        resolved.get(thread.id)?.inputs ?? UNSET_THREAD_NOTIFICATIONS,
        { parentThreadId: thread.parentThreadId },
        defaults,
      ).effective;
    },
    async publishSubtree(threadId) {
      await publishSubtree(threadId);
    },
  };
}
