import {
  PendingSendOverlay,
  PendingSendJournal,
  parsePromptDraftStorage,
  promptInputToDraft,
  serializePromptDraftStorage,
  type PendingSend,
  type JournalStatus,
  type PromptDraftState,
} from "@bb/client-core";
import { z } from "zod";
import { notifyManager, type QueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import { sdk } from "@/lib/sdk";
import { getPromptDraftAccessor } from "../usePromptDraftStorage";
import { getThreadEntity } from "./thread-entity-store";
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
import {
  syncThreadTimelineSubscriptionTag,
  COMPACT_THREAD_TIMELINE_SEGMENT_LIMIT,
} from "./thread-timeline-push-owner";

interface OwnerContext {
  owner: PendingSendOverlay;
  journal?: PendingSendJournal;
  scope?: string;
  identity?: string | null;
  identityPending: boolean;
  resumeWaitingJournal: boolean;
  identityRetry?: () => Promise<void>;
  resetting: boolean;
  active: Map<string, Promise<void>>;
  followup: Set<string>;
  scheduled: Map<string, ReturnType<typeof setTimeout>>;
  applying: boolean;
  generation: number;
}
const emptyRows: import("@bb/server-contract").TimelineRow[] = [];
const emptyQueue: ThreadQueuedMessage[] = [];
const owners = new WeakMap<QueryClient, OwnerContext>();
function context(
  client: QueryClient,
  initialIdentity?: string | null,
): OwnerContext {
  let state = owners.get(client);
  if (!state) {
    state = {
      owner: new PendingSendOverlay(),
      active: new Map(),
      followup: new Set(),
      scheduled: new Map(),
      applying: false,
      generation: 0,
      identity: initialIdentity,
      identityPending: initialIdentity === null,
      resumeWaitingJournal: false,
      resetting: false,
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
      if (current.journal && !current.identityPending && !current.resetting)
        saveJournal(current);
    });
  }
  ensureJournal(client, state);
  return state;
}
function saveJournal(state: OwnerContext) {
  state.journal?.save(state.owner.journalEntries(), () =>
    state.owner.journalEntries({ requests: false }),
  );
}
function ensureJournal(client: QueryClient, state: OwnerContext) {
  if (typeof window === "undefined" || state.identityPending || state.resetting)
    return;
  const config = client.getQueryData<SystemConfigResponse>(
    systemConfigQueryKey(),
  );
  if (!config) return;
  const scope = JSON.stringify([
    window.location.origin,
    config.primaryHostId,
    config.dataDir,
    state.identity,
  ]);
  if (state.scope === scope) return;
  if (state.scope !== undefined) resetScope(client, state);
  state.scope = scope;
  let storage: Storage | undefined;
  try {
    storage = window.sessionStorage;
  } catch {}
  const navigation = performance.getEntriesByType?.("navigation")[0];
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
    if (state.identityPending || state.resetting) return;
    for (const entry of entries) {
      const parsed = state.owner.parseRecovered(entry);
      if (parsed) state.owner.begin(parsed);
    }
  });
}
/**
 * The draft was cleared before the request, so an unacknowledged direct send
 * can be the only copy of its text: hand it back to its thread's draft (never
 * over a non-empty draft), bound to its id so an unchanged resend is deduped.
 * Returns the entries that could not be handed back; they stay visible.
 */
function handBackUnacknowledged(
  client: QueryClient,
  owner: PendingSendOverlay,
) {
  const kept: PendingSend[] = [];
  for (const entry of owner.list()) {
    if (
      entry.queueIds.length > 0 ||
      !(
        entry.state === "sending" ||
        entry.state === "unconfirmed" ||
        entry.state === "failed"
      )
    )
      continue;
    const projectId = getThreadEntity(client, entry.threadId)?.thread.projectId;
    const draft = entry.request
      ? promptInputToDraft(entry.request.input)
      : { text: entry.row.text, mentions: [], attachments: [] };
    const restored =
      projectId !== undefined &&
      getPromptDraftAccessor({
        kind: "thread",
        projectId,
        threadId: entry.threadId,
      }).restoreIfEmpty(draft);
    if (!restored) kept.push(entry);
    else if (entry.state !== "failed")
      bindDraft(entry.threadId, entry.id, draft);
  }
  return kept;
}
function resetScope(client: QueryClient, state: OwnerContext) {
  state.generation++;
  sends.delete(state.owner);
  state.active.clear();
  state.followup.clear();
  for (const timer of state.scheduled.values()) clearTimeout(timer);
  state.scheduled.clear();
  state.resumeWaitingJournal = false;
  state.resetting = true;
  const journal = state.journal;
  state.journal = undefined;
  state.scope = undefined;
  try {
    journal?.forget();
    const kept = handBackUnacknowledged(client, state.owner);
    state.owner.clear({ keep: kept });
  } finally {
    state.resetting = false;
  }
}
export function setPendingSendIdentity(
  client: QueryClient,
  identity: string | null,
) {
  const state = context(client, null);
  if (identity === null) {
    state.identityPending = true;
    if (state.journal?.status === "waiting") {
      state.resumeWaitingJournal = true;
      state.journal.hide();
    }
    state.owner.notify();
    return;
  }
  const previous = state.identity;
  const resumed = state.identityPending;
  state.identity = identity;
  state.identityPending = false;
  if (previous != null && previous !== identity) clearPendingSendScope(client);
  ensureJournal(client, state);
  if (resumed) {
    if (state.resumeWaitingJournal && state.journal?.status === "hidden")
      state.journal.refresh();
    else saveJournal(state);
    state.resumeWaitingJournal = false;
  }
  state.owner.notify();
}
export function setPendingSendIdentityRetry(
  client: QueryClient,
  retry: (() => Promise<void>) | undefined,
) {
  const state = context(client, null);
  state.identityRetry = retry;
  state.owner.notify();
}
export function pendingSendIdentityUnavailable(client: QueryClient) {
  const state = context(client);
  return state.identityPending && state.identityRetry !== undefined;
}
export async function retryPendingSendRecovery(client: QueryClient) {
  const state = context(client);
  if (state.identityPending) await state.identityRetry?.();
  else state.journal?.refresh();
}
export function pendingSendGeneration(client: QueryClient) {
  return context(client).generation;
}
export function clearPendingSendScope(client: QueryClient) {
  const state = owners.get(client);
  if (state) resetScope(client, state);
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
export function usePendingSendSnapshot(client: QueryClient) {
  const owner = pendingSendOwner(client);
  const read = useMemo(() => {
    let revision = -1;
    let snapshot:
      | {
          entries: readonly PendingSend[];
          recoveryStatus: JournalStatus;
          journal: PendingSendJournal | undefined;
          identityUnavailable: boolean;
        }
      | undefined;
    return () => {
      const current = owner.getSnapshot();
      if (!snapshot || revision !== current) {
        snapshot = {
          entries: owner.getEntriesSnapshot(),
          recoveryStatus: pendingRecoveryStatus(client),
          journal: pendingSendJournal(client),
          identityUnavailable: pendingSendIdentityUnavailable(client),
        };
        revision = current;
      }
      return snapshot;
    };
  }, [client, owner]);
  return useSyncExternalStore(owner.subscribe, read, read);
}
export function usePendingSendEntries(client: QueryClient) {
  return usePendingSendSnapshot(client).entries;
}
export function usePendingSendOwner(client: QueryClient) {
  const owner = pendingSendOwner(client);
  useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return owner;
}
export function pendingRecoveryStatus(client: QueryClient): JournalStatus {
  const state = context(client);
  return state.identityPending
    ? "unavailable"
    : (state.journal?.status ?? "unavailable");
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
        const appliedTimeline = client.getQueryData<ThreadTimelineResponse>(
          threadTimelineQueryKey(threadId),
        );
        if (appliedTimeline && appliedTimeline !== previous)
          syncThreadTimelineSubscriptionTag(
            client,
            threadId,
            appliedTimeline.tag,
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
      emptyRows,
    queue ??
      client.getQueryData<ThreadQueuedMessage[]>(
        threadQueuedMessagesQueryKey(threadId),
      ) ??
      emptyQueue,
  );
}
/**
 * After a failed send, hand the text back to the composer unless the server
 * accepted it or a live entry in an owned journal keeps it across a reload:
 * the draft was cleared before the request, so otherwise the text would have
 * no copy. A draft restored after an unknown outcome is bound to the
 * submission id, so sending it unchanged is deduped by the server.
 */
export function settleFailedPendingSend(
  client: QueryClient,
  threadId: string,
  id: string,
  restoreDraft: () => boolean,
  draft?: PromptDraftState,
): boolean {
  const owner = pendingSendOwner(client);
  const outcome = owner.outcome(threadId, id);
  if (
    outcome === "accepted" ||
    (outcome === undefined &&
      pendingRecoveryStatus(client) === "owned" &&
      owner.list(threadId).some((entry) => entry.id === id))
  )
    return false;
  const restored = restoreDraft();
  if (!restored) return false;
  if (outcome === undefined && draft) bindDraft(threadId, id, draft);
  owner.hide(threadId, id);
  return true;
}
const draftBindingKey = (threadId: string) =>
  `bb-pending-send-draft/${threadId}`;
const draftBindings = new Map<string, { id: string; draft: string }>();
/** A 53-bit hash of the normalized draft; the binding never holds its text. */
function draftHash(draft: PromptDraftState) {
  const text =
    serializePromptDraftStorage(
      parsePromptDraftStorage(serializePromptDraftStorage(draft)),
    ) ?? "";
  let h1 = 0xdeadbeef,
    h2 = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
function bindDraft(threadId: string, id: string, draft: PromptDraftState) {
  const binding = { id, draft: draftHash(draft) };
  draftBindings.set(threadId, binding);
  try {
    window.sessionStorage.setItem(
      draftBindingKey(threadId),
      JSON.stringify(binding),
    );
  } catch {}
}
/**
 * The submission id for sending `draft` in `threadId`: the id of the
 * unconfirmed send the draft was restored from while it is unchanged,
 * otherwise a new one. Each call consumes the binding.
 */
export function pendingSendDraftId(
  threadId: string,
  draft: PromptDraftState,
): string {
  let binding = draftBindings.get(threadId);
  draftBindings.delete(threadId);
  try {
    const stored = window.sessionStorage.getItem(draftBindingKey(threadId));
    window.sessionStorage.removeItem(draftBindingKey(threadId));
    if (!binding && stored !== null) {
      const parsed = z
        .object({ id: z.uuid(), draft: z.string() })
        .safeParse(JSON.parse(stored));
      if (parsed.success) binding = parsed.data;
    }
  } catch {}
  return binding?.draft === draftHash(draft) ? binding.id : crypto.randomUUID();
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
  const state = context(client);
  const generation = state.generation;
  const result = Promise.resolve()
    .then(() => {
      if (state.generation !== generation) {
        owner.markRejected(threadId, id);
        throw Error("Pending send scope changed");
      }
      return send();
    })
    .finally(() => {
      for (const key of keys) active!.delete(key);
    });
  for (const key of keys) active.set(key, { payload: encoded, result });
  return result;
}
