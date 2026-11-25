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
  },
) {
  return db.transaction(
    (tx) => {
      const op = readPlacementOperationRecord(tx, args.operationId);
      if (
        !op ||
        op.cancelRequested ||
        op.revision !== args.expectedRevision ||
        op.queuedMessageId !== null ||
        op.fence !== null ||
        !["accepted", "pending"].includes(op.phase) ||
        (args.outcome === "refuse" && op.kind === "retry")
      )
        return { kind: "stale" as const };
      const phase = args.outcome === "refuse" ? "refused" : "pending";
      if (op.phase === phase && op.reason === args.reason)
        return {
          kind: "unchanged" as const,
          operation: placementOperationProjection(op),
        };
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
