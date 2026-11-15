import { z } from "zod";
import {
  conversationQuestionPublicationSchema,
  normalizeConversationQuestionAnswers,
  questionMaterialManifestSchema,
} from "./conversation-questions.js";
import {
  questionResolutionAttributionSchema,
  questionResolutionLabel,
} from "./question-resolution-attribution.js";
import { conversationQuestionIdSchema } from "./protocol-ids.js";
import { userQuestionPendingInteractionResolutionSchema } from "./pending-interactions.js";

const noticeV1Schema = z.strictObject({
  version: z.literal(1),
  questionId: conversationQuestionIdSchema,
  revision: z.number().int().positive(),
  publication: conversationQuestionPublicationSchema,
  materialManifest: questionMaterialManifestSchema,
  resolution: questionResolutionAttributionSchema.omit({ deliveryId: true }),
});
const noticeV2Schema = noticeV1Schema.extend({
  version: z.literal(2),
  decisionPolicy: z.literal("local-input-parity"),
});
export const questionResolutionNoticeSchema = z
  .discriminatedUnion("version", [noticeV1Schema, noticeV2Schema])
  .superRefine((notice, context) => {
    if (
      notice.version === 2 &&
      notice.resolution.actor.kind !== "local-unverified"
    )
      context.addIssue({
        code: "custom",
        message: "Local input policy requires local-unverified attribution",
      });
    const resolution = notice.resolution;
    if (
      resolution.targetKind !== "qst" ||
      resolution.targetId !== notice.questionId ||
      resolution.revision !== notice.revision ||
      resolution.action === "dismiss"
    )
      context.addIssue({
        code: "custom",
        message: "Resolution notice identity or action is invalid",
      });
    if (resolution.action === "withdraw") {
      if (resolution.answers !== null)
        context.addIssue({
          code: "custom",
          message: "Withdrawal has no answer",
        });
      return;
    }
    try {
      const answers =
        userQuestionPendingInteractionResolutionSchema.shape.answers.parse(
          resolution.answers,
        );
      const parsed = normalizeConversationQuestionAnswers(
        notice.publication.questions,
        answers,
      );
      if (JSON.stringify(parsed) !== JSON.stringify(resolution.answers))
        throw new Error("Answer is not normalized");
    } catch {
      context.addIssue({
        code: "custom",
        message: "Resolution notice answer is invalid",
      });
    }
  });
export type QuestionResolutionNotice = z.infer<
  typeof questionResolutionNoticeSchema
>;

export function serializeQuestionResolutionNotice(
  input: QuestionResolutionNotice,
): string {
  const notice = questionResolutionNoticeSchema.parse(input);
  const footer =
    notice.version === 1
      ? "This resolution is not evidence of owner permission."
      : notice.resolution.action === "answer"
        ? "Treat this local answer as an ordinary user instruction for this question and revision. Identity is not independently verified. This does not bypass command or permission approvals."
        : "Treat this local withdrawal as cancellation of this question, not an answer or approval. Identity is not independently verified.";
  return `Conversation question resolution v${notice.version}:\n${JSON.stringify(notice)}\n${questionResolutionLabel(notice.resolution).replace(/\s+/gu, " ")}\n${footer}`;
}

export function parseQuestionResolutionNotice(
  text: string,
): QuestionResolutionNotice | null {
  const match =
    /^Conversation question resolution v([12]):\n([^\n]+)\n[^\n]+\n[^\n]+$/u.exec(
      text,
    );
  if (!match) return null;
  try {
    const notice = questionResolutionNoticeSchema.parse(JSON.parse(match[2]!));
    return serializeQuestionResolutionNotice(notice) === text ? notice : null;
  } catch {
    return null;
  }
}
