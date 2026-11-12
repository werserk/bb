import { z } from "zod";
import {
  questionResolutionInputSchema,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { answerConversationQuestion } from "./conversation-questions.js";
import type { QuestionResolutionInvocation } from "./question-resolution-scope.js";

const inputSchema = z.toJSONSchema(questionResolutionInputSchema, {
  io: "input",
});
delete inputSchema.$schema;

export const BB_RESOLVE_QUESTION_TOOL: DynamicTool = {
  name: "bb_resolve_question",
  description:
    "Answer an own or current managed descendant native question, or withdraw an open persistent qst question, with its revision, a stable operationId and a reason. Provider pint withdrawal and command/permission approvals are unsupported. Reuse operationId only for an identical retry. Actor identity comes from the runtime; an agent answer is never owner permission. A receipt distinguishes accepted resolution from delivery.",
  inputSchema,
};

export async function handleResolveQuestionToolCall(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QuestionResolutionInvocation & { input: unknown },
): Promise<ToolCallResponse> {
  try {
    const request = questionResolutionInputSchema.parse(args.input);
    if (!request.questionId || request.action !== "answer" || !request.answers)
      throw new Error("This question action is unsupported");
    const question = await answerConversationQuestion(
      deps,
      {
        threadId: request.threadId,
        questionId: request.questionId,
        revision: request.revision,
        answers: request.answers,
      },
      {
        operationId: request.operationId,
        reason: request.reason,
        invocation: {
          threadId: args.threadId,
          turnId: args.turnId,
          providerThreadId: args.providerThreadId,
        },
      },
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
            delivery: question.delivery,
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
