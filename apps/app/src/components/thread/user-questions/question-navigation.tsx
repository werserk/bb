import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { hydrateConversationQuestion } from "@/hooks/cache-owners/conversation-question-cache-owner";
import { useLocation } from "react-router-dom";
import { sdk } from "@/lib/sdk";
import { flashSearchTarget } from "@/lib/search-flash";
import {
  questionCardId,
  questionResponseId,
} from "./question-response-presentation";
import {
  resolveQuestionEventSequence,
  type QuestionNavigationKind,
} from "./question-navigation-events";

export interface QuestionNavigationRequest {
  threadId: string;
  seq: number;
  locationKey: string;
  routeKey: string;
  elementId: string;
}

type QueuedAnswerReveal = (signal: AbortSignal) => Promise<HTMLElement | null>;

interface QuestionNavigation {
  registerQueuedAnswer: (
    questionId: string,
    reveal: QueuedAnswerReveal,
  ) => () => void;
  feedback: {
    questionId: string;
    kind: QuestionNavigationKind;
    origin: "composer" | "inline";
  } | null;
  readOnly: boolean;
  fallbackQuestionId: string | null;
  request: QuestionNavigationRequest | null;
  error: string | null;
  pending: boolean;
  suppressedRouteKey: string | null;
  complete: (key: string) => void;
  scope: () => HTMLElement | null;
  navigate: (
    questionId: string,
    kind: QuestionNavigationKind,
    origin?: "composer" | "inline",
  ) => Promise<boolean>;
  retry: () => void;
  clear: () => void;
  fail: (locationKey: string) => void;
}
const Context = createContext<QuestionNavigation | null>(null);
export const useQuestionNavigation = () => useContext(Context);

export function QuestionNavigationProvider({
  threadId,
  children,
  readOnly = false,
}: {
  threadId: string;
  children: ReactNode;
  readOnly?: boolean;
}) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const routeKey = `${location.key}:${location.pathname}${location.search}${location.hash}`;
  const root = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, number>());
  const queuedAnswers = useRef(new Map<string, QueuedAnswerReveal>());
  const registerQueuedAnswer = useCallback(
    (id: string, reveal: QueuedAnswerReveal) => {
      queuedAnswers.current.set(id, reveal);
      return () => {
        if (queuedAnswers.current.get(id) === reveal)
          queuedAnswers.current.delete(id);
      };
    },
    [],
  );
  const last = useRef<{
    questionId: string;
    kind: QuestionNavigationKind;
    origin: "composer" | "inline";
  } | null>(null);
  const [request, setRequest] = useState<QuestionNavigationRequest | null>(
    null,
  );
  const [feedback, setFeedback] =
    useState<QuestionNavigation["feedback"]>(null);
  const [pending, setPending] = useState(false);
  const [fallbackQuestionId, setFallbackQuestionId] = useState<string | null>(
    null,
  );
  const [suppressedRouteKey, setSuppressedRouteKey] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const scope = useCallback(() => root.current, []);
  const clear = useCallback(() => {
    abort.current?.abort();
    setPending(false);
    setRequest(null);
    setError(null);
    setFeedback(null);
    setFallbackQuestionId(null);
  }, []);
  const [route, setRoute] = useState({ routeKey, threadId });
  if (route.routeKey !== routeKey || route.threadId !== threadId) {
    setRoute({ routeKey, threadId });
    setPending(false);
    setRequest(null);
    setError(null);
    setFeedback(null);
    setFallbackQuestionId(null);
    setSuppressedRouteKey(null);
  }
  useEffect(() => {
    abort.current?.abort();
    return () => abort.current?.abort();
  }, [routeKey, threadId]);
  const navigate = useCallback(
    async (
      questionId: string,
      kind: QuestionNavigationKind,
      origin: "composer" | "inline" = "composer",
    ) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      last.current = { questionId, kind, origin };
      setFeedback({ questionId, kind, origin });
      setError(null);
      setRequest(null);
      setPending(true);
      setSuppressedRouteKey(routeKey);
      let requested = false;
      const elementId =
        kind === "question"
          ? questionCardId(threadId, questionId)
          : questionResponseId(threadId, questionId);
      try {
        if (kind === "question") {
          const question = await sdk.threads.questions.get({
            threadId,
            questionId,
            signal: controller.signal,
          });
          controller.signal.throwIfAborted();
          hydrateConversationQuestion({
            queryClient,
            threadId,
            questionId,
            question,
          });
          const target = root.current?.querySelector<HTMLElement>(
            `[id="${elementId}"]`,
          );
          if (target) {
            target.scrollIntoView({ block: "center" });
            target.focus({ preventScroll: true });
            flashSearchTarget(target);
          } else {
            if (readOnly)
              throw new Error(
                "This question is outside the loaded read-only history.",
              );
            setFallbackQuestionId(questionId);
          }
          return true;
        }
        const queued =
          kind === "answer" ? queuedAnswers.current.get(questionId) : undefined;
        if (queued) {
          const element = await queued(controller.signal);
          controller.signal.throwIfAborted();
          if (element) {
            element.scrollIntoView({ block: "nearest" });
            element.focus({ preventScroll: true });
            flashSearchTarget(element);
            return true;
          }
        }
        const key = `${threadId}:${questionId}:${kind}`;
        const seq =
          cache.current.get(key) ??
          (await resolveQuestionEventSequence({
            list: sdk.threads.events.list,
            threadId,
            questionId,
            kind,
            signal: controller.signal,
          }));
        controller.signal.throwIfAborted();
        if (seq === null) {
          const target = root.current?.querySelector<HTMLElement>(
            `[id="${elementId}"]`,
          );
          if (!target)
            throw new Error(
              "This message is unavailable in the current history.",
            );
          target.scrollIntoView({ block: "center" });
          target.focus({ preventScroll: true });
          flashSearchTarget(target);
        } else {
          cache.current.set(key, seq);
          requested = true;
          setRequest({
            threadId,
            seq,
            elementId,
            routeKey,
            locationKey: `${routeKey}:question:${crypto.randomUUID()}`,
          });
        }
        return true;
      } catch (reason) {
        if (!controller.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Unable to open question.",
          );
        return controller.signal.aborted;
      } finally {
        if (!controller.signal.aborted && !requested) setPending(false);
      }
    },
    [threadId, routeKey, readOnly, queryClient],
  );
  const retry = useCallback(() => {
    if (last.current)
      void navigate(
        last.current.questionId,
        last.current.kind,
        last.current.origin,
      );
  }, [navigate]);
  const fail = useCallback(
    (key: string) => {
      if (request?.locationKey !== key) return;
      setPending(false);
      setError("Unable to reveal this message. Try again.");
      setFeedback((current) =>
        current ? { ...current, origin: "composer" } : null,
      );
      setRequest(null);
    },
    [request],
  );
  const complete = useCallback(
    (key: string) => {
      if (request?.locationKey === key) setPending(false);
    },
    [request],
  );
  return (
    <Context.Provider
      value={{
        readOnly,
        fallbackQuestionId,
        feedback,
        registerQueuedAnswer,
        suppressedRouteKey,
        complete,
        request,
        pending,
        error,
        scope,
        navigate,
        retry,
        clear,
        fail,
      }}
    >
      <div ref={root} className="contents" data-question-navigation-scope="">
        {children}
      </div>
    </Context.Provider>
  );
}
