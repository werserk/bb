import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePortalScopeProps } from "@/lib/portal-scope";

export function ComposerEditorFrame({
  expanded,
  children,
}: {
  expanded: boolean;
  children: ReactNode;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const scope = usePortalScopeProps();
  const [container] = useState(() => {
    if (typeof document === "undefined") return null;
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  useLayoutEffect(() => {
    if (!container) return;
    for (const [key, value] of Object.entries(scope))
      container.setAttribute(key, value);
  }, [container, scope]);
  useLayoutEffect(() => {
    if (!container) return;
    const target = expanded ? document.body : anchor.current;
    const focused =
      document.activeElement instanceof HTMLElement &&
      container.contains(document.activeElement)
        ? document.activeElement
        : null;
    const selection = window.getSelection();
    const range =
      selection?.rangeCount && container.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    const owner = anchor.current?.closest("[data-app-composer]");
    container.toggleAttribute("data-app-composer", expanded && Boolean(owner));
    if (expanded && owner)
      container.setAttribute(
        "data-app-composer-role",
        owner.getAttribute("data-app-composer-role") ?? "primary",
      );
    else container.removeAttribute("data-app-composer-role");
    target?.append(container);
    focused?.focus({ preventScroll: true });
    if (range && selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }, [container, expanded]);
  useLayoutEffect(() => () => container?.remove(), [container]);
  return (
    <>
      <div ref={anchor} className="contents" />
      {container ? createPortal(children, container) : children}
    </>
  );
}
