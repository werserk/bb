import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationQuestion, FrozenQuestionFile } from "@bb/domain";
import { VoiceInputTextareaProvider } from "@bb/shared-ui/voice-input-textarea";
import { VoiceInputTextarea } from "@/components/promptbox/VoiceInputTextarea";
import { QuestionForm } from "@bb/shared-ui/question-form";
import { QuestionFormHostProvider } from "@bb/shared-ui/question-form-host";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { MarkdownPreview } from "../../ui/markdown-preview";
import { conversationQuestionsQueryKey } from "@/hooks/queries/conversation-question-query-key";
import {
  hydrateConversationQuestion,
  invalidateConversationQuestions,
} from "@/hooks/cache-owners/conversation-question-cache-owner";

import {
  QuestionOriginalPrompts,
  questionTitle,
  questionTime,
  questionResponseId,
  questionCardId,
  questionDeliveryLabels,
} from "./question-response-presentation";

import {
  QuestionNavigationFeedback,
  useQuestionLinkState,
} from "./QuestionNavigationFeedback";
import { useQuestionNavigation } from "./question-navigation";
import { QuestionResolutionDetails } from "./QuestionResolutionDetails";

const formHost = {
  density: "default" as const,
  promptShownAbove: null,
  closeInline: null,
  shortcuts: new Map(),
  actionShortcuts: new Map(),
  registerChoiceHandler: () => () => {},
  registerActionHandler: () => () => {},
};

import { QuestionHtmlPreview } from "./QuestionHtmlPreview";

const MARKDOWN_PREVIEW_BYTES = 1024 * 1024;

async function readTextSnapshot(
  response: Response,
  limit: number,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > limit)
        throw new Error(
          "Preview exceeds its byte limit; download the snapshot to read it",
        );
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
}

function QuestionMaterial({
  material,
  threadId,
  questionId,
}: {
  material: FrozenQuestionFile;
  threadId: string;
  questionId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const url = `/api/v1/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/files/${material.snapshotPath.split("/").map(encodeURIComponent).join("/")}`;
  const mime = material.mimeType ?? "";
  const html = mime === "text/html";
  const markdown = mime === "text/markdown" || mime === "text/x-markdown";
  const preview = useQuery({
    queryKey: [
      "conversationQuestionMaterial",
      threadId,
      questionId,
      material.snapshotPath,
      material.snapshotRevision,
    ],
    enabled: expanded,
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const status = await fetchWithAppSurface(url, { method: "HEAD", signal });
      if (!status.ok) throw new Error(`HTTP ${status.status}`);
      if (!markdown && !html) return null;
      const response = await fetchWithAppSurface(url, {
        signal,
        headers: {
          Range: `bytes=0-${html ? material.sizeBytes : MARKDOWN_PREVIEW_BYTES}`,
        },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return readTextSnapshot(
        response,
        html ? material.sizeBytes : MARKDOWN_PREVIEW_BYTES,
      );
    },
  });
  const error = preview.error?.message ?? (failed ? "Media unavailable" : null);
  return (
    <figure className="space-y-2">
      <figcaption>
        <button
          type="button"
          className="text-sm font-medium underline"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Hide" : "Open"} {material.label}
        </button>
      </figcaption>
      {expanded && preview.isSuccess && !error ? (
        markdown ? (
          <MarkdownPreview
            content={preview.data ?? ""}
            allowHtml={false}
            urlTransform={(href, key) => {
              try {
                const resolved = new URL(
                  href,
                  new URL(url, window.location.origin),
                );
                if (key === "href")
                  return resolved.origin !== window.location.origin &&
                    ["https:", "http:"].includes(resolved.protocol)
                    ? resolved.href
                    : "";
                return resolved.origin === window.location.origin &&
                  resolved.pathname.startsWith(
                    `/api/v1/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/files/`,
                  )
                  ? resolved.href
                  : "";
              } catch {
                return "";
              }
            }}
          />
        ) : html ? (
          <QuestionHtmlPreview
            content={preview.data ?? ""}
            url={url}
            title={material.label}
          />
        ) : mime.startsWith("audio/") ? (
          <audio
            aria-label={material.label}
            controls
            preload="metadata"
            src={url}
            onError={() => setFailed(true)}
            className="w-full"
          />
        ) : mime.startsWith("video/") ? (
          <video
            aria-label={material.label}
            controls
            preload="metadata"
            src={url}
            onError={() => setFailed(true)}
            className="max-h-96 w-full"
          />
        ) : mime.startsWith("image/") ? (
          <img
            alt={material.label}
            src={url}
            onError={() => setFailed(true)}
            className="max-h-96 max-w-full"
          />
        ) : (
          <iframe
            title={material.label}
            sandbox="allow-scripts"
            src={url}
            onError={() => setFailed(true)}
            className="h-80 w-full rounded-md border"
          />
        )
      ) : null}
      {expanded && preview.isPending ? (
        <p className="text-xs text-muted-foreground">
          Loading {material.label}…
        </p>
      ) : null}
      <QuestionNavigationFeedback questionId={questionId} kind="answer" />
      {expanded && error ? (
        <p role="alert" className="text-sm text-destructive-text">
          Unable to load {material.label}: {error}
        </p>
      ) : null}
      <a href={url} download className="text-xs underline">
        Download {material.label}
      </a>
    </figure>
  );
}

function QuestionDelivery({ question }: { question: ConversationQuestion }) {
  const navigation = useQuestionNavigation();
  const client = useQueryClient();
  const retry = useMutation({
    mutationFn: () => {
      if (!question.queuedMessageId)
        throw new Error("Response queue entry missing");
      return sdk.threads.queuedMessages.send({
        threadId: question.threadId,
        queuedMessageId: question.queuedMessageId,
        mode: "auto",
      });
    },
    onSettled: () =>
      invalidateConversationQuestions({
        queryClient: client,
        threadId: question.threadId,
      }),
  });
  return (
    <div className="space-y-2 text-sm">
      <p>{questionDeliveryLabels[question.delivery.kind]}</p>
      {question.delivery.reason ? <p>{question.delivery.reason}</p> : null}
      {question.status === "answered" &&
      question.delivery.kind === "held" &&
      question.queuedMessageId &&
      !navigation?.readOnly ? (
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1 hover:bg-state-hover disabled:opacity-50"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          Send now
        </button>
      ) : null}
      {retry.error ? (
        <p role="alert" className="text-destructive-text">
          {retry.error.message}
        </p>
      ) : null}
    </div>
  );
}

export function ConversationQuestionCard({
  threadId,
  questionId,
  defaultExpanded = false,
  snapshot = false,
}: {
  threadId: string;
  questionId: string;
  defaultExpanded?: boolean;
  snapshot?: boolean;
}) {
  const root = useRef<HTMLElement>(null);
  const navigation = useQuestionNavigation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [answerUnavailable, setAnswerUnavailable] = useState(false);
  const client = useQueryClient();
  const queryKey = [...conversationQuestionsQueryKey(threadId), questionId];
  const query = useQuery({
    queryKey,
    queryFn: () => sdk.threads.questions.get({ threadId, questionId }),
    retry: false,
  });
  const action = useMutation({
    mutationFn: (
      request:
        | { kind: "dismiss"; question: ConversationQuestion }
        | {
            kind: "answer";
            question: ConversationQuestion;
            answers: NonNullable<ConversationQuestion["response"]>;
          },
    ) => {
      const identity = {
        threadId,
        questionId,
        revision: request.question.revision,
      };
      return request.kind === "dismiss"
        ? sdk.threads.questions.dismiss(identity)
        : sdk.threads.questions.answer({
            ...identity,
            answers: request.answers,
          });
    },
    onSuccess: (answered) =>
      hydrateConversationQuestion({
        queryClient: client,
        threadId,
        questionId,
        question: answered,
      }),
  });
  const question = query.data;
  const link = useQuestionLinkState(questionId, "answer");
  const headingId = `${questionCardId(threadId, questionId)}${snapshot ? "-snapshot" : ""}-heading`;

  useEffect(() => {
    if (
      navigation?.request?.elementId === questionCardId(threadId, questionId) ||
      (navigation?.feedback?.questionId === questionId &&
        navigation.feedback.kind === "question" &&
        !navigation.pending &&
        !navigation.error)
    )
      setExpanded(true);
  }, [
    navigation?.request,
    navigation?.feedback,
    navigation?.pending,
    navigation?.error,
    threadId,
    questionId,
  ]);
  const answerLink =
    question?.response != null ? (
      <button
        type="button"
        className="min-h-9 shrink-0 text-xs underline pointer-coarse:min-h-11"
        disabled={link.pending}
        aria-busy={link.pending}
        onMouseDown={(event) => {
          if (event.button === 0) event.preventDefault();
        }}
        onClick={async () => {
          if (
            navigation &&
            (await navigation.navigate(questionId, "answer", "inline"))
          ) {
            setAnswerUnavailable(false);
            return;
          }
          navigation?.clear();
          const scope = root.current?.closest("[data-thread-window]");
          const answer = [
            ...(scope?.querySelectorAll<HTMLElement>("[id]") ?? []),
          ].find(
            (element) =>
              element.id === questionResponseId(threadId, questionId),
          );
          if (answer) {
            answer.scrollIntoView({
              behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
                .matches
                ? "instant"
                : "smooth",
              block: "center",
            });
            answer.focus({ preventScroll: true });
            setAnswerUnavailable(false);
          } else setAnswerUnavailable(true);
        }}
      >
        View answer
      </button>
    ) : null;
  const error = action.error ?? query.error;
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-labelledby={question ? headingId : undefined}
      aria-label={question ? undefined : "Question"}
      id={`${questionCardId(threadId, questionId)}${snapshot ? "-snapshot" : ""}`}
      className={`min-w-0 rounded-xl border border-border focus-visible:outline-2 ${question?.status === "open" ? "space-y-4 border-l-2 border-l-attention bg-card p-4 focus-visible:-outline-offset-2 focus-visible:outline-attention" : "space-y-2 bg-transparent p-3 focus-visible:outline-offset-2 focus-visible:outline-timeline-accent"}`}
    >
      {question ? (
        <>
          {question.status === "open" ? (
            <>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span aria-hidden="true" className="text-attention">
                  ?
                </span>
                <span>Agent question</span>
                <span className="text-foreground">Open</span>
                {Number.isFinite(question.updatedAt) ? (
                  <time
                    className="ml-auto"
                    dateTime={new Date(question.updatedAt).toISOString()}
                    title={`Updated ${new Date(question.updatedAt).toLocaleString()}`}
                  >
                    {questionTime(question.updatedAt)}
                  </time>
                ) : null}
              </div>
              <h3 id={headingId} className="break-words text-sm font-medium">
                {questionTitle(question.publication)}
              </h3>
            </>
          ) : (
            <div className="flex min-h-11 min-w-0 items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h3 id={headingId} className="text-sm font-medium">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((value) => !value)}
                    className="block min-h-9 w-full truncate text-left pointer-coarse:min-h-11"
                  >
                    {questionTitle(question.publication)}
                  </button>
                </h3>
                <span className="text-xs text-muted-foreground">
                  Agent question ·{" "}
                  <span className="capitalize">{question.status}</span>
                  {Number.isFinite(question.updatedAt)
                    ? ` · ${questionTime(question.updatedAt)}`
                    : ""}{" "}
                  · {expanded ? "Hide original" : "Show original"}
                </span>
              </div>
              {answerLink}
            </div>
          )}
          {question.status !== "open" ? (
            <QuestionResolutionDetails
              resolution={question.resolutionAttribution ?? null}
              showIdentity={expanded}
            />
          ) : null}
          {question.status === "open" || expanded ? (
            <div className="space-y-4">
              {question.publication.body ? (
                <MarkdownPreview
                  content={question.publication.body}
                  allowHtml={false}
                />
              ) : null}
              <div className="space-y-4">
                {question.materialManifest.materials.map((material) => (
                  <QuestionMaterial
                    key={material.snapshotPath}
                    material={material}
                    threadId={threadId}
                    questionId={questionId}
                  />
                ))}
              </div>
              {question.status !== "open" ? (
                <QuestionOriginalPrompts publication={question.publication} />
              ) : null}
              {question.status !== "open" &&
              (question.resolutionHistory?.length ?? 0) > 1 ? (
                <details className="space-y-2 text-xs">
                  <summary className="cursor-pointer">
                    Earlier resolutions
                  </summary>
                  {question.resolutionHistory.slice(0, -1).map((resolution) => (
                    <div
                      key={resolution.id}
                      className="space-y-2 border-l border-border pl-3"
                    >
                      <QuestionResolutionDetails
                        resolution={resolution}
                        showIdentity
                      />
                      {resolution.answers !== null ? (
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(resolution.answers, null, 2)}
                        </pre>
                      ) : null}
                    </div>
                  ))}
                </details>
              ) : null}
            </div>
          ) : null}
          {question.status === "open" ? (
            <VoiceInputTextareaProvider value={VoiceInputTextarea}>
              <QuestionFormHostProvider value={formHost}>
                <QuestionForm
                  mode="plan"
                  draftKey={`${threadId}:${questionId}:${question.revision}`}
                  questions={question.publication.questions.map(
                    (item, index) => ({
                      ...item,
                      shortLabel: item.shortLabel ?? `Question ${index + 1}`,
                      options: item.options ?? [],
                    }),
                  )}
                  disabled={action.isPending || navigation?.readOnly === true}
                  cancelDisabled={
                    action.isPending || navigation?.readOnly === true
                  }
                  onSubmit={(answers) =>
                    action
                      .mutateAsync({ kind: "answer", question, answers })
                      .then(() => {})
                  }
                  onCancel={() =>
                    action
                      .mutateAsync({ kind: "dismiss", question })
                      .then(() => {})
                  }
                />
              </QuestionFormHostProvider>
            </VoiceInputTextareaProvider>
          ) : (
            <>
              {question.resolutionAttribution?.action === "withdraw" &&
              question.resolutionDelivery ? (
                <p className="text-xs text-muted-foreground">
                  Cancellation ·{" "}
                  {questionDeliveryLabels[question.resolutionDelivery.kind]}
                  {question.resolutionDelivery.reason
                    ? ` — ${question.resolutionDelivery.reason}`
                    : ""}
                </p>
              ) : null}
              {(question.status === "answered" || question.response != null) &&
              question.delivery.kind !== "submitted" ? (
                <QuestionDelivery question={question} />
              ) : null}

              {answerUnavailable ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Answer unavailable here. Retry View answer to load it again.
                </p>
              ) : null}
            </>
          )}
        </>
      ) : null}
      <QuestionNavigationFeedback questionId={questionId} kind="answer" />
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
