import { and, eq, lt, ne, sql } from "drizzle-orm";
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
export function physicalLockKey(
  host: string,
  lock: NonNullable<WorkerCustody["lock"]>,
) {
  return key([host, lock.device, lock.inode]);
}
function lockReportKey(resource: string, custodySource: string) {
  return key(["lock-report", resource, custodySource]);
}
function custodyReports(
  db: DbQueryConnection,
  owner: string,
  provider: string,
  c: WorkerCustody,
): Fact[] {
  const local = custodyFact(owner, provider, c);
  const prior = !c.lock && get(db, local.source);
  const lock =
    c.lock ||
    (prior &&
      workerObservationSchema.shape.custody.parse(JSON.parse(prior.bytes))
        .lock);
  if (!lock) return [local];
  const resource = physicalLockKey(c.agentHostId, lock);
  return [
    local,
    {
      ...asFact(lockReportKey(resource, local.source), c),
      blockedLock: c.status === "free" ? null : resource,
    },
  ];
}
type Holder = NonNullable<WorkerCustody["holder"]>;
function otherReports(owner: string, provider: string, c: WorkerCustody) {
  if (!c.lock) throw new Error("Physical lock is required");
  const resource = physicalLockKey(c.agentHostId, c.lock);
  return and(
    eq(facts.blockedLock, resource),
    ne(
      facts.source,
      lockReportKey(resource, custodyFact(owner, provider, c).source),
    ),
  );
}
function reportsHolder(holder: Holder) {
  return sql`(json_extract(${facts.bytes}, '$.status') IS 'held' AND json_extract(${facts.bytes}, '$.holder') IS ${key(holder)})`;
}
export function foreignLockReport(
  db: DbQueryConnection,
  owner: string,
  provider: string,
  c: WorkerCustody,
  closingHolder?: Holder | null,
) {
  if (!c.lock) return false;
  return !!db
    .select({ source: facts.source })
    .from(facts)
    .where(
      and(
        otherReports(owner, provider, c),
        closingHolder ? sql`NOT ${reportsHolder(closingHolder)}` : undefined,
      ),
    )
    .get();
}
export function dischargeClosedHolderReports(
  tx: DbTransaction,
  owner: string,
  provider: string,
  free: WorkerCustody,
  holder: Holder,
) {
  tx.update(facts)
    .set({ blockedLock: null })
    .where(and(otherReports(owner, provider, free), reportsHolder(holder)))
    .run();
}
function get(db: DbQueryConnection, source: string) {
  return db.select().from(facts).where(eq(facts.source, source)).get();
}
function store(tx: DbTransaction, f: Fact) {
  tx.insert(facts)
    .values(f)
    .onConflictDoUpdate({
      target: facts.source,
      setWhere: lt(facts.revision, f.revision),
      set: {
        revision: f.revision,
        bytes: f.bytes,
        blockedLock: f.blockedLock ?? null,
      },
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
  for (const report of custodyReports(tx, owner, provider, c))
    store(tx, report);
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
      ...custodyReports(tx, owner, w.providerId, w.custody),
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
