import { useLayoutEffect, useRef, useState } from "react";
import { observeSharedResize } from "@bb/shared-ui/lib/shared-resize-observer";

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

function setContainerStyle(container: HTMLDivElement, cssText: string) {
  container.style.cssText = cssText;
}

function presentContainer(
  container: HTMLDivElement,
  { tabId, live, bridge }: { tabId: string; live: boolean; bridge: boolean },
) {
  container.dataset.retainedFixedTabBody = tabId;
  container.className = "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-panel";
  container.hidden = !live && !bridge;
  container.inert = !live;
  container.setAttribute("aria-hidden", String(!live));
}

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
    const live = !!(attached && outlet?.element.isConnected);
    presentContainer(container, { tabId, live, bridge });
    if (live && outlet) {
      setContainerStyle(container, "");
      if (container.parentElement !== outlet.element) {
        outlet.element.append(container);
        restoreScroll();
      }
      return () => {
        if (container.parentElement === outlet.element) capture(outlet.element);
      };
    }
    park();
    const positionBridge = () => {
      const previous = anchor.current;
      if (!bridge || !previous) {
        setContainerStyle(container, "display:none");
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
      setContainerStyle(
        container,
        `position:fixed;left:${left}px;top:${top}px;width:${width}px;height:${height}px;z-index:30;pointer-events:none`,
      );
    };
    positionBridge();
    if (!bridge) return;
    restoreScroll();
    window.addEventListener("resize", positionBridge);
    const stopObserving = observeSharedResize(
      anchor.current?.element?.isConnected
        ? anchor.current.element
        : document.documentElement,
      { read: () => undefined, write: positionBridge },
    );
    return () => {
      window.removeEventListener("resize", positionBridge);
      stopObserving();
    };
  });
  return {
    container,
    parking,
    capture,
    park,
  };
}
