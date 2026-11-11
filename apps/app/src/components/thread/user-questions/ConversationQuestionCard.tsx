import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ConversationQuestion, FrozenQuestionFile } from "@bb/domain";
import { QuestionForm } from "@bb/shared-ui/question-form";
import { QuestionFormHostProvider } from "@bb/shared-ui/question-form-host";
import { fetchWithAppSurface } from "@/lib/app-surface";
import { sdk } from "@/lib/sdk";
import { MarkdownPreview } from "../../ui/markdown-preview";
import { conversationQuestionsQueryKey } from "@/hooks/queries/conversation-question-query-key";

import {
  QuestionOriginalPrompts,
  questionResponseId,
  questionCardId,
  questionDeliveryLabels,
} from "./question-response-presentation";

import { useQuestionNavigation } from "./question-navigation";

const formHost = {
  density: "default" as const,
  promptShownAbove: null,
  closeInline: null,
  shortcuts: new Map(),
  actionShortcuts: new Map(),
  registerChoiceHandler: () => () => {},
  registerActionHandler: () => () => {},
};

const MARKDOWN_PREVIEW_BYTES = 1024 * 1024;

async function readMarkdownSnapshot(response: Response): Promise<string> {
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
      if (size > MARKDOWN_PREVIEW_BYTES)
        throw new Error(
          "Markdown preview exceeds 1 MiB; download the snapshot to read it",
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
  const [failed, setFailed] = useState(false);
  const url = `/api/v1/threads/${encodeURIComponent(threadId)}/questions/${encodeURIComponent(questionId)}/files/${material.snapshotPath.split("/").map(encodeURIComponent).join("/")}`;
  const mime = material.mimeType ?? "";
  const markdown = mime === "text/markdown" || mime === "text/x-markdown";
  const preview = useQuery({
    queryKey: [
      "conversationQuestionMaterial",
      threadId,
      questionId,
      material.snapshotPath,
      material.snapshotRevision,
    ],
    staleTime: Infinity,
    retry: false,
    queryFn: async ({ signal }) => {
      const status = await fetchWithAppSurface(url, { method: "HEAD", signal });
      if (!status.ok) throw new Error(`HTTP ${status.status}`);
      if (!markdown) return null;
      const response = await fetchWithAppSurface(url, {
        signal,
        headers: { Range: `bytes=0-${MARKDOWN_PREVIEW_BYTES}` },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return readMarkdownSnapshot(response);
    },
  });
  const error = preview.error?.message ?? (failed ? "Media unavailable" : null);
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm font-medium">{material.label}</figcaption>
      {preview.isSuccess && !error ? (
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
      {preview.isPending ? (
        <p className="text-xs text-muted-foreground">
          Loading {material.label}…
        </p>
      ) : null}
      {error ? (
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
      client.invalidateQueries({
        queryKey: conversationQuestionsQueryKey(question.threadId),
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
}: {
  threadId: string;
  questionId: string;
  defaultExpanded?: boolean;
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
    onSuccess: (question) => client.setQueryData(queryKey, question),
  });
  const question = query.data;
  useEffect(() => {
    if (navigation?.request?.elementId === questionCardId(threadId, questionId))
      setExpanded(true);
  }, [navigation?.request, threadId, questionId]);
  const error = action.error ?? query.error;
  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-label="Question"
      id={questionCardId(threadId, questionId)}
      className={`min-w-0 space-y-4 rounded-xl border border-border bg-card p-4 ${question?.status === "open" ? "border-l-2 border-l-attention" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className="flex size-5 items-center justify-center rounded-full border border-current font-medium"
        >
          ?
        </span>
        <span>Agent question</span>
        <span className="capitalize">{question?.status ?? "Loading"}</span>
      </div>
      {question ? (
        <>
          <h3
            tabIndex={-1}
            className="break-words text-sm font-medium focus-visible:outline focus-visible:outline-ring"
          >
            {question.publication.questions[0]?.shortLabel ??
              question.publication.questions[0]?.prompt ??
              "Question"}
          </h3>
          {Number.isFinite(question.updatedAt) ? (
            <time
              className="block text-xs text-muted-foreground"
              dateTime={new Date(question.updatedAt).toISOString()}
            >
              Updated {new Date(question.updatedAt).toLocaleString()}
            </time>
          ) : null}
          {question.status !== "open" ? (
            <button
              type="button"
              aria-expanded={expanded}
              className="text-xs underline"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? "Hide original question" : "Show original question"}
            </button>
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
            </div>
          ) : null}
          {question.status === "open" ? (
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
          ) : (
            <>
              <p className="text-sm">
                {question.status === "answered"
                  ? "Response saved"
                  : question.status === "dismissed"
                    ? "Question dismissed"
                    : "Question withdrawn"}
              </p>
              {question.status === "answered" || question.response != null ? (
                <QuestionDelivery question={question} />
              ) : null}
              {question.response != null ? (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={async () => {
                    if (
                      navigation &&
                      (await navigation.navigate(questionId, "answer"))
                    ) {
                      setAnswerUnavailable(false);
                      return;
                    }
                    const scope = root.current?.closest("[data-thread-window]");
                    const answer = [
                      ...(scope?.querySelectorAll<HTMLElement>("[id]") ?? []),
                    ].find(
                      (element) =>
                        element.id === questionResponseId(threadId, questionId),
                    );
                    if (answer) {
                      answer.scrollIntoView({
                        behavior: "smooth",
                        block: "center",
                      });
                      answer.focus({ preventScroll: true });
                      setAnswerUnavailable(false);
                    } else setAnswerUnavailable(true);
                  }}
                >
                  View answer
                </button>
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
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}
