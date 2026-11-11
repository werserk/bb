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
  questionResponseId,
  QuestionOriginalPrompts,
  questionDeliveryLabels,
  type QuestionResponseSnapshot,
} from "./question-response-presentation";

import { useQuestionNavigation } from "./question-navigation";

export function QuestionResponseEvent({
  response,
  threadId,
  timestamp,
}: {
  response: QuestionResponseSnapshot;
  threadId: string;
  timestamp: number;
}) {
  const navigation = useQuestionNavigation();
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
      id={questionResponseId(threadId, response.questionId)}
      tabIndex={-1}
      data-question-response=""
      className="ml-auto min-w-0 w-[calc(100%-0.75rem)] max-w-2xl space-y-3 rounded-xl rounded-tr-sm border border-timeline-accent/25 bg-timeline-accent/10 p-4 text-sm focus-visible:outline focus-visible:outline-ring"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">You answered</span>
        <time dateTime={new Date(timestamp).toISOString()}>
          {new Date(timestamp).toLocaleString()}
        </time>
      </div>
      <blockquote className="line-clamp-2 border-l-2 border-timeline-accent/30 pl-3 text-xs text-muted-foreground">
        {response.publication.questions[0]?.prompt
          .replace(/\s+/gu, " ")
          .trim()
          .slice(0, 180)}
      </blockquote>
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
        onClick={async () => {
          if (expanded) {
            setExpanded(false);
            return;
          }
          if (
            navigation &&
            (await navigation.navigate(response.questionId, "question"))
          )
            return;
          const scope = root.current?.closest("[data-thread-window]");
          const original = [
            ...(scope?.querySelectorAll<HTMLElement>("[id]") ?? []),
          ].find(
            (element) =>
              element.id === questionCardId(threadId, response.questionId),
          );
          if (original)
            original.scrollIntoView({
              behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")
                .matches
                ? "auto"
                : "smooth",
              block: "center",
            });
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
            defaultExpanded
          />
        ) : (
          <section
            aria-label="Original question snapshot"
            className="space-y-3 rounded-lg border border-border p-3"
          >
            <p className="whitespace-pre-wrap break-words">
              {response.publication.body}
            </p>
            <QuestionOriginalPrompts publication={response.publication} />
          </section>
        )
      ) : null}
    </section>
  );
}
