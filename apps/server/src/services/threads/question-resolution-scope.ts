import {
  events,
  getThread,
  hasStoredTurnStarted,
  listStoredTurnCompletedKeys,
  type DbConnection,
} from "@bb/db";
import { LOCAL_QUESTION_ACTOR, type QuestionResolutionActor } from "@bb/domain";
import { and, eq, gt, inArray } from "drizzle-orm";
import { ApiError } from "../../errors.js";
import type {
  ExperimentalQuestionResolutionScopeContext,
  ExperimentalQuestionResolutionScopeDecision,
  ExperimentalQuestionResolutionScopePolicy,
} from "@get-bb/plugin-sdk";

export interface QuestionResolutionInvocation {
  threadId: string;
  turnId: string;
  providerThreadId: string;
  signal?: AbortSignal;
}
export type QuestionResolutionScopeContext =
  ExperimentalQuestionResolutionScopeContext;
export type QuestionResolutionScopeDecision =
  ExperimentalQuestionResolutionScopeDecision;
export type QuestionResolutionScopePolicy =
  ExperimentalQuestionResolutionScopePolicy;

let policy: {
  pluginId: string;
  handler: QuestionResolutionScopePolicy;
} | null = null;

export function assertQuestionResolutionScopeAvailable(pluginId: string): void {
  if (policy && policy.pluginId !== pluginId)
    throw new Error("Question resolution scope is already registered");
}

export function registerQuestionResolutionScope(
  pluginId: string,
  handler: QuestionResolutionScopePolicy,
): () => void {
  if (policy)
    throw new Error("Question resolution scope is already registered");
  const registration = { pluginId, handler };
  policy = registration;
  return () => {
    if (policy === registration) policy = null;
  };
}

function refuse(message: string): never {
  throw new ApiError(403, "question_resolution_refused", message, false);
}

function requireCaller(
  db: DbConnection,
  invocation: QuestionResolutionInvocation,
) {
  const caller = getThread(db, invocation.threadId);
  const started = db
    .select({ sequence: events.sequence })
    .from(events)
    .where(
      and(
        eq(events.threadId, invocation.threadId),
        eq(events.turnId, invocation.turnId),
        eq(events.providerThreadId, invocation.providerThreadId),
        eq(events.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (
    invocation.signal?.aborted ||
    !caller ||
    caller.deletedAt !== null ||
    caller.archivedAt !== null ||
    !started ||
    !hasStoredTurnStarted(db, invocation) ||
    listStoredTurnCompletedKeys(db, { keys: [invocation] }).length > 0
  )
    refuse("Question resolution requires a live native caller turn");
  if (
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, invocation.threadId),
          gt(events.sequence, started.sequence),
          inArray(events.type, [
            "system/thread/interrupted",
            "thread/context/cleared",
          ]),
        ),
      )
      .limit(1)
      .get()
  )
    refuse("Question resolution caller context was interrupted or cleared");
  return caller;
}

export async function withQuestionResolutionActor<T>(
  db: DbConnection,
  targetThreadId: string,
  invocation: QuestionResolutionInvocation | null,
  commit: (actor: QuestionResolutionActor) => T,
): Promise<T> {
  if (!invocation) return commit(LOCAL_QUESTION_ACTOR);
  const caller = requireCaller(db, invocation);
  const target = getThread(db, targetThreadId);
  if (
    !target ||
    target.deletedAt !== null ||
    caller.projectId !== target.projectId
  )
    refuse("Question target is unavailable or belongs to another project");
  const registration = policy;
  const commitDecision = (decision: QuestionResolutionScopeDecision) => {
    const fresh = requireCaller(db, invocation);
    const freshTarget = getThread(db, targetThreadId);
    const chain = decision.hostChain ?? [];
    if (
      decision.relationship === "ancestor" &&
      (!chain.some((hop) => hop.id === caller.id) ||
        !chain.some((hop) => hop.id === targetThreadId))
    )
      refuse("Managed question ancestry snapshot is missing");
    if (decision.relationship === "ancestor") {
      const byId = new Map(chain.map((hop) => [hop.id, hop]));
      const seen = new Set<string>();
      let id: string | null = targetThreadId;
      while (id !== caller.id) {
        if (!id || seen.has(id))
          refuse("Question target is not a current host descendant");
        seen.add(id);
        const hop = byId.get(id);
        if (!hop || hop.archived)
          refuse("Question host ancestry is unavailable");
        id = hop.parentThreadId;
      }
    }
    if (
      !chain.every((hop) => {
        const row = getThread(db, hop.id);
        return (
          row &&
          row.deletedAt === null &&
          row.projectId === hop.projectId &&
          row.projectId === fresh.projectId &&
          row.parentThreadId === hop.parentThreadId &&
          (row.archivedAt !== null) === hop.archived
        );
      })
    )
      refuse("Question host ancestry changed before acceptance");
    if (
      !freshTarget ||
      freshTarget.deletedAt !== null ||
      fresh.projectId !== caller.projectId ||
      freshTarget.projectId !== fresh.projectId ||
      !decision.isCurrent()
    )
      refuse("Question authority changed before acceptance");
    if (
      decision.relationship === "refuse" ||
      (decision.relationship === "self" && targetThreadId !== fresh.id)
    )
      refuse(
        "Only own or current managed descendant questions may be resolved",
      );
    return commit({
      kind: "agent",
      verification: "runtime",
      threadId: fresh.id,
      projectId: fresh.projectId,
      name: fresh.title ?? fresh.id,
      role: decision.role,
    });
  };
  if (!registration) {
    if (targetThreadId !== caller.id)
      refuse(
        "Managed question scope is unavailable; only self resolution is supported",
      );
    return commitDecision({
      relationship: "self",
      role: null,
      isCurrent: () => policy === null,
    });
  }
  let accepted: { result: T } | undefined;
  let open = true;
  try {
    await registration.handler(
      {
        caller: { threadId: caller.id, projectId: caller.projectId },
        target: { threadId: target.id, projectId: target.projectId },
      },
      (decision) => {
        if (!open || accepted || policy !== registration)
          refuse("Question scope callback is no longer current");
        accepted = { result: commitDecision(decision) };
      },
    );
  } finally {
    open = false;
  }
  if (!accepted) refuse("Managed question scope did not authorize acceptance");
  return accepted.result;
}
