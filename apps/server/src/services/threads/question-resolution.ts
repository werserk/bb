import {
  questionResolutionInputSchema,
  type QuestionResolutionResult,
} from "@bb/domain";
import type { LoggedPendingInteractionWorkSessionDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  answerConversationQuestion,
  closeConversationQuestion,
  readQuestionResolutionDelivery,
} from "./conversation-questions.js";
import type { QuestionResolutionInvocation } from "./question-resolution-scope.js";

export async function resolveQuestion(
  deps: LoggedPendingInteractionWorkSessionDeps,
  input: unknown,
  invocation: QuestionResolutionInvocation | null,
): Promise<QuestionResolutionResult> {
  const request = questionResolutionInputSchema.parse(input);
  if (!request.questionId)
    throw new ApiError(
      400,
      "unsupported_question_resolution",
      "Both pint agent actions and arbitrary forms are unsupported; no state was changed",
    );
  const ref = {
    threadId: request.threadId,
    questionId: request.questionId,
    revision: request.revision,
  };
  const call = {
    operationId: request.operationId,
    reason: request.reason,
    invocation,
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
  const resolution = question.resolutionHistory.find(
    (event) =>
      event.operationId === request.operationId &&
      (invocation
        ? event.actor.kind === "agent" &&
          event.actor.threadId === invocation.threadId
        : event.actor.kind === "local-unverified"),
  );
  if (!resolution)
    throw new Error("Accepted question resolution receipt is missing");
  return {
    resolution,
    question,
    delivery: readQuestionResolutionDelivery(deps, ref, resolution),
  };
}
