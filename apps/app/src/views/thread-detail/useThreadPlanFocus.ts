import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import type { PendingInteraction, ThreadPlanView } from "@bb/domain";
import type {
  FocusThreadPlanArgs,
  ThreadPlanStepsProps,
} from "@get-bb/plugin-sdk";
import {
  createThreadPlanFocusRequest,
  isThreadPlanVisible,
  registerThreadPlanFocusTarget,
  type ThreadPlanFocusRequest,
} from "./thread-plan-focus";

export function useThreadPlanFocus(facts: {
  props: ThreadPlanStepsProps;
  root: RefObject<HTMLDivElement | null>;
  view: ThreadPlanView | undefined;
  interactions: readonly PendingInteraction[] | undefined;
  interactionsLoading: boolean;
  focused: boolean;
  ready: boolean;
}) {
  const { props, view, interactions, interactionsLoading, ready } = facts;
  const current = useRef(facts);
  current.current = facts;
  const [request, setRequest] = useState<{
    threadId: string;
    value: ThreadPlanFocusRequest;
  }>();
  const observed = useRef<
    | {
        threadId: string;
        token: number | string | undefined;
        consumed: boolean;
      }
    | undefined
  >(undefined);
  const accept = useCallback(
    ({ interactionId }: FocusThreadPlanArgs) => {
      const { view, interactions, root, ready } = current.current;
      if (!ready || !view || !isThreadPlanVisible(root.current)) return false;
      if (interactionId) {
        const pending = interactions?.some(
          (item) =>
            item.id === interactionId &&
            item.threadId === props.threadId &&
            item.status === "pending" &&
            item.payload.kind === "user_question",
        );
        const displayed =
          view.unboundInteractionIds.includes(interactionId) ||
          [view.current, ...view.previousPlans].some((snapshot) =>
            snapshot?.items.some((step) =>
              step.interactionIds.includes(interactionId),
            ),
          );
        if (!pending || !displayed) return false;
      } else if (!view.current) return false;
      setRequest({
        threadId: props.threadId,
        value: createThreadPlanFocusRequest(interactionId),
      });
      return true;
    },
    [props.threadId],
  );
  useEffect(() => {
    if (props.placement !== "overlay") return;
    return registerThreadPlanFocusTarget({
      threadId: props.threadId,
      isFocused: () => current.current.focused,
      request: accept,
    });
  }, [props.threadId, props.placement, accept]);
  useEffect(() => {
    const token = props.focusSerial ?? props.focusInteractionId;
    if (
      observed.current?.threadId !== props.threadId ||
      !Object.is(observed.current.token, token)
    )
      observed.current = { threadId: props.threadId, token, consumed: false };
    if (
      token === undefined ||
      (typeof token === "number" && (!Number.isFinite(token) || token <= 0))
    )
      return;
    if (observed.current.consumed) return;
    if (!ready || !view) return;
    if (
      props.focusInteractionId &&
      (interactions === undefined || interactionsLoading)
    )
      return;
    observed.current.consumed = true;
    const args = {
      threadId: props.threadId,
      interactionId: props.focusInteractionId,
    };
    accept(args);
  }, [
    props.threadId,
    props.placement,
    props.focusSerial,
    props.focusInteractionId,
    ready,
    view,
    interactions,
    interactionsLoading,
    accept,
  ]);
  return request?.threadId === props.threadId ? request.value : undefined;
}
