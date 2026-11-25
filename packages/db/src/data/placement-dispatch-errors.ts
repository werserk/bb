export class PlacementDispatchConflictError extends Error {
  readonly code = "placement_dispatch_conflict" as const;
  constructor(reason: string) {
    super("Placement dispatch conflict: " + reason);
    this.name = "PlacementDispatchConflictError";
  }
}
export class PlacementGroupFairnessError extends PlacementDispatchConflictError {
  constructor(
    readonly retainedHead: { id: string; claimToken: string } | null,
    readonly blockedMemberOperationId: string,
    readonly earlierOperationId: string,
  ) {
    super("earlier compatible operation is waiting");
    this.name = "PlacementGroupFairnessError";
  }
}
