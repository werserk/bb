import { z } from "zod";
import {
  questionResolutionInputSchema,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import {
  answerConversationQuestion,
  closeConversationQuestion,
} from "./conversation-questions.js";
import type { QuestionResolutionInvocation } from "./question-resolution-scope.js";

const inputSchema = z.toJSONSchema(questionResolutionInputSchema, {
  io: "input",
});
delete inputSchema.$schema;

export const BB_RESOLVE_QUESTION_TOOL: DynamicTool = {
  name: "bb_resolve_question",
  description:
    "Answer or withdraw an own or current managed descendant persistent qst question, with its revision, a stable operationId and a reason. Both answer and withdrawal of provider pint questions, arbitrary plugin forms and command/permission approvals are unsupported and nonmutating. Reuse operationId only for an identical retry. Actor identity comes from the runtime; an agent answer is never owner permission. A receipt distinguishes accepted resolution from delivery.",
  inputSchema,
};

export async function handleResolveQuestionToolCall(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QuestionResolutionInvocation & { input: unknown },
): Promise<ToolCallResponse> {
  try {
    const request = questionResolutionInputSchema.parse(args.input);
    if (!request.questionId)
      throw new Error("This question action is unsupported");
    const ref = {
      threadId: request.threadId,
      questionId: request.questionId,
      revision: request.revision,
    };
    const call = {
      operationId: request.operationId,
      reason: request.reason,
      invocation: {
        threadId: args.threadId,
        turnId: args.turnId,
        providerThreadId: args.providerThreadId,
      },
    };
    const question =
      request.action === "answer" && request.answers
        ? await answerConversationQuestion(
            deps,
            { ...ref, answers: request.answers },
            call,
          )
        : await closeConversationQuestion(
            deps,
            { ...ref, action: "withdraw" },
            call,
          );
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            resolution: question.resolutionHistory.find(
              (event) => event.operationId === request.operationId,
            ),
            question,
            delivery: question.resolutionDelivery ?? question.delivery,
          }),
        },
      ],
    };
  } catch (error) {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: `Question was not resolved: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
