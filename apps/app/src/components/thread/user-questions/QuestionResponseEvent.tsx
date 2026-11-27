import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  conversationQuestionPublicationSchema,
  questionMaterialManifestSchema,
  normalizeConversationQuestionAnswers,
  questionResolutionAttributionSchema,
} from "@bb/domain";
import { sdk } from "@/lib/sdk";
import { conversationQuestionsQueryKey } from "@/hooks/queries/conversation-question-query-key";
import { ConversationQuestionCard } from "./ConversationQuestionCard";
import {
  questionCardId,
  questionResponseId,
  QuestionOriginalPrompts,
  questionDeliveryLabels,
  type QuestionResponseSnapshot,
} from "./question-response-presentation";

import {
  QuestionResponseBody,
  questionResponseClass,
  questionWithdrawnClass,
} from "./QuestionResponseBody";
import {
  QuestionNavigationFeedback,
  useQuestionLinkState,
} from "./QuestionNavigationFeedback";

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
  const link = useQuestionLinkState(response.questionId, "question");
  const root = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const source = useQuery({
    queryKey: [...conversationQuestionsQueryKey(threadId), response.questionId],
    queryFn: () =>
      sdk.threads.questions.get({ threadId, questionId: response.questionId }),
    retry: false,
  });
  const question = source.data;
  const acceptedResolution = response.resolution
    ? (question?.resolutionHistory?.find(
        (event) => event.id === response.resolution?.id,
      ) ?? null)
    : null;
  const acceptedNotice = acceptedResolution
    ? (({ deliveryId: _deliveryId, ...notice }) => notice)(acceptedResolution)
    : null;
  const matches = responseMatchesSource(
    source.isError,
    question,
    response,
    threadId,
    acceptedResolution,
    acceptedNotice,
  );
  const withdrawn = response.resolution?.action === "withdraw";
  const delivery =
    response.resolution?.action === "withdraw"
      ? question?.resolutionDelivery
      : question?.delivery;
  return (
    <section
      ref={root}
      aria-label="Question response"
      id={questionResponseId(threadId, response.questionId)}
      tabIndex={-1}
      data-question-response=""
      className={withdrawn ? questionWithdrawnClass : questionResponseClass}
    >
      <QuestionResponseBody
        quiet={withdrawn}
        response={response}
        timestamp={timestamp}
        resolution={matches ? acceptedResolution : null}
        footer={
          <>
            <span>
              {matches && delivery
                ? questionDeliveryLabels[delivery.kind]
                : source.isPending
                  ? "Checking response status…"
                  : "Source unavailable · delivery unverified"}
              {matches && delivery?.reason ? ` — ${delivery.reason}` : ""}
            </span>
            <button
              type="button"
              aria-expanded={expanded}
              className="min-h-9 shrink-0 text-xs text-foreground underline pointer-coarse:min-h-11"
              disabled={link.pending}
              aria-busy={link.pending}
              onMouseDown={(event) => {
                if (event.button === 0) event.preventDefault();
              }}
              onClick={async () => {
                if (expanded) {
                  setExpanded(false);
                  return;
                }
                if (
                  navigation &&
                  (await navigation.navigate(
                    response.questionId,
                    "question",
                    "inline",
                  ))
                )
                  return;
                navigation?.clear();
                const scope = root.current?.closest("[data-thread-window]");
                const original = [
                  ...(scope?.querySelectorAll<HTMLElement>("[id]") ?? []),
                ].find(
                  (element) =>
                    element.id ===
                    questionCardId(threadId, response.questionId),
                );
                if (original)
                  original.scrollIntoView({
                    behavior: window.matchMedia?.(
                      "(prefers-reduced-motion: reduce)",
                    ).matches
                      ? "auto"
                      : "smooth",
                    block: "center",
                  });
                else setExpanded((value) => !value);
              }}
            >
              Original question
            </button>
          </>
        }
      />
      <QuestionNavigationFeedback
        questionId={response.questionId}
        kind="question"
      />
      {expanded ? (
        matches ? (
          <ConversationQuestionCard
            threadId={threadId}
            questionId={response.questionId}
            defaultExpanded
            snapshot
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

type ResponseSource = Awaited<ReturnType<typeof sdk.threads.questions.get>>;

function responseMatchesSource(
  isError: boolean,
  question: ResponseSource | undefined,
  response: QuestionResponseSnapshot,
  threadId: string,
  acceptedResolution: unknown,
  acceptedNotice: unknown,
): boolean {
  try {
    return (
      !isError &&
      question?.id === response.questionId &&
      question.threadId === threadId &&
      question.revision === response.revision &&
      (response.resolution
        ? acceptedResolution !== null
        : question.status === "answered") &&
      JSON.stringify(
        conversationQuestionPublicationSchema.parse(question.publication),
      ) === JSON.stringify(response.publication) &&
      JSON.stringify(
        questionMaterialManifestSchema.parse(question.materialManifest),
      ) === JSON.stringify(response.materialManifest) &&
      (response.resolution
        ? JSON.stringify(
            questionResolutionAttributionSchema
              .omit({ deliveryId: true })
              .parse(acceptedNotice),
          ) === JSON.stringify(response.resolution)
        : JSON.stringify(
            normalizeConversationQuestionAnswers(
              question.publication.questions,
              question.response ?? {},
            ),
          ) === JSON.stringify(response.answers))
    );
  } catch {
    return false;
  }
}
