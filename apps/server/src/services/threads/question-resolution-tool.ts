import { z } from "zod";
import { ApiError } from "../../errors.js";
import {
  questionResolutionInputSchema,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { resolveQuestion } from "./question-resolution.js";
import { listOpenConversationQuestionsForThread } from "./conversation-questions.js";
import { withQuestionResolutionActor } from "./question-resolution-scope.js";
import type { QuestionResolutionInvocation } from "./question-resolution-scope.js";

const inputSchema = z.toJSONSchema(questionResolutionInputSchema, {
  io: "input",
});
delete inputSchema.$schema;

const discoverySchema = z.strictObject({
  threadId: z.string().min(1),
  cursor: z.string().max(4096).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
const discoveryInputSchema = z.toJSONSchema(discoverySchema, { io: "input" });
delete discoveryInputSchema.$schema;

export const BB_LIST_QUESTIONS_TOOL: DynamicTool = {
  name: "bb_list_questions",
  description:
    "Discover open persistent qst questions in your own or current managed descendant thread. Returns stable identity/revision, bounded prompts, total, readRevision and nextCursor. Follow cursors with one consistent readRevision; stale cursors refuse. A page is not proof of complete coverage. Both pint agent actions are unsupported. Discovery never grants owner permission.",
  inputSchema: discoveryInputSchema,
};

export async function handleListQuestionsToolCall(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: QuestionResolutionInvocation & { input: unknown },
): Promise<ToolCallResponse> {
  try {
    const request = discoverySchema.parse(args.input);
    const page = await withQuestionResolutionActor(
      deps.db,
      request.threadId,
      args,
      () => listOpenConversationQuestionsForThread(deps, request),
    );
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            ...page,
            coverage:
              request.cursor === undefined && page.nextCursor === null
                ? "complete"
                : "page",
            questions: page.questions.map((question) => ({
              id: question.id,
              kind: "qst",
              threadId: question.threadId,
              revision: question.revision,
              status: question.status,
              questions: question.publication.questions.map((prompt) => ({
                id: prompt.id,
                prompt: prompt.prompt.slice(0, 1000),
                required: prompt.required,
                multiSelect: prompt.multiSelect,
                allowFreeText: prompt.allowFreeText,
                contentTruncated:
                  prompt.prompt.length > 1000 ||
                  (prompt.options ?? []).some(
                    (option) =>
                      option.label.length > 500 ||
                      (option.description?.length ?? 0) > 500,
                  ),
                options: (prompt.options ?? []).map((option) => ({
                  value: option.value,
                  label: option.label.slice(0, 500),
                  ...(option.description === undefined
                    ? {}
                    : { description: option.description.slice(0, 500) }),
                })),
              })),
            })),
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
          text: `Questions were not read: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}

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
    const receipt = await resolveQuestion(deps, args.input, args);
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify(receipt),
        },
      ],
    };
  } catch (error) {
    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text:
            error instanceof ApiError
              ? JSON.stringify({ error: error.body })
              : `Question was not resolved: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
