import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  sha256Digest,
  canonicalJsonBytes,
  clientSubmissionIdSchema,
  isStandaloneBuiltinCompactCommand,
  isStandaloneBuiltinClearCommand,
  promptInputSchema,
  placementAuthoritySchema,
  type PlacementPayload,
  type PlacementAuthority,
  placementQuestionProtocolSchema,
  type PlacementQuestionProtocol,
  type placementStepKinds,
} from "@bb/domain";
import type { DbQueryConnection, DbTransaction } from "../connection.js";
import {
  placementActionIdentities as identities,
  placementSteps as steps,
  placementAttempts as attempts,
  placementEffects as effects,
  queuedThreadMessages,
} from "../schema.js";

export function actionIdentity(
  request: PlacementPayload,
  principal: string,
  authority: PlacementAuthority,
  protocol?: PlacementQuestionProtocol,
) {
  const auth = placementAuthoritySchema.parse(authority);
  if (auth.principal !== principal)
    throw new Error("Placement principal mismatch");
  const raw = request.intent.kind === "retry" ? null : request.intent.request;
  const body =
    raw && typeof raw === "object" && !Array.isArray(raw) ? raw : null;
  const input = Array.isArray(body?.input)
    ? body.input.map((i) => promptInputSchema.parse(i))
    : [];
  if (
    protocol &&
    (request.intent.kind !== "continuation" ||
      body?.clientSubmissionId !== undefined ||
      body?.compactFirst)
  )
    throw new Error("Invalid native question placement");
  const kinds: (typeof placementStepKinds)[number][] = protocol
    ? ["answer"]
    : request.intent.kind === "retry"
      ? ["retry"]
      : body?.compactFirst === true
        ? ["compact", "input"]
        : isStandaloneBuiltinCompactCommand(input)
          ? ["compact"]
          : isStandaloneBuiltinClearCommand(input)
            ? ["clear"]
            : ["input"];
  return {
    protocol: protocol
      ? canonicalJsonBytes(placementQuestionProtocolSchema.parse(protocol))
      : null,
    authority: canonicalJsonBytes(auth),
    uuid:
      body?.clientSubmissionId === undefined
        ? null
        : clientSubmissionIdSchema.parse(body.clientSubmissionId),
    kinds,
  };
}
export function insertAction(
  tx: DbTransaction,
  op: string,
  identity: ReturnType<typeof actionIdentity>,
) {
  tx.insert(identities)
    .values({
      op,
      authority: identity.authority,
      protocol: identity.protocol,
      submissionUuid: identity.protocol
        ? null
        : (identity.uuid ?? randomUUID()),
    })
    .run();
  identity.kinds.forEach((kind, step) =>
    tx.insert(steps).values({ op, step, kind }).run(),
  );
}
export function readPlacementActionReceipt(
  db: DbQueryConnection,
  operationId: string,
) {
  const identity = db
    .select()
    .from(identities)
    .where(eq(identities.op, operationId))
    .get();
  if (!identity) return null;
  const ordered = db
    .select()
    .from(steps)
    .where(eq(steps.op, operationId))
    .orderBy(asc(steps.step))
    .all()
    .map((step) => {
      const history = db
        .select({ attempt: attempts, state: effects.state })
        .from(attempts)
        .leftJoin(effects, eq(attempts.request, effects.request))
        .where(and(eq(attempts.op, operationId), eq(attempts.step, step.step)))
        .orderBy(asc(attempts.attempt))
        .all();
      return { ...step, history, latest: history.at(-1) ?? null };
    });
  return {
    operationId,
    protocol: identity.protocol
      ? placementQuestionProtocolSchema.parse(JSON.parse(identity.protocol))
      : null,
    submissionUuid: identity.submissionUuid,
    authority: placementAuthoritySchema.parse(JSON.parse(identity.authority)),
    steps: ordered,
    currentStep:
      ordered.find((s) => s.latest?.state !== "succeeded")?.step ?? null,
  };
}
export function readPlacementQueueAttempts(
  db: DbQueryConnection,
  queueId: string,
) {
  return db
    .select()
    .from(attempts)
    .where(eq(attempts.queueId, queueId))
    .orderBy(asc(attempts.queueOrdinal))
    .all();
}

export function queueMemberDigest(
  row: typeof queuedThreadMessages.$inferSelect,
) {
  const {
    id,
    threadId,
    placementOperationId,
    content,
    model,
    reasoningLevel,
    permissionMode,
    serviceTier,
    senderThreadId,
    origin,
    originPluginId,
    requestedByInitiator,
    requestedByThreadId,
    serviceTurn,
    payloadKind,
    retryOfTurnRequestId,
    retryAttempt,
    retryReason,
    deliveryMode,
    questionId,
    questionRevision,
    systemNotice,
  } = row;
  return sha256Digest(
    canonicalJsonBytes({
      id,
      threadId,
      placementOperationId,
      content,
      model,
      reasoningLevel,
      permissionMode,
      serviceTier,
      senderThreadId,
      origin,
      originPluginId,
      requestedByInitiator,
      requestedByThreadId,
      serviceTurn,
      payloadKind,
      retryOfTurnRequestId,
      retryAttempt,
      retryReason,
      deliveryMode,
      questionId,
      questionRevision,
      systemNotice,
    }),
  );
}
