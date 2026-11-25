import { eq } from "drizzle-orm";
import {
  canonicalJsonBytes,
  workerObservationSchema,
  workspaceEvidenceSchema,
  type WorkerObservation,
  type WorkerCustody,
} from "@bb/domain";
import type { DbTransaction, DbQueryConnection } from "../connection.js";
import { placementSourceFacts as facts } from "../schema.js";
type Fact = typeof facts.$inferInsert;
const key = canonicalJsonBytes;
function quotaKey(owner: string, w: WorkerObservation) {
  return key([
    "quota",
    owner,
    w.providerId,
    w.accountId,
    w.agentHostId,
    w.generation,
  ]);
}
function exclusionKey(w: WorkerObservation) {
  return key(["host-exclusion", w.agentHostId]);
}
function routeKey(
  owner: string,
  w: WorkerObservation,
  r: WorkerObservation["routes"][number],
) {
  return key([
    "route",
    owner,
    w.providerId,
    r.workspace,
    r.agent,
    r.tier,
    r.fixtureRunId,
  ]);
}
function asFact(source: string, value: { revision: number }): Fact {
  return { source, revision: value.revision, bytes: canonicalJsonBytes(value) };
}
function custodyFact(owner: string, provider: string, c: WorkerCustody) {
  return asFact(
    key(["custody", owner, provider, c.workerId, c.agentHostId, c.generation]),
    c,
  );
}
function get(db: DbQueryConnection, source: string) {
  return db.select().from(facts).where(eq(facts.source, source)).get();
}
function store(tx: DbTransaction, f: Fact) {
  tx.insert(facts)
    .values(f)
    .onConflictDoUpdate({
      target: facts.source,
      set: { revision: f.revision, bytes: f.bytes },
    })
    .run();
}
export function recordCustodyFact(
  tx: DbTransaction,
  owner: string,
  provider: string,
  c: WorkerCustody,
) {
  const f = custodyFact(owner, provider, c),
    old = get(tx, f.source);
  if (
    old &&
    (old.revision > f.revision ||
      (old.revision === f.revision && old.bytes !== f.bytes))
  )
    return false;
  store(tx, f);
  return true;
}
export function publishSourceFacts(
  tx: DbTransaction,
  owner: string,
  rows: WorkerObservation[],
) {
  const newest = new Map<string, Fact>(),
    seen = new Map<string, string>();
  for (const w of rows) {
    const exclusion = exclusionKey(w);
    const authority = get(tx, exclusion) ?? newest.get(exclusion);
    if (
      authority &&
      JSON.parse(authority.bytes).authorityPluginId !==
        w.exclusion.authorityPluginId
    )
      return false;
    const quotaSource = quotaKey(owner, w);
    // Unknown/stale telemetry can advance the observation clock. Only a fresh
    // observation can clear the last known applicable block.
    const applicable =
      w.quota.block || w.quota.freshness === "fresh"
        ? [asFact(key(["applicable", quotaSource]), w.quota)]
        : [];
    for (const f of [
      asFact(quotaSource, w.quota),
      ...applicable,
      asFact(exclusion, w.exclusion),
      custodyFact(owner, w.providerId, w.custody),
      ...w.routes.map((r) => asFact(routeKey(owner, w, r), r)),
    ]) {
      const old = get(tx, f.source);
      const pair = key([f.source, f.revision]);
      if (
        (old &&
          (old.revision > f.revision ||
            (old.revision === f.revision && old.bytes !== f.bytes))) ||
        (seen.has(pair) && seen.get(pair) !== f.bytes)
      )
        return false;
      seen.set(pair, f.bytes);
      if ((newest.get(f.source)?.revision ?? -1) < f.revision)
        newest.set(f.source, f);
    }
  }
  for (const f of newest.values()) store(tx, f);
  return true;
}
export function readSharedPolicy(
  db: DbQueryConnection,
  owner: string,
  w: WorkerObservation,
) {
  const q = get(db, quotaKey(owner, w)),
    e = get(db, exclusionKey(w));
  if (!q || !e) return null;
  const applicable = get(db, key(["applicable", q.source]));
  const quota = workerObservationSchema.shape.quota.parse(
    JSON.parse(applicable?.bytes ?? q.bytes),
  );
  const exclusion = workerObservationSchema.shape.exclusion.parse(
    JSON.parse(e.bytes),
  );
  return { quota, exclusion };
}
export function currentRoute(
  db: DbQueryConnection,
  owner: string,
  w: WorkerObservation,
  r: WorkerObservation["routes"][number],
) {
  const fact = get(db, routeKey(owner, w, r));
  return fact ? workspaceEvidenceSchema.parse(JSON.parse(fact.bytes)) : null;
}
