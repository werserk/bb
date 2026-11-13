import { useLayoutEffect, useRef, useState } from "react";

type Placement = { element: HTMLDivElement };
type ScrollPosition = {
  element: HTMLElement;
  top: number;
  left: number;
  node?: HTMLElement;
  offsetTop: number;
  offsetLeft: number;
};
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
  const scroll = useRef<ScrollPosition[]>([]);
  const capture = (element: HTMLDivElement) => {
    // Late layout cleanup can still name the removed outlet. Its zero geometry
    // must never replace the last visible snapshot (including a real zero offset).
    if (
      !element.isConnected ||
      container.parentElement !== element ||
      !container.isConnected ||
      container.getClientRects().length === 0 ||
      container.hidden ||
      container.style.display === "none"
    )
      return;
    const parent = element.closest<HTMLElement>("[data-split-pane-id]");
    anchor.current = {
      element: parent,
      bounds: parent?.getBoundingClientRect() ?? viewportRect(),
      rect: element.getBoundingClientRect(),
    };
    scroll.current = [...container.querySelectorAll<HTMLElement>("*")]
      .filter(
        (element) =>
          element instanceof HTMLElement &&
          (element.scrollTop !== 0 || element.scrollLeft !== 0),
      )
      .map((element) => {
        const viewport = element.getBoundingClientRect();
        // A leaf anchors content rather than the group's outer box, whose top
        // does not move when a temporary block above the visible row disappears.
        const node = [...element.querySelectorAll<HTMLElement>("*")].find(
          (child) => {
            if (child.childElementCount !== 0) return false;
            const rect = child.getBoundingClientRect();
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.bottom > viewport.top &&
              rect.top < viewport.bottom &&
              rect.right > viewport.left &&
              rect.left < viewport.right
            );
          },
        );
        const rect = node?.getBoundingClientRect();
        return {
          element,
          top: element.scrollTop,
          left: element.scrollLeft,
          node,
          offsetTop: rect ? rect.top - viewport.top : 0,
          offsetLeft: rect ? rect.left - viewport.left : 0,
        };
      });
  };
  const restoreScroll = () => {
    for (const position of scroll.current) {
      const { element, node } = position;
      if (node?.isConnected && element.contains(node)) {
        const viewport = element.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        element.scrollTop += rect.top - viewport.top - position.offsetTop;
        element.scrollLeft += rect.left - viewport.left - position.offsetLeft;
      } else {
        element.scrollTop = position.top;
        element.scrollLeft = position.left;
      }
    }
  };
  const park = () => {
    if (parking.current && container.parentElement !== parking.current)
      parking.current.append(container);
  };
  useLayoutEffect(() => {
    // Connectivity can change after render, before this layout effect runs.
    const live = attached && outlet?.element.isConnected;
    container.dataset.retainedFixedTabBody = tabId;
    container.className =
      "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-panel";
    container.hidden = !live && !bridge;
    container.inert = !live;
    container.setAttribute("aria-hidden", String(!live));
    if (live && outlet) {
      container.style.cssText = "";
      if (container.parentElement !== outlet.element) {
        outlet.element.append(container);
        restoreScroll();
      }
      return () => {
        // Capture before the next layout effect hides/parks the body. A late
        // outlet cleanup may run after it is hidden and must keep this record.
        if (container.parentElement === outlet.element) capture(outlet.element);
      };
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
    // Moving into the painted bridge resets descendant offsets just like an
    // outlet move. Restore after its geometry exists, before the browser paints.
    restoreScroll();
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
