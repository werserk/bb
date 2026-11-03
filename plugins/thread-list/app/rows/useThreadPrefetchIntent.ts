import {
  useCallback,
  useEffect,
  useRef,
  type FocusEventHandler,
  type PointerEventHandler,
} from "react";
import { experimental_prefetchThread } from "@get-bb/plugin-sdk/app";

export const THREAD_PREFETCH_DWELL_MS = 120;

interface ThreadPrefetchIntentHandlers {
  onFocus: FocusEventHandler<HTMLElement>;
  onPointerEnter: PointerEventHandler<HTMLElement>;
  onPointerLeave: PointerEventHandler<HTMLElement>;
}

function isKeyboardFocus(element: HTMLElement): boolean {
  try {
    return element.matches(":focus-visible");
  } catch {
    return false;
  }
}

export function useThreadPrefetchIntent(
  threadId: string,
): ThreadPrefetchIntentHandlers {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);
  useEffect(() => cancel, [cancel, threadId]);

  const onPointerEnter = useCallback<PointerEventHandler<HTMLElement>>(
    (event) => {
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      cancel();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        experimental_prefetchThread(threadId);
      }, THREAD_PREFETCH_DWELL_MS);
    },
    [cancel, threadId],
  );
  const onFocus = useCallback<FocusEventHandler<HTMLElement>>(
    (event) => {
      if (isKeyboardFocus(event.currentTarget)) {
        experimental_prefetchThread(threadId);
      }
    },
    [threadId],
  );

  return { onFocus, onPointerEnter, onPointerLeave: cancel };
}
