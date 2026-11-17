import {
  PendingSendOverlay,
  PendingSendJournal,
  type PendingSend,
  type JournalStatus,
} from "@bb/client-core";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { sdk } from "@/lib/sdk";
import {
  systemConfigQueryKey,
  threadTimelineQueryKey,
  threadQueuedMessagesQueryKey,
} from "../queries/query-keys";
import {
  isThreadTimelineDelta,
  applyThreadTimelineDelta,
  type SystemConfigResponse,
  type ThreadTimelineResponse,
} from "@bb/server-contract";
import type { ThreadQueuedMessage } from "@bb/domain";
import { COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT } from "./thread-timeline-push-owner";

interface OwnerContext {
  owner: PendingSendOverlay;
  journal?: PendingSendJournal;
  scope?: string;
  active: Map<string, Promise<void>>;
  followup: Set<string>;
  scheduled: Map<string, ReturnType<typeof setTimeout>>;
  applying: boolean;
  generation: number;
}
const owners = new WeakMap<QueryClient, OwnerContext>();
function context(client: QueryClient): OwnerContext {
  let state = owners.get(client);
  if (!state) {
    state = {
      owner: new PendingSendOverlay(),
      active: new Map(),
      followup: new Set(),
      scheduled: new Map(),
      applying: false,
      generation: 0,
    };
    owners.set(client, state);
    const current = state;
    client.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] === systemConfigQueryKey()[0] &&
        event.type !== "removed"
      )
        ensureJournal(client, current);
      if (
        current.applying ||
        event.type !== "updated" ||
        (event.action.type !== "invalidate" && event.action.type !== "success")
      )
        return;
      for (const threadId of new Set(
        current.owner.list().map((entry) => entry.threadId),
      )) {
        const queueEvent =
          event.query.queryHash ===
          JSON.stringify(threadQueuedMessagesQueryKey(threadId));
        if (
          !queueEvent &&
          event.query.queryHash !==
            JSON.stringify(threadTimelineQueryKey(threadId))
        )
          continue;
        const before = custodyKey(current.owner, threadId);
        const queue =
          client.getQueryData<ThreadQueuedMessage[]>(
            threadQueuedMessagesQueryKey(threadId),
          ) ?? [];
        current.owner.observe(
          threadId,
          client.getQueryData<ThreadTimelineResponse>(
            threadTimelineQueryKey(threadId),
          )?.rows ?? [],
          queue,
        );
        if (
          before !== custodyKey(current.owner, threadId) ||
          event.action.type === "invalidate" ||
          (queueEvent &&
            current.owner
              .list(threadId)
              .some(
                (entry) =>
                  entry.state === "queued" &&
                  entry.queueIds.some(
                    (id) => !queue.some((row) => row.id === id),
                  ),
              ))
        )
          schedulePendingSendRefresh(client, current, threadId);
      }
    });
    current.owner.subscribe(() => {
      if (current.journal) current.journal.save(current.owner.journalEntries());
    });
  }
  ensureJournal(client, state);
  return state;
}
function ensureJournal(client: QueryClient, state: OwnerContext) {
  if (typeof window === "undefined") return;
  const config = client.getQueryData<SystemConfigResponse>(
    systemConfigQueryKey(),
  );
  if (!config) return;
  const scope = JSON.stringify([
    window.location.origin,
    config.primaryHostId,
    config.dataDir,
  ]);
  if (state.scope === scope) return;
  if (state.scope !== undefined) resetScope(state);
  state.scope = scope;
  let storage: Storage | undefined;
  try {
    storage = window.sessionStorage;
  } catch {}
  const navigation = performance.getEntriesByType("navigation")[0];
  state.journal = new PendingSendJournal({
    key: `bb-pending-send/${scope}`,
    reload:
      typeof PerformanceNavigationTiming !== "undefined" &&
      navigation instanceof PerformanceNavigationTiming &&
      navigation.type === "reload",
    storage,
    locks: navigator.locks,
    onChange: () => state.owner.notify(),
  });
  state.journal.start((entries) => {
    for (const entry of entries) {
      const parsed = state.owner.parseRecovered(entry);
      if (parsed) state.owner.begin(parsed);
    }
  });
}
function resetScope(state: OwnerContext) {
  state.generation++;
  state.active.clear();
  state.followup.clear();
  for (const timer of state.scheduled.values()) clearTimeout(timer);
  state.scheduled.clear();
  state.journal?.forget();
  state.journal = undefined;
  state.scope = undefined;
  state.owner.clear();
}
export function clearPendingSendScope(client: QueryClient) {
  const state = owners.get(client);
  if (state) resetScope(state);
}
function custodyKey(owner: PendingSendOverlay, threadId: string) {
  return JSON.stringify(
    owner
      .list(threadId)
      .map((entry) => [
        entry.id,
        entry.state,
        entry.sequence,
        entry.requestedRequestId,
        entry.deferredRequestId,
        entry.queueIds,
        entry.legacyFence,
      ]),
  );
}
function needsHandoff(owner: PendingSendOverlay, threadId: string) {
  return owner
    .list(threadId)
    .some(
      (entry) =>
        entry.legacyFence !== undefined ||
        entry.state === "sending" ||
        entry.state === "sent" ||
        entry.state === "queued" ||
        ((entry.state === "unconfirmed" || entry.state === "unresolved") &&
          entry.queueIds.length > 0),
    );
}
function schedulePendingSendRefresh(
  client: QueryClient,
  state: OwnerContext,
  threadId: string,
) {
  if (state.scheduled.has(threadId) || !needsHandoff(state.owner, threadId))
    return;
  const generation = state.generation;
  state.scheduled.set(
    threadId,
    setTimeout(() => {
      state.scheduled.delete(threadId);
      if (
        state.generation === generation &&
        needsHandoff(state.owner, threadId)
      )
        void refreshPendingSends(client, threadId).catch(() => {});
    }, 250),
  );
}
export function pendingSendOwner(client: QueryClient) {
  return context(client).owner;
}
export function pendingSendJournal(client: QueryClient) {
  return context(client).journal;
}
export function usePendingSendOwner(client: QueryClient) {
  const owner = pendingSendOwner(client);
  useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return owner;
}
export function pendingRecoveryStatus(client: QueryClient): JournalStatus {
  return context(client).journal?.status ?? "unavailable";
}
export async function refreshPendingSends(
  client: QueryClient,
  threadId: string,
): Promise<void> {
  const state = context(client),
    owner = state.owner;
  const previous = state.active.get(threadId);
  if (previous) {
    state.followup.add(threadId);
    return previous;
  }
  const generation = state.generation;
  const read = async () => {
    const started = owner.startRead();
    const [timelineRead, queue] = await Promise.all([
      sdk.threads.timeline({
        threadId,
        deferContent: "true",
        segmentLimit: String(COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT),
      }),
      sdk.threads.queuedMessages.list({ threadId }),
    ]);
    const previous = client.getQueryData<ThreadTimelineResponse>(
      threadTimelineQueryKey(threadId),
    );
    let timeline = isThreadTimelineDelta(timelineRead)
      ? previous
        ? applyThreadTimelineDelta(previous, timelineRead)
        : null
      : timelineRead;
    if (!timeline) {
      const full = await sdk.threads.timeline({
        threadId,
        deferContent: "true",
        segmentLimit: String(COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT),
      });
      if (isThreadTimelineDelta(full))
        throw Error("Full timeline read required for delivery handoff");
      timeline = full;
    }
    const observedTimeline = timeline;
    const known = [
      ...new Set(
        owner
          .list(threadId)
          .flatMap((entry) => [
            ...entry.queueIds,
            ...queue
              .filter((row) =>
                entry.submissionIds.some((id) =>
                  row.clientSubmissionIds?.includes(id),
                ),
              )
              .map((row) => row.id),
          ]),
      ),
    ];
    let legacySnapshot = false;
    const snapshots: {
      data: import("@bb/server-contract").QueueSnapshotResponse;
      started: number;
    }[] = [];
    for (let offset = 0; offset < known.length; offset += 200) {
      try {
        const snapshotStarted = owner.startRead();
        snapshots.push({
          started: snapshotStarted,
          data: await sdk.threads.queueSnapshot({
            threadId,
            knownAdmittedQueueIds: known.slice(offset, offset + 200),
          }),
        });
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("status" in error) ||
          error.status !== 404
        )
          throw error;
        legacySnapshot = true;
        break;
      }
    }
    if (state.generation !== generation) return;
    state.applying = true;
    try {
      notifyManager.batch(() => {
        const previous = client.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey(threadId),
        );
        if (
          owner
            .list(threadId)
            .some(
              (entry) =>
                entry.legacyFence !== undefined && entry.legacyFence < started,
            )
        )
          client.setQueryData(
            threadTimelineQueryKey(threadId),
            previous && previous.maxSeq > observedTimeline.maxSeq
              ? previous
              : observedTimeline,
          );
        const latestQueue = snapshots.at(-1)?.data.rows ?? queue;
        client.setQueryData(
          threadQueuedMessagesQueryKey(threadId),
          latestQueue,
        );
        const nativeTimeline = client.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey(threadId),
        );
        const coveredSequence = Math.min(
          nativeTimeline?.maxSeq ?? 0,
          observedTimeline.maxSeq,
        );
        for (const snapshot of snapshots)
          owner.applySnapshot(
            threadId,
            snapshot.data,
            snapshot.started,
            coveredSequence,
          );
        owner.observe(threadId, observedTimeline.rows, latestQueue, {
          allowHandoff: false,
        });
        owner.observe(threadId, nativeTimeline?.rows ?? [], latestQueue);
        if (legacySnapshot)
          owner.legacyQueueRead(threadId, started, latestQueue);
        owner.finishRead(threadId, coveredSequence);
        owner.applyLegacyJointRead(threadId, started);
      });
    } finally {
      state.applying = false;
    }
  };
  const promise = read()
    .catch((error) => {
      if (state.generation === generation) owner.readFailed(threadId);
      throw error;
    })
    .finally(() => {
      if (state.generation !== generation) return;
      state.active.delete(threadId);
      if (state.followup.delete(threadId))
        schedulePendingSendRefresh(client, state, threadId);
    });
  state.active.set(threadId, promise);
  return promise;
}
export function composePendingSends(
  client: QueryClient,
  threadId: string,
  rows?: import("@bb/server-contract").TimelineRow[],
  queue?: ThreadQueuedMessage[],
) {
  return pendingSendOwner(client).project(
    threadId,
    rows ??
      client.getQueryData<ThreadTimelineResponse>(
        threadTimelineQueryKey(threadId),
      )?.rows ??
      [],
    queue ??
      client.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey(threadId),
      ) ??
      [],
  );
}
export function newPendingSend(
  entry: Omit<PendingSend, "sequence" | "state">,
): PendingSend {
  return { ...entry, sequence: 0, state: "sending" };
}

const sends = new WeakMap<
  PendingSendOverlay,
  Map<
    string,
    {
      payload: string;
      result: Promise<import("@bb/server-contract").SendMessageResponse>;
    }
  >
>();
export function dispatchPendingSend(
  client: QueryClient,
  threadId: string,
  id: string,
  payload: unknown,
  queueIds: string[],
  send: () => Promise<import("@bb/server-contract").SendMessageResponse>,
) {
  const owner = pendingSendOwner(client);
  let active = sends.get(owner);
  if (!active) {
    active = new Map();
    sends.set(owner, active);
  }
  const keys = queueIds.length
    ? queueIds.map((id) => `${threadId}/queue/${id}`)
    : [`${threadId}/send/${id}`];
  const encoded = JSON.stringify(payload);
  for (const key of keys) {
    const current = active.get(key);
    if (current) {
      if (queueIds.length === 0 && current.payload !== encoded)
        throw Error("Conflicting submission identity");
      return current.result;
    }
  }
  const result = Promise.resolve()
    .then(send)
    .finally(() => {
      for (const key of keys) active!.delete(key);
    });
  for (const key of keys) active.set(key, { payload: encoded, result });
  return result;
}
