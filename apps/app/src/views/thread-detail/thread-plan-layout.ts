import { useEffect, useState, type RefObject } from "react";

function heightOwner(root: HTMLElement): HTMLElement | null {
  for (
    let element = root.parentElement;
    element;
    element = element.parentElement
  ) {
    if (
      element.matches(
        "[data-thread-chat],[data-thread-window],[data-split-pane-id]",
      ) ||
      /^(auto|scroll|hidden|clip)$/.test(getComputedStyle(element).overflowY)
    ) {
      return element;
    }
  }
  return null;
}

export function useThreadPlanLayout(
  root: RefObject<HTMLDivElement | null>,
  placement: "overlay" | "panel",
): boolean | null {
  const [narrow, setNarrow] = useState<boolean | null>(null);
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const widthOwner =
      placement === "overlay"
        ? (element.closest<HTMLElement>(
            "[data-thread-chat],[data-thread-window]",
          ) ??
          element.parentElement ??
          element)
        : element;
    const available = heightOwner(element);
    const resize = () => {
      setNarrow(widthOwner.getBoundingClientRect().width <= 640);
      const height =
        available?.getBoundingClientRect().height ||
        window.visualViewport?.height ||
        window.innerHeight;
      element.style.setProperty(
        "--thread-plan-max-height",
        `${Math.max(96, Math.floor(height * 0.6))}px`,
      );
    };
    resize();
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(widthOwner);
    if (available && available !== widthOwner) observer?.observe(available);
    window.addEventListener("resize", resize);
    window.visualViewport?.addEventListener("resize", resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", resize);
      window.visualViewport?.removeEventListener("resize", resize);
    };
  }, [root, placement]);
  return narrow;
}
