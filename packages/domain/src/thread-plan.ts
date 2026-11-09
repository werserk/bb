export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "needs_input";
export type PlanOwnAttention = "none" | "needs_input" | "failed";
export interface PlanStepView {
  id: string;
  text: string;
  status: PlanStepStatus;
  note?: string;
  actor?: string;
  interactionIds: readonly string[];
}
export interface PlanSnapshotView {
  sourceSeq: number;
  updatedAt: number;
  planId?: string;
  staleSince?: number;
  items: readonly PlanStepView[];
}
export interface ThreadPlanView {
  threadId: string;
  revision: number;
  current: PlanSnapshotView | null;
  previousPlans: readonly PlanSnapshotView[];
  historyTruncated: boolean;
  ownAttention: PlanOwnAttention;
  attentionInteractionIds: readonly string[];
  unboundInteractionIds: readonly string[];
}
export interface ThreadPlansReadResponse {
  plans: Record<string, ThreadPlanView>;
  errors: Record<string, string>;
}
