import { and, eq, sql } from "drizzle-orm";
import { questionResolutionAttributionSchema, type QuestionResolutionActor, type QuestionResolutionAttribution } from "@bb/domain";
import type { DbQueryConnection } from "../connection.js";
import { questionResolutionEvents } from "../schema.js";

export function questionResolutionPrincipal(actor: QuestionResolutionActor): string {
  return actor.kind === "agent" ? `agent:${actor.threadId}` : "local-unverified";
}

export function getQuestionResolutionOperation(db: DbQueryConnection, principal: string, operationId: string) {
  const row = db.select().from(questionResolutionEvents).where(and(eq(questionResolutionEvents.principal, principal), eq(questionResolutionEvents.operationId, operationId))).get();
  return row ? { request: row.request, attribution: questionResolutionAttributionSchema.parse(JSON.parse(row.attribution)) } : null;
}

export function listQuestionResolutionHistory(db: DbQueryConnection, targetKind: "qst" | "pint", targetId: string): QuestionResolutionAttribution[] {
  return db.select().from(questionResolutionEvents).where(and(eq(questionResolutionEvents.targetKind, targetKind), eq(questionResolutionEvents.targetId, targetId))).orderBy(sql`rowid`).all().map(row => questionResolutionAttributionSchema.parse(JSON.parse(row.attribution)));
}

export function appendQuestionResolutionEvent(db: DbQueryConnection, args: { attribution: QuestionResolutionAttribution; request: string; initial: boolean }): void {
  const attribution = questionResolutionAttributionSchema.parse(args.attribution);
  db.insert(questionResolutionEvents).values({
    id: attribution.id,
    targetKind: attribution.targetKind,
    targetId: attribution.targetId,
    threadId: attribution.threadId,
    revision: attribution.revision,
    initial: args.initial,
    principal: questionResolutionPrincipal(attribution.actor),
    operationId: attribution.operationId,
    request: args.request,
    attribution: JSON.stringify(attribution),
    deliveryId: attribution.deliveryId,
  }).run();
}

export function getQuestionResolutionDelivery(db: DbQueryConnection, deliveryId: string) {
  const row = db.select().from(questionResolutionEvents).where(eq(questionResolutionEvents.deliveryId, deliveryId)).get();
  return row ? { attribution: questionResolutionAttributionSchema.parse(JSON.parse(row.attribution)), submittedAt: row.submittedAt } : null;
}

export function markQuestionResolutionSubmitted(db: DbQueryConnection, deliveryId: string): void {
  db.update(questionResolutionEvents).set({ submittedAt: Date.now() }).where(and(eq(questionResolutionEvents.deliveryId, deliveryId), sql`${questionResolutionEvents.submittedAt} IS NULL`)).run();
}
