import type { MouseEvent } from "react";

export function isOrdinaryFileActivation(
  event: MouseEvent<HTMLElement>,
): boolean {
  return !(
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    event.currentTarget.hasAttribute("download")
  );
}
