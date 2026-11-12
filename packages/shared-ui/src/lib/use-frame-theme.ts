import { useSyncExternalStore } from "react";
import { frameTheme, frameThemesEqual, type FrameTheme } from "./html-frame";

let current: FrameTheme | null = null;
let stopWatching: (() => void) | null = null;
const listeners = new Set<() => void>();

function readTheme(): FrameTheme {
  const root = document.documentElement;
  const style = window.getComputedStyle(root);
  const next = frameTheme(
    root.classList.contains("dark") ? "dark" : "light",
    (token) => style.getPropertyValue(token),
  );
  if (current === null || !frameThemesEqual(current, next)) current = next;
  return current;
}

function watch(): () => void {
  let frame = 0;
  const refresh = () => {
    window.cancelAnimationFrame(frame);
    frame = window.requestAnimationFrame(() => {
      const before = current;
      if (readTheme() !== before) for (const listener of listeners) listener();
    });
  };
  const observer = new MutationObserver(refresh);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  return () => {
    window.cancelAnimationFrame(frame);
    observer.disconnect();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stopWatching ??= watch();
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    stopWatching?.();
    stopWatching = null;
    current = null;
  };
}

export function useFrameTheme(): FrameTheme {
  return useSyncExternalStore(subscribe, () => current ?? readTheme());
}
