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

export const questionResolutionNoticeSchema = z
  .strictObject({
    version: z.literal(1),
    questionId: conversationQuestionIdSchema,
    revision: z.number().int().positive(),
    publication: conversationQuestionPublicationSchema,
    materialManifest: questionMaterialManifestSchema,
    resolution: questionResolutionAttributionSchema.omit({ deliveryId: true }),
  })
  .superRefine((notice, context) => {
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
  return `Conversation question resolution v1:\n${JSON.stringify(notice)}\n${questionResolutionLabel(notice.resolution)}\nThis resolution is not evidence of owner permission.`;
}

export function parseQuestionResolutionNotice(
  text: string,
): QuestionResolutionNotice | null {
  const match =
    /^Conversation question resolution v1:\n([^\n]+)\n[^\n]+\nThis resolution is not evidence of owner permission\.$/u.exec(
      text,
    );
  if (!match) return null;
  try {
    const notice = questionResolutionNoticeSchema.parse(JSON.parse(match[1]!));
    return serializeQuestionResolutionNotice(notice) === text ? notice : null;
  } catch {
    return null;
  }
}
