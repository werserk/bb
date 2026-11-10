import { z } from "zod";
import {
  CONVERSATION_QUESTION_TOOL_NAME,
  conversationQuestionToolInputSchema,
  normalizeConversationQuestionPublication,
  type DynamicTool,
  type ToolCallResponse,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { publishConversationQuestion } from "./conversation-questions.js";

const inputSchema = z.toJSONSchema(conversationQuestionToolInputSchema, {
  io: "input",
});
delete inputSchema.$schema;
inputSchema.type = "object";

export const CONVERSATION_QUESTION_INSTRUCTIONS =
  "Use bb_ask_question for ordinary questions and owner decisions. It publishes a persistent inline card and returns its ID immediately, without selecting an answer or blocking chat. Include the actual explanation in body and required files in materials (thread-storage relative paths with explicit dependencies); never leave materials only in Thinking or claim unlisted files were delivered. The user can answer or dismiss later while continuing chat. Continue independent work after publication; if work needs that answer, end the turn naturally and wait for a later question response. Do not poll, sleep or create a native pending question. This replaces ordinary native AskUserQuestion/request_user_input flows; command and permission approvals remain separate. A response is delivered later as a message containing the original question ID and context. Publishing a question grants no permission and is not an answer.";

export const BB_ASK_QUESTION_TOOL: DynamicTool = {
  name: CONVERSATION_QUESTION_TOOL_NAME,
  description:
    "Publish a persistent question card with its explanation and material snapshots, then immediately return its ID. The user can answer or dismiss at any time; normal chat stays available. Use body for context and materials for files relative to this thread's storage, including explicit HTML dependencies. Normalized questions use id/prompt/multiSelect/allowFreeText/options(value,label,description). Claude-native questions/question/header/options(label,description) are also accepted and normalized. This tool never waits for an answer and never authorizes a command.",
  inputSchema,
  presentation: {
    label: { pending: "Publishing question", completed: "Published question" },
    icon: { glyph: "MessageQuestion" },
    suppress: true,
  },
};

export async function handleConversationQuestionToolCall(
  deps: LoggedPendingInteractionWorkSessionDeps,
  args: {
    threadId: string;
    turnId: string;
    providerThreadId: string;
    callId: string;
    input: unknown;
  },
): Promise<ToolCallResponse> {
  try {
    const publication = normalizeConversationQuestionPublication(args.input);
    const question = await publishConversationQuestion(deps, {
      threadId: args.threadId,
      source: {
        turnId: args.turnId,
        providerThreadId: args.providerThreadId,
        callId: args.callId,
      },
      publication,
    });
    return {
      success: true,
      contentItems: [
        {
          type: "inputText",
          text: JSON.stringify({
            questionId: question.id,
            revision: question.revision,
            status: question.status,
            message:
              "Question card published with materials. No answer has been selected. Continue independent work; the user may answer or dismiss later. Do not wait in this tool call.",
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
          text: `Question was not published: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
}
