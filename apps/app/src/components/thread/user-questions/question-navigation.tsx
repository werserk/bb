import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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

interface QuestionNavigation {
  readOnly: boolean;
  request: QuestionNavigationRequest | null;
  error: string | null;
  pending: boolean;
  suppressedRouteKey: string | null;
  complete: (key: string) => void;
  scope: () => HTMLElement | null;
  navigate: (
    questionId: string,
    kind: QuestionNavigationKind,
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
  const routeKey = `${location.key}:${location.pathname}${location.search}${location.hash}`;
  const root = useRef<HTMLDivElement>(null);
  const abort = useRef<AbortController | null>(null);
  const cache = useRef(new Map<string, number>());
  const last = useRef<{
    questionId: string;
    kind: QuestionNavigationKind;
  } | null>(null);
  const [request, setRequest] = useState<QuestionNavigationRequest | null>(
    null,
  );
  const [pending, setPending] = useState(false);
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
  }, []);
  useEffect(() => {
    clear();
    setSuppressedRouteKey(null);
    return () => abort.current?.abort();
  }, [routeKey, threadId, clear]);
  const navigate = useCallback(
    async (questionId: string, kind: QuestionNavigationKind) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      last.current = { questionId, kind };
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
    [threadId, routeKey],
  );
  const retry = useCallback(() => {
    if (last.current) void navigate(last.current.questionId, last.current.kind);
  }, [navigate]);
  const fail = useCallback(
    (key: string) => {
      if (request?.locationKey !== key) return;
      setPending(false);
      setError("Unable to reveal this message. Try again.");
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
