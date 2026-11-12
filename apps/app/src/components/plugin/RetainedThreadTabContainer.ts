import { useLayoutEffect, useRef, useState } from "react";

type Placement = { element: HTMLDivElement };
type Anchor = { element: HTMLElement | null; bounds: DOMRect; rect: DOMRect };

function viewportRect() {
  return new DOMRect(0, 0, window.innerWidth, window.innerHeight);
}

export function useRetainedThreadTabContainer({
  attached,
  bridge,
  outlet,
  tabId,
}: {
  attached: boolean;
  bridge: boolean;
  outlet: Placement | null;
  tabId: string;
}) {
  const [container] = useState(() => document.createElement("div"));
  const parking = useRef<HTMLDivElement>(null);
  const anchor = useRef<Anchor | null>(null);
  const scroll = useRef<{ element: HTMLElement; top: number; left: number }[]>(
    [],
  );
  const capture = (element: HTMLDivElement) => {
    const parent = element.closest<HTMLElement>("[data-split-pane-id]");
    anchor.current = {
      element: parent,
      bounds: parent?.getBoundingClientRect() ?? viewportRect(),
      rect: element.getBoundingClientRect(),
    };
    scroll.current = [...container.querySelectorAll<HTMLElement>("*")]
      .filter((element) => element.scrollTop !== 0 || element.scrollLeft !== 0)
      .map((element) => ({
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      }));
  };
  const park = () => {
    if (parking.current && container.parentElement !== parking.current)
      parking.current.append(container);
  };
  useLayoutEffect(() => {
    container.dataset.retainedFixedTabBody = tabId;
    container.className =
      "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background";
    container.hidden = !attached && !bridge;
    container.inert = !attached;
    container.setAttribute("aria-hidden", String(!attached));
    if (attached && outlet) {
      container.style.cssText = "";
      if (container.parentElement !== outlet.element) {
        outlet.element.append(container);
        for (const position of scroll.current) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
      }
      capture(outlet.element);
      return;
    }
    park();
    const positionBridge = () => {
      const previous = anchor.current;
      if (!bridge || !previous) {
        container.style.cssText = "display:none";
        return;
      }
      const bounds = previous.element?.isConnected
        ? previous.element.getBoundingClientRect()
        : viewportRect();
      const width = Math.min(previous.rect.width, bounds.width);
      const rightInset = Math.max(
        0,
        previous.bounds.right - previous.rect.right,
      );
      const topInset = Math.max(0, previous.rect.top - previous.bounds.top);
      const bottomInset = Math.max(
        0,
        previous.bounds.bottom - previous.rect.bottom,
      );
      const left = Math.max(bounds.left, bounds.right - rightInset - width);
      const top = Math.min(bounds.bottom, bounds.top + topInset);
      const height = Math.max(0, bounds.bottom - bottomInset - top);
      container.style.cssText = `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;z-index:30;pointer-events:none`;
    };
    positionBridge();
    if (!bridge) return;
    window.addEventListener("resize", positionBridge);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(positionBridge);
    if (anchor.current?.element?.isConnected)
      observer?.observe(anchor.current.element);
    else observer?.observe(document.documentElement);
    return () => {
      window.removeEventListener("resize", positionBridge);
      observer?.disconnect();
    };
  });
  return {
    container,
    parking,
    capture,
    park,
    hasAnchor: anchor.current !== null,
  };
}
