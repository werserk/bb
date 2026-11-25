import { readPlacementOwner } from "./placement-workers.js";
import { eq } from "drizzle-orm";
import type { PlacementReason } from "@bb/domain";
import type { DbConnection } from "../connection.js";
import { placementOperations as operations } from "../schema.js";
import {
  placementOperationProjection,
  readPlacementOperationRecord,
} from "./placement-operations.js";

export function recordPlacementWait(
  db: DbConnection,
  args: {
    operationId: string;
    expectedRevision: number;
    outcome: "wait" | "refuse";
    reason: PlacementReason;
    source: {
      kind: "policy" | "owner_unavailable";
      providerId: string;
      ownerPluginId: string;
      ownerRevision: number;
    };
  },
) {
  return db.transaction(
    (tx) => {
      const op = readPlacementOperationRecord(tx, args.operationId);
      if (
        !op ||
        op.cancelRequested ||
        op.reservationId !== null ||
        op.clientTurnRequestId !== null ||
        op.queuedMessageId !== null ||
        op.fence !== null ||
        (args.outcome === "refuse" && op.kind === "retry")
      )
        return { kind: "stale" as const };
      const { source } = args;
      const owner = readPlacementOwner(tx, op.providerId);
      if (
        source.providerId !== op.providerId ||
        source.ownerPluginId !== op.ownerPluginId ||
        !owner ||
        owner.ownerPluginId !== source.ownerPluginId ||
        owner.revision !== source.ownerRevision
      )
        return { kind: "stale" as const };
      const available = owner.available && owner.mode === "managed";
      if (
        source.kind === "policy"
          ? !available
          : source.kind !== "owner_unavailable" ||
            available ||
            args.outcome !== "wait" ||
            args.reason !== "owner_unavailable"
      )
        return { kind: "stale" as const };
      const phase = args.outcome === "refuse" ? "refused" : "pending";
      if (
        (op.revision === args.expectedRevision ||
          op.revision === args.expectedRevision + 1) &&
        op.phase === phase &&
        op.reason === args.reason
      )
        return {
          kind: "unchanged" as const,
          operation: placementOperationProjection(op),
        };
      if (
        op.revision !== args.expectedRevision ||
        !["accepted", "pending"].includes(op.phase)
      )
        return { kind: "stale" as const };
      const row = tx
        .update(operations)
        .set({
          phase,
          reason: args.reason,
          revision: op.revision + 1,
          updatedAt: Date.now(),
        })
        .where(eq(operations.id, op.id))
        .returning()
        .get();
      return {
        kind: "recorded" as const,
        operation: placementOperationProjection(row),
      };
    },
    { behavior: "immediate" },
  );
}
