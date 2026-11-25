import {
  reconcileObservedUnusedReservation,
  type UnusedPlacementReservationGuard,
} from "./placement-unused-reservation.js";
import { publishSourceFacts } from "./placement-source-facts.js";
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
export function observePlacementWorkers(
  db: DbConnection,
  args: {
    providerId: string;
    ownerPluginId: string;
    expectedOwnerRevision: number;
    workers: WorkerObservation[];
    unusedReservations?: readonly UnusedPlacementReservationGuard[];
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

      for (const w of observed) {
        const old = readPlacementWorker(tx, args.ownerPluginId, w.workerId);
        if (
          w.providerId !== args.providerId ||
          (old &&
            (old.providerId !== args.providerId ||
              w.revision <= old.observationRevision ||
              old.observation.exclusion.authorityPluginId !==
                w.exclusion.authorityPluginId))
        )
          return { kind: "stale" as const };
        const routes = w.routes.map((r) =>
          canonicalJsonBytes([r.workspace, r.agent, r.tier, r.fixtureRunId]),
        );
        if (new Set(routes).size !== routes.length)
          return { kind: "stale" as const };
      }
      if (!publishSourceFacts(tx, args.ownerPluginId, observed))
        return { kind: "stale" as const };
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
        const changedClosingHolder =
          old?.slotState === "reclaiming" &&
          w.custody.status === "held" &&
          canonicalJsonBytes(w.custody.holder) !==
            canonicalJsonBytes(old.reclaimHolder);
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
          observation: w,
          nativeCustody: w.custody,
          available: true,
        };
        const guard = args.unusedReservations?.find(
          (g) => g.workerId === w.workerId,
        );
        const releasing =
          old &&
          guard &&
          owner.mode === "managed" &&
          !changed &&
          !lostResident &&
          reconcileObservedUnusedReservation(tx, old, w, guard);
        if (old)
          tx.update(workers)
            .set({
              ...data,
              ...(releasing
                ? {
                    ownerOperationId: null,
                    threadId: null,
                    physicalLock: null,
                    fenceLock: null,
                    reclaimOperationId: null,
                    reclaimSourceFence: null,
                    reclaimHolder: null,
                  }
                : {}),
              slotState: releasing
                ? "free"
                : (changed || lostResident || changedClosingHolder) &&
                    old.slotState !== "free"
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
