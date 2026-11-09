import type { FocusThreadPlanArgs } from "@get-bb/plugin-sdk";
export interface ThreadPlanFocusRequest {
  sequence: number;
  interactionId?: string;
  consumeReveal(): boolean;
  consumeFocus(): boolean;
}
interface ThreadPlanFocusTarget {
  threadId: string;
  isFocused(): boolean;
  request(args: FocusThreadPlanArgs): boolean;
}
const targets = new Set<ThreadPlanFocusTarget>();
let sequence = 0;
export function createThreadPlanFocusRequest(
  interactionId?: string,
): ThreadPlanFocusRequest {
  let revealed = false;
  let focused = false;
  return {
    sequence: ++sequence,
    ...(interactionId ? { interactionId } : {}),
    consumeReveal() {
      if (revealed) return false;
      revealed = true;
      return true;
    },
    consumeFocus() {
      if (focused) return false;
      focused = true;
      return true;
    },
  };
}
export function registerThreadPlanFocusTarget(target: ThreadPlanFocusTarget) {
  targets.add(target);
  return () => {
    targets.delete(target);
  };
}
export function focusThreadPlan(args: FocusThreadPlanArgs): boolean {
  const matching = [...targets]
    .filter((target) => target.threadId === args.threadId)
    .sort((a, b) => Number(b.isFocused()) - Number(a.isFocused()));
  return matching.some((target) => target.request(args));
}
export function isThreadPlanVisible(root: HTMLElement | null): boolean {
  if (!root?.isConnected) return false;
  for (
    let element: HTMLElement | null = root;
    element;
    element = element.parentElement
  ) {
    if (
      element.hidden ||
      element.inert ||
      element.getAttribute("aria-hidden") === "true"
    )
      return false;
    const style = getComputedStyle(element);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      style.opacity === "0" ||
      style.contentVisibility === "hidden"
    )
      return false;
  }
  const rect = root.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
export function focusPlanElement(element: HTMLElement | null) {
  if (!element) return;
  element.scrollIntoView?.({ block: "nearest" });
  element.focus({ preventScroll: true });
}
