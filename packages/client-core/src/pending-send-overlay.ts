import { z } from "zod";
import { timelineUserConversationRowSchema } from "@bb/server-contract";
import { threadQueuedMessageSchema } from "@bb/domain";
import type { ThreadQueuedMessage } from "@bb/domain";
import type {
  QueueSnapshotResponse,
  SendMessageResponse,
  TimelineRow,
  TimelineUserConversationRow,
} from "@bb/server-contract";

export type PendingSendState =
  | "sending"
  | "sent"
  | "queued"
  | "unconfirmed"
  | "unresolved"
  | "failed";
export interface PendingSend {
  id: string;
  threadId: string;
  row: TimelineUserConversationRow;
  queueIds: string[];
  submissionIds: string[];
  queueRows: ThreadQueuedMessage[];
  state: PendingSendState;
  sequence: number;
  afterSequence?: number;
  deferredRequestId?: string;
  requestedRequestId?: string;
  legacyFence?: number;
  legacyTimelineAfterSequence?: number;
  legacyQueueBaselineIds?: string[];
  error?: string;
  request?: import("@bb/server-contract").SendMessageRequest;
}
export interface PendingSendProjection {
  rows: TimelineRow[];
  queue: ThreadQueuedMessage[];
}

export class PendingSendOverlay {
  private observedRows = new WeakMap<
    TimelineRow[],
    Map<string, TimelineUserConversationRow[]>
  >();
  private projections = new WeakMap<
    TimelineRow[],
    WeakMap<
      ThreadQueuedMessage[],
      { threadId: string; revision: number; value: PendingSendProjection }
    >
  >();
  private freshness = new Map<string, number>();
  private settledQueues = new Set<string>();
  private entries = new Map<string, PendingSend>();
  private listeners = new Set<() => void>();
  private entrySnapshot: readonly PendingSend[] = [];
  private revision = 0;
  private clock = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.revision;
  getEntriesSnapshot = () => this.entrySnapshot;
  notify() {
    this.changed();
  }
  clear() {
    this.observedRows = new WeakMap();
    this.entries.clear();
    this.settledQueues.clear();
    this.freshness.clear();
    this.changed();
  }
  parseRecovered(value: unknown): PendingSend | null {
    const result = z
      .object({
        id: z.string(),
        threadId: z.string(),
        row: timelineUserConversationRowSchema,
        queueIds: z.array(z.string()),
        submissionIds: z.array(z.string()),
        queueRows: z.array(threadQueuedMessageSchema),
        state: z.enum([
          "sending",
          "sent",
          "queued",
          "unconfirmed",
          "unresolved",
          "failed",
        ]),
        sequence: z.number().int().nonnegative(),
        afterSequence: z.number().int().nonnegative().optional(),
        deferredRequestId: z.string().optional(),
        requestedRequestId: z.string().optional(),
        legacyFence: z.number().optional(),
        legacyTimelineAfterSequence: z.number().optional(),
        legacyQueueBaselineIds: z.array(z.string()).optional(),
        error: z.string().optional(),
      })
      .safeParse(value);
    if (!result.success || result.data.row.threadId !== result.data.threadId)
      return null;
    return {
      ...result.data,
      state:
        result.data.state === "sending" || result.data.state === "failed"
          ? "unconfirmed"
          : result.data.state,
    };
  }
  private changed() {
    this.projections = new WeakMap();
    this.entrySnapshot = this.list().map((entry) => ({ ...entry }));
    this.revision++;
    for (const listener of this.listeners) listener();
  }
  list(threadId?: string) {
    return [...this.entries.values()].filter(
      (entry) => threadId === undefined || entry.threadId === threadId,
    );
  }
  journalEntries() {
    return this.list().map(({ request: _request, ...entry }) => ({
      ...entry,
      row: {
        ...entry.row,
        attachments: entry.row.attachments
          ? {
              ...entry.row.attachments,
              imageUrls: entry.row.attachments.imageUrls.filter(
                (url) => !url.startsWith("data:"),
              ),
            }
          : null,
      },
      queueRows: entry.queueRows.map((row) => ({
        ...row,
        content: row.content.filter(
          (input) =>
            input.visibility !== "agent-only" &&
            (input.type !== "image" || !input.url.startsWith("data:")),
        ),
      })),
    }));
  }
  admittedQueue(threadId: string, id: string, queueId: string) {
    const entry = this.entries.get(`${threadId}/${id}`);
    if (!entry || entry.state === "sent") return;
    entry.queueIds = [queueId];
    entry.state = "unconfirmed";
    this.changed();
  }
  begin(entry: PendingSend) {
    const key = `${entry.threadId}/${entry.id}`;
    const previous = this.entries.get(key);
    if (previous) {
      const content = (value: PendingSend) => ({
        text: value.row.text,
        attachments: value.row.attachments,
        queueIds: value.queueIds,
      });
      if (
        JSON.stringify(
          previous.request && entry.request
            ? previous.request
            : content(previous),
        ) !==
        JSON.stringify(
          previous.request && entry.request ? entry.request : content(entry),
        )
      )
        throw new Error("Conflicting submission identity");
      return previous;
    }
    const overlap = this.list(entry.threadId).find(
      (active) =>
        active.state === "sending" &&
        active.queueIds.some((id) => entry.queueIds.includes(id)),
    );
    if (overlap) return overlap;
    this.clock = Math.max(this.clock, entry.legacyFence ?? 0);
    this.freshness.set(key, ++this.clock);
    this.entries.set(key, entry);
    this.changed();
    return entry;
  }
  replaceFailed(threadId: string, id: string, replacement: PendingSend) {
    const previous = this.entries.get(`${threadId}/${id}`);
    if (!previous || previous.state !== "failed") return false;
    this.entries.delete(`${threadId}/${id}`);
    this.begin(replacement);
    return true;
  }
  hide(threadId: string, id: string) {
    if (this.entries.delete(`${threadId}/${id}`)) this.changed();
  }
  fail(threadId: string, id: string, definitive: boolean, error: string) {
    const entry = this.entries.get(`${threadId}/${id}`);
    if (
      !entry ||
      entry.state === "sent" ||
      entry.state === "queued" ||
      entry.state === "failed"
    )
      return;
    entry.state = definitive ? "failed" : "unconfirmed";
    entry.error = error;
    this.changed();
  }
  receipt(
    threadId: string,
    id: string,
    receipt: SendMessageResponse,
    legacyBaseline?: { maxSeq: number; queueIds?: string[] },
  ) {
    const entry = this.entries.get(`${threadId}/${id}`);
    if (!entry) return;
    if (receipt.delivery === "queued") {
      if (entry.state === "sent" || entry.deferredRequestId) return;
      entry.queueRows = [
        receipt.queuedMessage,
        ...entry.queueRows.filter((row) => row.id !== receipt.queuedMessage.id),
      ];
      entry.queueIds = receipt.sourceQueuedMessageIds?.length
        ? receipt.sourceQueuedMessageIds
        : [receipt.queuedMessage.id];
      entry.state = "queued";
      this.freshness.set(`${threadId}/${id}`, ++this.clock);
    } else {
      if (receipt.command) {
        this.hide(threadId, id);
        return;
      }
      if (
        entry.sequence > 0 &&
        (!receipt.requested ||
          receipt.requested.sequence < entry.sequence ||
          entry.deferredRequestId === receipt.requested.requestId)
      )
        return;
      entry.state = "sent";
      if (receipt.requested) {
        entry.sequence = receipt.requested.sequence;
        entry.requestedRequestId = receipt.requested.requestId;
      } else {
        entry.legacyFence = ++this.clock;
        entry.legacyTimelineAfterSequence =
          entry.afterSequence ?? legacyBaseline?.maxSeq;
        entry.legacyQueueBaselineIds ??= legacyBaseline?.queueIds;
      }
    }
    this.changed();
  }
  startRead() {
    return ++this.clock;
  }
  applyLegacyJointRead(threadId: string, started: number) {
    for (const entry of this.list(threadId))
      if (entry.legacyFence !== undefined && entry.legacyFence < started)
        this.entries.delete(`${threadId}/${entry.id}`);
    this.changed();
  }
  restoreQueue(threadId: string, id: string) {
    const entry = this.entries.get(`${threadId}/${id}`);
    if (entry && entry.state !== "sent") {
      entry.state = "queued";
      this.changed();
    }
  }
  removed(threadId: string, queueId: string) {
    for (const entry of this.list(threadId))
      if (entry.queueIds.includes(queueId))
        this.entries.delete(`${threadId}/${entry.id}`);
    this.changed();
  }
  observe(
    threadId: string,
    rows: TimelineRow[],
    queue: ThreadQueuedMessage[],
    options: { allowHandoff?: boolean } = {},
  ) {
    let changed = false;
    if (this.list(threadId).length === 0) return;
    let index = this.observedRows.get(rows);
    if (!index) {
      index = new Map();
      const visit = (items: TimelineRow[]) => {
        for (const row of items) {
          if (row.kind === "conversation" && row.role === "user") {
            for (const key of [
              ...(row.clientSubmissionIds ?? []).map((id) => `s/${id}`),
              ...(row.sourceQueuedMessageIds ?? []).map((id) => `q/${id}`),
            ]) {
              const matches = index!.get(key) ?? [];
              matches.push(row);
              index!.set(key, matches);
            }
          }
          if (row.kind === "turn" && row.children) visit(row.children);
        }
      };
      visit(rows);
      this.observedRows.set(rows, index);
    }
    const matchingRows = (entry: PendingSend) =>
      [
        ...new Set([
          ...entry.submissionIds.flatMap((id) => index.get(`s/${id}`) ?? []),
          ...entry.queueIds.flatMap((id) => index.get(`q/${id}`) ?? []),
        ]),
      ].filter(
        (row) =>
          row.threadId === threadId &&
          (!entry.deferredRequestId ||
            row.submissionRequestId !== entry.deferredRequestId),
      );
    for (const entry of this.list(threadId)) {
      const matching = matchingRows(entry);
      const deferred = queue.find((row) => {
        if (row.payload.kind !== "deferredSteer") return false;
        const source = row.payload.sourceRequestId;
        return (
          (source === entry.requestedRequestId ||
            matching.some(
              (request) => request.submissionRequestId === source,
            )) &&
          !matching.some((request) =>
            request.sourceQueuedMessageIds?.includes(row.id),
          )
        );
      });
      if (deferred && entry.queueIds[0] !== deferred.id) {
        entry.deferredRequestId =
          deferred.payload.kind === "deferredSteer"
            ? deferred.payload.sourceRequestId
            : entry.requestedRequestId;
        this.freshness.set(`${threadId}/${entry.id}`, ++this.clock);
        entry.queueIds = [deferred.id];
        entry.queueRows = [deferred];
        entry.state = "queued";
        changed = true;
        continue;
      }
      const newest = Math.max(0, ...matching.map((row) => row.sourceSeqEnd));
      if (newest > entry.sequence) {
        entry.sequence = newest;
        entry.requestedRequestId = matching.find(
          (row) => row.sourceSeqEnd === newest,
        )?.submissionRequestId;
        entry.state = "sent";
        changed = true;
        continue;
      }
      if (entry.state === "sent" || entry.deferredRequestId) continue;
      const queued = queue.filter(
        (row) =>
          entry.queueIds.includes(row.id) ||
          entry.submissionIds.some((id) =>
            row.clientSubmissionIds?.includes(id),
          ),
      );
      if (
        queued.length &&
        JSON.stringify(queued) !== JSON.stringify(entry.queueRows)
      ) {
        if (queued.some((row) => !entry.queueIds.includes(row.id)))
          this.freshness.set(`${threadId}/${entry.id}`, ++this.clock);
        entry.queueRows = queued;
        entry.queueIds = queued.map((row) => row.id);
        entry.state = "queued";
        changed = true;
      }
    }
    for (const entry of options.allowHandoff === false
      ? []
      : this.list(threadId)) {
      const canonical = matchingRows(entry).filter(
        (row) =>
          (!entry.deferredRequestId ||
            row.submissionRequestId !== entry.deferredRequestId) &&
          row.sourceSeqEnd > (entry.afterSequence ?? -1),
      );
      const represented = entry.submissionIds.length
        ? entry.submissionIds.every((id) =>
            canonical.some((row) => row.clientSubmissionIds?.includes(id)),
          )
        : entry.queueIds.length > 0 &&
          entry.queueIds.every((id) =>
            canonical.some((row) => row.sourceQueuedMessageIds?.includes(id)),
          );
      if (
        represented &&
        (entry.state === "sent" || entry.state === "unresolved")
      ) {
        this.settle(entry);
        changed = true;
      }
    }
    if (changed) this.changed();
  }
  legacyQueueRead(
    threadId: string,
    started: number,
    queue: ThreadQueuedMessage[],
  ) {
    let changed = false;
    for (const entry of this.list(threadId))
      if (
        entry.state === "queued" &&
        entry.queueIds.length &&
        (this.freshness.get(`${threadId}/${entry.id}`) ?? 0) < started &&
        entry.queueIds.every((id) => !queue.some((row) => row.id === id))
      ) {
        entry.state = "unresolved";
        changed = true;
      }
    if (changed) this.changed();
  }
  readFailed(threadId: string) {
    let changed = false;
    for (const entry of this.list(threadId))
      if (entry.state === "sent") {
        entry.state = "unresolved";
        changed = true;
      }
    if (changed) this.changed();
  }
  finishRead(threadId: string, coveredSequence: number) {
    let changed = false;
    for (const entry of this.list(threadId))
      if (
        entry.state === "sent" &&
        entry.sequence > 0 &&
        entry.sequence <= coveredSequence &&
        entry.legacyFence === undefined
      ) {
        entry.state = "unresolved";
        changed = true;
      }
    if (changed) this.changed();
  }
  private settle(entry: PendingSend) {
    for (const id of [
      ...entry.queueIds,
      ...entry.submissionIds.map((id) => `qsub_${id}`),
    ])
      this.settledQueues.add(`${entry.threadId}/${id}`);
    this.entries.delete(`${entry.threadId}/${entry.id}`);
    this.freshness.delete(`${entry.threadId}/${entry.id}`);
  }
  applySnapshot(
    threadId: string,
    snapshot: QueueSnapshotResponse,
    started = Number.POSITIVE_INFINITY,
    coveredSequence = Number.NEGATIVE_INFINITY,
  ) {
    for (const entry of this.list(threadId)) {
      if (
        snapshot.eventMaxSeq < entry.sequence ||
        (this.freshness.get(`${threadId}/${entry.id}`) ?? 0) >= started
      )
        continue;
      if (snapshot.eventMaxSeq < (entry.afterSequence ?? 0)) {
        entry.state = "unresolved";
        continue;
      }
      const placements = snapshot.placements.filter((fact) =>
        entry.queueIds.includes(fact.queueId),
      );
      const placement =
        placements.find((fact) => fact.state === "deferred") ??
        placements.find(
          (fact) => fact.state === "requested" || fact.state === "rejected",
        );
      if (placement && (placement.requestSequence ?? 0) >= entry.sequence) {
        entry.sequence = placement.requestSequence ?? entry.sequence;
        if (
          placement.state === "deferred" &&
          placement.deferredToQueuedMessageId
        ) {
          entry.deferredRequestId = placement.requestId;
          entry.queueIds = [placement.deferredToQueuedMessageId];
          const row = snapshot.rows.find(
            (row) => row.id === placement.deferredToQueuedMessageId,
          );
          if (row) {
            entry.queueRows = [row];
            entry.state = "queued";
          } else entry.state = "unresolved";
        } else {
          entry.state = "sent";
          entry.requestedRequestId = placement.requestId;
          if ((placement.requestSequence ?? Infinity) <= coveredSequence)
            this.settle(entry);
        }
      } else if (placements.some((fact) => fact.state === "removed")) {
        const removed = new Set(
          placements
            .filter((fact) => fact.state === "removed")
            .map((fact) => fact.queueId),
        );
        for (const id of removed) this.settledQueues.add(`${threadId}/${id}`);
        entry.queueIds = entry.queueIds.filter((id) => !removed.has(id));
        entry.queueRows = entry.queueRows.filter((row) => !removed.has(row.id));
        if (entry.queueIds.length === 0) this.settle(entry);
      } else if (entry.state === "queued") {
        const present = snapshot.rows.filter((row) =>
          entry.queueIds.includes(row.id),
        );
        if (present.length) entry.queueRows = present;
        else if (placements.some((fact) => fact.state === "unresolved"))
          entry.state = "unresolved";
      }
    }
    this.changed();
  }
  project(
    threadId: string,
    rows: TimelineRow[],
    queue: ThreadQueuedMessage[],
  ): PendingSendProjection {
    const cached = this.projections.get(rows)?.get(queue);
    if (cached?.threadId === threadId && cached.revision === this.revision)
      return cached.value;
    const entries = this.list(threadId);
    const save = (value: PendingSendProjection) => {
      let byQueue = this.projections.get(rows);
      if (!byQueue) {
        byQueue = new WeakMap();
        this.projections.set(rows, byQueue);
      }
      byQueue.set(queue, { threadId, revision: this.revision, value });
      return value;
    };
    if (
      entries.length === 0 &&
      queue.every(
        (row) =>
          row.payload.kind !== "deferredSteer" &&
          !this.settledQueues.has(`${threadId}/${row.id}`),
      )
    ) {
      const visibleQueue = queue.filter(
        (row) => !this.settledQueues.has(`${threadId}/${row.id}`),
      );
      return save({
        rows,
        queue: visibleQueue.length === queue.length ? queue : visibleQueue,
      });
    }
    const represented = new Map<string, number>();
    const representedQueues = new Map<string, number>();
    function visit(rows: TimelineRow[]) {
      for (const row of rows) {
        if (row.threadId !== threadId) continue;
        if (row.kind === "conversation" && row.role === "user") {
          for (const id of row.clientSubmissionIds ?? [])
            represented.set(
              id,
              Math.max(represented.get(id) ?? 0, row.sourceSeqEnd),
            );
          for (const id of row.sourceQueuedMessageIds ?? [])
            representedQueues.set(
              id,
              Math.max(representedQueues.get(id) ?? 0, row.sourceSeqEnd),
            );
        }
        if (row.kind === "turn" && row.children) visit(row.children);
      }
    }
    const suppressed = new Set([
      ...entries.flatMap((entry) =>
        entry.deferredRequestId ? [entry.deferredRequestId] : [],
      ),
      ...queue.flatMap((row) =>
        row.payload.kind === "deferredSteer"
          ? [row.payload.sourceRequestId]
          : [],
      ),
    ]);
    const legacy = entries.filter(
      (entry) =>
        entry.legacyFence !== undefined &&
        entry.legacyTimelineAfterSequence !== undefined,
    );
    const legacyAfter = legacy.length
      ? Math.min(...legacy.map((entry) => entry.legacyTimelineAfterSequence!))
      : undefined;
    const legacyQueue = legacy.find(
      (entry) => entry.legacyQueueBaselineIds,
    )?.legacyQueueBaselineIds;
    const visible =
      suppressed.size || legacyAfter !== undefined
        ? filterPendingRows(rows, suppressed, legacyAfter, threadId)
        : rows;
    if (entries.length) visit(visible);
    let resultRows = visible;
    let resultQueue = queue.filter(
      (row) =>
        !this.settledQueues.has(`${threadId}/${row.id}`) &&
        (!legacyQueue || legacyQueue.includes(row.id)),
    );
    if (resultQueue.length === queue.length) resultQueue = queue;
    const mutableQueue = () => {
      if (resultQueue === queue) resultQueue = [...queue];
    };
    for (const entry of entries) {
      const canonical =
        entry.submissionIds.length > 0
          ? entry.submissionIds.every(
              (id) => (represented.get(id) ?? -1) > (entry.afterSequence ?? -1),
            )
          : entry.queueIds.length > 0 &&
            entry.queueIds.every(
              (id) =>
                (representedQueues.get(id) ?? -1) > (entry.afterSequence ?? -1),
            );
      if (canonical) {
        for (let i = resultQueue.length - 1; i >= 0; i--)
          if (
            entry.queueIds.includes(resultQueue[i]!.id) ||
            entry.submissionIds.some((id) =>
              resultQueue[i]!.clientSubmissionIds?.includes(id),
            )
          ) {
            mutableQueue();
            resultQueue.splice(i, 1);
          }
        continue;
      }
      if (entry.state === "queued") {
        for (const row of entry.queueRows) {
          const index = resultQueue.findIndex(
            (current) => current.id === row.id,
          );
          if (index < 0) {
            mutableQueue();
            resultQueue.push(row);
          } else if (
            resultQueue[index] !== row &&
            resultQueue[index]!.updatedAt <= row.updatedAt
          ) {
            mutableQueue();
            resultQueue[index] = row;
          }
        }
      } else {
        for (let i = resultQueue.length - 1; i >= 0; i--)
          if (entry.queueIds.includes(resultQueue[i]!.id)) {
            mutableQueue();
            resultQueue.splice(i, 1);
          }
        if (resultRows === visible) resultRows = [...visible];
        resultRows.push(entry.row);
      }
    }
    const repaired = resultQueue.map((row, index) => {
      const originalIndex = queue.findIndex((current) => current.id === row.id);
      if (
        row.groupWithNext &&
        originalIndex >= 0 &&
        queue[originalIndex + 1]?.id !== resultQueue[index + 1]?.id
      )
        return { ...row, groupWithNext: false };
      return row;
    });
    return save({
      rows: resultRows,
      queue: repaired.every((row, index) => row === resultQueue[index])
        ? resultQueue
        : repaired,
    });
  }
}

function filterPendingRows(
  items: TimelineRow[],
  suppressed: ReadonlySet<string>,
  legacyAfter: number | undefined,
  threadId: string,
): TimelineRow[] {
  let result: TimelineRow[] | undefined;
  for (let index = 0; index < items.length; index++) {
    const row = items[index]!;
    let next: TimelineRow | undefined = row;
    if (
      row.kind === "conversation" &&
      row.role === "user" &&
      ((row.submissionRequestId && suppressed.has(row.submissionRequestId)) ||
        (row.threadId === threadId &&
          legacyAfter !== undefined &&
          row.sourceSeqEnd > legacyAfter))
    )
      next = undefined;
    else if (row.kind === "turn" && row.children) {
      const children = filterPendingRows(
        row.children,
        suppressed,
        legacyAfter,
        threadId,
      );
      if (children !== row.children) next = { ...row, children };
    }
    if (next !== row && !result) result = items.slice(0, index);
    if (result && next) result.push(next);
  }
  return result ?? items;
}
