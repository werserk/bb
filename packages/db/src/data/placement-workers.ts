import { and, eq, notInArray } from "drizzle-orm";
import {
  canonicalJsonBytes,
  workerObservationSchema,
  type WorkerObservation,
} from "@bb/domain";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  placementOwners as owners,
  placementWorkers as workers,
} from "../schema.js";
export function registerPlacementOwner(
  db: DbConnection,
  args: { providerId: string; ownerPluginId: string },
) {
  return db.transaction(
    (tx) => {
      const old = tx
        .select()
        .from(owners)
        .where(eq(owners.providerId, args.providerId))
        .get();
      if (old?.available || (old && old.ownerPluginId !== args.ownerPluginId))
        return { kind: "conflict" as const };
      tx.update(workers)
        .set({ available: false })
        .where(
          and(
            eq(workers.providerId, args.providerId),
            eq(workers.ownerPluginId, args.ownerPluginId),
          ),
        )
        .run();
      const owner = old
        ? tx
            .update(owners)
            .set({ available: true, revision: old.revision + 1 })
            .where(eq(owners.providerId, args.providerId))
            .returning()
            .get()
        : tx
            .insert(owners)
            .values({ ...args, revision: 1, available: true })
            .returning()
            .get();
      return { kind: "registered" as const, owner };
    },
    { behavior: "immediate" },
  );
}
export function markPlacementOwnerUnavailable(
  db: DbConnection,
  args: { providerId: string; ownerPluginId: string; expectedRevision: number },
) {
  return db.transaction(
    (tx) =>
      tx
        .update(owners)
        .set({ available: false, revision: args.expectedRevision + 1 })
        .where(
          and(
            eq(owners.providerId, args.providerId),
            eq(owners.ownerPluginId, args.ownerPluginId),
            eq(owners.revision, args.expectedRevision),
          ),
        )
        .returning()
        .get() ?? null,
    { behavior: "immediate" },
  );
}
export function resetPlacementOwnerAvailability(db: DbConnection) {
  return db.transaction(
    (tx) => tx.update(owners).set({ available: false }).run(),
    { behavior: "immediate" },
  );
}
export function readPlacementOwner(db: DbQueryConnection, providerId: string) {
  return (
    db.select().from(owners).where(eq(owners.providerId, providerId)).get() ??
    null
  );
}
export function readPlacementWorker(
  db: DbQueryConnection,
  ownerPluginId: string,
  workerId: string,
) {
  return (
    db
      .select()
      .from(workers)
      .where(
        and(
          eq(workers.ownerPluginId, ownerPluginId),
          eq(workers.workerId, workerId),
        ),
      )
      .get() ?? null
  );
}
function staleEvidence<T extends { revision: number }>(previous: T, next: T) {
  return (
    next.revision < previous.revision ||
    (next.revision === previous.revision &&
      canonicalJsonBytes(previous) !== canonicalJsonBytes(next))
  );
}

type Route = WorkerObservation["routes"][number];
function routeKey(route: Route) {
  return canonicalJsonBytes([
    route.workspace,
    route.agent,
    route.tier,
    route.fixtureRunId,
  ]);
}

function mergeRoutes(previous: Route[], next: Route[]) {
  const history = new Map(previous.map((route) => [routeKey(route), route]));
  const seen = new Set<string>();
  for (const route of next) {
    const key = routeKey(route);
    const prior = history.get(key);
    if (seen.has(key) || (prior && staleEvidence(prior, route))) return null;
    seen.add(key);
    history.set(key, route);
  }
  return [...history.values()];
}

type WorkerRow = typeof workers.$inferSelect;

// The worker row already partitions provider/owner/worker. Registration fences
// publication; reconnecting the same owner does not reset its evidence sources.
function mergeSourceEvidence(old: WorkerRow | null, w: WorkerObservation) {
  const history = { ...old?.sourceEvidence };
  function retain(key: string[], fact: { revision: number }) {
    const id = canonicalJsonBytes(key);
    const previous = history[id];
    const bytes = canonicalJsonBytes(fact);
    if (
      previous &&
      (previous.revision > fact.revision ||
        (previous.revision === fact.revision && previous.bytes !== bytes))
    )
      return false;
    history[id] = { revision: fact.revision, bytes };
    return true;
  }
  // Runtime reports and proven release can advance native custody independently
  // of owner publication. Preserve that last fact before replacing the projection.
  if (
    old?.nativeCustody &&
    !retain(["custody", old.agentHostId, old.generation], old.nativeCustody)
  )
    return null;
  if (
    !retain(["custody", w.agentHostId, w.generation], w.custody) ||
    !retain(["quota", w.accountId, w.agentHostId, w.generation], w.quota) ||
    !retain(
      ["exclusion", w.exclusion.authorityPluginId, w.agentHostId],
      w.exclusion,
    )
  )
    return null;
  return history;
}

export function observePlacementWorkers(
  db: DbConnection,
  args: {
    providerId: string;
    ownerPluginId: string;
    expectedOwnerRevision: number;
    workers: WorkerObservation[];
  },
) {
  const observed = args.workers.map((w) => workerObservationSchema.parse(w));
  if (new Set(observed.map((w) => w.workerId)).size !== observed.length)
    return { kind: "conflict" as const };
  return db.transaction(
    (tx) => {
      const owner = readPlacementOwner(tx, args.providerId);
      if (
        !owner?.available ||
        owner.ownerPluginId !== args.ownerPluginId ||
        owner.revision !== args.expectedOwnerRevision
      )
        return { kind: "stale" as const };
      const histories = new Map<string, Route[]>();
      const sources = new Map<string, WorkerRow["sourceEvidence"]>();
      for (const w of observed) {
        const old = readPlacementWorker(tx, args.ownerPluginId, w.workerId);
        const history = mergeRoutes(old?.routeEvidence ?? [], w.routes);
        if (!history) return { kind: "stale" as const };
        histories.set(w.workerId, history);
        if (
          w.providerId !== args.providerId ||
          (old &&
            (old.providerId !== args.providerId ||
              w.revision <= old.observationRevision ||
              old.observation.exclusion.authorityPluginId !==
                w.exclusion.authorityPluginId))
        )
          return { kind: "stale" as const };
        const sourceHistory = mergeSourceEvidence(old, w);
        if (!sourceHistory) return { kind: "stale" as const };
        sources.set(w.workerId, sourceHistory);
      }
      const ids = observed.map((w) => w.workerId);
      tx.update(workers)
        .set({ available: false })
        .where(
          and(
            eq(workers.ownerPluginId, args.ownerPluginId),
            eq(workers.providerId, args.providerId),
            ids.length ? notInArray(workers.workerId, ids) : undefined,
          ),
        )
        .run();
      for (const w of observed) {
        const old = readPlacementWorker(tx, args.ownerPluginId, w.workerId);
        const lostResident =
          old?.nativeCustody?.status === "held" &&
          old.slotState !== "reclaiming" &&
          (w.custody.status !== "held" ||
            canonicalJsonBytes(old.nativeCustody.holder) !==
              canonicalJsonBytes(w.custody.holder));
        const changed =
          old &&
          (old.agentHostId !== w.agentHostId ||
            old.generation !== w.generation ||
            old.accountId !== w.accountId ||
            (old.fenceLock !== null &&
              w.custody.lock !== null &&
              canonicalJsonBytes(old.fenceLock) !==
                canonicalJsonBytes(w.custody.lock)));
        const data = {
          providerId: w.providerId,
          accountId: w.accountId,
          agentHostId: w.agentHostId,
          generation: w.generation,
          providerVersion: w.providerVersion,
          observationRevision: w.revision,
          policyRevision: w.exclusion.revision,
          sourceEvidence: sources.get(w.workerId)!,
          routeEvidence: histories.get(w.workerId)!,
          observation: w,
          nativeCustody: w.custody,
          available: true,
        };
        if (old)
          tx.update(workers)
            .set({
              ...data,
              slotState:
                (changed || lostResident) && old.slotState !== "free"
                  ? "unknown"
                  : old.slotState,
            })
            .where(
              and(
                eq(workers.ownerPluginId, args.ownerPluginId),
                eq(workers.workerId, w.workerId),
              ),
            )
            .run();
        else
          tx.insert(workers)
            .values({
              ...data,
              ownerPluginId: args.ownerPluginId,
              workerId: w.workerId,
              slotState: w.custody.status === "free" ? "free" : "unknown",
            })
            .run();
      }
      return { kind: "observed" as const };
    },
    { behavior: "immediate" },
  );
}
