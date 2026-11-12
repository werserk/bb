import { z } from "zod";
import { userQuestionPendingInteractionResolutionSchema } from "./pending-interactions.js";
import type { ConversationQuestion } from "./conversation-questions.js";
import type { QuestionResolutionAttribution } from "./question-resolution-attribution.js";

export const questionResolutionInputSchema = z
  .strictObject({
    threadId: z.string().min(1),
    questionId: z.string().min(1).optional(),
    interactionId: z.string().min(1).optional(),
    revision: z.number().int().positive(),
    operationId: z.string().trim().min(1).max(128),
    action: z.enum(["answer", "withdraw"]),
    reason: z.string().trim().min(1).max(2000),
    answers:
      userQuestionPendingInteractionResolutionSchema.shape.answers.optional(),
  })
  .superRefine((input, context) => {
    if (
      (input.questionId === undefined) ===
      (input.interactionId === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Provide exactly one questionId or interactionId",
      });
    if ((input.action === "answer") !== (input.answers !== undefined))
      context.addIssue({
        code: "custom",
        message: "Only an answer action requires answers",
      });
  });
export type QuestionResolutionInput = z.infer<
  typeof questionResolutionInputSchema
>;

export interface QuestionResolutionResult {
  resolution: QuestionResolutionAttribution;
  question: ConversationQuestion;
  delivery: ConversationQuestion["delivery"];
}
