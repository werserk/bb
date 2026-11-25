import { and, eq } from "drizzle-orm";
import type { DbConnection, DbTransaction } from "./connection.js";
import { placementOwners as owners } from "./schema.js";
import { readPlacementOwner } from "./data/placement-workers.js";

export type PlacementOwnerRow = typeof owners.$inferSelect;
type OwnerScope = Pick<PlacementOwnerRow, "providerId" | "ownerPluginId">;
type RevisionScope = OwnerScope & { expectedRevision: number };
export type PlacementActivationEvidence = OwnerScope & {
  ownerRevision: number;
} & (
    | { kind: "verified_empty" }
    | {
        kind: "committed_handoff";
        handoffReceiptId: string;
        quiescenceReceiptId: string;
      }
  );
type ReadActivationEvidence = (
  tx: DbTransaction,
  scope: RevisionScope,
) => PlacementActivationEvidence | null;

export function setOwnerMode(
  db: DbConnection,
  args: RevisionScope & {
    mode: PlacementOwnerRow["mode"];
    handoffReceiptId: string | null;
  },
  readActivationEvidence?: ReadActivationEvidence,
) {
  return db.transaction(
    (tx) => {
      const owner = readPlacementOwner(tx, args.providerId);
      if (
        !owner ||
        owner.ownerPluginId !== args.ownerPluginId ||
        owner.revision !== args.expectedRevision
      )
        return { kind: "stale" as const };
      if (args.mode === "managed") {
        if (!owner.available) return { kind: "owner_unavailable" as const };
        const { providerId, ownerPluginId, expectedRevision } = args;
        const evidence = readActivationEvidence?.(tx, {
          providerId,
          ownerPluginId,
          expectedRevision,
        });
        if (
          !evidence ||
          evidence.providerId !== providerId ||
          evidence.ownerPluginId !== ownerPluginId ||
          evidence.ownerRevision !== expectedRevision
        )
          return { kind: "handoff_required" as const };
        if (evidence.kind === "verified_empty") {
          if (
            args.handoffReceiptId !== null ||
            "handoffReceiptId" in evidence ||
            "quiescenceReceiptId" in evidence
          )
            return { kind: "handoff_required" as const };
        } else if (
          evidence.kind !== "committed_handoff" ||
          !evidence.handoffReceiptId?.trim() ||
          !evidence.quiescenceReceiptId?.trim() ||
          evidence.handoffReceiptId !== args.handoffReceiptId
        )
          return { kind: "handoff_required" as const };
      } else if (args.mode !== "disabled" || args.handoffReceiptId !== null)
        return { kind: "handoff_required" as const };
      if (owner.mode === args.mode)
        return { kind: "unchanged" as const, owner };
      const updated = tx
        .update(owners)
        .set({ mode: args.mode, revision: owner.revision + 1 })
        .where(
          and(
            eq(owners.providerId, owner.providerId),
            eq(owners.revision, owner.revision),
          ),
        )
        .returning()
        .get();
      return { kind: "updated" as const, owner: updated };
    },
    { behavior: "immediate" },
  );
}
