import {
  conversationQuestionPublicationSchema,
  parseQuestionResolutionNotice,
  type QuestionResolutionNotice,
  questionMaterialManifestSchema,
  normalizeConversationQuestionAnswers,
  userQuestionPendingInteractionResolutionSchema,
  type ConversationQuestionPublication,
  type ConversationQuestion,
} from "@bb/domain";
import { parseAgentMessageEnvelope } from "@bb/thread-view";

function keepsEveryKey(raw: unknown, parsed: unknown): boolean {
  if (Array.isArray(raw))
    return (
      Array.isArray(parsed) &&
      raw.length === parsed.length &&
      raw.every((value, index) => keepsEveryKey(value, parsed[index]))
    );
  if (raw !== null && typeof raw === "object") {
    if (parsed === null || typeof parsed !== "object") return false;
    return Object.entries(raw).every(
      ([key, value]) =>
        Object.hasOwn(parsed, key) &&
        keepsEveryKey(value, Reflect.get(parsed, key)),
    );
  }
  return true;
}

export interface QuestionResponseSnapshot {
  questionId: string;
  revision: number;
  publication: ConversationQuestionPublication;
  materialManifest: ReturnType<typeof questionMaterialManifestSchema.parse>;
  answers: ConversationQuestion["response"];
  resolution: QuestionResolutionNotice["resolution"] | null;
  decisionPolicy: "local-input-parity" | null;
}

export function parseQuestionResponse(
  text: string,
): QuestionResponseSnapshot | null {
  const notice = parseQuestionResolutionNotice(text);
  if (notice)
    return {
      questionId: notice.questionId,
      revision: notice.revision,
      publication: notice.publication,
      materialManifest: notice.materialManifest,
      answers:
        notice.resolution.action === "answer"
          ? userQuestionPendingInteractionResolutionSchema.shape.answers.parse(
              notice.resolution.answers,
            )
          : null,
      resolution: notice.resolution,
      decisionPolicy: notice.version === 2 ? notice.decisionPolicy : null,
    };

  const match =
    /^Conversation question response: (qst_[23456789abcdefghijkmnpqrstuvwxyz]{10}) \(revision ([1-9][0-9]*)\)\nOriginal question:\n([^\n]+)\nFrozen materials:\n([^\n]+)\nOwner answers:\n([^\n]+)$/u.exec(
      text,
    );
  if (!match || match[0] !== text) return null;
  try {
    const revision = Number(match[2]);
    if (!Number.isSafeInteger(revision)) return null;
    const rawPublication: unknown = JSON.parse(match[3]!);
    const rawManifest: unknown = JSON.parse(match[4]!);
    const rawAnswers: unknown = JSON.parse(match[5]!);
    const publication =
      conversationQuestionPublicationSchema.parse(rawPublication);
    const materialManifest = questionMaterialManifestSchema.parse(rawManifest);
    const input =
      userQuestionPendingInteractionResolutionSchema.shape.answers.parse(
        rawAnswers,
      );
    if (
      !keepsEveryKey(rawPublication, publication) ||
      !keepsEveryKey(rawManifest, materialManifest) ||
      !keepsEveryKey(rawAnswers, input)
    )
      return null;
    const answers = normalizeConversationQuestionAnswers(
      publication.questions,
      input,
    );
    return {
      questionId: match[1]!,
      revision,
      publication,
      materialManifest,
      answers,
      resolution: null,
      decisionPolicy: null,
    };
  } catch {
    return null;
  }
}

export function questionResponseForHistory(row: {
  text: string;
  initiator: string;
  senderThreadId: string | null;
  mentions: readonly unknown[];
  attachments: object | null;
}) {
  if (row.mentions.length > 0) return null;
  const envelope = parseAgentMessageEnvelope(row.text);
  if (
    envelope &&
    (row.initiator !== "agent" ||
      row.senderThreadId !== envelope.senderThreadId)
  )
    return null;
  const response = parseQuestionResponse(
    envelope ? row.text.slice(envelope.bodyStart) : row.text,
  );
  if (!response) return null;
  const actor = response.resolution?.actor;
  if (actor?.kind === "agent") {
    if (row.initiator !== "agent" || row.senderThreadId !== actor.threadId)
      return null;
  } else if (row.initiator !== "user" || row.senderThreadId !== null)
    return null;
  if (
    row.attachments &&
    Object.values(row.attachments).some((value) =>
      Array.isArray(value)
        ? value.length > 0
        : typeof value === "number"
          ? value !== 0
          : value != null,
    )
  )
    return null;
  return response;
}

export function queuedQuestionResponse(
  payload: { kind: string; questionId?: string; revision?: number },
  content: readonly {
    type: string;
    text?: string;
    mentions?: readonly unknown[];
  }[],
) {
  if (payload.kind !== "questionResponse" || content.length !== 1) return null;
  const part = content[0];
  if (part?.type !== "text" || !part.text || (part.mentions?.length ?? 0) > 0)
    return null;
  const response = parseQuestionResponse(part.text);
  return response &&
    response.questionId === payload.questionId &&
    response.revision === payload.revision
    ? response
    : null;
}

export function questionTitle(publication: ConversationQuestionPublication) {
  const first = publication.questions[0];
  return (
    first?.shortLabel?.trim() ||
    first?.prompt.replace(/\s+/gu, " ").trim() ||
    "Question"
  );
}

export function questionTime(timestamp: number) {
  const date = new Date(timestamp);
  const now = new Date();
  return date.toLocaleString(undefined, {
    ...(date.toDateString() === now.toDateString()
      ? {}
      : {
          month: "short",
          day: "numeric",
          ...(date.getFullYear() === now.getFullYear()
            ? {}
            : { year: "numeric" }),
        }),
    hour: "numeric",
    minute: "2-digit",
  });
}

export const questionDeliveryLabels: Record<
  ConversationQuestion["delivery"]["kind"],
  string
> = {
  none: "Saved · not sent yet",
  queued: "Queued · will be sent after this turn",
  held: "Held · not sent",
  submitted: "Sent to agent",
  removed: "Queue entry removed; delivery unverified",
};

export function QuestionAnswers({
  publication,
  answers,
  showPrompts = true,
}: {
  publication: ConversationQuestionPublication;
  answers: ConversationQuestion["response"];
  showPrompts?: boolean;
}) {
  return (
    <div className="space-y-3 text-sm">
      {publication.questions.map((item) => {
        const answer = answers?.[item.id];
        return (
          <div
            key={item.id}
            className="space-y-1 whitespace-pre-wrap break-words"
          >
            {showPrompts ? <p className="font-medium">{item.prompt}</p> : null}
            {answer ? (
              <>
                {answer.selected.map((value) => (
                  <p key={value}>
                    <span
                      aria-hidden="true"
                      className="mr-2 text-muted-foreground"
                    >
                      ✓
                    </span>
                    <span>
                      {item.options?.find((option) => option.value === value)
                        ?.label ?? value}
                    </span>
                  </p>
                ))}
                {answer.freeText !== undefined ? (
                  <p>{answer.freeText}</p>
                ) : null}
                {answer.selected.length === 0 &&
                answer.freeText === undefined ? (
                  <p className="text-muted-foreground">Not answered</p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground">Not answered</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function questionCardId(threadId: string, questionId: string) {
  return `conversation-question-${threadId}-${questionId}`;
}

export function questionResponseId(threadId: string, questionId: string) {
  return `conversation-question-response-${threadId}-${questionId}`;
}

export function QuestionOriginalPrompts({
  publication,
}: {
  publication: ConversationQuestionPublication;
}) {
  return (
    <div className="space-y-3 text-sm">
      {publication.questions.map((item) => (
        <div
          key={item.id}
          className="space-y-1 whitespace-pre-wrap break-words"
        >
          <p className="font-medium">{item.prompt}</p>
          {item.options?.map((option) => (
            <div key={option.value}>
              <p>{option.label}</p>
              {option.description ? (
                <p className="text-muted-foreground">{option.description}</p>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
