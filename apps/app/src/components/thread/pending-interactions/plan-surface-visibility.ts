import { useLayoutEffect, useState, type RefObject } from "react";

export function isPlanSurfaceVisible(root: HTMLElement | null): boolean {
  if (!root?.isConnected) return false;
  for (
    let element: HTMLElement | null = root;
    element;
    element = element.parentElement
  ) {
    if (
      element.hidden ||
      element.inert ||
      element.hasAttribute("inert") ||
      element.getAttribute("aria-hidden") === "true" ||
      (element.tagName === "DETAILS" && !element.hasAttribute("open"))
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
  return true;
}

export function usePlanSurfaceVisible(
  root: RefObject<HTMLElement | null>,
  enabled = true,
): boolean | null {
  const [visible, setVisible] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element || !enabled) return;
    const measure = () => setVisible(isPlanSurfaceVisible(element));
    const observer = new MutationObserver(() => {
      observe();
      measure();
    });
    const observe = () => {
      observer.disconnect();
      for (
        let ancestor: HTMLElement | null = element;
        ancestor;
        ancestor = ancestor.parentElement
      ) {
        observer.observe(ancestor, {
          attributes: true,
          attributeFilter: [
            "hidden",
            "inert",
            "aria-hidden",
            "class",
            "style",
            "open",
          ],
          childList: true,
        });
      }
    };
    observe();
    measure();
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [root, enabled]);
  return enabled ? visible : false;
}
