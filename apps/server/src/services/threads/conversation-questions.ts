import { createHash } from "node:crypto";
import {
  createConversationQuestion,
  createConversationQuestionId,
  createQueuedThreadMessageInTransaction,
  events,
  getConversationQuestion,
  getQueuedThreadMessage,
  isThreadQueueAutoSendPaused,
  getConversationQuestionBySource,
  projects,
  getThread,
  listConversationQuestions,
  listOpenConversationQuestionPage,
  listOpenConversationQuestionIdentities,
  listStoredTurnCompletedKeys,
  setConversationQuestionTerminal,
  withdrawConversationQuestion,
  type ConversationQuestionRow,
  type DbQueryConnection,
  appendQuestionResolutionEvent,
  listQuestionResolutionHistory,
  getQuestionResolutionOperation,
  questionResolutionPrincipal,
  getQuestionResolutionDelivery,
} from "@bb/db";
import {
  conversationQuestionMarker,
  conversationQuestionIdSchema,
  parseConversationQuestionPublication,
  conversationQuestionSchema,
  normalizeConversationQuestionAnswers,
  queuedMessageWaitingOnSchema,
  turnScope,
  type ConversationQuestion,
  type ConversationQuestionsOpenPage,
  type ConversationQuestionPublication,
  type ConversationQuestionStatus,
  type PendingInteractionUserAnswer,
  serializeQuestionResolutionNotice,
  type QuestionResolutionActor,
  type QuestionResolutionAttribution,
} from "@bb/domain";
import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { prepareQuestionMaterials } from "./question-materials.js";
import { buildExecutionOptions } from "./thread-commands.js";
import { appendThreadEventInTransaction } from "./thread-events.js";
import { requestQueuedMessageDispatch } from "./queued-message-dispatch.js";
import { ensureThreadQueueIsWritable } from "./thread-send.js";
import {
  withQuestionResolutionActor,
  type QuestionResolutionInvocation,
} from "./question-resolution-scope.js";

import { requirePublicThread } from "../lib/entity-lookup.js";

const sourceSchema = z.strictObject({
  turnId: z.string().min(1),
  providerThreadId: z.string().min(1),
  callId: z.string().min(1),
});
export type ConversationQuestionSource = z.infer<typeof sourceSchema>;
type QuestionRef = { threadId: string; questionId: string };
type VersionedQuestionRef = QuestionRef & { revision: number };
type AnswerArgs = VersionedQuestionRef & {
  answers: Record<string, PendingInteractionUserAnswer>;
};
export interface QuestionResolutionCall {
  operationId: string;
  reason: string;
  invocation: QuestionResolutionInvocation | null;
}

function conflict(message: string, current?: ConversationQuestion): never {
  throw new ApiError(409, "conversation_question_conflict", message, {
    retryable: false,
    ...(current ? { details: { current } } : {}),
  });
}
function publicThread(
  db: DbQueryConnection,
  threadId: string,
  requireLive = false,
) {
  const thread = getThread(db, threadId);
  const project = thread
    ? db
        .select({ deletedAt: projects.deletedAt })
        .from(projects)
        .where(eq(projects.id, thread.projectId))
        .get()
    : null;
  if (
    !thread ||
    thread.deletedAt !== null ||
    !project ||
    project.deletedAt !== null
  )
    throw new ApiError(404, "thread_not_found", "Thread not found");
  if (requireLive && thread.archivedAt !== null) conflict("Thread is archived");
  return thread;
}
function questionDelivery(
  db: DbQueryConnection,
  row: ConversationQuestionRow,
): ConversationQuestion["delivery"] {
  if (row.dispatchedAt !== null) return { kind: "submitted", reason: null };
  if (row.queuedMessageId === null) return { kind: "none", reason: null };
  const queued = getQueuedThreadMessage(db, row.queuedMessageId);
  if (!queued)
    return {
      kind: "removed",
      reason: "Response is no longer queued and has no submission receipt",
    };
  if (row.status !== "answered")
    return { kind: "held", reason: `Question ${row.status}` };
  if (queued.failureReason !== null)
    return { kind: "held", reason: queued.failureReason };
  const thread = getThread(db, row.threadId);
  if (!thread || thread.deletedAt !== null)
    return { kind: "held", reason: "Thread deleted" };
  if (thread.archivedAt !== null)
    return { kind: "held", reason: "Thread archived" };
  if (isThreadQueueAutoSendPaused(db, row.threadId))
    return { kind: "held", reason: "Queue paused after manual stop" };
  if (queued.waitingOn !== null) {
    const wait = queuedMessageWaitingOnSchema.parse(
      JSON.parse(queued.waitingOn),
    );
    return {
      kind: "held",
      reason:
        wait.kind === "plugin"
          ? wait.reason
          : wait.kind === "host-offline"
            ? `Host ${wait.hostName} is offline`
            : `Waiting for ${wait.kind.replaceAll("-", " ")}`,
    };
  }
  return { kind: "queued", reason: null };
}
function resolutionDeliveryForRow(
  db: DbQueryConnection,
  row: ConversationQuestionRow,
  resolution: QuestionResolutionAttribution,
): ConversationQuestion["delivery"] {
  const receipt = resolution.deliveryId
    ? getQuestionResolutionDelivery(db, resolution.deliveryId)
    : null;
  return questionDelivery(db, {
    ...row,
    status:
      resolution.action === "withdraw" && row.status === "withdrawn"
        ? "answered"
        : row.status,
    queuedMessageId: resolution.deliveryId,
    dispatchedAt: receipt?.submittedAt ?? null,
  });
}

export function readQuestionResolutionDelivery(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  ref: QuestionRef,
  resolution: QuestionResolutionAttribution,
): ConversationQuestion["delivery"] {
  return resolutionDeliveryForRow(
    deps.db,
    questionRow(deps.db, ref),
    resolution,
  );
}

function rowToQuestion(
  db: DbQueryConnection,
  row: ConversationQuestionRow,
): ConversationQuestion {
  const resolutionHistory = listQuestionResolutionHistory(db, "qst", row.id);
  const latest = resolutionHistory.at(-1) ?? null;
  const resolutionDelivery = latest?.deliveryId
    ? resolutionDeliveryForRow(db, row, latest)
    : null;
  return conversationQuestionSchema.parse({
    ...row,
    delivery: questionDelivery(db, row),
    publication: JSON.parse(row.publication),
    materialManifest: JSON.parse(row.materialManifest),
    response: row.response === null ? null : JSON.parse(row.response),
    resolutionHistory,
    resolutionDelivery,
    resolutionAttribution: resolutionHistory.at(-1) ?? null,
  });
}
function questionRow(
  db: DbQueryConnection,
  args: QuestionRef,
): ConversationQuestionRow {
  const row = getConversationQuestion(db, args);
  if (!row)
    throw new ApiError(
      404,
      "conversation_question_not_found",
      "Question not found",
    );
  return row;
}
function requireRevision(question: ConversationQuestion, revision: number) {
  if (question.revision !== revision)
    conflict("Question revision is stale", question);
}
function requireSource(
  db: DbQueryConnection,
  threadId: string,
  source: ConversationQuestionSource,
  requireOpen: boolean,
) {
  const started = db
    .select({
      providerThreadId: events.providerThreadId,
      sequence: events.sequence,
    })
    .from(events)
    .where(
      and(
        eq(events.threadId, threadId),
        eq(events.turnId, source.turnId),
        eq(events.type, "turn/started"),
      ),
    )
    .limit(1)
    .get();
  if (!started || started.providerThreadId !== source.providerThreadId)
    conflict(
      "Question source turn is missing or has different provider provenance",
    );
  if (
    requireOpen &&
    listStoredTurnCompletedKeys(db, {
      keys: [{ threadId, turnId: source.turnId }],
    }).length > 0
  )
    conflict("Question source turn is completed");
  if (
    requireOpen &&
    db
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.threadId, threadId),
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
    conflict("Question source context was interrupted or cleared");
}
function existingPublication(
  db: DbQueryConnection,
  args: { threadId: string; source: ConversationQuestionSource },
  publication: string,
) {
  const existing = getConversationQuestionBySource(db, {
    threadId: args.threadId,
    sourceTurnId: args.source.turnId,
    sourceCallId: args.source.callId,
  });
  if (!existing) return null;
  if (existing.publication !== publication)
    conflict("Conflicting question publication retry");
  return rowToQuestion(db, existing);
}

export function readConversationQuestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QuestionRef,
): ConversationQuestion {
  publicThread(deps.db, args.threadId);
  return rowToQuestion(deps.db, questionRow(deps.db, args));
}
export function listConversationQuestionsForThread(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    threadId: string;
    statuses?: readonly ConversationQuestionStatus[];
    limit?: number;
  },
): ConversationQuestion[] {
  publicThread(deps.db, args.threadId);
  return listConversationQuestions(deps.db, args).map((row) =>
    rowToQuestion(deps.db, row),
  );
}
export async function publishConversationQuestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    threadId: string;
    source: ConversationQuestionSource;
    publication: ConversationQuestionPublication;
  },
): Promise<ConversationQuestion> {
  const source = sourceSchema.safeParse(args.source);
  if (!source.success)
    throw new ApiError(
      400,
      "invalid_question_source",
      "Question publication requires exact source turn, provider thread and call IDs",
    );
  const publication = parseConversationQuestionPublication(args.publication);
  const serialized = JSON.stringify(publication);
  const thread = publicThread(deps.db, args.threadId, true);
  requireSource(deps.db, args.threadId, source.data, false);
  const previous = existingPublication(deps.db, args, serialized);
  if (previous) return previous;
  if (thread.status === "stopping")
    conflict("Cannot publish a question while thread is stopping");
  requireSource(deps.db, args.threadId, source.data, true);
  const id = createConversationQuestionId();
  const materialManifest = await prepareQuestionMaterials(deps, {
    threadId: args.threadId,
    questionId: id,
    materials: publication.materials,
  });
  const result = deps.db.transaction(
    (tx) => {
      const thread = publicThread(tx, args.threadId, true);
      requireSource(tx, args.threadId, source.data, false);
      const previous = existingPublication(tx, args, serialized);
      if (previous) return { question: previous, sequence: null };
      if (thread.status === "stopping")
        conflict("Cannot publish a question while thread is stopping");
      requireSource(tx, args.threadId, source.data, true);
      const row = createConversationQuestion(tx, {
        id,
        threadId: thread.id,
        sourceTurnId: source.data.turnId,
        sourceCallId: source.data.callId,
        publication: serialized,
        materialManifest: JSON.stringify(materialManifest),
      });
      if (!row) conflict("Conflicting question publication");
      const sequence = appendThreadEventInTransaction(tx, {
        threadId: thread.id,
        environmentId: thread.environmentId,
        providerThreadId: source.data.providerThreadId,
        type: "item/completed",
        scope: turnScope(source.data.turnId),
        data: {
          providerThreadId: source.data.providerThreadId,
          item: {
            type: "agentMessage",
            id: `question:${id}`,
            text: conversationQuestionMarker(id),
          },
        },
      });
      return { question: rowToQuestion(tx, row), sequence };
    },
    { behavior: "immediate" },
  );
  if (result.sequence !== null)
    deps.hub.notifyThread(
      args.threadId,
      ["events-appended", "interactions-changed"],
      {
        timelineSequence: result.sequence,
        eventTypes: ["item/completed"],
        projectId: thread.projectId,
      },
    );
  return result.question;
}

function responseReceipt(
  question: ConversationQuestion,
  args: AnswerArgs,
  normalized: Record<string, PendingInteractionUserAnswer>,
  actor: QuestionResolutionActor,
  call: QuestionResolutionCall | undefined,
) {
  requireRevision(question, args.revision);
  if (question.status === "answered") {
    if (
      call ||
      actor.kind !== "local-unverified" ||
      question.resolutionHistory.some(
        (event) => event.actor.kind !== "local-unverified",
      )
    )
      conflict(
        "Question is already answered by another resolution operation",
        question,
      );
    if (JSON.stringify(question.response) !== JSON.stringify(normalized))
      conflict(
        "Question is already answered with a different response",
        question,
      );
    return question;
  }
  if (question.status !== "open")
    conflict(`Question is ${question.status}`, question);
  return null;
}
export async function answerConversationQuestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: AnswerArgs,
  call?: QuestionResolutionCall,
): Promise<ConversationQuestion> {
  // Target-derived conflicts and validation are reads subject to the same scope
  // as acceptance. Reauthorize below after asynchronous execution preparation.
  const { question, normalized } = await withQuestionResolutionActor(
    deps.db,
    args.threadId,
    call?.invocation ?? null,
    () => {
      publicThread(deps.db, args.threadId, true);
      const question = rowToQuestion(deps.db, questionRow(deps.db, args));
      requireRevision(question, args.revision);
      try {
        return {
          question,
          normalized: normalizeConversationQuestionAnswers(
            question.publication.questions,
            args.answers,
          ),
        };
      } catch (error) {
        throw new ApiError(
          400,
          "invalid_question_answer",
          error instanceof Error ? error.message : "Invalid question answer",
        );
      }
    },
  );
  const execution =
    question.status === "open"
      ? await buildExecutionOptions(deps, {}, { threadId: args.threadId })
      : null;
  const accepted = await withQuestionResolutionActor(
    deps.db,
    args.threadId,
    call?.invocation ?? null,
    (actor) =>
      deps.db.transaction(
        (tx) => {
          const thread = publicThread(tx, args.threadId, true);
          ensureThreadQueueIsWritable(thread);
          const current = rowToQuestion(tx, questionRow(tx, args));
          const operationId =
            call?.operationId ??
            `card:${current.id}:${current.revision}:answer`;
          const reason = call?.reason ?? "Answered in question card";
          const request = JSON.stringify({
            threadId: args.threadId,
            questionId: args.questionId,
            revision: args.revision,
            action: "answer",
            reason,
            answers: normalized,
          });
          requireRevision(current, args.revision);
          const previous = getQuestionResolutionOperation(
            tx,
            questionResolutionPrincipal(actor),
            operationId,
          );
          if (previous) {
            if (!call && current.status !== "answered")
              conflict(`Question is ${current.status}`, current);
            if (previous.request !== request)
              conflict(
                call
                  ? "Question resolution operationId was reused with different content"
                  : "Question is already answered with a different response",
                current,
              );
            return { question: current, created: false };
          }
          const receipt = responseReceipt(
            current,
            args,
            normalized,
            actor,
            call,
          );
          if (receipt) return { question: receipt, created: false };
          if (!execution)
            conflict("Question changed before answer preparation", current);
          const attribution = {
            id: `qres_${randomUUID()}`,
            targetKind: "qst" as const,
            targetId: current.id,
            threadId: current.threadId,
            revision: current.revision,
            operationId,
            action: "answer" as const,
            actor,
            reason,
            acceptedAt: Date.now(),
            answers: normalized,
          };
          const content = serializeQuestionResolutionNotice({
            version: 1,
            questionId: current.id,
            revision: current.revision,
            publication: current.publication,
            materialManifest: current.materialManifest,
            resolution: attribution,
          });
          const queued = createQueuedThreadMessageInTransaction(tx, {
            threadId: thread.id,
            content: [{ type: "text", text: content, mentions: [] }],
            senderThreadId: actor.kind === "agent" ? actor.threadId : null,
            model: execution.model,
            reasoningLevel: execution.reasoningLevel,
            permissionMode: execution.permissionMode,
            serviceTier: execution.serviceTier,
            waitingOn:
              thread.status === "stopping"
                ? { kind: "stopping" }
                : { kind: "thread-busy" },
            sendAt: null,
            payload: {
              kind: "questionResponse",
              questionId: current.id,
              revision: current.revision,
            },
            systemNotice: null,
          });
          const row = setConversationQuestionTerminal(tx, {
            ...args,
            status: "answered",
            response: JSON.stringify(normalized),
            queuedMessageId: queued.id,
          });
          if (!row)
            conflict("Question changed before answer acceptance", current);
          appendQuestionResolutionEvent(tx, {
            initial: true,
            request,
            attribution: { ...attribution, deliveryId: queued.id },
          });
          return { question: rowToQuestion(tx, row), created: true };
        },
        { behavior: "immediate" },
      ),
  );
  if (accepted.created) {
    deps.hub.notifyThread(
      args.threadId,
      ["interactions-changed", "queue-changed"],
      { projectId: publicThread(deps.db, args.threadId, true).projectId },
    );
    requestQueuedMessageDispatch(deps, {
      kind: "thread-ready",
      threadId: args.threadId,
    });
  }
  return accepted.question;
}
export async function closeConversationQuestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: VersionedQuestionRef & { action: "dismiss" | "withdraw" },
  call?: QuestionResolutionCall,
): Promise<ConversationQuestion> {
  if (call && args.action !== "withdraw")
    conflict("Agent dismissal is unsupported");
  const before = await withQuestionResolutionActor(
    deps.db,
    args.threadId,
    call?.invocation ?? null,
    () => {
      publicThread(deps.db, args.threadId, true);
      const question = rowToQuestion(deps.db, questionRow(deps.db, args));
      requireRevision(question, args.revision);
      return question;
    },
  );
  const execution =
    args.action === "withdraw" &&
    (before.status === "open" || before.status === "answered")
      ? await buildExecutionOptions(deps, {}, { threadId: args.threadId })
      : null;
  const accepted = await withQuestionResolutionActor(
    deps.db,
    args.threadId,
    call?.invocation ?? null,
    (actor) =>
      deps.db.transaction(
        (tx) => {
          const thread = publicThread(tx, args.threadId, true);
          const current = rowToQuestion(tx, questionRow(tx, args));
          requireRevision(current, args.revision);
          const operationId =
            call?.operationId ??
            `card:${current.id}:${current.revision}:${args.action}`;
          const reason =
            call?.reason ??
            (args.action === "dismiss"
              ? "Dismissed in question card"
              : "Withdrawn in question card");
          const request = JSON.stringify({ ...args, reason });
          const previous = getQuestionResolutionOperation(
            tx,
            questionResolutionPrincipal(actor),
            operationId,
          );
          if (previous) {
            if (previous.request !== request)
              conflict(
                "Question resolution operationId was reused with different content",
                current,
              );
            return { question: current, created: false };
          }
          const status = args.action === "dismiss" ? "dismissed" : "withdrawn";
          if (!call && current.status === status)
            return { question: current, created: false };
          if (call?.invocation && current.status !== "open")
            conflict(`Question is ${current.status}`, current);
          const row =
            args.action === "withdraw"
              ? withdrawConversationQuestion(tx, args)
              : setConversationQuestionTerminal(tx, {
                  ...args,
                  status: "dismissed",
                  response: null,
                  queuedMessageId: null,
                });
          if (!row) conflict(`Question is ${current.status}`, current);
          const attribution = {
            id: `qres_${randomUUID()}`,
            targetKind: "qst" as const,
            targetId: current.id,
            threadId: current.threadId,
            revision: current.revision,
            operationId,
            action: args.action,
            actor,
            reason,
            acceptedAt: Date.now(),
            answers: null,
          };
          let deliveryId: string | null = null;
          if (args.action === "withdraw") {
            ensureThreadQueueIsWritable(thread);
            if (!execution)
              conflict(
                "Question changed before withdrawal preparation",
                current,
              );
            const content = serializeQuestionResolutionNotice({
              version: 1,
              questionId: current.id,
              revision: current.revision,
              publication: current.publication,
              materialManifest: current.materialManifest,
              resolution: attribution,
            });
            deliveryId = createQueuedThreadMessageInTransaction(tx, {
              threadId: thread.id,
              content: [{ type: "text", text: content, mentions: [] }],
              senderThreadId: actor.kind === "agent" ? actor.threadId : null,
              model: execution.model,
              reasoningLevel: execution.reasoningLevel,
              permissionMode: execution.permissionMode,
              serviceTier: execution.serviceTier,
              waitingOn:
                thread.status === "stopping"
                  ? { kind: "stopping" }
                  : { kind: "thread-busy" },
              sendAt: null,
              payload: {
                kind: "questionResponse",
                questionId: current.id,
                revision: current.revision,
              },
              systemNotice: null,
            }).id;
          }
          appendQuestionResolutionEvent(tx, {
            initial: current.status === "open",
            request,
            attribution: { ...attribution, deliveryId },
          });
          return { question: rowToQuestion(tx, row), created: true };
        },
        { behavior: "immediate" },
      ),
  );
  if (accepted.created) {
    deps.hub.notifyThread(
      args.threadId,
      ["interactions-changed", "queue-changed"],
      { projectId: publicThread(deps.db, args.threadId, true).projectId },
    );
    if (args.action === "withdraw")
      requestQueuedMessageDispatch(deps, {
        kind: "thread-ready",
        threadId: args.threadId,
      });
  }
  return accepted.question;
}

const openQuestionCursorSchema = z.strictObject({
  version: z.literal(1),
  threadId: z.string(),
  readRevision: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  id: conversationQuestionIdSchema,
});

function decodeOpenQuestionCursor(cursor: string, threadId: string) {
  try {
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor)
      throw new Error("Invalid encoding");
    const parsed = openQuestionCursorSchema.parse(
      JSON.parse(bytes.toString("utf8")),
    );
    if (parsed.threadId !== threadId) throw new Error("Different thread");
    return parsed;
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid open-question cursor");
  }
}

export function listOpenConversationQuestionsForThread(
  deps: Pick<LoggedPendingInteractionWorkSessionDeps, "db">,
  args: { threadId: string; cursor?: string; limit?: number },
): ConversationQuestionsOpenPage {
  const cursor =
    args.cursor === undefined
      ? null
      : decodeOpenQuestionCursor(args.cursor, args.threadId);
  const limit = args.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new ApiError(400, "invalid_request", "Question limit must be 1–200");
  return deps.db.transaction(() => {
    const thread = requirePublicThread(deps.db, args.threadId);
    const identities = listOpenConversationQuestionIdentities(
      deps.db,
      args.threadId,
    );
    const readRevision = createHash("sha256")
      .update(
        JSON.stringify({
          archived: thread.archivedAt !== null,
          identities,
        }),
      )
      .digest("hex");
    if (cursor !== null && cursor.readRevision !== readRevision)
      throw new ApiError(
        409,
        "stale-question-cursor",
        "Open questions changed; restart the list",
      );
    const rows = listOpenConversationQuestionPage(deps.db, {
      threadId: args.threadId,
      limit: limit + 1,
      ...(cursor === null
        ? {}
        : { after: { createdAt: cursor.createdAt, id: cursor.id } }),
    });
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    const nextCursor =
      rows.length > limit && last !== undefined
        ? Buffer.from(
            JSON.stringify({
              version: 1,
              threadId: args.threadId,
              readRevision,
              createdAt: last.createdAt,
              id: last.id,
            }),
          ).toString("base64url")
        : null;
    return {
      questions: visible.map((row) => rowToQuestion(deps.db, row)),
      total: identities.length,
      nextCursor,
      readRevision,
    };
  });
}
