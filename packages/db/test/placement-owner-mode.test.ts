import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import * as S from "../src/index.js";
import { createMigratedConnection } from "../src/testing.js";
import {
  setOwnerMode,
  type PlacementActivationEvidence,
} from "@bb/db/internal-placement-owner";
import {
  fixtureAuthority,
  setupPlacement,
  acceptPrepared,
  attachAndQueue,
} from "./helpers/placement.js";

const scope = { providerId: "claude", ownerPluginId: "workers" };
const mode = {
  ...scope,
  expectedRevision: 1,
  mode: "managed" as const,
  handoffReceiptId: null,
};
const empty = { ...scope, kind: "verified_empty" as const, ownerRevision: 1 };
const accept = (db: S.DbConnection, key: string, input = key) =>
  S.acceptPlacementOperation(db, {
    ...scope,
    principalScope: "owner",
    submissionKey: key,
    authority: fixtureAuthority,
    request: {
      schemaVersion: 1,
      intent: {
        kind: "independent",
        selection: { mode: "auto" },
        request: { input },
      },
    },
  });
it("requires revision-scoped authoritative activation evidence; registration alone stays disabled", () => {
  const db = createMigratedConnection();
  try {
    S.registerPlacementOwner(db, scope);
    expect(accept(db, "before").kind).toBe("refused");
    expect(setOwnerMode(db, mode).kind).toBe("handoff_required");
    for (const evidence of [
      { ...empty, providerId: "other" },
      { ...empty, ownerPluginId: "other" },
      { ...empty, ownerRevision: 2 },
      { ...empty, handoffReceiptId: "contradiction" },
    ]) {
      expect(setOwnerMode(db, mode, () => evidence).kind).toBe(
        "handoff_required",
      );
    }
    const requested = { ...mode, handoffReceiptId: "receipt" };
    expect(setOwnerMode(db, requested, () => empty).kind).toBe(
      "handoff_required",
    );
    db.$client.exec(
      "CREATE TABLE fixture_verified_import(provider_id TEXT,owner_id TEXT,revision INTEGER,handoff TEXT,quiescence TEXT)",
    );
    const read = (tx: S.DbTransaction): PlacementActivationEvidence | null => {
      const row = tx.get<{
        providerId: string;
        ownerPluginId: string;
        ownerRevision: number;
        handoffReceiptId: string;
        quiescenceReceiptId: string;
      }>(
        sql`SELECT provider_id as providerId,owner_id as ownerPluginId,revision as ownerRevision,handoff as handoffReceiptId,quiescence as quiescenceReceiptId FROM fixture_verified_import`,
      );
      return row ? { kind: "committed_handoff", ...row } : null;
    };
    expect(setOwnerMode(db, requested, read).kind).toBe("handoff_required");
    db.$client
      .prepare("INSERT INTO fixture_verified_import VALUES (?,?,?,?,?)")
      .run("claude", "workers", 1, "receipt", "");
    expect(setOwnerMode(db, requested, read).kind).toBe("handoff_required");
    db.$client.exec(
      "UPDATE fixture_verified_import SET quiescence='fixture-closed'",
    );
    expect(
      setOwnerMode(db, { ...requested, handoffReceiptId: "unrelated" }, read)
        .kind,
    ).toBe("handoff_required");
    expect(setOwnerMode(db, requested, read)).toMatchObject({
      kind: "updated",
      owner: { mode: "managed", revision: 2 },
    });
    expect(setOwnerMode(db, requested, read).kind).toBe("stale");
    expect(
      setOwnerMode(db, { ...requested, expectedRevision: 2 }, read).kind,
    ).toBe("handoff_required");
    const old = accept(db, "replay");
    expect(old.kind).toBe("accepted");
    expect(
      setOwnerMode(db, { ...mode, mode: "disabled", expectedRevision: 2 }).kind,
    ).toBe("updated");
    expect(
      S.readPlacementSubmissionContext(db, {
        principalScope: "owner",
        submissionKey: "replay",
      }),
    ).toEqual({ ...scope, permission: fixtureAuthority.permission });
    expect(
      S.readPlacementSubmissionContext(db, {
        principalScope: "other",
        submissionKey: "replay",
      }),
    ).toBeNull();
    expect(accept(db, "replay")).toEqual(old);
    expect(accept(db, "replay", "changed").kind).toBe("conflict");
    expect(accept(db, "new").kind).toBe("refused");
    expect(db.select().from(S.placementOperations).all()).toHaveLength(1);
    expect(db.select().from(S.placementCounters).get()?.acceptedSeq).toBe(1);
    expect(db.select().from(S.threads).all()).toHaveLength(0);
    expect(db.select().from(S.queuedThreadMessages).all()).toHaveLength(0);
  } finally {
    db.$client.close();
  }
});
it("fences policy results across disposal, wait replay, queue ownership and cancellation", () => {
  const db = createMigratedConnection();
  try {
    setupPlacement(db);
    const op = acceptPrepared(db, "wait");
    const source = { ...scope, ownerRevision: 2, kind: "policy" as const };
    const wait = {
      operationId: op.id,
      expectedRevision: op.revision,
      outcome: "wait" as const,
      reason: "all_busy" as const,
      source,
    };
    expect(
      S.recordPlacementWait(db, {
        ...wait,
        source: { ...source, ownerPluginId: "other" },
      }).kind,
    ).toBe("stale");
    expect(S.recordPlacementWait(db, wait).kind).toBe("recorded");
    expect(S.recordPlacementWait(db, wait).kind).toBe("unchanged");
    expect(
      S.recordPlacementWait(db, { ...wait, reason: "worker_offline" }).kind,
    ).toBe("stale");
    const current = {
      ...wait,
      expectedRevision: S.readPlacementOperation(db, op.id)!.revision,
    };
    S.markPlacementOwnerUnavailable(db, { ...scope, expectedRevision: 2 });
    expect(
      setOwnerMode(db, { ...mode, expectedRevision: 3 }, () => ({
        ...empty,
        ownerRevision: 3,
      })).kind,
    ).toBe("owner_unavailable");
    expect(accept(db, "unavailable")).toMatchObject({
      kind: "accepted",
      operation: { phase: "pending", reason: "owner_unavailable" },
    });
    expect(
      S.recordPlacementWait(db, { ...current, outcome: "refuse" }).kind,
    ).toBe("stale");
    const unavailable = {
      ...current,
      source: {
        ...source,
        kind: "owner_unavailable" as const,
        ownerRevision: 3,
      },
      reason: "owner_unavailable" as const,
    };
    expect(S.recordPlacementWait(db, unavailable).kind).toBe("recorded");
    const replace = S.registerPlacementOwner(db, scope);
    expect(replace.kind).toBe("registered");
    const updated = S.readPlacementOperation(db, op.id)!;
    expect(
      S.recordPlacementWait(db, {
        ...current,
        expectedRevision: updated.revision,
        outcome: "refuse",
      }).kind,
    ).toBe("stale");
    expect(
      S.recordPlacementWait(db, {
        ...unavailable,
        expectedRevision: updated.revision,
        source: { ...unavailable.source, ownerRevision: 4 },
      }).kind,
    ).toBe("stale");
    S.cancelPlacementOperation(db, op.id);
    expect(
      S.recordPlacementWait(db, {
        ...wait,
        expectedRevision: S.readPlacementOperation(db, op.id)!.revision,
        source: { ...source, ownerRevision: 4 },
      }).kind,
    ).toBe("stale");
  } finally {
    db.$client.close();
  }
});
it("rejects a late wait after reservation or queue transfer at the current operation revision", () => {
  const db = createMigratedConnection();
  try {
    setupPlacement(db);
    const op = acceptPrepared(db, "queued");
    attachAndQueue(db, op.id);
    expect(
      S.recordPlacementWait(db, {
        operationId: op.id,
        expectedRevision: S.readPlacementOperation(db, op.id)!.revision,
        source: { ...scope, kind: "policy", ownerRevision: 2 },
        outcome: "refuse",
        reason: "capability_mismatch",
      }),
    ).toEqual({ kind: "stale" });
    const bound = S.readPlacementOperation(db, op.id)!;
    expect(
      setOwnerMode(db, {
        ...scope,
        expectedRevision: 2,
        mode: "disabled",
        handoffReceiptId: null,
      }).kind,
    ).toBe("updated");
    expect(
      S.acceptPlacementOperation(db, {
        ...scope,
        principalScope: "owner",
        submissionKey: "bound",
        authority: fixtureAuthority,
        request: {
          schemaVersion: 1,
          intent: {
            kind: "continuation",
            threadId: bound.threadId!,
            request: { input: "later" },
          },
        },
      }),
    ).toEqual({ kind: "refused", reason: "owner_unavailable" });
    expect(S.readPlacementThreadBinding(db, bound.threadId!)).toEqual(
      bound.binding,
    );
  } finally {
    db.$client.close();
  }
});
