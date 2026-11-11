import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  conversationQuestionPublicationSchema,
  questionMaterialManifestSchema,
  normalizeConversationQuestionAnswers,
} from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { conversationQuestionsQueryKey } from "@/hooks/queries/conversation-question-query-key";
import { ConversationQuestionCard } from "./ConversationQuestionCard";
import {
  QuestionAnswers,
  questionCardId,
  questionDeliveryLabels,
  type QuestionResponseSnapshot,
} from "./question-response-presentation";

export function QuestionResponseEvent({
  response,
  threadId,
  timestamp,
}: {
  response: QuestionResponseSnapshot;
  threadId: string;
  timestamp: number;
}) {
  const root = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const source = useQuery({
    queryKey: [...conversationQuestionsQueryKey(threadId), response.questionId],
    queryFn: () =>
      sdk.threads.questions.get({ threadId, questionId: response.questionId }),
    retry: false,
  });
  const question = source.data;
  let matches = false;
  try {
    matches =
      !source.isError &&
      question?.id === response.questionId &&
      question.threadId === threadId &&
      question.revision === response.revision &&
      question.status === "answered" &&
      JSON.stringify(
        conversationQuestionPublicationSchema.parse(question.publication),
      ) === JSON.stringify(response.publication) &&
      JSON.stringify(
        questionMaterialManifestSchema.parse(question.materialManifest),
      ) === JSON.stringify(response.materialManifest) &&
      JSON.stringify(
        normalizeConversationQuestionAnswers(
          question.publication.questions,
          question.response ?? {},
        ),
      ) === JSON.stringify(response.answers);
  } catch {
    matches = false;
  }
  return (
    <section
      ref={root}
      aria-label="Question response"
      data-question-response=""
      className="space-y-3 border-l border-border py-1 pl-4 text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>Question response</span>
        <time dateTime={new Date(timestamp).toISOString()}>
          {new Date(timestamp).toLocaleString()}
        </time>
      </div>
      <QuestionAnswers
        publication={response.publication}
        answers={response.answers}
      />
      <p className="text-xs text-muted-foreground">
        {matches && question
          ? questionDeliveryLabels[question.delivery.kind]
          : source.isPending
            ? "Checking response status…"
            : "Source unavailable · delivery unverified"}
      </p>
      {matches && question?.delivery.reason ? (
        <p className="text-xs text-muted-foreground">
          {question.delivery.reason}
        </p>
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        className="text-xs underline"
        onClick={() => {
          if (expanded) {
            setExpanded(false);
            return;
          }
          const scope = root.current?.closest("[data-thread-window]");
          const original = [
            ...(scope?.querySelectorAll<HTMLElement>("[id]") ?? []),
          ].find(
            (element) =>
              element.id === questionCardId(threadId, response.questionId),
          );
          if (original)
            original.scrollIntoView({ behavior: "smooth", block: "center" });
          else setExpanded((value) => !value);
        }}
      >
        Original question
      </button>
      {expanded ? (
        matches ? (
          <ConversationQuestionCard
            threadId={threadId}
            questionId={response.questionId}
          />
        ) : (
          <section
            aria-label="Original question snapshot"
            className="space-y-3 rounded-lg border border-border p-3"
          >
            <p className="whitespace-pre-wrap break-words">
              {response.publication.body}
            </p>
            <QuestionAnswers
              publication={response.publication}
              answers={response.answers}
            />
          </section>
        )
      ) : null}
    </section>
  );
}
